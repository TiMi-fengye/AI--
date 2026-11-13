const http = require("http");
const fs = require("fs");
const path = require("path");
const { createAuthService, staticFile, sendJson, writeAtomic } = require("./auth-service");
const { createSmsVerification } = require("./sms-verification");
const { createAliyunSmsSender } = require("./sms-aliyun");

// 读取配置
let CONFIG = { port: 8080, staticIP: "" };
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
  if (!CONFIG || typeof CONFIG !== "object" || Array.isArray(CONFIG)) throw new Error("Invalid server configuration");
  if (CONFIG.sms !== undefined && (!CONFIG.sms || typeof CONFIG.sms !== "object" || Array.isArray(CONFIG.sms) || (CONFIG.sms.enabled !== undefined && typeof CONFIG.sms.enabled !== "boolean"))) throw new Error("Invalid SMS configuration");
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("服务端配置无法读取，请检查配置文件及权限");
}

const PORT = Number(process.env.HR_PORT || CONFIG.port || 8080);
const HOST = process.env.HR_HOST || CONFIG.staticIP || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.HR_DATA_DIR ? path.resolve(process.env.HR_DATA_DIR) : path.join(__dirname, "data");
let MYSQL_POOL = null;
let MYSQL_SETTINGS = null;
let FEISHU_TOKEN = { value: "", expiresAt: 0 };

function saveConfig() {
  fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(CONFIG, null, 2), "utf-8");
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

async function initMySQL() {
  MYSQL_SETTINGS = mysqlSettings();
  if (!MYSQL_SETTINGS.enabled) return;
  let mysql;
  try { mysql = require("mysql2/promise"); } catch (e) { throw new Error("MySQL 已启用，但未安装 mysql2 依赖"); }
  if (!MYSQL_SETTINGS.password) throw new Error("MySQL 已启用，但未配置数据库密码");
  MYSQL_POOL = mysql.createPool({
    host: MYSQL_SETTINGS.host,
    port: MYSQL_SETTINGS.port,
    user: MYSQL_SETTINGS.user,
    password: MYSQL_SETTINGS.password,
    database: MYSQL_SETTINGS.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4"
  });
  await MYSQL_POOL.query("CREATE TABLE IF NOT EXISTS system_snapshots (snapshot_key VARCHAR(64) NOT NULL PRIMARY KEY, payload LONGTEXT NOT NULL, updated_at DATETIME(3) NOT NULL) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
  const [rows] = await MYSQL_POOL.query("SELECT snapshot_key FROM system_snapshots WHERE snapshot_key = 'default' LIMIT 1");
  if (!rows.length && fs.existsSync(snapshotFilePath())) {
    const raw = fs.readFileSync(snapshotFilePath(), "utf-8");
    JSON.parse(raw);
    await MYSQL_POOL.query("INSERT INTO system_snapshots (snapshot_key, payload, updated_at) VALUES ('default', ?, UTC_TIMESTAMP(3))", [raw]);
  }
  console.log("    MySQL 数据库已连接: " + MYSQL_SETTINGS.database + "@" + MYSQL_SETTINGS.host + ":" + MYSQL_SETTINGS.port);
}

async function readMySQLSnapshot() {
  if (!MYSQL_POOL) return null;
  const [rows] = await MYSQL_POOL.query("SELECT payload FROM system_snapshots WHERE snapshot_key = 'default' LIMIT 1");
  if (!rows.length) return null;
  return JSON.parse(rows[0].payload);
}

async function writeMySQLSnapshot(snapshot) {
  if (!MYSQL_POOL) return false;
  const payload = JSON.stringify(snapshot);
  await MYSQL_POOL.query("INSERT INTO system_snapshots (snapshot_key, payload, updated_at) VALUES ('default', ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = UTC_TIMESTAMP(3)", [payload]);
  // 保留一份本地快照作为灾备，不再作为线上数据源。
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(snapshotFilePath(), JSON.stringify(snapshot, null, 2), "utf-8"); } catch (e) { console.warn("本地快照备份写入失败: " + e.message); }
  return true;
}

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

// 代码类文件一律禁用缓存，保证前端更新立即生效
const NO_CACHE_EXT = [".html", ".js", ".css", ".json"];
function cacheHeaders(ext) {
  const headers = {};
  if (NO_CACHE_EXT.indexOf(ext) >= 0) {
    headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
    headers["Pragma"] = "no-cache";
    headers["Expires"] = "0";
  }
  return headers;
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
const smsConfig = smsSettings();
const smsVerification = createSmsVerification({
  dataDir: DATA_DIR, enabled: smsConfig.enabled,
  sendCode: createAliyunSmsSender(smsConfig)
});
const auth = createAuthService({
  dataDir: DATA_DIR,
  smsVerification,
  readSnapshot: async () => {
    if (MYSQL_POOL) return readMySQLSnapshot();
    try { return JSON.parse(await fs.promises.readFile(snapshotFilePath(), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  },
  writeSnapshot: async snapshot => {
    if (MYSQL_POOL) await writeMySQLSnapshot(snapshot);
    else writeAtomic(snapshotFilePath(), snapshot);
  }
});

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost").pathname; } catch { sendJson(res, 400, { ok: false, message: "请求地址无效" }); return; }
  if (url === "/") url = "/index.html";
  if (await auth.handle(req, res, url)) return;
  if (url.startsWith("/api/wechat/") || /^\/api\/feishu\/(?:login-config|auth-url|auth-code|callback)$/.test(url)) {
    sendJson(res, 410, { ok: false, enabled: false, message: "第三方登录已停用，请使用手机号登录" }); return;
  }
  if (url.startsWith("/api/")) {
    try { auth.checkOrigin(req); auth.requireAdmin(req); }
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
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff", ...cacheHeaders(ext) });
    res.end(req.method === "HEAD" ? undefined : data);
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

module.exports = { server, startServer };
