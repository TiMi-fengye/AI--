"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { once } = require("node:events");
const { acceptsGzip, emptySnapshot, sendJson } = require("../server/auth-service");

const password = "synthetic-performance-Password-2026";
const sourceRoot = path.resolve(__dirname, "..");
function rawRequest(base, route, method = "GET", headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
function decoded(response) {
  return (response.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(response.body) : response.body).toString("utf8");
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(sourceRoot, ".hr-http-performance-"));
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), sourceRoot);
    assert.match(path.basename(target), /^\.hr-http-performance-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const data = path.join(directory, "synthetic-data");
  fs.mkdirSync(path.join(directory, "server"));
  fs.mkdirSync(path.join(directory, "js"));
  fs.mkdirSync(path.join(directory, "css"));
  fs.mkdirSync(data);
  // Copy only explicitly public code. Loading server.js in this isolated tree
  // cannot read the workspace's private config.json, auth users or data files.
  for (const file of ["server.js", "auth-service.js", "sms-verification.js", "sms-aliyun.js"]) {
    fs.copyFileSync(path.join(sourceRoot, "server", file), path.join(directory, "server", file));
  }
  const text = "/* 合成性能测试，不含真实人员 */\n" + "var syntheticValue = '示例字符串';\n".repeat(600);
  fs.writeFileSync(path.join(directory, "js", "synthetic.js"), text);
  fs.writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>测试页面</title><p>无账号内容</p>");
  fs.writeFileSync(path.join(directory, "sw.js"), "// synthetic worker\n" + "// worker\n".repeat(200));
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ name: "合成应用" }));
  const snapshot = {
    ...emptySnapshot(), revision: 7,
    employees: [
      { id: 1, name: "A栋演示人员", employeeNo: "00001", building: "A栋", phone: "13800000001", aiProfile: "仅第一位人员可见的简介".repeat(400), resumeData: "data:text/plain;base64," + Buffer.from("synthetic attachment").toString("base64") },
      { id: 2, name: "B栋演示人员", employeeNo: "00002", building: "B栋", phone: "13800000002", aiProfile: "另一栋人员独立简介".repeat(400) }
    ]
  };
  fs.writeFileSync(path.join(data, "snapshot.json"), JSON.stringify(snapshot));
  const previous = { HR_DATA_DIR: process.env.HR_DATA_DIR, HR_NO_OPEN: process.env.HR_NO_OPEN, HR_SMS_ENABLED: process.env.HR_SMS_ENABLED };
  process.env.HR_DATA_DIR = data;
  process.env.HR_NO_OPEN = "1";
  process.env.HR_SMS_ENABLED = "false";
  ({ server } = require(path.join(directory, "server", "server.js")));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  async function json(route, method = "GET", body, cookie = "", extraHeaders = {}) {
    const response = await rawRequest(base, route, method, {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders
    }, body === undefined ? undefined : JSON.stringify(body));
    return { ...response, data: JSON.parse(decoded(response)), cookie: response.headers["set-cookie"]?.[0]?.split(";")[0] };
  }
  async function accounts() {
    const admin = await json("/api/auth/setup", "POST", { password });
    assert.equal(admin.status, 201);
    const result = { admin: admin.cookie };
    for (const [username, role, buildings, employeeId] of [["leader", "leader", ["A栋"], 1], ["member", "user", [], 2]]) {
      assert.equal((await json("/api/auth/users", "POST", { username, name: username, role, buildings, employeeId, password }, admin.cookie)).status, 200);
      const login = await json("/api/auth/login", "POST", { username, password });
      assert.equal(login.status, 200); result[username] = login.cookie;
    }
    return result;
  }
  return { base, directory, text, json, accounts };
}

test("Accept-Encoding尊重gzip禁用、通配符与坏q值，不误认其他编码", () => {
  for (const header of [undefined, "", "br", "xgzip", "gzip;q=0", "GZIP; q=0.000", "*;q=1,gzip;q=0", "gzip;q=invalid", "gzip;q=1.1", "gzip;q=.5", "gzip;q=1.0000", "gzip;foo=bar", "gzip,gzip;q=0"]) assert.equal(acceptsGzip(header), false, String(header));
  for (const header of ["gzip", "br, gzip", "GZIP; q=0.5", "*;q=1", "gzip;q=1.000", "identity;q=0,gzip;q=1"]) assert.equal(acceptsGzip(header), true, header);
});

test("静态资源200带重验证ETag，相同条件返回304，失配和坏条件返回正文", async t => {
  const f = await fixture(t);
  const first = await rawRequest(f.base, "/js/synthetic.js?v=unchanged");
  assert.equal(first.status, 200);
  assert.equal(first.body.toString("utf8"), f.text);
  assert.equal(first.headers["cache-control"], "public, max-age=0, must-revalidate");
  assert.equal(first.headers.vary, "Accept-Encoding");
  assert.match(first.headers.etag, /^"[a-f0-9]{64}"$/);
  assert.ok(first.headers["last-modified"]);
  assert.equal((await rawRequest(f.base, "/js/synthetic.js?v=unchanged", "GET", { "If-None-Match": first.headers.etag })).status, 304);
  const weak = await rawRequest(f.base, "/js/synthetic.js", "GET", { "If-None-Match": '"other", W/' + first.headers.etag });
  assert.equal(weak.status, 304); assert.equal(weak.body.length, 0);
  assert.equal((await rawRequest(f.base, "/js/synthetic.js", "GET", { "If-None-Match": "*" })).status, 304);
  assert.equal((await rawRequest(f.base, "/js/synthetic.js", "GET", { "If-None-Match": "malformed-unquoted" })).status, 200);
  assert.equal((await rawRequest(f.base, "/js/synthetic.js", "GET", { "If-None-Match": '"different"' })).status, 200);
});

test("静态文本gzip与identity使用不同ETag，q=0保留原文，HEAD无正文", async t => {
  const f = await fixture(t);
  const gzip = await rawRequest(f.base, "/js/synthetic.js", "GET", { "Accept-Encoding": "gzip" });
  const identity = await rawRequest(f.base, "/js/synthetic.js", "GET", { "Accept-Encoding": "gzip;q=0" });
  assert.equal(gzip.status, 200); assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.equal(decoded(gzip), f.text);
  assert.ok(gzip.body.length < Buffer.byteLength(f.text) / 3);
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.body.toString("utf8"), f.text);
  assert.notEqual(gzip.headers.etag, identity.headers.etag);
  assert.equal((await rawRequest(f.base, "/js/synthetic.js", "GET", { "Accept-Encoding": "gzip", "If-None-Match": gzip.headers.etag })).status, 304);
  assert.equal((await rawRequest(f.base, "/js/synthetic.js", "GET", { "Accept-Encoding": "gzip;q=0", "If-None-Match": gzip.headers.etag })).status, 200);
  const head = await rawRequest(f.base, "/js/synthetic.js", "HEAD", { "Accept-Encoding": "gzip" });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers["content-length"]), gzip.body.length);
  assert.equal(head.headers.etag, gzip.headers.etag);
  const small = await rawRequest(f.base, "/manifest.json", "GET", { "Accept-Encoding": "gzip" });
  assert.equal(small.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(small.body).name, "合成应用");
});

test("相同URL和v参数的内容更新后返回200，新HTML和SW也始终要求重验证", async t => {
  const f = await fixture(t);
  const route = "/js/synthetic.js?v=same-old-date";
  const before = await rawRequest(f.base, route, "GET", { "Accept-Encoding": "gzip" });
  const changed = f.text.replace("syntheticValue", "syntheticOther");
  assert.equal(changed.length, f.text.length);
  fs.writeFileSync(path.join(f.directory, "js", "synthetic.js"), changed);
  // Force a changed stat stamp even on filesystems with coarse time precision.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(f.directory, "js", "synthetic.js"), later, later);
  const after = await rawRequest(f.base, route, "GET", { "Accept-Encoding": "gzip", "If-None-Match": before.headers.etag });
  assert.equal(after.status, 200); assert.notEqual(after.headers.etag, before.headers.etag);
  assert.equal(decoded(after), changed);
  for (const resource of ["/index.html", "/sw.js", "/manifest.json"]) {
    const response = await rawRequest(f.base, resource);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal((await rawRequest(f.base, resource, "GET", { "If-None-Match": response.headers.etag })).status, 304);
  }
});

test("私有路径和错误方法不因静态缓存开放，缺失文件不返回其他缓存资源", async t => {
  const f = await fixture(t);
  await rawRequest(f.base, "/js/synthetic.js");
  for (const route of ["/server/config.json", "/server/data/snapshot.json", "/server/auth-service.js", "/js/%2e%2e/server/config.json", "/js/missing.js"]) {
    const response = await rawRequest(f.base, route, "GET", { "Accept-Encoding": "gzip", "If-None-Match": "*" });
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.etag, undefined);
    assert.doesNotMatch(response.body.toString("utf8"), /合成性能测试|A栋演示人员/);
  }
  assert.equal((await rawRequest(f.base, "/js/synthetic.js", "POST")).status, 405);
});

test("认证与人员数据gzip保持no-store且无ETag，匿名401和各角色范围不因条件缓存改变", async t => {
  const f = await fixture(t);
  const cookies = await f.accounts();
  const staticFile = await rawRequest(f.base, "/js/synthetic.js");
  const headers = { "Accept-Encoding": "gzip", "If-None-Match": staticFile.headers.etag };
  const anonymous = await f.json("/api/data/snapshot.json", "GET", undefined, "", headers);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["cache-control"], "no-store");
  assert.equal(anonymous.headers.etag, undefined);
  for (const [role, ids] of [["admin", [1, 2]], ["leader", [1]], ["member", [2]]]) {
    const response = await f.json("/api/data/snapshot.json", "GET", undefined, cookies[role], headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["last-modified"], undefined);
    assert.deepEqual(response.data.employees.map(employee => employee.id), ids);
    const identity = await f.json("/api/data/snapshot.json", "GET", undefined, cookies[role], { "Accept-Encoding": "gzip;q=0" });
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.deepEqual(identity.data, response.data);
  }
  const session = await f.json("/api/auth/session", "GET", undefined, cookies.member, headers);
  assert.equal(session.status, 200); assert.equal(session.headers["cache-control"], "no-store");
  assert.equal(session.headers.etag, undefined);
});

test("JSON异步压缩保留状态、Cookie和Retry-After，客户端关闭后不再次结束响应", async t => {
  const server = http.createServer((req, res) => {
    res.setHeader("Set-Cookie", "synthetic_cookie=example; HttpOnly");
    res.setHeader("Retry-After", "60");
    res.setHeader("ETag", '"must-not-leak-to-api"');
    sendJson(res, 429, { ok: false, message: "合成限流提示".repeat(500), retryAfter: 60 });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const response = await rawRequest("http://127.0.0.1:" + server.address().port, "/", "GET", { "Accept-Encoding": "gzip" });
  assert.equal(response.status, 429); assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
  assert.match(response.headers["set-cookie"][0], /synthetic_cookie/);
  assert.equal(response.headers["retry-after"], "60");
  assert.equal(JSON.parse(decoded(response)).retryAfter, 60);
  let writes = 0;
  sendJson({ destroyed: true, writableEnded: false, writeHead() { writes++; }, end() { writes++; } }, 200, { ok: true });
  sendJson({ destroyed: false, writableEnded: true, writeHead() { writes++; }, end() { writes++; } }, 200, { ok: true });
  assert.equal(writes, 0);
});

test("gzip错误回退原始JSON，压缩完成前关闭的响应不会再次写入", () => {
  const original = zlib.gzip;
  const originalWarning = console.warn;
  let complete, warnings = 0;
  zlib.gzip = (_body, _options, callback) => { complete = callback; };
  console.warn = () => { warnings++; };
  function response() {
    return { destroyed: false, writableEnded: false, headersSent: false,
      req: { method: "GET", headers: { "accept-encoding": "gzip" } },
      writes: 0, headers: {}, body: null,
      getHeader(name) { return this.headers[name]; }, removeHeader() {},
      writeHead(status, headers) { this.status = status; this.headers = headers; this.writes++; },
      end(body) { this.body = body; this.writableEnded = true; this.writes++; }
    };
  }
  try {
    const closed = response();
    sendJson(closed, 200, { message: "合成关闭场景".repeat(500) });
    closed.destroyed = true;
    complete(null, Buffer.from("synthetic-gzip"));
    assert.equal(closed.writes, 0);
    const fallback = response();
    const value = { message: "合成压缩失败场景".repeat(500) };
    sendJson(fallback, 429, value);
    complete(new Error("synthetic compression error"));
    assert.equal(fallback.status, 429);
    assert.equal(fallback.headers["Content-Encoding"], undefined);
    assert.equal(fallback.headers["Cache-Control"], "no-store");
    assert.deepEqual(JSON.parse(fallback.body), value);
    assert.equal(warnings, 1);
  } finally { zlib.gzip = original; console.warn = originalWarning; }
});
