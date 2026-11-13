"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { createAuthService, emptySnapshot } = require("../server/auth-service");
const { createSmsVerification } = require("../server/sms-verification");

const password = "sms-fixture-password-2026";

async function fixture(t, { enabled = true, configured = true } = {}) {
  const parent = process.platform === "win32" ? path.resolve(__dirname, "..") : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(parent, ".hr-sms-auth-"));
  let snapshot = emptySnapshot(), time = Date.parse("2026-11-12T04:00:00Z"), failWrite = false;
  const deliveries = [];
  const smsVerification = createSmsVerification({
    dataDir: directory, enabled, now: () => time,
    sendCode: configured ? async message => { deliveries.push({ ...message }); } : null
  });
  const auth = createAuthService({
    dataDir: directory, smsVerification,
    readSnapshot: async () => structuredClone(snapshot),
    writeSnapshot: async value => {
      if (failWrite) { failWrite = false; throw new Error("Synthetic persistence failure"); }
      snapshot = structuredClone(value);
    }
  });
  const server = http.createServer(async (req, res) => {
    if (!(await auth.handle(req, res, new URL(req.url, "http://localhost").pathname))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, method = "GET", body, cookie = "", extraHeaders = {}) {
    const response = await fetch(base + route, {
      method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  }
  let ip = 1;
  async function code(phone, purpose) {
    const result = await request("/api/auth/sms-code", "POST", { phone, purpose }, "", { "X-Forwarded-For": "203.0.113." + ip++ });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const message = deliveries.findLast(delivery => delivery.phone === phone && delivery.purpose === purpose);
    assert.ok(message);
    assert.equal(Object.prototype.hasOwnProperty.call(result.data, "code"), false);
    return { smsChallengeId: result.data.challengeId, smsCode: message.code };
  }
  async function register(phone, extra = {}) {
    const verification = await code(phone, "register");
    const result = await request("/api/auth/register", "POST", { phone, password, employee: { name: "测试人员", phone }, ...verification, ...extra });
    return { ...result, verification };
  }
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(parent));
    assert.match(path.basename(target), /^\.hr-sms-auth-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { request, code, register, deliveries, directory, advance(ms) { time += ms; }, failNextWrite() { failWrite = true; }, get snapshot() { return snapshot; } };
}

test("验证码启用后注册必须持有对应手机号的有效验证码，且仍校验人员表单与密码", async t => {
  const f = await fixture(t);
  const phone = "13800000301";
  const body = { phone, password, employee: { name: "测试人员", phone } };
  const missing = await f.request("/api/auth/register", "POST", body);
  assert.notEqual(missing.status, 201);
  assert.equal(f.snapshot.employees.length, 0);
  const verification = await f.code(phone, "register");
  const wrongCode = { ...verification, smsCode: verification.smsCode === "000000" ? "999999" : "000000" };
  assert.notEqual((await f.request("/api/auth/register", "POST", { ...body, ...wrongCode })).status, 201);
  assert.notEqual((await f.request("/api/auth/register", "POST", { ...body, ...verification, phone: "13800000302", employee: { name: "另一个号码" } })).status, 201);
  assert.equal((await f.request("/api/auth/register", "POST", { ...body, ...verification, password: "short" })).status, 400);
  const result = await f.request("/api/auth/register", "POST", { ...body, ...verification, role: "admin" });
  assert.equal(result.status, 201);
  assert.equal(result.data.user.role, "user");
  assert.equal(f.snapshot.employees.length, 1);
  const accounts = fs.readFileSync(path.join(f.directory, "auth-users.json"), "utf8");
  assert.doesNotMatch(accounts, /"(?:smsCode|smsChallengeId)"\s*:/);
});

test("手机号登录必须同时验证密码与登录验证码，成功后验证码不能重复使用", async t => {
  const f = await fixture(t), phone = "13800000303";
  assert.equal((await f.register(phone)).status, 201);
  assert.notEqual((await f.request("/api/auth/login", "POST", { username: phone, password })).status, 200);
  f.advance(61000);
  const verification = await f.code(phone, "login");
  const wrongPassword = await f.request("/api/auth/login", "POST", { username: phone, password: "wrong-password", ...verification });
  assert.equal(wrongPassword.status, 401);
  const success = await f.request("/api/auth/login", "POST", { username: phone, password, ...verification });
  assert.equal(success.status, 200);
  assert.match(success.cookie, /^hr_session=/);
  assert.notEqual((await f.request("/api/auth/login", "POST", { username: phone, password, ...verification })).status, 200);
});

test("注册验证码不能用于登录，过期验证码被拒绝", async t => {
  const f = await fixture(t), phone = "13800000304";
  assert.equal((await f.register(phone)).status, 201);
  f.advance(61000);
  const registrationCode = await f.code(phone, "register");
  assert.notEqual((await f.request("/api/auth/login", "POST", { username: phone, password, ...registrationCode })).status, 200);
  f.advance(61000);
  const loginCode = await f.code(phone, "login");
  f.advance(301000);
  assert.notEqual((await f.request("/api/auth/login", "POST", { username: phone, password, ...loginCode })).status, 200);
});

test("短信未配置时手机号入口明确拒绝，管理员管理账号仍可登录", async t => {
  const f = await fixture(t, { configured: false });
  const status = (await f.request("/api/auth/status")).data;
  assert.equal(status.smsVerificationRequired, true);
  assert.equal(status.smsConfigured, false);
  assert.equal((await f.request("/api/auth/sms-code", "POST", { phone: "13800000305", purpose: "register" })).status, 503);
  assert.equal((await f.request("/api/auth/register", "POST", { phone: "13800000305", password, employee: { name: "测试人员" }, smsCode: "123456" })).status, 503);
  const setup = await f.request("/api/auth/setup", "POST", { password });
  assert.equal(setup.status, 201);
  const admin = await f.request("/api/auth/login", "POST", { username: "admin", password });
  assert.equal(admin.status, 200);
  assert.equal(f.deliveries.length, 0);
});

test("旧用户名别名不能绕过短信，正确绑定手机号登录保留楼长权限", async t => {
  const f = await fixture(t);
  const setup = await f.request("/api/auth/setup", "POST", { password });
  const phone = "13800000306";
  await f.request("/api/auth/users", "POST", { username: "leaderAlias", name: "测试楼长", password, phone, role: "leader", buildings: ["测试楼栋"] }, setup.cookie);
  assert.equal((await f.request("/api/auth/login", "POST", { username: "leaderAlias", password })).status, 400);
  const verification = await f.code(phone, "login");
  const result = await f.request("/api/auth/login", "POST", { username: phone, password, ...verification });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.role, "leader");
  assert.deepEqual(result.data.user.buildings, ["测试楼栋"]);
});

test("并发重复使用验证码只建立一次登录会话", async t => {
  const f = await fixture(t), phone = "13800000307";
  assert.equal((await f.register(phone)).status, 201);
  f.advance(61000);
  const verification = await f.code(phone, "login");
  const body = { username: phone, password, ...verification };
  const results = await Promise.all([f.request("/api/auth/login", "POST", body), f.request("/api/auth/login", "POST", body)]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
});

test("业务保存失败不会消耗有效注册验证码，重试不会创建重复人员", async t => {
  const f = await fixture(t), phone = "13800000308";
  const verification = await f.code(phone, "register");
  const body = { phone, password, employee: { name: "测试人员" }, ...verification };
  f.failNextWrite();
  assert.equal((await f.request("/api/auth/register", "POST", body)).status, 500);
  assert.equal(f.snapshot.employees.length, 0);
  assert.equal((await f.request("/api/auth/register", "POST", body)).status, 201);
  assert.equal(f.snapshot.employees.length, 1);
});

test("短信开关未启用时兼容现有密码流程，发送接口不会伪装成功", async t => {
  const f = await fixture(t, { enabled: false, configured: false }), phone = "13800000309";
  assert.equal((await f.request("/api/auth/status")).data.smsVerificationRequired, false);
  assert.equal((await f.request("/api/auth/sms-code", "POST", { phone, purpose: "register" })).status, 503);
  assert.equal((await f.request("/api/auth/register", "POST", { phone, password, employee: { name: "测试人员" } })).status, 201);
  assert.equal((await f.request("/api/auth/login", "POST", { username: phone, password })).status, 200);
  assert.equal(f.deliveries.length, 0);
});
