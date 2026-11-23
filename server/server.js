const http = require("http");
const fs = require("fs");
const path = require("path");
const { createAuthService, staticFile, sendJson, writeAtomic, acceptsGzip } = require("./auth-service");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const gzipStatic = require("node:util").promisify(zlib.gzip);
const { createSmsVerification } = require("./sms-verification");
const { createAliyunSmsSender } = require("./sms-aliyun");
const { createMySQLStore } = require("./mysql-store");
const { createMySQLAuthStore } = require("./mysql-auth-store");

// 读取配置
// Explicit file-mode test processes may point at their own synthetic config;
// normal MySQL production always keeps the established private config path.
const CONFIG_PATH = process.env.HR_STORAGE_MODE === "file" && process.env.HR_TEST_CONFIG_FILE
  ? path.resolve(process.env.HR_TEST_CONFIG_FILE) : path.join(__dirname, "config.json");
let CONFIG = { port: 8080, staticIP: "" };
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!CONFIG || typeof CONFIG !== "object" || Array.isArray(CONFIG)) throw new Error("Invalid server configuration");
  if (CONFIG.sms !== undefined && (!CONFIG.sms || typeof CONFIG.sms !== "object" || Array.isArray(CONFIG.sms) || (CONFIG.sms.enabled !== undefined && typeof CONFIG.sms.enabled !== "boolean"))) throw new Error("Invalid SMS configuration");
  if (CONFIG.approvalSms !== undefined && (!CONFIG.approvalSms || typeof CONFIG.approvalSms !== "object" || Array.isArray(CONFIG.approvalSms) || (CONFIG.approvalSms.enabled !== undefined && typeof CONFIG.approvalSms.enabled !== "boolean"))) throw new Error("Invalid approval SMS configuration");
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("服务端配置无法读取，请检查配置文件及权限");
}

const PORT = Number(process.env.HR_PORT || CONFIG.port || 8080);
const HOST = process.env.HR_HOST || CONFIG.staticIP || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.HR_DATA_DIR ? path.resolve(process.env.HR_DATA_DIR) : path.join(__dirname, "data");
const STORAGE_MODE = process.env.HR_STORAGE_MODE || "mysql";
if (!["mysql", "file"].includes(STORAGE_MODE)) throw new Error("存储模式无效，仅支持mysql或显式file开发模式");
let MYSQL_POOL = null;
let MYSQL_STORE = null;
let MYSQL_AUTH_STORE = null;
let storageInitialization = null;
let MYSQL_SETTINGS = null;
let FEISHU_TOKEN = { value: "", expiresAt: 0 };

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), "utf-8");
}

function mysqlSettings() {
  const m = CONFIG.mysql || {};
  return {
    enabled: String(process.env.HR_MYSQL_ENABLED || (m.enabled ? "true" : "false")).toLowerCase() === "true",
    host: process.env.HR_MYSQL_HOST || m.host || "127.0.0.1",
    port: Number(process.env.HR_MYSQL_PORT || m.port || 3306),
    database: process.env.HR_MYSQL_DATABASE || m.database || "hr_system",
    user: process.env.HR_MYSQL_USER || m.user || "hrsystem",
    password: process.env.HR_MYSQL_PASSWORD || m.password || ""
  };
}

function snapshotFilePath() {
  return path.join(DATA_DIR, "snapshot.json");
}

function isMigrationReadOnly() {
  return STORAGE_MODE === "mysql" && fs.existsSync("/run/hr-system-relational-migration.hold");
}
function requireWritableStorage() {
  if (isMigrationReadOnly()) { const error = new Error("数据库迁移校验中，系统暂为只读，请稍后重试"); error.status = 503; throw error; }
}
async function initMySQL() {
  if (STORAGE_MODE === "file") return;
  if (!storageInitialization) storageInitialization = (async () => {
    MYSQL_SETTINGS = mysqlSettings();
    if (!MYSQL_SETTINGS.enabled || !MYSQL_SETTINGS.password) throw new Error("正式存储必须启用并配置MySQL，禁止自动回退文件存储");
    let mysql;
    try { mysql = require("mysql2/promise"); } catch (_) { throw new Error("MySQL驱动未安装，请先安装已声明的服务端依赖"); }
    MYSQL_POOL = mysql.createPool({
      host: MYSQL_SETTINGS.host, port: MYSQL_SETTINGS.port, user: MYSQL_SETTINGS.user,
      password: MYSQL_SETTINGS.password, database: MYSQL_SETTINGS.database,
      waitForConnections: true, connectionLimit: 10, queueLimit: 0, charset: "utf8mb4",
      supportBigNumbers: true, bigNumberStrings: true
    });
    MYSQL_STORE = createMySQLStore(MYSQL_POOL, { isReadOnly: isMigrationReadOnly });
    MYSQL_AUTH_STORE = createMySQLAuthStore(MYSQL_STORE, { isReadOnly: isMigrationReadOnly });
    // Schema creation/import is a separate, backed-up migration, never startup.
    await MYSQL_STORE.verifyInitialized();
    await MYSQL_AUTH_STORE.verifyInitialized();
  })();
  return storageInitialization;
}
const authPersistence = STORAGE_MODE === "file" ? null : Object.fromEntries(
  ["readUsers", "writeUsers", "readOrganization", "writeOrganization", "transaction"].map(method => [method, async (...args) => {
    await initMySQL();
    return MYSQL_AUTH_STORE[method](...args);
  }])
);

async function feishuToken() {
  const f = CONFIG.feishu || {};
  if (!f.appId || !f.appSecret) throw new Error("未配置飞书 App ID/App Secret");
  if (FEISHU_TOKEN.value && FEISHU_TOKEN.expiresAt > Date.now() + 60000) return FEISHU_TOKEN.value;
  const r = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: f.appId, client_secret: f.appSecret })
  });
  const d = await r.json();
  if (!r.ok || d.code) throw new Error(d.error_description || d.msg || ("获取飞书 token 失败 (" + r.status + ")"));
  FEISHU_TOKEN = { value: d.access_token, expiresAt: Date.now() + Math.max(60, (d.expires_in || 7200) - 60) * 1000 };
  return FEISHU_TOKEN.value;
}

async function feishuSend(text) {
  const f = CONFIG.feishu || {};
  if (!f.receiveId) throw new Error("未配置飞书接收对象 ID");
  const token = await feishuToken();
  const type = f.receiveIdType || "chat_id";
  const url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=" + encodeURIComponent(type);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ receive_id: f.receiveId, msg_type: "text", content: JSON.stringify({ text: text }) })
  });
  const d = await r.json();
  if (!r.ok || d.code) throw new Error(d.msg || d.error_description || ("发送飞书消息失败 (" + r.status + ")"));
  return d;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1024 * 1024) reject(new Error("请求内容过大")); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch(e) { reject(new Error("请求 JSON 格式错误")); } });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Public resources may reuse bytes only after validation. Date query strings
// are not immutable content hashes: a changed file must be visible immediately.
const STATIC_CACHE_MAX_ENTRIES = 64;
const STATIC_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const staticCache = new Map();
const staticLoads = new Map();
let staticCacheBytes = 0;
function cacheHeaders(resource, compressed) {
  return { "Cache-Control": "public, max-age=0, must-revalidate", Vary: "Accept-Encoding",
    ETag: compressed ? resource.gzipEtag : resource.etag, "Last-Modified": resource.modified };
}
function cacheStatic(file, resource) {
  const old = staticCache.get(file);
  if (old) { staticCacheBytes -= old.bytes; staticCache.delete(file); }
  if (resource.bytes > STATIC_CACHE_MAX_BYTES) return;
  staticCache.set(file, resource); staticCacheBytes += resource.bytes;
  while (staticCache.size > STATIC_CACHE_MAX_ENTRIES || staticCacheBytes > STATIC_CACHE_MAX_BYTES) {
    const oldest = staticCache.keys().next().value;
    staticCacheBytes -= staticCache.get(oldest).bytes;
    staticCache.delete(oldest);
  }
}
async function loadStatic(file, ext) {
  const info = await fs.promises.stat(file, { bigint: true });
  if (!info.isFile()) { const error = new Error("Not a file"); error.code = "ENOENT"; throw error; }
  const stamp = String(info.size) + ":" + String(info.mtimeNs) + ":" + String(info.ctimeNs);
  const cached = staticCache.get(file);
  if (cached && cached.stamp === stamp) {
    staticCache.delete(file); staticCache.set(file, cached);
    return cached;
  }
  const pending = staticLoads.get(file);
  if (pending && pending.stamp === stamp) return pending.promise;
  const promise = (async () => {
    const data = await fs.promises.readFile(file);
    let compressed = null;
    if (data.length >= 1024 && [".html", ".js", ".css", ".json", ".txt"].includes(ext)) {
      try { compressed = await gzipStatic(data, { level: 6 }); }
      catch (_) { console.warn("Static response compression failed; using the original response"); }
    }
    const etag = '"' + crypto.createHash("sha256").update(data).digest("hex") + '"';
    const gzipEtag = compressed ? '"' + crypto.createHash("sha256").update(compressed).digest("hex") + '"' : null;
    const resource = { stamp, data, compressed, etag, gzipEtag, modified: info.mtime.toUTCString(), bytes: data.length + (compressed ? compressed.length : 0) };
    cacheStatic(file, resource);
    return resource;
  })();
  // Bound both stored resources and in-flight deduplication metadata. Actual
  // file authorization still comes solely from staticFile's public allowlist.
  if (staticLoads.size < STATIC_CACHE_MAX_ENTRIES) staticLoads.set(file, { stamp, promise });
  try { return await promise; }
  finally { if (staticLoads.get(file)?.promise === promise) staticLoads.delete(file); }
}
function matchesStaticEtag(value, etag) {
  return typeof value === "string" && value.split(",").some(item => {
    const tag = item.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

function smsSettings() {
  const config = CONFIG.sms || {};
  if (process.env.HR_SMS_ENABLED !== undefined && !/^(?:true|false)$/i.test(process.env.HR_SMS_ENABLED)) throw new Error("短信开关配置无效，请使用 true 或 false");
  return {
    enabled: String(process.env.HR_SMS_ENABLED || (config.enabled ? "true" : "false")).toLowerCase() === "true",
    accessKeyId: process.env.HR_SMS_ACCESS_KEY_ID || config.accessKeyId || "",
    accessKeySecret: process.env.HR_SMS_ACCESS_KEY_SECRET || config.accessKeySecret || "",
    securityToken: process.env.HR_SMS_SECURITY_TOKEN || config.securityToken || "",
    signName: process.env.HR_SMS_SIGN_NAME || config.signName || "",
    templateCode: process.env.HR_SMS_TEMPLATE_CODE || config.templateCode || "",
    templateParamKey: process.env.HR_SMS_TEMPLATE_PARAM_KEY || config.templateParamKey || "code"
  };
}
function approvalSmsSettings() {
  const config = CONFIG.approvalSms || {};
  if (process.env.HR_APPROVAL_SMS_ENABLED !== undefined && !/^(?:true|false)$/i.test(process.env.HR_APPROVAL_SMS_ENABLED)) throw new Error("审批短信开关配置无效，请使用 true 或 false");
  return {
    enabled: String(process.env.HR_APPROVAL_SMS_ENABLED || (config.enabled ? "true" : "false")).toLowerCase() === "true",
    accessKeyId: process.env.HR_APPROVAL_SMS_ACCESS_KEY_ID || config.accessKeyId || "",
    accessKeySecret: process.env.HR_APPROVAL_SMS_ACCESS_KEY_SECRET || config.accessKeySecret || "",
    securityToken: process.env.HR_APPROVAL_SMS_SECURITY_TOKEN || config.securityToken || "",
    signName: process.env.HR_APPROVAL_SMS_SIGN_NAME || config.signName || "",
    templateCode: process.env.HR_APPROVAL_SMS_TEMPLATE_CODE || config.templateCode || ""
  };
}
const smsConfig = smsSettings();
const smsVerification = createSmsVerification({
  dataDir: DATA_DIR, enabled: smsConfig.enabled,
  sendCode: createAliyunSmsSender(smsConfig)
});
const auth = createAuthService({
  dataDir: DATA_DIR,
  approvalSms: approvalSmsSettings(),
  smsVerification,
  authStore: authPersistence,
  isReadOnly: isMigrationReadOnly,
  storageStatus: () => ({ backend: STORAGE_MODE === "mysql" ? "mysql" : "file", model: STORAGE_MODE === "mysql" ? "relational" : "development", readOnly: isMigrationReadOnly() }),
  readSnapshot: async () => {
    if (STORAGE_MODE === "mysql") { await initMySQL(); return MYSQL_STORE.read(); }
    try { return JSON.parse(await fs.promises.readFile(snapshotFilePath(), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  },
  writeSnapshot: async snapshot => {
    requireWritableStorage();
    if (STORAGE_MODE === "mysql") { await initMySQL(); await MYSQL_STORE.write(snapshot, { expectedRevision: snapshot.revision - 1 }); }
    else writeAtomic(snapshotFilePath(), snapshot);
  }
});

async function handleRequest(req, res) {
  let url;
  try { url = new URL(req.url, "http://localhost").pathname; } catch { sendJson(res, 400, { ok: false, message: "请求地址无效" }); return; }
  if (url === "/") url = "/index.html";
  if (url.startsWith("/api/") && !["GET", "HEAD"].includes(req.method) && isMigrationReadOnly()) { sendJson(res, 503, { ok: false, message: "数据库迁移校验中，系统暂为只读，请稍后重试" }); return; }
  if (await auth.handle(req, res, url)) return;
  if (url.startsWith("/api/wechat/") || /^\/api\/feishu\/(?:login-config|auth-url|auth-code|callback)$/.test(url)) {
    sendJson(res, 410, { ok: false, enabled: false, message: "第三方登录已停用，请使用手机号登录" }); return;
  }
  if (url.startsWith("/api/")) {
    try { await auth.refreshUsers(); auth.checkOrigin(req); auth.requireAdmin(req); }
    catch (error) { sendJson(res, error.status || 500, { ok: false, message: error.message }); return; }
  }

  // AI 统一代理：密钥只保存在服务端配置或环境变量中，浏览器不直连第三方接口。
  if (url === "/api/ai/chat" && req.method === "POST") {
    readRequestBody(req).then(async body => {
      const ai = CONFIG.ai || {};
      const endpoint = process.env.HR_AI_ENDPOINT || ai.endpoint;
      const apiKey = process.env.HR_AI_API_KEY || ai.apiKey;
      const model = String(body.model || process.env.HR_AI_MODEL || ai.model || "deepseek-chat");
      if (!endpoint || !apiKey) { json(res, 503, { error: { message: "AI 尚未配置，请联系管理员完成服务端 AI 配置" } }); return; }
      const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey };
      const upstream = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...body, model, stream: false }) });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(text);
    }).catch(e => json(res, 502, { error: { message: "AI 服务请求失败: " + e.message } }));
    return;
  }

  if (url === "/api/feishu/config") {
    if (req.method === "GET") {
      const f = CONFIG.feishu || {};
      json(res, 200, { appId: f.appId || "", receiveId: f.receiveId || "", receiveIdType: f.receiveIdType || "chat_id", configured: !!(f.appId && f.appSecret && f.receiveId), loginEnabled: false, appSecretConfigured: !!f.appSecret });
      return;
    }
    if (req.method === "POST") {
      readRequestBody(req).then(body => {
        const current = CONFIG.feishu || {};
        const appId = String(body.appId || "").trim();
        const appSecret = String(body.appSecret || "").trim() || current.appSecret || "";
        const receiveId = String(body.receiveId || "").trim();
        const receiveIdType = ["chat_id", "open_id", "user_id", "union_id", "email"].indexOf(body.receiveIdType) >= 0 ? body.receiveIdType : "chat_id";
        if (!appId || !appSecret || !receiveId) { json(res, 400, { ok: false, message: "App ID、App Secret 和接收对象 ID 均不能为空" }); return; }
        CONFIG.feishu = { ...current, appId, appSecret, receiveId, receiveIdType };
        FEISHU_TOKEN = { value: "", expiresAt: 0 };
        saveConfig();
        json(res, 200, { ok: true, configured: true });
      }).catch(e => json(res, 400, { ok: false, message: e.message }));
      return;
    }
  }

  if (url === "/api/feishu/test" && req.method === "POST") {
    readRequestBody(req).then(body => feishuSend(String(body.text || "人员管理系统飞书接入测试消息")))
      .then(() => json(res, 200, { ok: true }))
      .catch(e => json(res, 502, { ok: false, message: e.message }));
    return;
  }

  if (url === "/api/feishu/send" && req.method === "POST") {
    readRequestBody(req).then(body => feishuSend(String(body.text || "")))
      .then(() => json(res, 200, { ok: true }))
      .catch(e => json(res, 502, { ok: false, message: e.message }));
    return;
  }

  if (url.startsWith("/api/")) { sendJson(res, 404, { ok: false, message: "接口不存在" }); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end("Method Not Allowed"); return; }
  const fp = staticFile(ROOT, url);
  if (!fp) { res.writeHead(404); res.end("Not Found"); return; }
  const ext = path.extname(fp).toLowerCase();
  try {
    const resource = await loadStatic(fp, ext);
    if (res.destroyed || res.writableEnded) return;
    const compressed = !!resource.compressed && acceptsGzip(req.headers["accept-encoding"]);
    const data = compressed ? resource.compressed : resource.data;
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff", ...cacheHeaders(resource, compressed), ...(compressed ? { "Content-Encoding": "gzip" } : {}) };
    if (matchesStaticEtag(req.headers["if-none-match"], headers.ETag)) {
      res.writeHead(304, headers); res.end(); return;
    }
    res.writeHead(200, { ...headers, "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (error) {
    if (res.destroyed || res.writableEnded || res.headersSent) return;
    const missing = ["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code);
    if (!missing) console.warn("Public static resource could not be read");
    res.writeHead(missing ? 404 : 500, { "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : missing ? "Not Found" : "Resource unavailable");
  }
}
const server = http.createServer((req, res) => {
  const run = () => handleRequest(req, res);
  const operation = String(req.url || "").startsWith("/api/") ? auth.withRequestContext(run) : run();
  Promise.resolve(operation).catch(() => {
    if (!res.headersSent && !res.destroyed) sendJson(res, 503, { ok: false, message: "数据库服务暂不可用，请联系管理员" });
    else if (!res.destroyed) res.end();
  });
});

async function startServer() {
  await initMySQL();
  server.listen(PORT, HOST, () => {
  const os = require("os");
  const ifs = os.networkInterfaces();
  let ips = [];
  Object.keys(ifs).forEach(function(n) {
    (ifs[n]||[]).forEach(function(f) {
      if (f.family === "IPv4" && !f.internal) ips.push(f.address);
    });
  });
  const ip = ips.length > 0 ? ips[0] : "127.0.0.1";
  console.log("");
  console.log("  ====================================");
  console.log("    人员管理系统 - 服务器运行中");
  console.log("  ====================================");
  console.log("");
  console.log("    本地访问:  http://localhost:" + PORT);
  console.log("    内网访问:  http://" + ip + ":" + PORT);
  if (CONFIG.staticIP) console.log("    静态IP:   http://" + CONFIG.staticIP + ":" + PORT);
  console.log("");
  console.log("    按 Ctrl+C 停止服务");
  console.log("  ====================================");
  console.log("");
  if (process.platform === "win32" && process.env.HR_NO_OPEN !== "1") {
    var cp = require("child_process");
    setTimeout(function() { cp.exec("start http://localhost:" + PORT, function(){}); }, 1000);
  }
  });
}

if (require.main === module) {
  startServer().catch(function (e) {
    console.error("服务器启动失败: " + e.message);
    process.exit(1);
  });
}

module.exports = { server, startServer, initStorage: initMySQL, closeStorage: async () => { if (MYSQL_POOL) await MYSQL_POOL.end(); } };
