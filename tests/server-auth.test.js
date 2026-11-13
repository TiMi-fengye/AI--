"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { emptySnapshot, scopedSnapshot, mergeSnapshot, staticFile } = require("../server/auth-service");

let directory, server, base;
const password = "test-account-Password-2026";
async function request(route, method = "GET", body, cookie = "", extraHeaders = {}) {
  const response = await fetch(base + route, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual"
  });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
}
async function login(username) {
  const response = await request("/api/auth/login", "POST", { username, password });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.cookie;
}
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-auth-tests-"));
  process.env.HR_DATA_DIR = directory;
  process.env.HR_NO_OPEN = "1";
  process.env.HR_SMS_ENABLED = "false";
  ({ server } = require("../server/server"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("匿名数据被拒绝，管理员初始化仅本机并哈希保存密码", async () => {
  assert.equal((await request("/api/data/snapshot.json")).status, 401);
  assert.equal((await request("/api/auth/session")).data.user, null);
  assert.equal((await request("/api/auth/status")).data.setupRequired, true);
  assert.equal((await request("/api/auth/setup", "POST", { password }, "", { "X-Forwarded-For": "203.0.113.9" })).status, 403);
  assert.equal((await request("/api/auth/setup", "POST", { password: "short" })).status, 400);
  const setup = await request("/api/auth/setup", "POST", { password });
  assert.equal(setup.status, 201); assert.match(setup.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  const saved = fs.readFileSync(path.join(directory, "auth-users.json"), "utf8");
  assert.ok(!saved.includes(password)); assert.match(saved, /passwordHash/);
  assert.equal((await request("/api/auth/setup", "POST", { password })).status, 409);
});

test("注册须姓名手机号及密码，六个可选组织字段为空，不能自授管理员", async () => {
  assert.equal((await request("/api/auth/register", "POST", { phone: "13800000001", password })).status, 400);
  assert.equal((await request("/api/auth/register", "POST", { phone: "13800000001", password, employee: {} })).status, 400);
  assert.equal((await request("/api/auth/register", "POST", { phone: "123", password, employee: { name: "同名测试" } })).status, 400);
  assert.equal((await request("/api/auth/register", "POST", { phone: "13800000001", password: "short", employee: { name: "同名测试" } })).status, 400);
  const fields = { name: "同名测试", company: "", personAttribute: "", workAttribute: "", department: "", status: "", building: "" };
  const registered = await request("/api/auth/register", "POST", { phone: "13800000001", password, role: "admin", buildings: ["楼栋A"], employee: { ...fields, role: "admin" } });
  assert.equal(registered.status, 201); assert.equal(registered.data.user.role, "user"); assert.deepEqual(registered.data.user.buildings, []);
  const own = await request("/api/data/snapshot.json", "GET", undefined, registered.cookie);
  assert.equal(own.data.employees.length, 1); assert.equal(own.data.employees[0].phone, "13800000001");
  for (const field of ["company", "personAttribute", "workAttribute", "department", "status", "building"]) assert.equal(own.data.employees[0][field], "");
  assert.equal(own.data.employees[0].role, undefined);
  assert.equal((await request("/api/auth/register", "POST", { phone: "13800000001", password, employee: fields })).status, 409);
});

test("同名账号按人员ID隔离，自己的资料可更新但不能改登录手机号", async () => {
  const second = await request("/api/auth/register", "POST", { phone: "13800000002", password, employee: { name: "同名测试" } });
  assert.equal(second.status, 201);
  const firstCookie = await login("13800000001");
  const mine = (await request("/api/data/snapshot.json", "GET", undefined, firstCookie)).data;
  assert.equal(mine.employees.length, 1); assert.notEqual(mine.employees[0].id, second.data.user.employeeId);
  mine.employees[0].email = "test@example.com";
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, firstCookie)).status, 200);
  const changed = (await request("/api/data/snapshot.json", "GET", undefined, firstCookie)).data;
  assert.equal(changed.employees[0].email, "test@example.com");
  changed.employees[0].phone = "13800000003";
  assert.equal((await request("/api/data/snapshot.json", "POST", changed, firstCookie)).status, 403);
  changed.employees[0].id = second.data.user.employeeId;
  assert.equal((await request("/api/data/snapshot.json", "POST", changed, firstCookie)).status, 403);
});

test("用户可提交自己的申请，不能自审批、修改、删除或提交他人申请", async () => {
  const cookie = await login("13800000001");
  let mine = (await request("/api/data/snapshot.json", "GET", undefined, cookie)).data;
  const id = Date.now();
  mine.overtime.push({ id, employeeId: mine.employees[0].id, date: "2026-11-11", hours: 2, overtimeType: "compensatory", reason: "测试", status: "pending", otPay: 0, otRate: "调休加班", createdAt: new Date().toISOString() });
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, cookie)).status, 200);
  mine = (await request("/api/data/snapshot.json", "GET", undefined, cookie)).data;
  assert.equal(mine.overtime[0].otPay, undefined);
  mine.overtime[0].status = "approved";
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, cookie)).status, 403);
  mine.overtime[0].status = "pending"; mine.overtime[0].hours = 8;
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, cookie)).status, 403);
  mine.overtime = [];
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, cookie)).status, 403);
  mine = (await request("/api/data/snapshot.json", "GET", undefined, cookie)).data;
  mine.overtime.push({ id: id + 1, employeeId: 99999, date: "2026-11-11", hours: 2, status: "pending" });
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, cookie)).status, 403);
  assert.equal((await request("/api/auth/users", "GET", undefined, cookie)).status, 403);
  assert.equal((await request("/api/feishu/config", "GET", undefined, cookie)).status, 403);
});

test("楼长只读写本楼栋，其他楼栋资料和记录在合并后仍保留", async () => {
  const admin = await login("admin");
  let snapshot = (await request("/api/data/snapshot.json", "GET", undefined, admin)).data;
  snapshot.employees.push({ id: 1, name: "楼栋A测试", phone: "13800000004", building: "楼栋A" }, { id: 2, name: "楼栋B测试", building: "楼栋B" });
  snapshot.attendance.push({ id: 1, employeeId: 1, date: "2026-11-11" }, { id: 2, employeeId: 2, date: "2026-11-11" });
  snapshot.overtime.push({ id: 1, employeeId: 1, date: "2026-11-11", hours: 2, status: "pending" }, { id: 2, employeeId: 2, date: "2026-11-11", hours: 4, status: "pending" });
  snapshot.orgStructure = { name: "秘密组织", children: [{ name: "其他楼栋人员" }] };
  assert.equal((await request("/api/data/snapshot.json", "POST", snapshot, admin)).status, 200);
  assert.equal((await request("/api/auth/register", "POST", { phone: "13800000004", password, employee: { name: "试图接管" } })).status, 409);
  assert.equal((await request("/api/auth/users", "POST", { username: "leaderA", name: "A楼长", password, role: "leader", buildings: ["楼栋A"], employeeId: 1 }, admin)).status, 200);
  const leader = await login("leaderA");
  let mine = (await request("/api/data/snapshot.json", "GET", undefined, leader)).data;
  assert.deepEqual(mine.employees.map(e => e.id), [1]); assert.deepEqual(mine.attendance.map(r => r.employeeId), [1]); assert.deepEqual(mine.overtime.map(r => r.employeeId), [1]);
  assert.ok(!JSON.stringify(mine).includes("其他楼栋人员"));
  mine.employees[0].building = "楼栋B";
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, leader)).status, 403);
  mine.employees[0].building = "楼栋A"; mine.overtime[0].status = "approved";
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, leader)).status, 200);
  snapshot = (await request("/api/data/snapshot.json", "GET", undefined, admin)).data;
  assert.equal(snapshot.employees.find(e => e.id === 2).name, "楼栋B测试");
  assert.equal(snapshot.overtime.find(r => r.id === 2).status, "pending");
  assert.equal(snapshot.overtime.find(r => r.id === 1).status, "approved");
  mine = (await request("/api/data/snapshot.json", "GET", undefined, leader)).data;
  mine.overtime.push({ id: 2, employeeId: 1, date: "2026-11-11", hours: 4, status: "approved" });
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, leader)).status, 403);
});

test("快照版本冲突返回409，跨站写入被拒绝，会话退出后失效", async () => {
  const cookie = await login("13800000001");
  const mine = (await request("/api/data/snapshot.json", "GET", undefined, cookie)).data;
  const stale = structuredClone(mine);
  assert.equal((await request("/api/data/snapshot.json", "POST", mine, cookie)).status, 200);
  assert.equal((await request("/api/data/snapshot.json", "POST", stale, cookie)).status, 409);
  assert.equal((await request("/api/auth/logout", "POST", {}, cookie, { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await request("/api/auth/logout", "POST", {}, cookie)).status, 200);
  assert.equal((await request("/api/data/snapshot.json", "GET", undefined, cookie)).status, 401);
});

test("已登录远程浏览器可独立备份旧资料和哈希账号，不替换在线数据或保存明文密码", async () => {
  const cookie = await login("13800000001");
  const previous = (await request("/api/data/snapshot.json", "GET", undefined, cookie)).data;
  const backup = { snapshot: { employees: [{ id: 99999, name: "仅旧备份" }], users: { leaked: { password } } }, users: { leaked: { password } } };
  assert.equal((await request("/api/auth/legacy-backup", "POST", backup)).status, 401);
  assert.equal((await request("/api/auth/legacy-backup", "POST", backup, cookie, { "X-Forwarded-For": "203.0.113.1" })).status, 201);
  const folders = fs.readdirSync(directory).filter(file => file.startsWith("legacy-browser-backup-"));
  assert.equal(folders.length, 1);
  const folder = path.join(directory, folders[0]);
  assert.ok(!folders[0].includes("13800000001"));
  const files = fs.readdirSync(folder);
  const content = fs.readFileSync(path.join(folder, files[0]), "utf8");
  assert.ok(content.includes("仅旧备份")); assert.ok(!content.includes(password));
  assert.match(content, /passwordHash/); assert.match(content, /passwordSalt/);
  assert.equal(JSON.parse(content).legacyUsers.leaked.role, "user");
  assert.deepEqual((await request("/api/data/snapshot.json", "GET", undefined, cookie)).data, previous);
  const admin = await login("admin");
  assert.equal((await request("/api/auth/users", "GET", undefined, admin)).data.users.leaked, undefined);
  for (let i = 0; i < 4; i++) assert.equal((await request("/api/auth/legacy-backup", "POST", backup, cookie)).status, 201);
  assert.equal(fs.readdirSync(folder).length, 5);
  assert.equal((await request("/api/auth/legacy-backup", "POST", backup, cookie)).status, 429);
});

test("管理员账号绑定须匹配人员手机号，修改档案不能使登录手机号失配", async () => {
  const admin = await login("admin");
  assert.equal((await request("/api/auth/users", "POST", { username: "13800000008", name: "错误手机号绑定", password, role: "user", employeeId: 1, phone: "13800000008" }, admin)).status, 409);
  // 1号已绑定楼长；新增未绑定档案单独验证手机号一致性。
  let snapshot = (await request("/api/data/snapshot.json", "GET", undefined, admin)).data;
  snapshot.employees.push({ id: 8, name: "绑定一致性", phone: "13800000008", building: "楼栋A" });
  assert.equal((await request("/api/data/snapshot.json", "POST", snapshot, admin)).status, 200);
  assert.equal((await request("/api/auth/users", "POST", { username: "13800000009", name: "错误绑定", password, role: "user", employeeId: 8, phone: "13800000009" }, admin)).status, 400);
  assert.equal((await request("/api/auth/users", "POST", { username: "bound8", name: "正确绑定", password, role: "user", employeeId: 8 }, admin)).status, 200);
  const users = (await request("/api/auth/users", "GET", undefined, admin)).data.users;
  assert.equal(users.bound8.phone, "13800000008");
  snapshot = (await request("/api/data/snapshot.json", "GET", undefined, admin)).data;
  snapshot.employees.find(e => e.id === 8).phone = "13800000009";
  assert.equal((await request("/api/data/snapshot.json", "POST", snapshot, admin)).status, 403);
});

test("服务端文件、旧数据接口及编码路径均不可绕过权限，第三方登录已停用", async () => {
  const admin = await login("admin");
  for (const url of ["/server/server.js", "/server/config.json", "/server/data/auth-users.json", "/%73erver/data/auth-users.json", "/.git/config", "/js/../server/data/snapshot.json", "/api/data/auth-users.json"]) {
    const result = await request(url, "GET", undefined, admin);
    assert.equal(result.status, 404, url);
  }
  for (const url of ["/api/wechat/auth-url", "/api/wechat/login-config", "/api/feishu/login-config", "/api/feishu/auth-code"]) assert.equal((await request(url)).status, 410);
  assert.equal((await request("/login.html")).status, 200);
  assert.equal(staticFile(directory, "/server/data/auth-users.json"), null);
  assert.equal(staticFile(directory, "/js/%2e%2e/server.js"), null);
});

test("范围合并不接受普通用户新增人员，调休审批不能透支小时数", () => {
  const source = { ...emptySnapshot(), employees: [{ id: 1, name: "个人", phone: "13800000009", building: "楼栋A" }], leaveRequests: [{ id: 1, employeeId: 1, type: "compensatory", startDate: "2026-11-11", endDate: "2026-11-11", days: 1, hours: 2, status: "pending" }] };
  const user = { role: "user", employeeId: 1, buildings: [] };
  const own = scopedSnapshot(source, user);
  own.employees.push({ id: 2, name: "越权新增" });
  assert.throws(() => mergeSnapshot(source, own, user), /只能维护/);
  const leader = { role: "leader", employeeId: 1, buildings: ["楼栋A"] };
  const scope = scopedSnapshot(source, leader);
  scope.leaveRequests[0].status = "approved";
  assert.throws(() => mergeSnapshot(source, scope, leader), /超过可用余额/);
});

test("管理员通过账号接口重设本人密码后返回新的有效会话", async () => {
  const oldCookie = await login("admin");
  const response = await request("/api/auth/users", "POST", { username: "admin", password }, oldCookie);
  assert.equal(response.status, 200);
  assert.ok(response.cookie && response.cookie !== oldCookie);
  assert.equal((await request("/api/auth/users", "GET", undefined, response.cookie)).status, 200);
  assert.equal((await request("/api/auth/users", "GET", undefined, oldCookie)).status, 401);
});
