"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const { createSmsVerification } = require("../server/sms-verification");

const root = path.resolve(__dirname, "..");
const publicServerFiles = ["server.js", "auth-service.js", "sms-verification.js", "sms-aliyun.js"];

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(root, ".sms-auth-isolated-"));
  t.after(() => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), root);
    assert.match(path.basename(target), /^\.sms-auth-isolated-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

test("并发改密先完成后，排队中的旧密码加验证码登录不能重新建立会话", async t => {
  const directory = temporary(t);
  const copiedAuth = path.join(directory, "auth-service.js");
  fs.copyFileSync(path.join(root, "server/auth-service.js"), copiedAuth);

  // The public module captures promisify(scrypt) at import. Track only completion
  // promises (no password values) to deterministically exercise the old race.
  const operations = [], originalScrypt = crypto.scrypt;
  crypto.scrypt = function (...args) {
    const callback = args.pop();
    let complete;
    operations.push(new Promise(resolve => { complete = resolve; }));
    return originalScrypt(...args, (error, result) => { callback(error, result); complete(); });
  };
  let createAuthService, emptySnapshot;
  try { ({ createAuthService, emptySnapshot } = require(copiedAuth)); }
  finally { crypto.scrypt = originalScrypt; }

  let snapshot = emptySnapshot(), time = Date.parse("2026-11-12T04:00:00Z"), delivery;
  const sms = createSmsVerification({ dataDir: directory, enabled: true, now: () => time, sendCode: async value => { delivery = value; } });
  const auth = createAuthService({ dataDir: directory, smsVerification: sms, readSnapshot: async () => structuredClone(snapshot), writeSnapshot: async value => { snapshot = structuredClone(value); } });
  const parsedRequests = new Map();
  function whenParsed(route) {
    return new Promise(resolve => { parsedRequests.set(route, resolve); });
  }
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    const pending = auth.handle(req, res, route);
    // readJson's end listener was installed above. Its continuation queues the
    // auth transaction before this observer's following microtask executes.
    req.once("end", () => queueMicrotask(() => {
      const resolve = parsedRequests.get(route);
      if (resolve) { parsedRequests.delete(route); resolve(); }
    }));
    pending.then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, body, cookie = "") {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const phone = "13800000999", oldPassword = "old-synthetic-password", newPassword = "new-synthetic-password";
  let sent = await request("/api/auth/sms-code", { phone, purpose: "register" });
  assert.equal(sent.status, 200);
  const registered = await request("/api/auth/register", { phone, password: oldPassword, employee: { name: "合成测试人员", phone }, smsCode: delivery.code, smsChallengeId: sent.data.challengeId });
  assert.equal(registered.status, 201);
  time += 61000;
  sent = await request("/api/auth/sms-code", { phone, purpose: "login" });
  assert.equal(sent.status, 200);
  const verification = { smsCode: delivery.code, smsChallengeId: sent.data.challengeId };

  let release, entered;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  auth.serialized(() => new Promise(resolve => { release = resolve; entered(); }));
  await enteredGate;
  let changing, logging;
  try {
    const passwordParsed = whenParsed("/api/auth/password");
    changing = request("/api/auth/password", { oldPassword, newPassword }, registered.cookie);
    await passwordParsed;
    const before = operations.length;
    const loginParsed = whenParsed("/api/auth/login");
    logging = request("/api/auth/login", { username: phone, password: oldPassword, ...verification });
    await loginParsed;
    // Old implementations started password hashing outside the queue; ensure
    // that verification has finished before releasing the earlier password edit.
    // Fixed implementations have no new crypto operation while the queue waits.
    await Promise.all(operations.slice(before));
    await new Promise(setImmediate);
    release();
    const [changed, loggedIn] = await Promise.all([changing, logging]);
    assert.equal(changed.status, 200);
    assert.equal(loggedIn.status, 401);
    assert.equal(loggedIn.cookie, undefined);
    assert.equal((await request("/api/auth/session", undefined, registered.cookie)).data.user, null);
    // A failed old-password attempt must not burn the valid SMS challenge.
    assert.equal((await request("/api/auth/login", { username: phone, password: newPassword, ...verification })).status, 200);
  } finally {
    if (release) release();
    await Promise.allSettled([changing, logging].filter(Boolean));
  }
});

function configurationFixture(t, value, { raw = false, directoryInstead = false, environment = {} } = {}) {
  const directory = temporary(t), serverDirectory = path.join(directory, "server");
  fs.mkdirSync(serverDirectory);
  // Copy only public source modules. Never read the working config or data.
  for (const file of publicServerFiles) fs.copyFileSync(path.join(root, "server", file), path.join(serverDirectory, file));
  if (directoryInstead) fs.mkdirSync(path.join(serverDirectory, "config.json"));
  else if (value !== undefined) fs.writeFileSync(path.join(serverDirectory, "config.json"), raw ? value : JSON.stringify(value));
  const child = `
    const http=require('node:http');
    globalThis.fetch=()=>{throw new Error('External network is disabled in this fixture');};
    const {server}=require('./server/server');
    server.listen(0,'127.0.0.1',()=>{
      http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/auth/status'},response=>{
        let body='';response.on('data',part=>{body+=part;});response.on('end',()=>{
          console.log(body);server.closeAllConnections();server.close();
        });
      }).on('error',()=>{process.exitCode=1;server.closeAllConnections();server.close();});
    });
  `;
  // A narrow process environment avoids inheriting real HR/SMS credentials.
  const env = { HR_DATA_DIR: path.join(directory, "data"), HR_NO_OPEN: "1", ...environment };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, ["-e", child], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
}

test("缺少配置时使用默认关闭的短信开发模式，不读取真实配置", t => {
  const result = configurationFixture(t);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.smsVerificationRequired, false);
  assert.equal(status.smsConfigured, false);
});

test("损坏或不可读的配置拒绝启动，不把秘密片段输出到错误", t => {
  const marker = "SYNTHETIC_CONFIG_SECRET_MUST_NOT_LEAK";
  for (const setup of [
    { value: '{"sms":{"enabled":true,"accessKeySecret":"' + marker + '","broken":', raw: true },
    { value: undefined, directoryInstead: true }
  ]) {
    const result = configurationFixture(t, setup.value, setup);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /服务端配置无法读取/);
    assert.ok(!(result.stdout + result.stderr).includes(marker));
    assert.doesNotMatch(result.stdout, /"smsVerificationRequired":false/);
  }
});

test("错误的顶层结构或短信开关类型不能静默关闭验证码", t => {
  const values = [null, [], 1, "incorrect", { sms: null }, { sms: [] }, { sms: "incorrect" },
    { sms: { enabled: "false" } }, { sms: { enabled: "true" } }, { sms: { enabled: 0 } }, { sms: { enabled: 1 } }];
  for (const value of values) {
    const result = configurationFixture(t, value);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, JSON.stringify(value));
    assert.match(result.stderr, /服务端配置无法读取/);
  }
});

test("有效布尔短信配置及环境覆盖只改变启用状态，不发送短信", t => {
  for (const setup of [
    { value: { sms: { enabled: true } }, required: true },
    { value: { sms: { enabled: false } }, required: false },
    { value: { sms: { enabled: true } }, environment: { HR_SMS_ENABLED: "FALSE" }, required: false },
    { value: { sms: { enabled: false } }, environment: { HR_SMS_ENABLED: "TRUE" }, required: true }
  ]) {
    const result = configurationFixture(t, setup.value, setup);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.smsVerificationRequired, setup.required);
    assert.equal(status.smsConfigured, false);
  }
});

test("无效短信环境开关使配置失败，错误中不包含输入值", t => {
  for (const value of ["", "tru", "0", "SYNTHETIC_ENV_SECRET_MUST_NOT_LEAK"]) {
    const result = configurationFixture(t, { sms: { enabled: true } }, { environment: { HR_SMS_ENABLED: value } });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /短信开关配置无效/);
    if (value.startsWith("SYNTHETIC_")) assert.ok(!result.stderr.includes(value));
  }
});
