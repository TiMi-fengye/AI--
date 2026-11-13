"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createAliyunSmsSender, signAliyunRequest, SmsProviderError } = require("../server/sms-aliyun");

// Synthetic credentials and phone only. fetch is always injected, never network.
const config = {
  enabled: true, provider: "aliyun", accessKeyId: "testAccessKeyId",
  accessKeySecret: "test-access-key-secret", signName: "测试签名 & (甲)*!",
  templateCode: "SMS_123456", templateParamKey: "code"
};
const input = { phone: "13800000001", code: "095271", purpose: "register" };
const clock = () => Date.parse("2026-11-12T03:04:05.123Z");
const fixedNonce = () => "synthetic-unique-nonce";

function fixture(overrides = {}, options = {}, reply = { Code: "OK", Message: "OK" }) {
  const requests = [];
  const sender = createAliyunSmsSender({ ...config, ...overrides }, {
    now: clock, nonce: fixedNonce,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(reply), { status: 200 }); },
    ...options
  });
  return { sender, requests };
}

test("ACS3签名通过官方固定参数向量，不依赖实际短信服务", () => {
  // Official vector: the shared V3 signing documentation, fixed-parameter example.
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const actual = signAliyunRequest({
    accessKeyId: "YourAccessKeyId", accessKeySecret: "YourAccessKeySecret",
    headers: {
      host: "ecs.cn-shanghai.aliyuncs.com", "x-acs-action": "RunInstances",
      "x-acs-content-sha256": emptyHash, "x-acs-date": "2023-10-26T10:22:32Z",
      "x-acs-signature-nonce": "3156853299f313e23d1673dc12e1703d", "x-acs-version": "2014-05-26"
    },
    query: { RegionId: "cn-shanghai", ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd" }
  });
  assert.equal(actual.authorization, "ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0");
  assert.equal(actual.canonicalQuery, "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai");
});

test("短信未启用、配置不完整或任意目标地址不会创建发送器", () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Must not call"); };
  const invalid = [undefined, {}, { ...config, enabled: false }, { ...config, enabled: "true" },
    { ...config, provider: "unknown" }, { ...config, accessKeyId: "" }, { ...config, accessKeySecret: "" },
    { ...config, signName: "" }, { ...config, templateCode: "" },
    { ...config, endpoint: "https://example.com" }, { ...config, endpoint: "http://dysmsapi.aliyuncs.com" },
    { ...config, securityToken: "bad\r\nheader" }, { ...config, templateParamKey: "__proto__" }];
  for (const value of invalid) assert.equal(createAliyunSmsSender(value, { fetchImpl }), null);
  assert.equal(calls, 0);
});

test("固定HTTPS单号POST及RFC3986编码，签名覆盖必需头且不把密钥放入URL", async () => {
  const f = fixture();
  assert.deepEqual(await f.sender(input), { ok: true });
  assert.equal(f.requests.length, 1);
  const { url, init } = f.requests[0], parsed = new URL(url);
  assert.equal(parsed.origin, "https://dysmsapi.aliyuncs.com");
  assert.equal(parsed.pathname, "/");
  assert.equal(parsed.searchParams.get("PhoneNumbers"), input.phone);
  assert.equal(parsed.searchParams.get("SignName"), config.signName);
  assert.equal(parsed.searchParams.get("TemplateCode"), config.templateCode);
  assert.deepEqual(JSON.parse(parsed.searchParams.get("TemplateParam")), { code: input.code });
  assert.match(url, /%20%26%20%28/);
  assert.match(url, /%29%2A%21/);
  assert.doesNotMatch(url, /testAccessKeyId|test-access-key-secret/);
  assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
  assert.equal(init.body, undefined); assert.equal(init.headers["content-type"], undefined);
  assert.equal(init.headers["x-acs-action"], "SendSms");
  assert.equal(init.headers["x-acs-version"], "2017-05-25");
  assert.equal(init.headers["x-acs-date"], "2026-11-12T03:04:05Z");
  assert.equal(init.headers["x-acs-signature-nonce"], fixedNonce());
  assert.ok(init.signal instanceof AbortSignal);
  assert.match(init.headers.authorization, /^ACS3-HMAC-SHA256 Credential=testAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[a-f0-9]{64}$/);
});

test("可选STS令牌参与签名，模板变量名来自配置", async () => {
  const f = fixture({ securityToken: "synthetic-token+/=", templateParamKey: "otp" });
  await f.sender({ ...input, purpose: "login" });
  const { url, init } = f.requests[0];
  assert.deepEqual(JSON.parse(new URL(url).searchParams.get("TemplateParam")), { otp: input.code });
  assert.equal(init.headers["x-acs-security-token"], "synthetic-token+/=");
  assert.match(init.headers.authorization, /;x-acs-security-token;x-acs-signature-nonce;/);
  const { authorization, accept, ...headers } = init.headers;
  const names = Object.keys(headers).sort();
  const canonical = ["POST", "/", new URL(url).search.slice(1), names.map(key => key + ":" + headers[key] + "\n").join(""), names.join(";"), headers["x-acs-content-sha256"]].join("\n");
  const toSign = "ACS3-HMAC-SHA256\n" + crypto.createHash("sha256").update(canonical).digest("hex");
  const signature = crypto.createHmac("sha256", config.accessKeySecret).update(toSign).digest("hex");
  assert.ok(authorization.endsWith("Signature=" + signature));
  assert.doesNotMatch(url, /synthetic-token/);
});

test("默认每次签名使用新nonce，成功结果不转发上游ID或消息", async () => {
  const f = fixture({}, { nonce: undefined }, { Code: "OK", Message: "upstream-private", RequestId: "private-request-id", BizId: "private-biz-id" });
  assert.deepEqual(await f.sender(input), { ok: true });
  assert.deepEqual(await f.sender(input), { ok: true });
  assert.notEqual(f.requests[0].init.headers["x-acs-signature-nonce"], f.requests[1].init.headers["x-acs-signature-nonce"]);
});

test("不接受群发号码、非六位验证码或非注册登录用途", async () => {
  const f = fixture();
  for (const bad of [{ phone: "13800000001,13800000002" }, { phone: "+8613800000001" }, { code: "12345" }, { code: 123456 }, { purpose: "reset-password" }]) {
    await assert.rejects(f.sender({ ...input, ...bad }), error => error instanceof SmsProviderError && error.status === 400 && error.message === "短信发送参数无效");
  }
  assert.equal(f.requests.length, 0);
});

test("HTTP失败、无效JSON及厂商失败均为安全错误且不自动重试", async () => {
  const leak = [input.phone, input.code, config.accessKeyId, config.accessKeySecret, "PRIVATE-UPSTREAM-MESSAGE"].join(" ");
  const replies = [
    () => new Response(leak, { status: 400 }),
    () => new Response("not-json " + leak, { status: 200 }),
    () => new Response(JSON.stringify({ Code: "SignatureDoesNotMatch", Message: leak, RequestId: leak }), { status: 200 }),
    () => new Response(JSON.stringify({ Code: "ok" }), { status: 200 }),
    () => new Response(JSON.stringify([{ Code: "OK" }]), { status: 200 }),
    () => new Response(JSON.stringify({ Code: "OK", Message: "x".repeat(66000) }), { status: 200 }),
    () => { throw new Error(leak); }
  ];
  for (const reply of replies) {
    let attempts = 0;
    const sender = createAliyunSmsSender(config, { fetchImpl: async () => { attempts++; return reply(); } });
    await assert.rejects(sender(input), error => {
      assert.equal(error.status, 502); assert.equal(error.message, "短信发送暂不可用，请稍后重试或联系管理员");
      assert.equal(error.cause, undefined);
      for (const value of [input.phone, input.code, config.accessKeyId, config.accessKeySecret, "PRIVATE-UPSTREAM-MESSAGE"]) assert.ok(!String(error.stack).includes(value));
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test("总超时会终止请求且不重试，连读取响应卡住也受期限约束", async () => {
  for (const stuckBody of [false, true]) {
    let attempts = 0, signal;
    const sender = createAliyunSmsSender(config, { timeoutMs: 20, fetchImpl: async (_, init) => {
      attempts++; signal = init.signal;
      if (stuckBody) return { ok: true, text: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    await assert.rejects(sender(input), error => error.status === 502 && error.message === "短信发送暂不可用，请稍后重试或联系管理员");
    assert.equal(signal.aborted, true); assert.equal(attempts, 1);
  }
});

test("损坏时间或nonce不发请求且错误不包含内部签名输入", async () => {
  for (const override of [{ now: () => NaN }, { nonce: () => "bad\r\nnonce" }, { nonce: () => "contains spaces" }]) {
    const f = fixture({}, override);
    await assert.rejects(f.sender(input), error => error.status === 502 && !error.message.includes("Invalid signing"));
    assert.equal(f.requests.length, 0);
  }
});
