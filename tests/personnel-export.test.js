"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { once, EventEmitter } = require("node:events");
const { createAuthService, emptySnapshot } = require("../server/auth-service");

const password = "export-test-password-2026";
const initial = {
  ...emptySnapshot(), revision: 9,
  employees: [
    { id: 1, employeeNo: "000042", name: "同名演示人员", phone: "13800000001", building: "A栋", department: "测试部门", resumeName: "简历.txt", resumeData: "data:text/plain;base64,SEVMTE8=", credentialName: "证件.pdf", credentialData: "data:application/pdf;base64,JVBERi0=", aiProfile: "简介\n第二行", _resumeText: "简历提取文本", hiddenSecret: "employee-unknown-secret", passwordHash: "employee-fake-hash", token: "employee-fake-token" },
    { id: 2, employeeNo: "000042", name: "同名演示人员", phone: "13800000002", building: "B栋", status: "离职", email: "demo@example.com" },
    { id: 3, name: "未填楼栋演示人员", phone: "13800000003", building: "" },
    { id: 4, name: "第三楼演示人员", phone: "13800000004", building: "C栋" },
    { id: 5, name: "仅空白楼栋", building: "   " }
  ],
  overtime: [{ id: 1, employeeId: 2, reason: "不属于人员导出的业务记录" }]
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, seeded = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-personnel-export-"));
  const accountFile = path.join(directory, "auth-users.json");
  if (Object.keys(seeded).length) {
    const salt = "synthetic-test-salt";
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    fs.writeFileSync(accountFile, JSON.stringify(Object.fromEntries(Object.entries(seeded).map(([key, value]) => [key, { name: key, passwordHash, passwordSalt: salt, ...value }]))));
  }
  let snapshot = structuredClone(initial), writes = 0, reads = 0, nextReadGate = null;
  const observed = new EventEmitter();
  const service = createAuthService({
    dataDir: directory,
    readSnapshot: async () => {
      reads++;
      if (nextReadGate) {
        const gate = nextReadGate; nextReadGate = null;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return structuredClone(snapshot);
    },
    writeSnapshot: async value => { writes++; snapshot = structuredClone(value); }
  });
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    const handling = service.handle(req, res, route);
    observed.emit(route);
    if (!(await handling)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^hr-personnel-export-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  async function request(route, method = "GET", body, cookie = "", extraHeaders = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const setup = await request("/api/auth/setup", "POST", { password });
  assert.equal(setup.status, 201);
  async function account(username, role, buildings = [], employeeId = null) {
    const created = await request("/api/auth/users", "POST", { username, name: "测试账号" + username, role, buildings, employeeId, password }, setup.cookie);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    return login(username);
  }
  async function login(username) {
    const loggedIn = await request("/api/auth/login", "POST", { username, password });
    assert.equal(loggedIn.status, 200);
    return loggedIn.cookie;
  }
  return {
    request, account, login, admin: setup.cookie, accountFile, service,
    get writes() { return writes; }, get reads() { return reads; }, get snapshot() { return snapshot; },
    replaceSnapshot(value) { snapshot = structuredClone(value); },
    waitForRoute: route => once(observed, route),
    holdNextRead() { nextReadGate = { entered: deferred(), release: deferred() }; return nextReadGate; }
  };
}

test("管理员导出全部人员表单值与附件，保留工号和空值，排除账号及其他业务数据", async t => {
  const f = await fixture(t);
  const beforeAccounts = fs.readFileSync(f.accountFile, "utf8");
  const response = await f.request("/api/employees/export", "GET", undefined, f.admin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(Object.keys(response.data).sort(), ["ok", "generatedAt", "scope", "fields", "employees"].sort());
  assert.equal(response.data.ok, true);
  assert.equal(new Date(response.data.generatedAt).toISOString(), response.data.generatedAt);
  assert.deepEqual(response.data.scope, { role: "admin", buildings: [] });
  assert.deepEqual(response.data.employees.map(e => e.id), [1, 2, 3, 4, 5]);
  assert.equal(response.data.fields.length, 20);
  assert.deepEqual(response.data.fields[0], { key: "employeeNo", label: "工号" });
  for (const employee of response.data.employees) {
    assert.deepEqual(Object.keys(employee).sort(), ["id", ...response.data.fields.map(f => f.key), "resumeData", "credentialData"].sort());
  }
  assert.equal(response.data.employees[0].employeeNo, "000042");
  assert.equal(response.data.employees[0].aiProfile, "简介\n第二行");
  assert.equal(response.data.employees[0].resumeData, initial.employees[0].resumeData);
  assert.equal(response.data.employees[0].credentialData, initial.employees[0].credentialData);
  assert.equal(response.data.employees[2].employeeNo, "");
  assert.equal(response.data.employees[2].joinDate, "");
  assert.doesNotMatch(JSON.stringify(response.data), /hiddenSecret|passwordHash|passwordSalt|token|employee-unknown-secret|不属于人员导出的业务记录/);
  assert.equal(fs.readFileSync(f.accountFile, "utf8"), beforeAccounts);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.snapshot, initial);
});

test("匿名与普通人员不能导出，伪造角色参数和接口方法不能提权", async t => {
  const f = await fixture(t);
  const member = await f.account("member", "user", [], 2);
  const anonymous = await f.request("/api/employees/export");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  const forbidden = await f.request("/api/employees/export?role=admin&employeeId=2&scope=all", "GET", undefined, member, { "X-Role": "admin" });
  assert.equal(forbidden.status, 403);
  assert.doesNotMatch(JSON.stringify(forbidden.data), /同名演示人员|1380000000|employees/);
  assert.equal((await f.request("/api/employees/export", "POST", { role: "admin", buildings: ["B栋"] }, member)).status, 405);
  assert.equal(f.writes, 0);
});

test("楼长严格按当前授权楼栋导出，多楼栋覆盖同名人员但不额外导出自己所在的外栋", async t => {
  const f = await fixture(t);
  const leader = await f.account("leader", "leader", ["A栋"], 2);
  const exported = await f.request("/api/employees/export?scope=all&role=admin&buildings=B%E6%A0%8B&employeeId=2", "GET", undefined, leader);
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.data.scope, { role: "leader", buildings: ["A栋"] });
  assert.deepEqual(exported.data.employees.map(e => e.id), [1]);
  assert.doesNotMatch(JSON.stringify(exported.data), /13800000002|B栋|C栋|未填楼栋/);
  assert.equal((await f.request("/api/auth/users", "POST", { username: "leader", role: "leader", buildings: ["A栋", "B栋"] }, f.admin)).status, 200);
  const multiple = await f.request("/api/employees/export", "GET", undefined, leader);
  assert.deepEqual(multiple.data.employees.map(e => e.id), [1, 2]);
  assert.deepEqual(multiple.data.scope.buildings, ["A栋", "B栋"]);
  assert.equal(f.writes, 0);
});

test("旧楼长的空授权或空白楼栋不扩大范围，未知角色同样拒绝", async t => {
  const f = await fixture(t, {
    noBuildings: { role: "leader", buildings: [], employeeId: 1 },
    whitespace: { role: "leader", buildings: ["   ", "A栋", "A栋"], employeeId: 3 },
    emptyBuilding: { role: "leader", buildings: [""] },
    unknownRole: { role: "custom", buildings: ["A栋"] }
  });
  for (const username of ["noBuildings", "emptyBuilding"]) {
    const response = await f.request("/api/employees/export", "GET", undefined, await f.login(username));
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.employees, []);
    assert.deepEqual(response.data.scope.buildings, []);
  }
  const clean = await f.request("/api/employees/export", "GET", undefined, await f.login("whitespace"));
  assert.deepEqual(clean.data.employees.map(e => e.id), [1]);
  assert.deepEqual(clean.data.scope.buildings, ["A栋"]);
  assert.equal((await f.request("/api/employees/export", "GET", undefined, await f.login("unknownRole"))).status, 403);
});

test("已有会话在楼长改楼栋、降级或删除账号后立即采用当前权限", async t => {
  const f = await fixture(t);
  const leader = await f.account("leader", "leader", ["A栋"]);
  assert.equal((await f.request("/api/auth/users", "POST", { username: "leader", role: "leader", buildings: ["C栋"] }, f.admin)).status, 200);
  assert.deepEqual((await f.request("/api/employees/export", "GET", undefined, leader)).data.employees.map(e => e.id), [4]);
  assert.equal((await f.request("/api/auth/users", "POST", { username: "leader", role: "user" }, f.admin)).status, 200);
  assert.equal((await f.request("/api/employees/export", "GET", undefined, leader)).status, 403);
  assert.equal((await f.request("/api/auth/users/leader", "DELETE", {}, f.admin)).status, 200);
  assert.equal((await f.request("/api/employees/export", "GET", undefined, leader)).status, 401);
});

test("等待存储读取期间楼栋授权改变，导出使用读取完成后的当前授权", async t => {
  const f = await fixture(t);
  const leader = await f.account("leader", "leader", ["A栋"]);
  const gate = f.holdNextRead();
  const exporting = f.request("/api/employees/export", "GET", undefined, leader);
  await gate.entered.promise;
  assert.equal((await f.request("/api/auth/users", "POST", { username: "leader", role: "leader", buildings: ["B栋"] }, f.admin)).status, 200);
  gate.release.resolve();
  const response = await exporting;
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.employees.map(e => e.id), [2]);
  assert.deepEqual(response.data.scope.buildings, ["B栋"]);
});

test("等待存储期间撤销角色、等待写队列期间退出会话均不能继续导出", async t => {
  const f = await fixture(t);
  const leader = await f.account("leader", "leader", ["A栋"]);
  const readGate = f.holdNextRead();
  const exporting = f.request("/api/employees/export", "GET", undefined, leader);
  await readGate.entered.promise;
  assert.equal((await f.request("/api/auth/users", "POST", { username: "leader", role: "user" }, f.admin)).status, 200);
  readGate.release.resolve();
  assert.equal((await exporting).status, 403);

  const secondLeader = await f.account("secondLeader", "leader", ["B栋"]);
  const waitingQueue = deferred();
  const queued = f.service.serialized(() => waitingQueue.promise);
  const entered = f.waitForRoute("/api/employees/export");
  const nextExport = f.request("/api/employees/export", "GET", undefined, secondLeader);
  await entered;
  assert.equal((await f.request("/api/auth/logout", "POST", {}, secondLeader)).status, 200);
  waitingQueue.resolve();
  await queued;
  assert.equal((await nextExport).status, 401);
});

test("使用最新服务端快照且只输出标量字段，异常嵌套对象和未知字段不会进入导出", async t => {
  const f = await fixture(t);
  const changed = structuredClone(initial);
  changed.employees[0].employeeNo = "000099";
  changed.employees[0].aiProfile = { passwordHash: "nested-secret" };
  changed.employees[0].resumeData = { token: "nested-attachment-secret" };
  changed.employees[0].department = 123;
  changed.employees[0].workAttribute = true;
  changed.employees[0].room = null;
  changed.employees[0].extra = { privateMetadata: "another-secret" };
  changed.employees.push({ id: 6, name: "最新新增演示人员", building: "A栋", employeeNo: "000123" });
  f.replaceSnapshot(changed);
  const response = await f.request("/api/employees/export", "GET", undefined, f.admin);
  assert.equal(response.status, 200);
  assert.equal(response.data.employees.length, 6);
  assert.equal(response.data.employees[0].employeeNo, "000099");
  assert.equal(response.data.employees[0].aiProfile, "");
  assert.equal(response.data.employees[0].resumeData, "");
  assert.equal(response.data.employees[0].department, "123");
  assert.equal(response.data.employees[0].workAttribute, "true");
  assert.equal(response.data.employees[0].room, "");
  assert.doesNotMatch(JSON.stringify(response.data), /nested-secret|nested-attachment-secret|privateMetadata|another-secret/);
  assert.equal(f.writes, 0);
});
