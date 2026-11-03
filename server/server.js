const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 读取配置
let CONFIG = { port: 8080, staticIP: "" };
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
} catch(e) {}

const PORT = CONFIG.port || 8080;
const HOST = CONFIG.staticIP || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
let MYSQL_POOL = null;
let MYSQL_SETTINGS = null;
let FEISHU_TOKEN = { value: "", expiresAt: 0 };
let FEISHU_APP_TOKEN = { value: "", expiresAt: 0 };
const FEISHU_OAUTH_STATES = new Map();
const WECHAT_OAUTH_STATES = new Map();

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

async function feishuAppAccessToken() {
  const f = CONFIG.feishu || {};
  if (!f.appId || !f.appSecret) throw new Error("未配置飞书 App ID/App Secret");
  if (FEISHU_APP_TOKEN.value && FEISHU_APP_TOKEN.expiresAt > Date.now() + 60000) return FEISHU_APP_TOKEN.value;
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: f.appId, app_secret: f.appSecret })
  });
  const d = await r.json();
  if (!r.ok || d.code) throw new Error(d.msg || d.error_description || ("获取飞书应用令牌失败 (" + r.status + ")"));
  const token = d.app_access_token || (d.data && d.data.app_access_token);
  if (!token) throw new Error("飞书应用令牌响应无效");
  FEISHU_APP_TOKEN = { value: token, expiresAt: Date.now() + Math.max(60, (d.expire || d.expires_in || 7200) - 60) * 1000 };
  return token;
}

function defaultFeishuRedirect(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers.host || ("localhost:" + PORT);
  return proto + "://" + host + "/api/feishu/callback";
}

function feishuOAuthConfig(req) {
  const f = CONFIG.feishu || {};
  return {
    enabled: f.loginEnabled === true || (f.loginEnabled == null && !!(f.appId && f.appSecret)),
    autoProvision: f.autoProvision !== false,
    // App ID 不是敏感凭证，工作台内免登的前端 JSAPI 需要使用它。
    appId: f.appId || "",
    redirectUri: f.oauthRedirectUri || defaultFeishuRedirect(req),
    appIdConfigured: !!f.appId,
    appSecretConfigured: !!f.appSecret
  };
}

function defaultWechatRedirect(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers.host || ("localhost:" + PORT);
  return proto + "://" + host + "/api/wechat/callback";
}

function wechatOAuthConfig(req) {
  const w = CONFIG.wechat || {};
  return {
    enabled: w.loginEnabled === true,
    autoProvision: w.autoProvision === true,
    appId: w.appId || "",
    redirectUri: w.oauthRedirectUri || defaultWechatRedirect(req),
    appIdConfigured: !!w.appId,
    appSecretConfigured: !!w.appSecret
  };
}

function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function oauthResultPage(targetOrigin, payload) {
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const safeOrigin = JSON.stringify(targetOrigin);
  return "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>飞书登录</title><body style=\"font-family:system-ui;padding:32px;background:#071426;color:#eaf4ff\">正在返回系统…</body><script>var p=" + safePayload + ";var o=" + safeOrigin + ";if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'feishu-auth-result',payload:p},o);setTimeout(function(){window.close()},120);}else{document.body.textContent=p.ok?'飞书授权完成，请返回系统页面。':('飞书授权失败：'+(p.message||'未知错误'));}</script></html>";
}

async function feishuOAuthUser(code) {
  const appToken = await feishuAppAccessToken();
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + appToken },
    body: JSON.stringify({ grant_type: "authorization_code", code: code })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.code) throw new Error(tokenData.msg || tokenData.error_description || ("获取飞书用户令牌失败 (" + tokenRes.status + ")"));
  const userToken = tokenData.access_token || (tokenData.data && tokenData.data.access_token);
  if (!userToken) throw new Error("飞书用户令牌响应无效");
  const userRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { "Authorization": "Bearer " + userToken } });
  const userData = await userRes.json();
  if (!userRes.ok || userData.code) throw new Error(userData.msg || userData.error_description || ("获取飞书用户信息失败 (" + userRes.status + ")"));
  const d = userData.data || userData;
  return {
    open_id: d.open_id || d.openId || "",
    union_id: d.union_id || d.unionId || "",
    user_id: d.user_id || d.userId || "",
    name: d.name || d.en_name || d.nickname || "飞书用户",
    en_name: d.en_name || "",
    email: d.email || "",
    avatar_url: d.avatar_url || ""
  };
}

function wechatOAuthResultPage(targetOrigin, payload) {
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const safeOrigin = JSON.stringify(targetOrigin);
  return "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>微信登录</title><body style=\"font-family:system-ui;padding:32px;background:#071426;color:#eaf4ff\">正在返回系统…</body><script>var p=" + safePayload + ";var o=" + safeOrigin + ";if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'wechat-auth-result',payload:p},o);setTimeout(function(){window.close()},120);}else{document.body.textContent=p.ok?'微信授权完成，请返回系统页面。':('微信授权失败：'+(p.message||'未知错误'));}</script></html>";
}

async function wechatOAuthUser(code) {
  const w = CONFIG.wechat || {};
  if (!w.appId || !w.appSecret) throw new Error("未配置微信 AppID/AppSecret");
  const tokenUrl = "https://api.weixin.qq.com/sns/oauth2/access_token?appid=" + encodeURIComponent(w.appId) + "&secret=" + encodeURIComponent(w.appSecret) + "&code=" + encodeURIComponent(code) + "&grant_type=authorization_code";
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.errcode) throw new Error(tokenData.errmsg || ("获取微信访问令牌失败 (" + tokenRes.status + ")"));
  const userUrl = "https://api.weixin.qq.com/sns/userinfo?access_token=" + encodeURIComponent(tokenData.access_token) + "&openid=" + encodeURIComponent(tokenData.openid) + "&lang=zh_CN";
  const userRes = await fetch(userUrl);
  const userData = await userRes.json();
  if (!userRes.ok || userData.errcode) throw new Error(userData.errmsg || ("获取微信用户信息失败 (" + userRes.status + ")"));
  return {
    open_id: userData.openid || "",
    union_id: userData.unionid || "",
    name: userData.nickname || "微信用户",
    nickname: userData.nickname || "",
    avatar_url: userData.headimgurl || "",
    sex: userData.sex || 0,
    country: userData.country || "",
    province: userData.province || "",
    city: userData.city || ""
  };
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

const server = http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/index.html";

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
      json(res, 200, { appId: f.appId || "", receiveId: f.receiveId || "", receiveIdType: f.receiveIdType || "chat_id", configured: !!(f.appId && f.appSecret && f.receiveId), loginEnabled: f.loginEnabled === true, autoProvision: f.autoProvision !== false, oauthRedirectUri: f.oauthRedirectUri || defaultFeishuRedirect(req), appSecretConfigured: !!f.appSecret });
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
        FEISHU_APP_TOKEN = { value: "", expiresAt: 0 };
        saveConfig();
        json(res, 200, { ok: true, configured: true });
      }).catch(e => json(res, 400, { ok: false, message: e.message }));
      return;
    }
  }

  if (url === "/api/feishu/login-config") {
    if (req.method === "GET") {
      json(res, 200, feishuOAuthConfig(req));
      return;
    }
    if (req.method === "POST") {
      readRequestBody(req).then(body => {
        const current = CONFIG.feishu || {};
        const hasRedirect = Object.prototype.hasOwnProperty.call(body, "oauthRedirectUri");
        const configuredRedirect = hasRedirect ? String(body.oauthRedirectUri || "").trim() : String(current.oauthRedirectUri || "").trim();
        const defaultRedirect = defaultFeishuRedirect(req);
        const redirectUri = configuredRedirect || defaultRedirect;
        if (!/^https?:\/\//i.test(redirectUri)) { json(res, 400, { ok: false, message: "OAuth 回调地址必须以 http:// 或 https:// 开头" }); return; }
        // 与当前访问地址一致时保存为空，登录请求会按访问端的 localhost/LAN 地址动态生成。
        const persistedRedirect = configuredRedirect === defaultRedirect ? "" : configuredRedirect;
        CONFIG.feishu = { ...current, loginEnabled: body.loginEnabled === true, autoProvision: body.autoProvision !== false, oauthRedirectUri: persistedRedirect };
        saveConfig();
        json(res, 200, { ok: true, ...feishuOAuthConfig(req) });
      }).catch(e => json(res, 400, { ok: false, message: e.message }));
      return;
    }
  }

  if (url === "/api/feishu/auth-url" && req.method === "GET") {
    const f = CONFIG.feishu || {};
    const cfg = feishuOAuthConfig(req);
    if (!cfg.enabled) { json(res, 403, { ok: false, message: "系统尚未启用飞书登录" }); return; }
    if (!f.appId || !f.appSecret) { json(res, 400, { ok: false, message: "请先在系统设置中配置飞书 App ID 和 App Secret" }); return; }
    const state = crypto.randomBytes(24).toString("hex");
    const redirectUri = cfg.redirectUri;
    let redirectOrigin;
    try { redirectOrigin = new URL(redirectUri).origin; } catch (e) { json(res, 400, { ok: false, message: "OAuth 回调地址无效" }); return; }
    let callerOrigin = String(req.headers.origin || "").trim();
    if (!callerOrigin) {
      try { callerOrigin = new URL(String(req.headers.referer || "http://" + (req.headers.host || "localhost"))).origin; } catch (e) { callerOrigin = redirectOrigin; }
    }
    FEISHU_OAUTH_STATES.set(state, { redirectUri, origin: callerOrigin, expiresAt: Date.now() + 10 * 60 * 1000 });
    const authUrl = "https://open.feishu.cn/open-apis/authen/v1/index?app_id=" + encodeURIComponent(f.appId) + "&redirect_uri=" + encodeURIComponent(redirectUri) + "&state=" + encodeURIComponent(state);
    json(res, 200, { ok: true, authUrl, state });
    return;
  }

  // 飞书工作台内免登：前端通过 requestAccess/requestAuthCode 获取 code，
  // 服务端使用同一套 App 凭证换取 user_access_token 和用户身份。
  if (url === "/api/feishu/auth-code" && req.method === "POST") {
    if (!feishuOAuthConfig(req).enabled) { json(res, 403, { ok: false, message: "飞书登录已停用" }); return; }
    readRequestBody(req).then(body => {
      const code = String(body.code || "").trim();
      if (!code) throw new Error("飞书未返回授权码");
      return feishuOAuthUser(code);
    }).then(user => json(res, 200, { ok: true, user }))
      .catch(e => json(res, 502, { ok: false, message: e.message }));
    return;
  }

  if (url === "/api/feishu/callback" && req.method === "GET") {
    if (!feishuOAuthConfig(req).enabled) { html(res, 403, "飞书登录已停用"); return; }
    const query = new URL(req.url, "http://localhost").searchParams;
    const state = query.get("state") || "";
    const record = FEISHU_OAUTH_STATES.get(state);
    if (record) FEISHU_OAUTH_STATES.delete(state);
    const targetOrigin = record ? record.origin : "*";
    if (!record || record.expiresAt < Date.now()) { html(res, 400, oauthResultPage(targetOrigin, { ok: false, message: "飞书登录状态已失效，请重新发起登录" })); return; }
    if (query.get("error")) { html(res, 400, oauthResultPage(targetOrigin, { ok: false, message: query.get("error_description") || query.get("error") })); return; }
    const code = query.get("code") || "";
    if (!code) { html(res, 400, oauthResultPage(targetOrigin, { ok: false, message: "飞书未返回授权码" })); return; }
    feishuOAuthUser(code).then(user => html(res, 200, oauthResultPage(targetOrigin, { ok: true, user }))).catch(e => html(res, 502, oauthResultPage(targetOrigin, { ok: false, message: e.message })));
    return;
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

  // 微信网页登录：只用于身份授权，AppSecret 始终留在服务端。
  if (url === "/api/wechat/login-config") {
    if (req.method === "GET") {
      json(res, 200, wechatOAuthConfig(req));
      return;
    }
    if (req.method === "POST") {
      readRequestBody(req).then(body => {
        const current = CONFIG.wechat || {};
        const hasRedirect = Object.prototype.hasOwnProperty.call(body, "oauthRedirectUri");
        const configuredRedirect = hasRedirect ? String(body.oauthRedirectUri || "").trim() : String(current.oauthRedirectUri || "").trim();
        const defaultRedirect = defaultWechatRedirect(req);
        const redirectUri = configuredRedirect || defaultRedirect;
        if (!/^https?:\/\//i.test(redirectUri)) { json(res, 400, { ok: false, message: "微信 OAuth 回调地址必须以 http:// 或 https:// 开头" }); return; }
        const persistedRedirect = configuredRedirect === defaultRedirect ? "" : configuredRedirect;
        const appId = Object.prototype.hasOwnProperty.call(body, "appId") ? String(body.appId || "").trim() : String(current.appId || "").trim();
        const appSecret = String(body.appSecret || "").trim() || String(current.appSecret || "").trim();
        if (body.loginEnabled === true && (!appId || !appSecret)) { json(res, 400, { ok: false, message: "启用微信登录前请配置 AppID 和 AppSecret" }); return; }
        CONFIG.wechat = {
          ...current,
          appId,
          appSecret,
          loginEnabled: body.loginEnabled === true,
          autoProvision: body.autoProvision === true,
          oauthRedirectUri: persistedRedirect
        };
        saveConfig();
        json(res, 200, { ok: true, ...wechatOAuthConfig(req) });
      }).catch(e => json(res, 400, { ok: false, message: e.message }));
      return;
    }
  }

  if (url === "/api/wechat/auth-url" && req.method === "GET") {
    const w = CONFIG.wechat || {};
    const cfg = wechatOAuthConfig(req);
    if (!cfg.enabled) { json(res, 403, { ok: false, message: "系统尚未启用微信登录" }); return; }
    if (!w.appId || !w.appSecret) { json(res, 400, { ok: false, message: "请先在系统设置中配置微信 AppID 和 AppSecret" }); return; }
    const state = crypto.randomBytes(24).toString("hex");
    const redirectUri = cfg.redirectUri;
    let redirectOrigin;
    try { redirectOrigin = new URL(redirectUri).origin; } catch (e) { json(res, 400, { ok: false, message: "微信 OAuth 回调地址无效" }); return; }
    let callerOrigin = String(req.headers.origin || "").trim();
    if (!callerOrigin) {
      try { callerOrigin = new URL(String(req.headers.referer || "http://" + (req.headers.host || "localhost"))).origin; } catch (e) { callerOrigin = redirectOrigin; }
    }
    WECHAT_OAUTH_STATES.set(state, { redirectUri, origin: callerOrigin, expiresAt: Date.now() + 10 * 60 * 1000 });
    const authUrl = "https://open.weixin.qq.com/connect/qrconnect?appid=" + encodeURIComponent(w.appId) + "&redirect_uri=" + encodeURIComponent(redirectUri) + "&response_type=code&scope=snsapi_login&state=" + encodeURIComponent(state) + "#wechat_redirect";
    json(res, 200, { ok: true, authUrl, state });
    return;
  }

  if (url === "/api/wechat/callback" && req.method === "GET") {
    const query = new URL(req.url, "http://localhost").searchParams;
    const state = query.get("state") || "";
    const record = WECHAT_OAUTH_STATES.get(state);
    if (record) WECHAT_OAUTH_STATES.delete(state);
    const targetOrigin = record ? record.origin : "*";
    if (!record || record.expiresAt < Date.now()) { html(res, 400, wechatOAuthResultPage(targetOrigin, { ok: false, message: "微信登录状态已失效，请重新发起登录" })); return; }
    if (query.get("error")) { html(res, 400, wechatOAuthResultPage(targetOrigin, { ok: false, message: query.get("error_description") || query.get("error") })); return; }
    const code = query.get("code") || "";
    if (!code) { html(res, 400, wechatOAuthResultPage(targetOrigin, { ok: false, message: "微信未返回授权码" })); return; }
    wechatOAuthUser(code).then(user => html(res, 200, wechatOAuthResultPage(targetOrigin, { ok: true, user }))).catch(e => html(res, 502, wechatOAuthResultPage(targetOrigin, { ok: false, message: e.message })));
    return;
  }

  // 共享快照：MySQL 启用后以数据库为主，文件快照仅用于初始化和灾备。
  if (url === "/api/data/snapshot.json") {
    if (req.method === "GET" && MYSQL_POOL) {
      readMySQLSnapshot().then(snapshot => {
        if (snapshot) json(res, 200, snapshot);
        else json(res, 200, { key: "snapshot", data: null });
      }).catch(e => json(res, 503, { status: "error", message: "MySQL 数据读取失败" }));
      return;
    }
    if (req.method === "POST" && MYSQL_POOL) {
      readRequestBody(req).then(snapshot => {
        if (!snapshot || !Array.isArray(snapshot.employees)) throw new Error("快照格式无效");
        return writeMySQLSnapshot(snapshot);
      }).then(() => json(res, 200, { status: "ok", storage: "mysql" }))
        .catch(e => json(res, 400, { status: "error", message: e.message }));
      return;
    }
  }

  const fp = path.join(ROOT, url);
  const ext = path.extname(fp).toLowerCase();
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(fp, (err, data) => {
    if (err) {
      if (url.startsWith("/api/data/")) {
        // File-based data API
        var key = url.replace("/api/data/", "").replace(".json", "");
        var filePath = path.join(DATA_DIR, key + ".json");
        
        if (req.method === "GET") {
          fs.readFile(filePath, "utf-8", function(err, data) {
            if (err) {
              res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
              res.end(JSON.stringify({key: key, data: null}));
            } else {
              res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
              res.end(data);
            }
          });
          return;
        }
        
        if (req.method === "POST") {
          var body = "";
          req.on("data", function(chunk){ body += chunk; });
          req.on("end", function() {
            fs.writeFile(filePath, body, "utf-8", function(err) {
              res.writeHead(err ? 500 : 200, {"Content-Type":"application/json; charset=utf-8"});
              res.end(JSON.stringify({status: err ? "error" : "ok"}));
            });
          });
          return;
        }
        
        if (req.method === "DELETE") {
          fs.unlink(filePath, function(err) {
            res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
            res.end(JSON.stringify({status: "ok"}));
          });
          return;
        }
      }
      if (url.startsWith("/api/")) { res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"}); res.end(JSON.stringify({status:"ok"})); return; }
      const fb = path.join(ROOT, "index.html");
      fs.readFile(fb, (e2, d2) => { if(e2){res.writeHead(404);res.end("Not Found");return;} res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0", "Pragma":"no-cache", "Expires":"0"}); res.end(d2); });
      return;
    }
    var _h = { "Content-Type": MIME[ext] || "application/octet-stream" };
    var _c = cacheHeaders(ext);
    for (var _k in _c) _h[_k] = _c[_k];
    res.writeHead(200, _h);
    res.end(data);
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
  if (process.platform === "win32") {
    var cp = require("child_process");
    setTimeout(function() { cp.exec("start http://localhost:" + PORT, function(){}); }, 1000);
  }
  });
}

startServer().catch(function (e) {
  console.error("服务器启动失败: " + e.message);
  process.exit(1);
});

