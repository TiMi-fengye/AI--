"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { createAuthService, emptySnapshot, staticFile } = require("../server/auth-service");

const password = "organization-test-Password-2026";
const optionKeys = ["companies", "personAttributes", "workAttributes", "positions", "departments", "statuses", "buildings", "regions", "rooms"];
const initialSnapshot = {
  ...emptySnapshot(),
  revision: 8,
  departments: ["既有部门", "尚无人员部门"],
  employees: [
    { id: 1, name: "测试人员甲", phone: "13800000001", company: "既有单位", personAttribute: "既有人员属性", workAttribute: "既有工作属性", position: "既有岗位", department: "既有部门", status: "在职", building: "第一楼", region: "既有大区", room: "既有机房" },
    { id: 2, name: "测试人员乙", phone: "13800000002", company: "第二单位", personAttribute: "其他属性", workAttribute: "其他工作属性", position: "其他岗位", department: "其他部门", status: "离职", building: "第二楼", region: "其他大区", room: "其他机房" }
  ]
};
const configured = {
  schemaVersion: 1, revision: 3,
  options: {
    companies: ["配置单位", "尚无人员单位"], personAttributes: ["配置属性"], workAttributes: ["配置班次"],
    positions: ["配置岗位"], departments: ["配置部门"], statuses: ["配置状态"],
    buildings: ["第一楼", "第二楼", "未使用楼栋"], regions: ["配置大区"], rooms: ["配置机房"]
  },
  buildingLeaders: [{ building: "第一楼", leaders: ["第一楼负责人"] }, { building: "第二楼", leaders: "第二楼负责人" }, { building: "未使用楼栋", leaders: "预设负责人" }]
};

async function fixture(t, settings, accounts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-organization-tests-"));
  const organizationFile = path.join(directory, "organization-settings.json");
  if (settings) fs.writeFileSync(organizationFile, JSON.stringify(settings));
  if (accounts) fs.writeFileSync(path.join(directory, "auth-users.json"), JSON.stringify(accounts));
  let snapshot = structuredClone(initialSnapshot), writes = 0;
  const service = createAuthService({ dataDir: directory, readSnapshot: async () => structuredClone(snapshot), writeSnapshot: async value => { writes++; snapshot = structuredClone(value); } });
  const server = http.createServer(async (req, res) => { if (!(await service.handle(req, res, new URL(req.url, "http://localhost").pathname))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, method = "GET", body, cookie = "", extraHeaders = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^hr-organization-tests-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const setup = await request("/api/auth/setup", "POST", { password });
  assert.equal(setup.status, 201);
  async function account(username, role, buildings, employeeId) {
    const created = await request("/api/auth/users", "POST", { username, password, name: username + "测试账号", role, buildings, employeeId }, setup.cookie);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const loggedIn = await request("/api/auth/login", "POST", { username, password });
    assert.equal(loggedIn.status, 200);
    return loggedIn.cookie;
  }
  return { request, account, admin: setup.cookie, organizationFile, service, directory, get snapshot() { return snapshot; }, get writes() { return writes; } };
}

test("未配置下拉项时从既有人员和部门推导，不产生示例值或暴露人员资料", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/organization/options");
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.data).sort(), ["ok", "options"]);
  assert.deepEqual(Object.keys(response.data.options).sort(), optionKeys.slice().sort());
  assert.deepEqual(response.data.options.companies, ["既有单位", "第二单位"]);
  assert.deepEqual(response.data.options.departments, ["既有部门", "尚无人员部门", "其他部门"]);
  assert.deepEqual(response.data.options.buildings, ["第一楼", "第二楼"]);
  assert.doesNotMatch(JSON.stringify(response.data), /测试人员|1380000000|公司A|属性A|楼栋A|password/);
  assert.equal(fs.existsSync(f.organizationFile), false);
  assert.equal(f.writes, 0);
});

test("独立配置保留原选项和空楼栋，旧手填楼长姓名不再展示且不公开", async t => {
  const f = await fixture(t, configured);
  const publicOptions = await f.request("/api/organization/options");
  assert.deepEqual(publicOptions.data.options, configured.options);
  assert.doesNotMatch(JSON.stringify(publicOptions.data), /负责人|buildingLeaders/);
  const all = await f.request("/api/organization/settings", "GET", undefined, f.admin);
  assert.equal(all.status, 200);
  assert.equal(all.data.revision, 3);
  assert.deepEqual(all.data.options.buildings, ["第一楼", "第二楼", "未使用楼栋"]);
  assert.deepEqual(all.data.buildingLeaders, []);
  assert.doesNotMatch(JSON.stringify(all.data), /负责人/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.organizationFile, "utf8")), configured);
  assert.deepEqual(f.snapshot, initialSnapshot);
  assert.equal(f.writes, 0);
  assert.equal(staticFile(f.directory, "/server/data/organization-settings.json"), null);
});

test("楼长只接收负责楼栋及对应负责人，普通人员不接收楼长资料，写配置仅管理员", async t => {
  const f = await fixture(t, configured);
  const leader = await f.account("leader", "leader", ["第一楼"], 1);
  const user = await f.account("member", "user", [], 2);
  assert.equal((await f.request("/api/organization/settings")).status, 401);
  const leaderSettings = await f.request("/api/organization/settings", "GET", undefined, leader);
  assert.equal(leaderSettings.status, 200);
  assert.deepEqual(leaderSettings.data.options.buildings, ["第一楼"]);
  assert.deepEqual(leaderSettings.data.buildingLeaders, [{ building: "第一楼", leaders: "测试人员甲" }]);
  assert.doesNotMatch(JSON.stringify(leaderSettings.data), /第二楼|预设负责人/);
  assert.deepEqual((await f.request("/api/organization/options", "GET", undefined, leader)).data.options.buildings, ["第一楼"]);
  const own = await f.request("/api/organization/settings", "GET", undefined, user);
  assert.equal(own.status, 200); assert.deepEqual(own.data.buildingLeaders, []);
  assert.doesNotMatch(JSON.stringify(own.data), /负责人/);
  const change = { revision: 3, options: { companies: ["越权修改"] } };
  for (const cookie of [leader, user]) assert.equal((await f.request("/api/organization/settings", "POST", change, cookie)).status, 403);
  assert.equal((await f.request("/api/organization/settings", "POST", change)).status, 401);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.organizationFile, "utf8")), configured);
});

test("管理员持久化配置不改人员或账号权限，保留未更新字段并拒绝旧版本与跨站写入", async t => {
  const f = await fixture(t, configured);
  const beforeUsers = fs.readFileSync(path.join(f.directory, "auth-users.json"), "utf8");
  const update = { revision: 3, options: { companies: ["  恢复单位  ", "恢复单位", ""], statuses: [] } };
  const original = fs.readFileSync(f.organizationFile, "utf8");
  const manual = await f.request("/api/organization/settings", "POST", { ...update, buildingLeaders: [{ building: "第一楼", leaders: "手填负责人" }] }, f.admin);
  assert.equal(manual.status, 400); assert.match(manual.data.message, /账号权限自动同步/);
  assert.equal(fs.readFileSync(f.organizationFile, "utf8"), original);
  assert.equal((await f.request("/api/organization/settings", "POST", update, f.admin, { Origin: "https://other.example" })).status, 403);
  const saved = await f.request("/api/organization/settings", "POST", update, f.admin);
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 4);
  assert.deepEqual(saved.data.options.companies, ["恢复单位"]);
  assert.deepEqual(saved.data.options.statuses, []);
  assert.deepEqual(saved.data.options.buildings, configured.options.buildings);
  assert.deepEqual(saved.data.buildingLeaders, []);
  const persisted = JSON.parse(fs.readFileSync(f.organizationFile, "utf8"));
  assert.equal(persisted.revision, 4);
  assert.deepEqual(persisted.options.companies, ["恢复单位"]);
  assert.equal((await f.request("/api/organization/settings", "POST", update, f.admin)).status, 409);
  assert.deepEqual(f.snapshot, initialSnapshot); assert.equal(f.writes, 0);
  assert.equal(fs.readFileSync(path.join(f.directory, "auth-users.json"), "utf8"), beforeUsers);
});

test("损坏配置拒绝读取和覆盖，格式错误的写入不能破坏已有配置", async t => {
  const f = await fixture(t, configured);
  const original = fs.readFileSync(f.organizationFile, "utf8");
  for (const invalid of [
    { options: { companies: ["漏传版本"] } },
    { revision: 3, options: [] },
    { revision: 3, options: { companies: "错误类型" } },
    { revision: 3, buildingLeaders: [{ building: "第一楼", leaders: [123] }] },
    { revision: 3, buildingLeaders: [{ building: "第一楼", leaders: "甲" }, { building: "第一楼", leaders: "乙" }] }
  ]) assert.equal((await f.request("/api/organization/settings", "POST", invalid, f.admin)).status, 400);
  assert.equal(fs.readFileSync(f.organizationFile, "utf8"), original);
  fs.writeFileSync(f.organizationFile, "{invalid-json");
  assert.equal((await f.request("/api/organization/options")).status, 500);
  assert.equal((await f.request("/api/organization/settings", "POST", { revision: 3, options: {} }, f.admin)).status, 500);
  assert.equal(fs.readFileSync(f.organizationFile, "utf8"), "{invalid-json");
});

test("并发管理员配置写入按版本串行，楼长姓名优先绑定人员而非账号别名", async t => {
  const f = await fixture(t);
  await f.account("existing-leader", "leader", ["第一楼"], 1);
  const inferred = await f.request("/api/organization/settings", "GET", undefined, f.admin);
  assert.deepEqual(inferred.data.buildingLeaders, [{ building: "第一楼", leaders: "测试人员甲" }]);
  const [first, second] = await Promise.all([
    f.request("/api/organization/settings", "POST", { revision: 0, options: { companies: ["第一个修改"] } }, f.admin),
    f.request("/api/organization/settings", "POST", { revision: 0, options: { companies: ["第二个修改"] } }, f.admin)
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(JSON.parse(fs.readFileSync(f.organizationFile, "utf8")).revision, 1);
  assert.deepEqual(f.snapshot, initialSnapshot); assert.equal(f.writes, 0);
});

test("楼长任命、姓名维护、换楼、撤任和删除实时投影，不修改手填配置或要求保持在线", async t => {
  const f = await fixture(t, configured);
  const original = fs.readFileSync(f.organizationFile, "utf8");
  const first = await f.account("first-leader", "leader", ["第一楼"], 1);
  await f.account("co-leader", "leader", ["第一楼"]);
  const view = async () => (await f.request("/api/organization/settings", "GET", undefined, f.admin)).data.buildingLeaders;
  assert.deepEqual(await view(), [{ building: "第一楼", leaders: "测试人员甲、co-leader测试账号" }]);
  const own = await f.request("/api/data/snapshot.json", "GET", undefined, first);
  own.data.employees.find(employee => employee.id === 1).name = "更新后的楼长姓名";
  assert.equal((await f.request("/api/data/snapshot.json", "POST", own.data, first)).status, 200);
  assert.deepEqual(await view(), [{ building: "第一楼", leaders: "更新后的楼长姓名、co-leader测试账号" }]);
  assert.equal((await f.request("/api/auth/users", "POST", { username: "co-leader", name: "换楼后的楼长", buildings: ["第二楼"] }, f.admin)).status, 200);
  assert.deepEqual(await view(), [{ building: "第一楼", leaders: "更新后的楼长姓名" }, { building: "第二楼", leaders: "换楼后的楼长" }]);
  assert.equal((await f.request("/api/auth/users", "POST", { username: "first-leader", role: "user" }, f.admin)).status, 200);
  assert.deepEqual(await view(), [{ building: "第二楼", leaders: "换楼后的楼长" }]);
  assert.deepEqual((await f.request("/api/organization/settings", "GET", undefined, first)).data.buildingLeaders, []);
  const replacement = await f.account("replacement", "leader", ["第一楼"], 2);
  assert.deepEqual(await view(), [{ building: "第二楼", leaders: "换楼后的楼长" }, { building: "第一楼", leaders: "测试人员乙" }]);
  assert.equal((await f.request("/api/auth/users/co-leader", "DELETE", {}, f.admin)).status, 200);
  assert.equal((await f.request("/api/auth/logout", "POST", {}, replacement)).status, 200);
  assert.deepEqual(await view(), [{ building: "第一楼", leaders: "测试人员乙" }]);
  assert.equal(fs.readFileSync(f.organizationFile, "utf8"), original);
  // Only the explicit profile edit writes business data; viewing/changing
  // assignments never uploads a replacement personnel snapshot.
  assert.equal(f.writes, 1);
});

test("手机号注册不能自报楼长，管理员授权后登录自动纳入名单且公开接口不泄露姓名", async t => {
  const f = await fixture(t, configured);
  const phone = "13800000003";
  const registered = await f.request("/api/auth/register", "POST", {
    phone, password, role: "leader", buildings: ["第一楼"],
    employee: { name: "新注册楼长姓名", position: "楼长", building: "第一楼", role: "leader" }
  });
  assert.equal(registered.status, 201); assert.equal(registered.data.user.role, "user");
  const view = async () => (await f.request("/api/organization/settings", "GET", undefined, f.admin)).data.buildingLeaders;
  assert.deepEqual(await view(), []);
  assert.equal((await f.request("/api/auth/users", "POST", { username: phone, role: "leader", buildings: ["第一楼"] }, registered.cookie)).status, 403);
  const promoted = await f.request("/api/auth/users", "POST", { username: phone, role: "leader", buildings: ["第一楼"] }, f.admin);
  assert.equal(promoted.status, 200);
  const login = await f.request("/api/auth/login", "POST", { username: phone, password });
  assert.equal(login.status, 200); assert.equal(login.data.user.role, "leader");
  assert.deepEqual(await view(), [{ building: "第一楼", leaders: "新注册楼长姓名" }]);
  assert.deepEqual((await f.request("/api/organization/settings", "GET", undefined, login.cookie)).data.buildingLeaders, [{ building: "第一楼", leaders: "新注册楼长姓名" }]);
  const ordinary = await f.account("ordinary", "user", [], 2);
  assert.deepEqual((await f.request("/api/organization/settings", "GET", undefined, ordinary)).data.buildingLeaders, []);
  for (const cookie of ["", login.cookie, ordinary, f.admin]) {
    const publicView = await f.request("/api/organization/options", "GET", undefined, cookie);
    assert.equal(publicView.status, 200);
    assert.doesNotMatch(JSON.stringify(publicView.data), /新注册楼长姓名|buildingLeaders|13800000003/);
  }
});

test("同名人员按账号绑定分别任命，无姓名的旧账号不回退登录手机号", async t => {
  const f = await fixture(t, configured, {
    "13800000009": { role: "leader", employeeId: 9999, name: "", phone: "13800000009", buildings: ["第一楼"] },
    "legacy-leader": { role: "leader", employeeId: 9998, name: "未绑定的账号姓名", buildings: ["第二楼"] }
  });
  const view = async () => (await f.request("/api/organization/settings", "GET", undefined, f.admin)).data.buildingLeaders;
  assert.deepEqual(await view(), [{ building: "第二楼", leaders: "未绑定的账号姓名" }]);
  assert.doesNotMatch(JSON.stringify(await view()), /13800000009|9999/);
  const snapshot = await f.request("/api/data/snapshot.json", "GET", undefined, f.admin);
  for (const employee of snapshot.data.employees) employee.name = "同名楼长";
  assert.equal((await f.request("/api/data/snapshot.json", "POST", snapshot.data, f.admin)).status, 200);
  await f.account("first-name", "leader", ["第一楼"], 1);
  await f.account("second-name", "leader", ["第二楼"], 2);
  assert.deepEqual(await view(), [{ building: "第二楼", leaders: "未绑定的账号姓名、同名楼长" }, { building: "第一楼", leaders: "同名楼长" }]);
  assert.equal((await f.request("/api/auth/users", "POST", { username: "first-name", role: "user" }, f.admin)).status, 200);
  assert.deepEqual(await view(), [{ building: "第二楼", leaders: "未绑定的账号姓名、同名楼长" }]);
});
