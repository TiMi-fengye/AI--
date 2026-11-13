"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSmsVerification } = require("../server/sms-verification");

const phone = "13800000001", ip = "203.0.113.1";
function fixture(t, overrides = {}) {
  // Keep test paths in the workspace so Windows sandbox ancestors are readable.
  const parent = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(parent, ".sms-engine-test-"));
  let time = Date.UTC(2026, 10, 12, 1);
  const sent = [];
  const sender = async value => { sent.push(value); };
  const options = { dataDir: directory, enabled: true, sendCode: sender, now: () => time, random: () => 12345, ...overrides };
  const service = createSmsVerification(options);
  t.after(() => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), parent);
    assert.match(path.basename(target), /^\.sms-engine-test-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  return {
    service, directory, sent, options,
    file: path.join(directory, "sms-rate-limits.json"),
    advance(amount) { time += amount; },
    setTime(value) { time = value; },
    async request(purpose = "register", extra = {}) { return service.requestCode({ phone, purpose, ip, ...extra }); },
    verification(challenge, code = "012345", extra = {}) { return { phone, purpose: "register", challengeId: challenge.challengeId, code, ...extra }; }
  };
}
function status(expected) { return error => error.status === expected; }

test("短信关闭或未配置时拒绝发送与验证，不创建假验证码", async t => {
  for (const override of [{ enabled: false }, { sendCode: undefined }]) {
    const f = fixture(t, override);
    assert.equal(f.service.required, override.enabled !== false);
    assert.equal(f.service.configured, override.sendCode !== undefined || override.enabled === false);
    await assert.rejects(f.request(), status(503));
    assert.throws(() => f.service.verify({ phone, purpose: "register", code: "123456" }), status(503));
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(f.sent.length, 0);
  }
});

test("生成随机六位码与随机挑战ID，只给发送器明文，API和磁盘不包含验证码及原号码IP", async t => {
  const f = fixture(t);
  const challenge = await f.request();
  assert.deepEqual(Object.keys(challenge).sort(), ["challengeId", "expiresIn", "retryAfter"]);
  assert.match(challenge.challengeId, /^[a-f0-9]{64}$/);
  assert.equal(challenge.expiresIn, 300); assert.equal(challenge.retryAfter, 60);
  assert.deepEqual(f.sent, [{ phone, purpose: "register", code: "012345" }]);
  const saved = fs.readFileSync(f.file, "utf8");
  for (const value of [phone, ip, "012345", challenge.challengeId]) assert.ok(!saved.includes(value));
  assert.equal(JSON.parse(saved).total, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  f.advance(60000);
  const another = await f.request();
  assert.notEqual(another.challengeId, challenge.challengeId);
});

test("验证码绑定号码、用途与挑战ID，伪造和缺失输入不能通过", async t => {
  const f = fixture(t), challenge = await f.request();
  for (const fields of [
    { phone: "13800000002" }, { purpose: "login" }, { challengeId: "0".repeat(64) }, { challengeId: undefined }, { code: undefined }
  ]) assert.throws(() => f.service.verify(f.verification(challenge, "012345", fields)), status(400));
  assert.ok(f.service.verify(f.verification(challenge)));
  await assert.rejects(f.request("reset"), status(400));
  await assert.rejects(f.request("register", { phone: "123", ip }), status(400));
  await assert.rejects(f.request("register", { ip: "forged-header" }), status(400));
});

test("五次错误后作废；正确验证码在业务失败未消费时仍可重试", async t => {
  const f = fixture(t), challenge = await f.request();
  for (let index = 0; index < 4; index++) assert.throws(() => f.service.verify(f.verification(challenge, "999999")), status(400));
  assert.ok(f.service.verify(f.verification(challenge)));
  assert.ok(f.service.verify(f.verification(challenge)));
  assert.throws(() => f.service.verify(f.verification(challenge, "bad")), status(400));
  assert.throws(() => f.service.verify(f.verification(challenge)), status(400));
});

test("验证码五分钟过期且发送中的挑战不可验证", async t => {
  let complete;
  const f = fixture(t, { sendCode: () => new Promise(resolve => { complete = resolve; }) });
  const pending = f.request();
  // IDs are returned only after delivery succeeds; even a guessed ID cannot work.
  assert.throws(() => f.service.verify({ phone, purpose: "register", challengeId: "a".repeat(64), code: "012345" }), status(400));
  complete();
  const challenge = await pending;
  f.advance(299999);
  assert.ok(f.service.verify(f.verification(challenge)));
  f.advance(1);
  assert.throws(() => f.service.verify(f.verification(challenge)), status(400));
});

test("消费票据不可伪造且一次性使用；重复消费和重发后的旧票据安全no-op", async t => {
  const f = fixture(t), challenge = await f.request();
  f.service.consume({}); f.service.consume(null); f.service.consume("forged");
  const ticket = f.service.verify(f.verification(challenge));
  assert.equal(JSON.stringify(ticket), "{}");
  f.service.consume(ticket); f.service.consume(ticket);
  assert.throws(() => f.service.verify(f.verification(challenge)), status(400));
  f.advance(60000);
  const second = await f.request(), oldTicket = f.service.verify(f.verification(second));
  f.advance(60000);
  const third = await f.request();
  f.service.consume(oldTicket);
  assert.ok(f.service.verify(f.verification(third)));
});

test("同手机号跨用途60秒冷却，异步发送并发和服务重启均不能绕过", async t => {
  let complete;
  const f = fixture(t, { sendCode: () => new Promise(resolve => { complete = resolve; }) });
  const pending = f.request();
  await assert.rejects(f.request("login"), error => error.status === 429 && error.retryAfter === 60);
  const restarted = createSmsVerification({ ...f.options, sendCode: async () => {} });
  await assert.rejects(restarted.requestCode({ phone, purpose: "login", ip }), status(429));
  complete(); const challenge = await pending;
  assert.throws(() => restarted.verify(f.verification(challenge)), status(400));
  f.advance(60000);
  assert.ok(await restarted.requestCode({ phone, purpose: "login", ip }));
});

test("发送失败隐藏厂商细节且保留冷却和计数，不能通过重试刷短信", async t => {
  const f = fixture(t, { sendCode: async () => { throw new Error("secret-code=012345;vendor-request=secret"); } });
  await assert.rejects(f.request(), error => error.status === 503 && error.retryAfter === 60 && !/012345|vendor|secret/.test(error.message));
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).total, 1);
  await assert.rejects(f.request(), status(429));
});

test("发送超时按剩余冷却倒计时，不重置为完整60秒", async t => {
  let reject;
  const f = fixture(t, { sendCode: () => new Promise((_, fail) => { reject = fail; }) });
  const pending = f.request();
  f.advance(15000);
  reject(new Error("provider timeout"));
  await assert.rejects(pending, error => error.status === 503 && error.retryAfter === 45);
  await assert.rejects(f.request(), error => error.status === 429 && error.retryAfter === 45);
});

test("重新发送使相同用途的旧挑战失效；晚返回的旧发送不能覆盖新挑战", async t => {
  const completes = [];
  const f = fixture(t, { sendCode: () => new Promise(resolve => completes.push(resolve)) });
  const first = f.request();
  const oldFailure = assert.rejects(first, status(503));
  f.advance(60000);
  const second = f.request();
  completes[1](); const challenge = await second;
  completes[0](); await oldFailure;
  assert.ok(f.service.verify(f.verification(challenge)));
});

test("IP十分钟限额与手机每日限额持久化生效", async t => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) await f.request("register", { phone: "13800000" + String(100 + index) });
  await assert.rejects(f.request("register", { phone: "13800000105" }), error => error.status === 429 && error.retryAfter === 600);
  f.advance(600000);
  assert.ok(await f.request("register", { phone: "13800000105" }));
  const g = fixture(t);
  for (let index = 0; index < 10; index++) {
    await g.request("register", { ip: "203.0.113." + (index + 1) });
    g.advance(60000);
  }
  await assert.rejects(g.request("login", { ip: "203.0.113.20" }), status(429));
  const restarted = createSmsVerification(g.options);
  await assert.rejects(restarted.requestCode({ phone, purpose: "login", ip: "203.0.113.21" }), status(429));
});

test("全局与IP每日限额拒绝发送；午夜日限额重置但冷却仍保留", async t => {
  const f = fixture(t);
  await f.request();
  const state = JSON.parse(fs.readFileSync(f.file, "utf8"));
  const addressKey = Object.keys(state.ips)[0];
  state.ips[addressKey].count = 50;
  fs.writeFileSync(f.file, JSON.stringify(state));
  await assert.rejects(f.request("register", { phone: "13800000002" }), error => error.status === 429 && error.retryAfter > 0 && error.retryAfter <= 86400);
  state.ips[addressKey].count = 1; state.total = 200;
  fs.writeFileSync(f.file, JSON.stringify(state));
  await assert.rejects(f.request("register", { phone: "13800000002", ip: "203.0.113.2" }), status(429));
  const g = fixture(t);
  g.setTime(Date.UTC(2026, 10, 12, 15, 59, 50));
  await g.request();
  g.advance(20000);
  await assert.rejects(g.request("login"), error => error.status === 429 && error.retryAfter === 40);
  g.advance(40000);
  await g.request("login");
  assert.equal(JSON.parse(fs.readFileSync(g.file, "utf8")).total, 1);
});

test("损坏限额文件和保存失败时不发送短信且不覆盖已有文件", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "{broken");
  await assert.rejects(f.request(), status(503));
  assert.equal(fs.readFileSync(f.file, "utf8"), "{broken");
  assert.equal(f.sent.length, 0);
  fs.unlinkSync(f.file); fs.mkdirSync(f.file);
  await assert.rejects(f.request(), status(503));
  assert.equal(f.sent.length, 0);
});

test("不安全随机数注入被拒绝，真实默认生成器提供六位数字", async t => {
  const f = fixture(t, { random: () => -1 });
  await assert.rejects(f.request(), status(503));
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(f.file), false);
  const g = fixture(t, { random: undefined });
  await g.request();
  assert.match(g.sent[0].code, /^\d{6}$/);
});
