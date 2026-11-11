"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { isDeepStrictEqual } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const COOKIE = "hr_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const PROFILE_FIELDS = ["name", "gender", "position", "company", "personAttribute", "workAttribute", "department", "status", "region", "room", "building", "phone", "email", "joinDate", "leaveDate", "aiProfile", "resumeData", "resumeName", "credentialData", "credentialName", "_resumeText"];
const COLLECTIONS = ["employees", "attendance", "leaveRequests", "overtime", "settlements", "departments", "updateLogs", "performance"];
const PHONE = /^1[3-9]\d{9}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function positiveId(value) { return Number.isSafeInteger(value) && value > 0; }
function emptySnapshot() {
  return { employees: [], attendance: [], leaveRequests: [], overtime: [], settlements: [], departments: [], updateLogs: [], performance: [], orgStructure: { id: 1, name: "组织架构", type: "company", children: [] }, revision: 0 };
}
function normalizeSnapshot(value) {
  const snapshot = { ...emptySnapshot(), ...(value || {}) };
  for (const key of COLLECTIONS) if (!Array.isArray(snapshot[key])) snapshot[key] = [];
  snapshot.revision = Number.isSafeInteger(snapshot.revision) ? snapshot.revision : 0;
  return snapshot;
}
function publicUser(username, user) {
  return { username, name: user.name || username, role: user.role, employeeId: user.employeeId || null, phone: user.phone || "", buildings: user.role === "leader" && Array.isArray(user.buildings) ? user.buildings.slice() : [] };
}
function visibleEmployees(snapshot, user) {
  if (user.role === "admin") return snapshot.employees;
  if (user.role === "leader") return snapshot.employees.filter(e => user.buildings.includes(e.building) && !!e.building);
  return snapshot.employees.filter(e => e.id === user.employeeId);
}
function scopedSnapshot(input, user) {
  const snapshot = normalizeSnapshot(input);
  if (user.role === "admin") return clone(snapshot);
  const employees = visibleEmployees(snapshot, user);
  const ids = new Set(employees.map(e => e.id));
  const result = emptySnapshot();
  result.employees = clone(employees);
  result.overtime = clone(snapshot.overtime.filter(r => ids.has(r.employeeId)));
  result.leaveRequests = clone(snapshot.leaveRequests.filter(r => ids.has(r.employeeId)));
  result.revision = snapshot.revision;
  if (user.role === "leader") {
    result.attendance = clone(snapshot.attendance.filter(r => ids.has(r.employeeId)));
    result.performance = clone(snapshot.performance.filter(r => ids.has(r.employeeId)));
    result.departments = [...new Set(employees.map(e => e.department).filter(Boolean))];
    result.updateLogs = clone(snapshot.updateLogs.filter(r => user.buildings.includes(r.building) && !!r.building));
    result.settlements = snapshot.settlements.filter(s => Array.isArray(s.records)).map(s => {
      const records = s.records.filter(r => ids.has(r.employeeId));
      const totalOtPay = records.reduce((sum, r) => sum + (Number(r.otPay) || 0), 0);
      const totalLvDeduct = records.reduce((sum, r) => sum + (Number(r.lvDeduct) || 0), 0);
      return { ...clone(s), records: clone(records), totalEmployees: records.length, totalOtPay, totalLvDeduct, totalFee: totalOtPay - totalLvDeduct };
    });
  } else {
    // 普通人员只接收个人资料和申请/小时数据，不传费用与其他管理模块内容。
    for (const record of result.overtime) { delete record.otPay; delete record.otRate; }
    for (const record of result.leaveRequests) { delete record.lvDeduct; delete record.lvRate; }
  }
  return result;
}
function profileData(input, allowed = PROFILE_FIELDS) {
  const output = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      if (typeof input[field] !== "string") fail(400, "人员表单字段格式错误");
      const max = field.endsWith("Data") ? 8 * 1024 * 1024 : (field === "_resumeText" || field === "aiProfile" ? 50000 : 1000);
      if (input[field].length > max) fail(400, "人员表单字段内容过长");
      output[field] = input[field].trim();
    }
  }
  if (output.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(output.email)) fail(400, "邮箱格式不正确");
  if (output.phone && !PHONE.test(output.phone)) fail(400, "请输入有效的11位手机号");
  return output;
}
function validateRows(rows, label, employeeIds) {
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !positiveId(row.id) || ids.has(row.id)) fail(400, label + "编号无效或重复");
    ids.add(row.id);
    if (employeeIds && !employeeIds.has(row.employeeId)) fail(403, "记录关联了无权访问的人员");
  }
}
function validateRequest(record, kind) {
  if (!["pending", "approved", "rejected"].includes(record.status)) fail(400, "申请状态无效");
  if (kind === "overtime") {
    const date = new Date(record.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date || "") || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== record.date || !Number.isFinite(Number(record.hours)) || Number(record.hours) <= 0 || Number(record.hours) > 24) fail(400, "加班日期或小时数无效");
    if (!["fee", "compensatory"].includes(record.overtimeType || "fee")) fail(400, "加班类型无效");
  } else {
    if (!["leave", "compensatory", "shift", "sick", "personal", "annual", "marriage", "maternity", "other"].includes(record.type)) fail(400, "请假类型无效");
    const start = new Date(record.startDate), end = new Date(record.endDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(record.endDate || "") || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) fail(400, "请假起止日期无效");
    if (!Number.isFinite(Number(record.days)) || Number(record.days) <= 0 || Number(record.days) > 3660) fail(400, "请假天数无效");
    if (record.type === "compensatory" && (!Number.isFinite(Number(record.hours)) || Number(record.hours) <= 0)) fail(400, "调休小时数无效");
  }
}
function requestBusinessData(record, kind) {
  const fields = kind === "overtime" ? ["id", "employeeId", "date", "hours", "reason", "status", "overtimeType"] : ["id", "employeeId", "type", "startDate", "endDate", "days", "hours", "reason", "status"];
  const result = {};
  for (const key of fields) if (record[key] !== undefined) result[key] = record[key];
  // 旧数据可能没有这些缺省字段。浏览器计算费用不会形成业务内容变更。
  if (kind === "overtime") result.overtimeType = result.overtimeType || "fee";
  result.reason = result.reason || "";
  if (result.hours !== undefined) result.hours = Number(result.hours) || 0;
  if (kind === "leaveRequests") { result.hours = Number(result.hours) || 0; result.days = Number(result.days) || 0; }
  return result;
}
function ensureBalance(snapshot) {
  const balance = new Map();
  for (const row of snapshot.overtime) if (row.status === "approved" && row.overtimeType === "compensatory") balance.set(row.employeeId, (balance.get(row.employeeId) || 0) + (Number(row.hours) || 0));
  for (const row of snapshot.leaveRequests) if (row.status === "approved" && row.type === "compensatory") balance.set(row.employeeId, (balance.get(row.employeeId) || 0) - (Number(row.hours) || 0));
  if ([...balance.values()].some(value => value < -0.001)) fail(400, "已批准的调休小时数超过可用余额");
}
function mergeSnapshot(input, incoming, user) {
  const current = normalizeSnapshot(input);
  if (!incoming || !Array.isArray(incoming.employees)) fail(400, "快照格式无效");
  if (incoming.revision !== undefined && incoming.revision !== current.revision) fail(409, "数据已更新，请刷新后重试");
  if (user.role === "admin") {
    const next = normalizeSnapshot(incoming);
    validateRows(next.employees, "人员");
    const ids = new Set(next.employees.map(e => e.id));
    for (const key of ["attendance", "overtime", "leaveRequests"]) validateRows(next[key], key, ids);
    for (const key of ["overtime", "leaveRequests"]) next[key].forEach(r => validateRequest(r, key));
    ensureBalance(next);
    next.revision = current.revision + 1;
    return next;
  }
  const next = clone(current);
  const visible = visibleEmployees(current, user);
  const ids = new Set(visible.map(e => e.id));
  const allIds = new Set(current.employees.map(e => e.id));
  validateRows(incoming.employees, "人员");
  if (user.role === "user") {
    if (incoming.employees.length !== visible.length || incoming.employees.some(e => !ids.has(e.id))) fail(403, "只能维护自己的人员资料，不能新建或删除人员");
    for (const employee of incoming.employees) {
      const old = current.employees.find(e => e.id === employee.id);
      if (employee.phone !== undefined && employee.phone !== old.phone) fail(403, "登录手机号请联系管理员变更");
      const profile = profileData(employee);
      if (!text(profile.name)) fail(400, "姓名不能为空");
      next.employees = next.employees.map(e => e.id === old.id ? { ...e, ...profile, updatedAt: new Date().toISOString() } : e);
    }
  } else {
    for (const employee of incoming.employees) {
      if (!user.buildings.includes(employee.building) || !employee.building) fail(403, "只能维护所负责楼栋内的人员");
      if (allIds.has(employee.id) && !ids.has(employee.id)) fail(403, "不能维护其他楼栋人员");
      if (!text(employee.name)) fail(400, "姓名不能为空");
    }
    next.employees = current.employees.filter(e => !ids.has(e.id)).concat(incoming.employees.map(e => {
      const old = current.employees.find(item => item.id === e.id);
      return { ...(old || {}), ...profileData(e), id: e.id, createdAt: old ? old.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
    }));
  }
  const newIds = new Set(incoming.employees.map(e => e.id));
  for (const key of ["overtime", "leaveRequests", "attendance", "performance"]) {
    const rows = incoming[key];
    if (!Array.isArray(rows)) continue;
    validateRows(rows, key, newIds);
    const oldRows = current[key];
    if (user.role === "user") {
      if (key === "attendance" || key === "performance") {
        if (rows.length) fail(403, "无权修改此模块");
        continue;
      }
      const ownOld = oldRows.filter(r => ids.has(r.employeeId));
      const byId = new Map(rows.map(r => [r.id, r]));
      if (ownOld.some(r => !byId.has(r.id))) fail(403, "不能删除已有申请");
      for (const record of ownOld) {
        if (!isDeepStrictEqual(requestBusinessData(record, key), requestBusinessData(byId.get(record.id), key))) fail(403, "不能修改或审批已有申请");
      }
      const oldIds = new Set(oldRows.map(r => r.id));
      const additions = rows.filter(r => !ownOld.some(old => old.id === r.id));
      for (const record of additions) {
        if (oldIds.has(record.id)) fail(403, "申请编号冲突，请重试");
        if (record.employeeId !== user.employeeId || record.status !== "pending") fail(403, "只能为自己提交待审批申请");
        validateRequest(record, key);
      }
      next[key] = oldRows.concat(additions.map(record => ({ ...requestBusinessData(record, key), status: "pending", createdAt: new Date().toISOString() })));
    } else {
      for (const row of rows) {
        const old = oldRows.find(r => r.id === row.id);
        if (old && !ids.has(old.employeeId)) fail(403, "不能修改其他楼栋记录");
        if (key === "overtime" || key === "leaveRequests") validateRequest(row, key);
      }
      next[key] = oldRows.filter(r => !ids.has(r.employeeId)).concat(clone(rows));
    }
  }
  // 楼长删除本楼栋人员时一并清理关联数据；其他楼栋记录始终保留。
  const keptIds = new Set(next.employees.map(e => e.id));
  for (const key of ["overtime", "leaveRequests", "attendance", "performance"]) next[key] = next[key].filter(r => keptIds.has(r.employeeId));
  ensureBalance(next);
    next.settlements = []; // 派生结算缓存失效，按保留的业务数据重新计算。
  next.revision = current.revision + 1;
  return next;
}
function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function readJson(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], oversized = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { if (!oversized) reject(new HttpError(413, "请求内容过大")); oversized = true; chunks = []; }
      else if (!oversized) chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) return;
      try { const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); resolve(value); }
      catch { reject(new HttpError(400, "请求 JSON 格式错误")); }
    });
    req.on("error", reject);
  });
}
function checkOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.headers["sec-fetch-site"] === "cross-site") fail(403, "不接受跨站请求");
  if (req.headers.origin) {
    let origin; try { origin = new URL(req.headers.origin); } catch { fail(403, "请求来源无效"); }
    if (origin.host.toLowerCase() !== String(req.headers.host || "").toLowerCase()) fail(403, "不接受跨站请求");
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) fail(415, "请使用 application/json 请求");
}
function isLocalSetup(req) {
  const local = address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
  let hostname; try { hostname = new URL("http://" + req.headers.host).hostname; } catch { return false; }
  return local(req.socket.remoteAddress) && ["localhost", "127.0.0.1", "[::1]"].includes(hostname) && (!req.headers["x-forwarded-for"] || String(req.headers["x-forwarded-for"]).split(",").every(address => local(address.trim())));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: (await scrypt(password, salt, 64)).toString("hex") };
}
async function validPassword(password, user) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const actual = await scrypt(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function validatePassword(password, minimum = 8) {
  if (typeof password !== "string" || password.length < minimum || password.length > 256) fail(400, "密码长度应为" + minimum + "至256位");
}
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function createAuthService({ dataDir, readSnapshot, writeSnapshot }) {
  const userFile = path.join(dataDir, "auth-users.json");
  let users = Object.create(null);
  try { const data = JSON.parse(fs.readFileSync(userFile, "utf8")); for (const [key, user] of Object.entries(data)) users[key] = user; }
  catch (error) { if (error.code !== "ENOENT") throw new Error("账号文件无法读取，请检查备份和文件权限"); }
  const sessions = new Map(), attempts = new Map();
  let queue = Promise.resolve();
  function serialized(action) { const task = queue.then(action); queue = task.catch(() => {}); return task; }
  function saveUsers() { writeAtomic(userFile, users); }
  function setupRequired() { return !Object.values(users).some(u => u.role === "admin"); }
  function getUser(req) {
    const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(COOKIE + "="));
    if (!cookie) return null;
    const token = cookie.substring(COOKIE.length + 1);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now() || !Object.prototype.hasOwnProperty.call(users, session.username)) { sessions.delete(token); return null; }
    return publicUser(session.username, users[session.username]);
  }
  function startSession(req, res, username) {
    for (const [token, session] of sessions) if (session.expires < Date.now()) sessions.delete(token);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { username, expires: Date.now() + SESSION_MS });
    const secure = req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
    res.setHeader("Set-Cookie", COOKIE + "=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + SESSION_MS / 1000 + (secure ? "; Secure" : ""));
  }
  function invalidateUser(username) { for (const [token, session] of sessions) if (session.username === username) sessions.delete(token); }
  function rateLimit(req, key, max, windowMs = 10 * 60 * 1000) {
    const id = String(req.socket.remoteAddress) + ":" + key;
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const attempt = attempts.get(id) || { count: 0, until: now + windowMs };
    if (++attempt.count > max) fail(429, "操作过于频繁，请稍后重试");
    attempts.set(id, attempt);
  }
  function requireUser(req) { const user = getUser(req); if (!user) fail(401, "请先登录"); return user; }
  function requireAdmin(req) { const user = requireUser(req); if (user.role !== "admin") fail(403, "仅管理员可执行此操作"); return user; }
  async function handle(req, res, url) {
    if (!(url.startsWith("/api/auth/") || url === "/api/data/snapshot.json")) return false;
    try {
      checkOrigin(req);
      if (url === "/api/auth/status" && req.method === "GET") sendJson(res, 200, { ok: true, setupRequired: setupRequired(), setupAllowed: isLocalSetup(req) });
      else if (url === "/api/auth/session" && req.method === "GET") sendJson(res, 200, { ok: true, user: getUser(req) });
      else if (url === "/api/auth/setup" && req.method === "POST") {
        if (!isLocalSetup(req)) fail(403, "请在服务器本机使用 localhost 完成管理员初始化");
        const body = await readJson(req, 4096);
        await serialized(async () => {
          if (!setupRequired()) fail(409, "管理员已初始化，请直接登录");
          validatePassword(body.password, 12);
          const password = await hashPassword(body.password);
          users.admin = { name: "管理员", role: "admin", passwordHash: password.hash, passwordSalt: password.salt, createdAt: new Date().toISOString() };
          saveUsers();
        });
        startSession(req, res, "admin"); sendJson(res, 201, { ok: true, user: publicUser("admin", users.admin) });
      } else if (url === "/api/auth/register" && req.method === "POST") {
        rateLimit(req, "register", 20);
        const body = await readJson(req);
        const phone = text(body.phone);
        if (!PHONE.test(phone)) fail(400, "请输入有效的11位手机号");
        validatePassword(body.password);
        if (!body.employee || typeof body.employee !== "object" || Array.isArray(body.employee)) fail(400, "请填写添加人员信息表单");
        const employee = profileData(body.employee);
        if (!employee.name) fail(400, "请填写姓名");
        if (employee.phone && employee.phone !== phone) fail(400, "人员手机号必须与注册手机号一致");
        employee.phone = phone;
        await serialized(async () => {
          if (Object.prototype.hasOwnProperty.call(users, phone) || Object.values(users).some(u => u.phone === phone)) fail(409, "该手机号已注册，请直接登录");
          const snapshot = normalizeSnapshot(await readSnapshot());
          if (snapshot.employees.some(e => e.phone === phone)) fail(409, "该手机号已有人员档案，请联系管理员绑定账号");
          const password = await hashPassword(body.password);
          const id = Math.max(Date.now(), ...snapshot.employees.map(e => Number(e.id) + 1 || 1));
          const user = { name: employee.name, phone, employeeId: id, role: "user", buildings: [], passwordHash: password.hash, passwordSalt: password.salt, createdAt: new Date().toISOString() };
          snapshot.employees.push({ ...employee, id, createdAt: user.createdAt, registrationSource: "phone" });
          snapshot.revision++;
          users[phone] = user;
          try { saveUsers(); await writeSnapshot(snapshot); }
          catch (error) { delete users[phone]; saveUsers(); throw error; }
        });
        startSession(req, res, phone); sendJson(res, 201, { ok: true, user: publicUser(phone, users[phone]) });
      } else if (url === "/api/auth/login" && req.method === "POST") {
        const body = await readJson(req, 4096), username = text(body.username);
        rateLimit(req, "login-total", 100);
        rateLimit(req, "login:" + username, 15);
        if (!username || typeof body.password !== "string" || body.password.length > 256 || username.length > 100) fail(400, "账号或密码格式错误");
        const key = Object.prototype.hasOwnProperty.call(users, username) ? username : Object.keys(users).find(key => users[key].phone === username);
        const user = key ? users[key] : null;
        if (!(await validPassword(body.password, user))) fail(401, "手机号、账号或密码不正确");
        startSession(req, res, key); sendJson(res, 200, { ok: true, user: publicUser(key, user) });
      } else if (url === "/api/auth/logout" && req.method === "POST") {
        const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(COOKIE + "="));
        if (cookie) sessions.delete(cookie.substring(COOKIE.length + 1));
        res.setHeader("Set-Cookie", COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        sendJson(res, 200, { ok: true });
      } else if (url === "/api/auth/password" && req.method === "POST") {
        const current = requireUser(req), body = await readJson(req, 4096);
        rateLimit(req, "password:" + current.username, 15);
        validatePassword(body.newPassword, current.role === "admin" ? 12 : 8);
        await serialized(async () => {
          if (typeof body.oldPassword !== "string" || !(await validPassword(body.oldPassword, users[current.username]))) fail(400, "原密码错误");
          const password = await hashPassword(body.newPassword);
          users[current.username].passwordHash = password.hash; users[current.username].passwordSalt = password.salt; saveUsers();
          invalidateUser(current.username);
        });
        startSession(req, res, current.username); sendJson(res, 200, { ok: true });
      } else if (url === "/api/auth/users" && req.method === "GET") {
        requireAdmin(req);
        const result = Object.create(null); for (const [key, user] of Object.entries(users)) result[key] = { ...publicUser(key, user), createdAt: user.createdAt };
        sendJson(res, 200, { ok: true, users: result });
      } else if (url === "/api/auth/legacy-backup" && req.method === "POST") {
        const actor = requireUser(req);
        rateLimit(req, "legacy-backup:" + actor.username, 5, 60 * 60 * 1000);
        const body = await readJson(req);
        if (!body.snapshot || !Array.isArray(body.snapshot.employees)) fail(400, "旧资料快照格式无效");
        // 只保存该浏览器上传的独立恢复副本，不写入在线资料和账号。
        const snapshot = {};
        for (const key of [...COLLECTIONS, "orgStructure", "exportedAt"]) if (body.snapshot[key] !== undefined) snapshot[key] = body.snapshot[key];
        if (body.users && typeof body.users === "object" && !Array.isArray(body.users)) {
          const entries = Object.entries(body.users);
          if (entries.length > 200) fail(400, "旧账号数量超过单次备份上限，请联系管理员");
          snapshot.legacyUsers = Object.create(null);
          for (const [username, old] of entries) {
            if (!/^[a-zA-Z0-9_@.\-\u4e00-\u9fa5]{1,80}$/.test(username) || ["__proto__", "constructor", "prototype"].includes(username) || !old || typeof old !== "object") continue;
            if (typeof old.password !== "string" || !old.password || old.password.length > 256 || old.authType === "wechat" || old.authType === "feishu") continue;
            const password = await hashPassword(old.password);
            snapshot.legacyUsers[username] = {
              username, name: text(old.name).slice(0, 100) || username,
              role: ["admin", "leader", "user"].includes(old.role) ? old.role : "user",
              employeeId: positiveId(old.employeeId) ? old.employeeId : null,
              phone: PHONE.test(text(old.phone)) ? text(old.phone) : (PHONE.test(username) ? username : ""),
              buildings: Array.isArray(old.buildings) ? [...new Set(old.buildings.filter(b => typeof b === "string" && b.trim() && b.length <= 100).map(b => b.trim()))].slice(0, 100) : [],
              passwordHash: password.hash, passwordSalt: password.salt
            };
          }
        }
        await serialized(async () => {
          // 每个账号最多保留五份，文件名不暴露账号或手机号；旧版本按最早写入顺序轮换。
          const backupDir = path.join(dataDir, "legacy-browser-backup-" + crypto.createHash("sha256").update(actor.username).digest("hex").slice(0, 24));
          fs.mkdirSync(backupDir, { recursive: true });
          const candidates = Array.from({ length: 5 }, (_, i) => path.join(backupDir, "snapshot-" + i + ".json"));
          const target = candidates.find(file => !fs.existsSync(file)) || candidates.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)[0];
          writeAtomic(target, snapshot);
        });
        sendJson(res, 201, { ok: true });
      } else if (url === "/api/auth/users" && req.method === "POST") {
        const actor = requireAdmin(req), body = await readJson(req, 16384);
        const username = text(body.username);
        if (!/^[a-zA-Z0-9_@.\-\u4e00-\u9fa5]{1,80}$/.test(username) || ["__proto__", "constructor", "prototype"].includes(username)) fail(400, "账号格式无效");
        await serialized(async () => {
          const old = users[username];
          const role = body.role === undefined && old ? old.role : body.role;
          if (!["admin", "leader", "user"].includes(role)) fail(400, "角色无效");
          if (username === actor.username && role !== "admin") fail(400, "不能取消当前管理员权限");
          if (username === "admin" && role !== "admin") fail(400, "默认管理员角色不能更改");
          const name = body.name === undefined && old ? old.name : text(body.name);
          if (!name || name.length > 100) fail(400, "请填写姓名");
          let phone = body.phone === undefined && old ? old.phone || "" : text(body.phone);
          if (phone && !PHONE.test(phone)) fail(400, "手机号格式不正确");
          if (phone && Object.entries(users).some(([key, user]) => key !== username && (key === phone || user.phone === phone))) fail(409, "手机号已被其他账号使用");
          let employeeId = body.employeeId === undefined && old ? old.employeeId : body.employeeId;
          if (employeeId === "" || employeeId === null) employeeId = null;
          const snapshot = normalizeSnapshot(await readSnapshot());
          if (employeeId != null && (!positiveId(employeeId) || !snapshot.employees.some(e => e.id === employeeId))) fail(400, "绑定的人员不存在");
          if (employeeId && Object.entries(users).some(([key, user]) => key !== username && user.employeeId === employeeId)) fail(409, "该人员已有绑定账号");
          const employee = employeeId ? snapshot.employees.find(e => e.id === employeeId) : null;
          if (!phone && employee && PHONE.test(text(employee.phone))) phone = text(employee.phone);
          if (PHONE.test(username)) {
            if (phone && phone !== username) fail(400, "手机号登录账号须与账号手机号一致");
            phone = username;
          }
          if (old && old.phone && phone !== old.phone) fail(400, "暂不支持更换已有账号的登录手机号，请保留原手机号");
          if (employee && phone && !employee.phone) fail(400, "请先在所选人员档案中填写相同的手机号，再关联登录账号");
          if (employee && employee.phone && phone && employee.phone !== phone) fail(400, "登录手机号与所选人员档案手机号不一致，请核对关联人员");
          if (phone && Object.entries(users).some(([key, user]) => key !== username && (key === phone || user.phone === phone))) fail(409, "手机号已被其他账号使用");
          const buildings = role === "leader" ? (body.buildings === undefined && old ? old.buildings || [] : body.buildings) : [];
          if (!Array.isArray(buildings) || buildings.some(b => typeof b !== "string" || !b.trim() || b.length > 100) || (role === "leader" && !buildings.length)) fail(400, "请为楼长分配负责楼栋");
          const user = { ...(old || {}), name, phone, role, employeeId: employeeId || null, buildings: [...new Set(buildings.map(b => b.trim()))], createdAt: old ? old.createdAt : new Date().toISOString() };
          if (body.password) { validatePassword(body.password, role === "admin" ? 12 : 8); const password = await hashPassword(body.password); user.passwordHash = password.hash; user.passwordSalt = password.salt; }
          else if (!old) fail(400, "新账号必须设置密码");
          users[username] = user; saveUsers();
          if (body.password) invalidateUser(username);
        });
        if (body.password && username === actor.username) startSession(req, res, username);
        sendJson(res, 200, { ok: true, user: publicUser(username, users[username]) });
      } else if (url.startsWith("/api/auth/users/") && req.method === "DELETE") {
        const actor = requireAdmin(req), username = decodeURIComponent(url.substring("/api/auth/users/".length));
        if (username === "admin" || username === actor.username) fail(400, "不能删除默认管理员或当前账号");
        await serialized(async () => { if (!Object.prototype.hasOwnProperty.call(users, username)) fail(404, "账号不存在"); delete users[username]; saveUsers(); invalidateUser(username); });
        sendJson(res, 200, { ok: true });
      } else if (url === "/api/data/snapshot.json" && req.method === "GET") {
        const user = requireUser(req);
        await queue;
        sendJson(res, 200, scopedSnapshot(await readSnapshot(), user));
      } else if (url === "/api/data/snapshot.json" && req.method === "POST") {
        const user = requireUser(req), incoming = await readJson(req);
        const result = await serialized(async () => {
          // 进入写队列后重新读取权限，避免排队期间已被撤权的请求继续写入。
          const currentUser = requireUser(req);
          const next = mergeSnapshot(await readSnapshot(), incoming, currentUser);
          for (const account of Object.values(users)) {
            const employee = next.employees.find(e => e.id === account.employeeId);
            if (employee && account.phone && String(employee.phone || "") !== account.phone) fail(403, "请通过账号管理变更登录手机号");
          }
          await writeSnapshot(next);
          let namesChanged = false;
          for (const account of Object.values(users)) {
            const employee = next.employees.find(e => e.id === account.employeeId);
            if (employee && employee.name && employee.name !== account.name) { account.name = employee.name; namesChanged = true; }
          }
          if (namesChanged) saveUsers();
          return next;
        });
        sendJson(res, 200, { ok: true, status: "ok", revision: result.revision, user: getUser(req) });
      } else sendJson(res, 405, { ok: false, message: "不支持的请求方式或接口" });
    } catch (error) { sendJson(res, error.status || 500, { ok: false, status: "error", message: error.status ? error.message : "服务器处理失败，请稍后重试" }); }
    return true;
  }
  return { handle, getUser, requireUser, requireAdmin, checkOrigin, serialized };
}

// 静态服务只开放应用资源，任何服务端配置、数据、隐藏路径均不能直接下载。
function staticFile(root, requestPath) {
  let decoded; try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some(part => part.startsWith("."))) return null;
  const allowed = /^\/(?:index\.html|login\.html|status\.html|manifest\.json|sw\.js|icon-(?:192|512)\.png|login-bg\.png|(?:js|css)\/[\w.-]+\.(?:js|css))$/;
  if (!allowed.test(decoded)) return null;
  const file = path.resolve(root, "." + decoded);
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}

module.exports = { createAuthService, emptySnapshot, scopedSnapshot, mergeSnapshot, staticFile, readJson, sendJson, writeAtomic, HttpError };
