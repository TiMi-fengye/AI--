"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");

class AIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AIError(status, message); };
const DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-flash";

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Accept global unicast only. Mapped, loopback, link-local, ULA and the
  // documentation/special 2001::/23 range are deliberately excluded.
  if (net.isIP(address) === 6) {
    const parts = address.split(":"), first = parseInt(parts[0], 16), second = parseInt(parts[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}
function endpointURL(value) {
  if (typeof value !== "string" || value.length > 1000) fail(400, "AI接口地址无效");
  let url; try { url = new URL(value.trim()); } catch { fail(400, "AI接口地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || (url.port && url.port !== "443")) fail(400, "AI接口须使用不含凭据和查询参数的公网HTTPS地址");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !net.isIP(host)) fail(400, "AI接口须使用公网域名");
  if (/\.(?:localhost|local|internal)$/i.test(host) || (net.isIP(host) && !publicAddress(host))) fail(400, "AI接口不能指向本机或私有网络");
  return url;
}

async function publicJSONRequest({ endpoint, apiKey, payload, timeoutMs = 45000 }, { lookup = dns.lookup, request = https.request } = {}) {
  const url = endpointURL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  let dnsTimer;
  try { addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS timeout")), Math.min(timeoutMs, 10000)); })
  ]); }
  catch { fail(502, "AI接口域名解析失败，请检查服务器网络"); }
  finally { clearTimeout(dnsTimer); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(row => !publicAddress(row.address))) fail(400, "AI接口解析到了非公网地址，已拒绝连接");
  // Pin the checked address to the actual TLS connection; no redirect or
  // second DNS lookup may send the server-side bearer key somewhere else.
  const chosen = addresses[0];
  const bytes = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const req = request(url, {
      method: "POST", agent: false,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "Content-Length": bytes.length },
      lookup: (_host, options, callback) => options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)
    }, res => {
      let size = 0; const chunks = [];
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { finish(new AIError(502, "AI响应过大，请缩小报表范围")); res.destroy(); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on("error", () => finish(new AIError(502, "AI响应读取失败，请稍后重试")));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = [401, 403].includes(res.statusCode) ? "AI服务拒绝认证，请管理员检查密钥和模型权限" : res.statusCode === 429 ? "AI服务额度不足或请求过快，请稍后重试" : "AI服务未成功响应，请检查接口、模型及服务器网络";
          finish(new AIError(502, message)); return;
        }
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new AIError(502, "AI服务响应格式不兼容")); }
      });
    });
    timer = setTimeout(() => { finish(new AIError(504, "AI服务响应超时，统计数据仍可使用")); req.destroy(); }, timeoutMs);
    req.on("error", () => finish(new AIError(502, "AI服务连接失败，请检查服务器网络")));
    req.end(bytes);
  });
}

function createPrivateSettingsStore({ file, base = {} }) {
  let saved = null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error();
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error();
  } catch (error) { if (error.code !== "ENOENT") throw new Error("AI私有配置无法读取，请检查权限及备份"); }
  return {
    get: () => ({ ...base, ...(saved || {}) }),
    set: next => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
      let fd;
      try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(next, null, 2) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
        fs.renameSync(temporary, file); saved = { ...next };
      } finally { if (fd !== undefined && fd !== null) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
    }
  };
}

function createAIProvider({ getSettings, saveSettings, env = process.env, transport = publicJSONRequest }) {
  const envKeys = { enabled: "HR_AI_ENABLED", endpoint: "HR_AI_ENDPOINT", model: "HR_AI_MODEL", apiKey: "HR_AI_API_KEY" };
  function effective() {
    const saved = getSettings() || {}, settings = { ...saved };
    for (const [key, name] of Object.entries(envKeys)) if (env[name] !== undefined && env[name] !== "") settings[key] = env[name];
    if (typeof settings.enabled === "string") {
      if (!/^(?:true|false)$/i.test(settings.enabled)) fail(503, "AI启用开关配置无效");
      settings.enabled = settings.enabled.toLowerCase() === "true";
    }
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") fail(503, "AI启用开关配置无效");
    settings.endpoint = settings.endpoint || DEFAULT_ENDPOINT;
    settings.model = settings.model || DEFAULT_MODEL;
    settings.apiKey = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
    settings.enabled = settings.enabled === undefined ? !!settings.apiKey : settings.enabled;
    return settings;
  }
  function validate(settings) {
    endpointURL(settings.endpoint);
    if (typeof settings.model !== "string" || !/^[\w.:/\-]{1,120}$/.test(settings.model)) fail(400, "AI模型名称无效");
    if (typeof settings.apiKey !== "string" || settings.apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(settings.apiKey)) fail(400, "AI密钥格式无效");
    if (settings.enabled && !settings.apiKey) fail(400, "启用AI前请填写服务端密钥");
  }
  function status() {
    const envOverrides = Object.fromEntries(Object.entries(envKeys).map(([key, name]) => [key, env[name] !== undefined && env[name] !== ""]));
    let settings;
    try { settings = effective(); }
    catch { return { enabled: false, configured: false, endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, apiKeyConfigured: false, envOverrides, envOverride: Object.values(envOverrides).some(Boolean), configurationError: "AI配置无效，请管理员核对启用开关" }; }
    let valid = true; try { validate({ ...settings, enabled: false }); } catch { valid = false; }
    return { enabled: settings.enabled, endpoint: settings.endpoint, model: settings.model,
      apiKeyConfigured: !!settings.apiKey, configured: !!(valid && settings.enabled && settings.apiKey),
      envOverrides, envOverride: Object.values(envOverrides).some(Boolean) };
  }
  function save(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "AI设置格式无效");
    const allowed = new Set(["enabled", "endpoint", "model", "apiKey", "clearApiKey"]);
    if (Object.keys(body).some(key => !allowed.has(key))) fail(400, "AI设置包含不支持的字段");
    if (body.clearApiKey !== undefined && typeof body.clearApiKey !== "boolean") fail(400, "清除密钥选项无效");
    const current = getSettings() || {};
    const next = { enabled: current.enabled ?? false, endpoint: current.endpoint || DEFAULT_ENDPOINT, model: current.model || DEFAULT_MODEL, apiKey: current.apiKey || "" };
    for (const key of ["enabled", "endpoint", "model"]) if (body[key] !== undefined) next[key] = typeof body[key] === "string" ? body[key].trim() : body[key];
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") fail(400, "AI密钥格式无效");
    if (body.apiKey?.trim()) next.apiKey = body.apiKey.trim();
    if (body.clearApiKey) { next.apiKey = ""; next.enabled = false; }
    if (typeof next.enabled !== "boolean") fail(400, "AI启用选项无效");
    // A service-managed environment key may be used without copying it to disk.
    const effectiveKey = env.HR_AI_API_KEY || next.apiKey;
    validate({ ...next, apiKey: effectiveKey, enabled: next.enabled });
    try { saveSettings(next); } catch { fail(500, "AI私有设置保存失败，请检查运行目录权限"); }
    return status();
  }
  async function chat(messages, options = {}) {
    const settings = effective(); validate({ ...settings, enabled: false });
    if (!settings.enabled || !settings.apiKey) fail(503, "AI尚未启用或未配置密钥；统计报表仍可生成");
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 24 || messages.some(message => !message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string")) fail(400, "AI消息格式无效");
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > 160000) fail(413, "AI内容过大，请缩小范围");
    const payload = { model: settings.model, messages: messages.map(({ role, content }) => ({ role, content })), stream: false,
      max_tokens: Number.isInteger(options.maxTokens) ? Math.min(4096, Math.max(32, options.maxTokens)) : 2048,
      temperature: 0.2 };
    if (endpointURL(settings.endpoint).hostname === "api.deepseek.com") payload.thinking = { type: "disabled" };
    let response;
    try { response = await transport({ endpoint: settings.endpoint, apiKey: settings.apiKey, payload }); }
    catch (error) { if (error instanceof AIError) throw error; fail(502, "AI服务请求失败，请稍后重试"); }
    let text = response?.choices?.[0]?.message?.content;
    if (response?.choices?.[0]?.finish_reason === "length") fail(502, "AI输出达到长度限制，请缩小统计范围后重试");
    if (typeof text !== "string" || !text.trim()) fail(502, "AI服务没有返回有效文本");
    text = text.slice(0, 50000).split(settings.apiKey).join("[密钥已隐藏]");
    return { text, model: settings.model };
  }
  return { status, save, chat };
}

module.exports = { AIError, createAIProvider, createPrivateSettingsStore, publicJSONRequest, endpointURL, publicAddress };
