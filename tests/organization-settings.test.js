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

async function fixture(t, settings) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-organization-tests-"));
  const organizationFile = path.join(directory, "organization-settings.json");
  if (settings) fs.writeFileSync(organizationFile, JSON.stringify(settings));
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

test("独立配置优先保留原选项和空楼栋，公开接口不含楼长姓名", async t => {
  const f = await fixture(t, configured);
  const publicOptions = await f.request("/api/organization/options");
  assert.deepEqual(publicOptions.data.options, configured.options);
  assert.doesNotMatch(JSON.stringify(publicOptions.data), /负责人|buildingLeaders/);
  const all = await f.request("/api/organization/settings", "GET", undefined, f.admin);
  assert.equal(all.status, 200);
  assert.equal(all.data.revision, 3);
  assert.deepEqual(all.data.options.buildings, ["第一楼", "第二楼", "未使用楼栋"]);
  assert.equal(all.data.buildingLeaders[0].leaders, "第一楼负责人");
  assert.equal(all.data.buildingLeaders[2].leaders, "预设负责人");
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
  assert.deepEqual(leaderSettings.data.buildingLeaders, [{ building: "第一楼", leaders: "第一楼负责人" }]);
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
  const update = { revision: 3, options: { companies: ["  恢复单位  ", "恢复单位", ""], statuses: [] }, buildingLeaders: [{ building: "第一楼", leaders: ["显示负责人甲", "显示负责人乙"] }] };
  assert.equal((await f.request("/api/organization/settings", "POST", update, f.admin, { Origin: "https://other.example" })).status, 403);
  const saved = await f.request("/api/organization/settings", "POST", update, f.admin);
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 4);
  assert.deepEqual(saved.data.options.companies, ["恢复单位"]);
  assert.deepEqual(saved.data.options.statuses, []);
  assert.deepEqual(saved.data.options.buildings, configured.options.buildings);
  assert.deepEqual(saved.data.buildingLeaders, [{ building: "第一楼", leaders: "显示负责人甲、显示负责人乙" }]);
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

test("并发管理员配置写入按版本串行，配置缺失时楼长显示仅源于既有授权账号", async t => {
  const f = await fixture(t);
  await f.account("existing-leader", "leader", ["第一楼"], 1);
  const inferred = await f.request("/api/organization/settings", "GET", undefined, f.admin);
  assert.deepEqual(inferred.data.buildingLeaders, [{ building: "第一楼", leaders: "existing-leader测试账号" }]);
  const [first, second] = await Promise.all([
    f.request("/api/organization/settings", "POST", { revision: 0, options: { companies: ["第一个修改"] } }, f.admin),
    f.request("/api/organization/settings", "POST", { revision: 0, options: { companies: ["第二个修改"] } }, f.admin)
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(JSON.parse(fs.readFileSync(f.organizationFile, "utf8")).revision, 1);
  assert.deepEqual(f.snapshot, initialSnapshot); assert.equal(f.writes, 0);
});
