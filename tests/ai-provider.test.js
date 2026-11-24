"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { AIError, createAIProvider, createPrivateSettingsStore, publicJSONRequest, endpointURL, publicAddress } = require(process.env.HR_AI_PROVIDER_MODULE || "../server/ai-provider");
const syntheticKey = "synthetic-ai-key-not-valid";
function fixture(options = {}) {
  let saved = options.settings || {};
  const calls = [];
  const provider = createAIProvider({ getSettings: () => saved, saveSettings: next => { saved = next; }, env: options.env || {}, transport: options.transport || (async value => { calls.push(value); return { choices: [{ message: { content: "合成解读" } }] }; }) });
  return { provider, calls, saved: () => saved };
}
test("AI settings mask keys, preserve blank keys, clear explicitly and honor service environment", () => {
  const f = fixture({ settings: { enabled: true, apiKey: syntheticKey } });
  assert.equal(f.provider.status().configured, true); assert.doesNotMatch(JSON.stringify(f.provider.status()), /synthetic-ai-key/);
  f.provider.save({ model: "example-model", apiKey: "" }); assert.equal(f.saved().apiKey, syntheticKey);
  f.provider.save({ clearApiKey: true }); assert.equal(f.saved().enabled, false); assert.equal(f.saved().apiKey, "");
  const e = fixture({ env: { HR_AI_ENABLED: "true", HR_AI_API_KEY: syntheticKey, HR_AI_MODEL: "service-model" } });
  e.provider.save({ enabled: true, model: "disk-model" });
  assert.equal(e.provider.status().model, "service-model"); assert.equal(e.provider.status().envOverrides.apiKey, true); assert.equal(e.saved().apiKey, "");
});
test("AI disabled and invalid configurations cannot cause requests or fake configured status", async () => {
  const f = fixture(); assert.equal(f.provider.status().configured, false);
  await assert.rejects(f.provider.chat([{ role: "user", content: "hello" }]), { status: 503 }); assert.equal(f.calls.length, 0);
  assert.throws(() => f.provider.save({ enabled: true }), /密钥/);
  for (const body of [{ enabled: "true" }, { extra: true }, { apiKey: "bad\nkey" }, { endpoint: "http://example.com/chat" }, { clearApiKey: "yes" }]) assert.throws(() => f.provider.save(body));
  assert.equal(fixture({ env: { HR_AI_ENABLED: "wrong" } }).provider.status().configured, false);
});
test("provider accepts only bounded messages and fixed server model/parameters, redacts secrets", async () => {
  let request;
  const f = fixture({ settings: { enabled: true, apiKey: syntheticKey, model: "server-model" }, transport: async value => { request = value; return { choices: [{ message: { content: "不要展示" + syntheticKey } }] }; } });
  const result = await f.provider.chat([{ role: "user", content: "合成测试", tool_calls: "ignored" }], { model: "forged", maxTokens: 99999 });
  assert.equal(request.payload.model, "server-model"); assert.equal(request.payload.stream, false); assert.equal(request.payload.max_tokens, 4096);
  assert.deepEqual(request.payload.messages, [{ role: "user", content: "合成测试" }]); assert.doesNotMatch(result.text, /synthetic-ai-key/);
  for (const messages of [[], [{ role: "tool", content: "x" }], [{ role: "user", content: [] }], [{ role: "user", content: "x".repeat(160001) }]]) await assert.rejects(f.provider.chat(messages));
});
test("provider errors and malformed upstream output never expose raw bodies or credentials", async () => {
  const f = fixture({ settings: { enabled: true, apiKey: syntheticKey }, transport: async () => { throw new Error(syntheticKey); } });
  await assert.rejects(f.provider.chat([{ role: "user", content: "x" }]), error => error.status === 502 && !error.message.includes(syntheticKey));
  const malformed = fixture({ settings: { enabled: true, apiKey: syntheticKey }, transport: async () => ({ choices: [] }) });
  await assert.rejects(malformed.provider.chat([{ role: "user", content: "x" }]), { status: 502 });
});
test("private AI settings remain separate from protected source config and persist as private files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-ai-settings-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "runtime", "ai-settings.json");
  const store = createPrivateSettingsStore({ file, base: { model: "legacy", apiKey: "legacy-synthetic" } });
  store.set({ enabled: true, apiKey: syntheticKey });
  const restored = createPrivateSettingsStore({ file, base: { model: "legacy" } }); assert.equal(restored.get().apiKey, syntheticKey); assert.equal(restored.get().model, "legacy");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  fs.writeFileSync(file, "invalid"); assert.throws(() => createPrivateSettingsStore({ file }), /无法读取/);
});
test("endpoint validation refuses private addresses, URL credentials, non-HTTPS and redirects to other networks", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001::1", "2001:db8::1", "2002:7f00:1::"]) assert.equal(publicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true, address);
  for (const endpoint of ["http://example.com/chat", "https://localhost/chat", "https://127.0.0.1/chat", "https://169.254.169.254/latest", "https://example.com:8443/chat", "https://user:key@example.com/chat", "https://example.com/chat?token=bad", "https://example.com/#secret"]) assert.throws(() => endpointURL(endpoint));
  assert.equal(endpointURL("https://api.deepseek.com/chat/completions").hostname, "api.deepseek.com");
});
function network(status = 200, content = '{"choices":[{"message":{"content":"OK"}}]}', neverEnd = false) {
  const calls = [];
  function request(url, options, callback) {
    calls.push({ url, options });
    const req = new EventEmitter(); req.destroy = () => {}; req.end = bytes => {
      calls[0].bytes = bytes;
      if (neverEnd) return;
      queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = status; res.destroy = () => {}; callback(res); res.emit("data", Buffer.from(content)); res.emit("end"); });
    };
    return req;
  }
  return { calls, request, lookup: async () => [{ address: "8.8.8.8", family: 4 }] };
}
test("checked DNS address is pinned to TLS connection and mixed private answers fail before any send", async () => {
  const n = network();
  await publicJSONRequest({ endpoint: "https://provider.example/chat", apiKey: syntheticKey, payload: {} }, n);
  n.calls[0].options.lookup("provider.example", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
  n.calls[0].options.lookup("provider.example", { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]); });
  const bad = network(); bad.lookup = async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
  await assert.rejects(publicJSONRequest({ endpoint: "https://provider.example/chat", apiKey: syntheticKey, payload: {} }, bad), { status: 400 }); assert.equal(bad.calls.length, 0);
});
test("network redirects, errors, excessive responses, DNS hangs and request hangs are bounded", async () => {
  for (const [status, content] of [[302, "redirect"], [401, syntheticKey], [429, syntheticKey], [500, syntheticKey], [200, "bad JSON"], [200, "x".repeat(1024 * 1024 + 1)]]) {
    await assert.rejects(publicJSONRequest({ endpoint: "https://provider.example/chat", apiKey: syntheticKey, payload: {} }, network(status, content)), error => error instanceof AIError && !error.message.includes(syntheticKey));
  }
  const stuck = network(200, "", true);
  await assert.rejects(publicJSONRequest({ endpoint: "https://provider.example/chat", apiKey: syntheticKey, payload: {}, timeoutMs: 15 }, stuck), { status: 504 });
  stuck.lookup = () => new Promise(() => {});
  await assert.rejects(publicJSONRequest({ endpoint: "https://provider.example/chat", apiKey: syntheticKey, payload: {}, timeoutMs: 15 }, stuck), { status: 502 });
});
