"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { createAuthService, emptySnapshot, scopedSnapshot, mergeSnapshot } = require(process.env.HR_ATTENDANCE_AUTH_TEST_MODULE || path.join(__dirname, "../server/auth-service"));

const admin = { role: "admin" };
const leader = { role: "leader", employeeId: 1, buildings: ["楼栋A"] };
const member = { role: "user", employeeId: 1, buildings: [] };
const collections = ["attendance", "overtime", "leaveRequests"];

function requestRecord(id, employeeId, type = "statutoryAnnual") {
  return { id, employeeId, type, startDate: "2026-11-18T09:05", endDate: "2026-11-18T17:35", days: 1, hours: 0, reason: "合成请假", status: "pending" };
}

function snapshot() {
  return {
    ...emptySnapshot(), revision: 8,
    employees: [
      { id: 1, name: "合成本栋甲", phone: "13800000001", building: "楼栋A" },
      { id: 2, name: "合成其他楼栋", phone: "13800000002", building: "楼栋B" },
      { id: 3, name: "合成本栋乙", phone: "13800000003", building: "楼栋A" }
    ],
    attendance: [
      { id: 101, employeeId: 1, date: "2026-11-18", checkIn: "09:00", status: "present" },
      { id: 102, employeeId: 2, date: "2026-11-18", checkIn: "09:00", status: "present" }
    ],
    overtime: [
      { id: 201, employeeId: 1, date: "2026-11-18", hours: 2, overtimeType: "fee", status: "pending", reason: "合成加班" },
      { id: 202, employeeId: 2, date: "2026-11-18", hours: 3, overtimeType: "fee", status: "pending", reason: "合成其他楼栋加班" }
    ],
    leaveRequests: [requestRecord(301, 1), requestRecord(302, 2, "paidSick")],
    performance: [{ id: 401, employeeId: 3, score: 80 }]
  };
}

function denied(action) {
  assert.throws(action, error => error.status === 403);
}

test("administrators can delete each attendance collection across request statuses while retaining unrelated records", () => {
  for (const key of collections) {
    for (const status of ["pending", "approved", "rejected"]) {
      const source = snapshot();
      if (key !== "attendance") source[key][0].status = status;
      const before = structuredClone(source), incoming = scopedSnapshot(source, admin);
      incoming[key] = incoming[key].filter(row => row.employeeId !== 1);
      const result = mergeSnapshot(source, incoming, admin);
      assert.deepEqual(result[key], source[key].filter(row => row.employeeId !== 1));
      for (const other of collections.filter(name => name !== key)) assert.deepEqual(result[other], source[other]);
      assert.equal(result.revision, source.revision + 1);
      assert.deepEqual(source, before);
    }
  }
});

test("leaders cannot delete records with missing rows, empty arrays or replacement record IDs", () => {
  for (const key of collections) {
    for (const change of ["omit-row", "empty", "replace-id"]) {
      const source = snapshot(), before = structuredClone(source), incoming = scopedSnapshot(source, leader);
      if (change === "empty") incoming[key] = [];
      else if (change === "omit-row") incoming[key] = incoming[key].filter(row => row.employeeId !== 1);
      else incoming[key][0].id += 1000;
      denied(() => mergeSnapshot(source, incoming, leader));
      assert.deepEqual(source, before);
    }
  }
  for (const key of ["overtime", "leaveRequests"]) {
    const source = snapshot(), incoming = scopedSnapshot(source, member);
    incoming[key] = [];
    denied(() => mergeSnapshot(source, incoming, member));
  }
});

test("removing a person cannot cascade-delete records even when protected collections are omitted or null", () => {
  for (const key of collections) {
    for (const mode of ["empty-rows", "omitted-collections", "null-collections"]) {
      const source = snapshot();
      for (const other of collections.filter(name => name !== key)) source[other] = source[other].filter(row => row.employeeId !== 1);
      const before = structuredClone(source), incoming = scopedSnapshot(source, leader);
      incoming.employees = incoming.employees.filter(employee => employee.id !== 1);
      for (const name of collections) {
        if (mode === "omitted-collections") delete incoming[name];
        else if (mode === "null-collections") incoming[name] = null;
        else incoming[name] = incoming[name].filter(row => row.employeeId !== 1);
      }
      denied(() => mergeSnapshot(source, incoming, leader));
      assert.deepEqual(source, before);
    }
  }
});

test("leaders retain building-scoped profile, check-out and pending overtime edits without snapshot approval", () => {
  const source = snapshot(), incoming = scopedSnapshot(source, leader);
  incoming.employees[0].email = "synthetic@example.com";
  incoming.attendance[0].checkOut = "18:15";
  incoming.overtime[0].hours = 4;
  incoming.attendance.push({ id: 103, employeeId: 3, date: "2026-11-18", checkIn: "08:30", status: "present" });
  incoming.overtime.push({ id: 203, employeeId: 3, date: "2026-11-18", hours: 1, overtimeType: "fee", status: "pending" });
  incoming.leaveRequests.push(requestRecord(303, 3, "welfareAnnual"));
  const result = mergeSnapshot(source, incoming, leader);
  assert.equal(result.employees.find(employee => employee.id === 1).email, "synthetic@example.com");
  assert.equal(result.attendance.find(row => row.id === 101).checkOut, "18:15");
  assert.equal(result.overtime.find(row => row.id === 201).hours, 4);
  assert.equal(result.overtime.find(row => row.id === 201).status, "pending");
  assert.equal(result.leaveRequests.find(row => row.id === 301).status, "pending");
  assert.equal(result.leaveRequests.find(row => row.id === 303).startDate, "2026-11-18T09:05");
  for (const key of collections) {
    assert.deepEqual(result[key].find(row => row.employeeId === 2), source[key].find(row => row.employeeId === 2));
    assert.equal(result[key].length, source[key].length + 1);
  }
});

test("leaders can still delete people without protected records and preserve the original performance cleanup", () => {
  const source = snapshot(), incoming = scopedSnapshot(source, leader);
  incoming.employees = incoming.employees.filter(employee => employee.id !== 3);
  incoming.performance = [];
  const result = mergeSnapshot(source, incoming, leader);
  assert.deepEqual(result.employees.map(employee => employee.id).sort(), [1, 2]);
  assert.deepEqual(result.performance, []);
  for (const key of collections) assert.deepEqual(result[key].map(row => row.id).sort(), source[key].map(row => row.id).sort());
});

test("historical orphan records remain untouched instead of being deleted or blocking ordinary saves", () => {
  const source = snapshot();
  source.attendance.push({ id: 901, employeeId: 99, date: "2026-11-17", status: "present" });
  source.overtime.push({ id: 902, employeeId: 99, date: "2026-11-17", hours: 2, overtimeType: "fee", status: "approved" });
  source.leaveRequests.push(requestRecord(903, 99, "annual"));
  for (const actor of [leader, member]) {
    const incoming = scopedSnapshot(source, actor);
    incoming.employees[0].email = "orphan-test@example.com";
    const result = mergeSnapshot(source, incoming, actor);
    for (const key of collections) assert.deepEqual(result[key].find(row => row.employeeId === 99), source[key].find(row => row.employeeId === 99));
  }
});

test("administrator deletion still respects approved compensatory balance constraints", () => {
  const source = snapshot();
  source.overtime[0] = { ...source.overtime[0], overtimeType: "compensatory", hours: 4, status: "approved" };
  source.leaveRequests[0] = { ...source.leaveRequests[0], type: "compensatory", hours: 2, status: "approved" };
  const incoming = scopedSnapshot(source, admin);
  incoming.overtime = incoming.overtime.filter(row => row.id !== 201);
  assert.throws(() => mergeSnapshot(source, incoming, admin), error => error.status === 400 && /超过可用余额/.test(error.message));
  incoming.leaveRequests = incoming.leaveRequests.filter(row => row.id !== 301);
  assert.doesNotThrow(() => mergeSnapshot(source, incoming, admin));
});

async function httpFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-attendance-delete-"));
  const password = "synthetic-delete-password-2026", salt = "synthetic-test-salt";
  const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
  let current = snapshot(), writes = 0;
  const accounts = {
    admin: { role: "admin", name: "管理员" },
    leaderA: { role: "leader", name: "合成本栋甲", employeeId: 1, buildings: ["楼栋A"] },
    memberA: { role: "user", name: "合成本栋甲", employeeId: 1, buildings: [] }
  };
  fs.writeFileSync(path.join(directory, "auth-users.json"), JSON.stringify(Object.fromEntries(Object.entries(accounts).map(([username, actor]) => [username, { ...actor, passwordSalt: salt, passwordHash }]))));
  const service = createAuthService({ dataDir: directory, readSnapshot: async () => structuredClone(current), writeSnapshot: async value => { writes++; current = structuredClone(value); } });
  const server = http.createServer(async (req, res) => {
    if (!(await service.handle(req, res, new URL(req.url, "http://localhost").pathname))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^hr-attendance-delete-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, method = "GET", body, cookie = "") {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  async function login(username) {
    const response = await request("/api/auth/login", "POST", { username, password });
    assert.equal(response.status, 200);
    return response.cookie;
  }
  return { request, login, get snapshot() { return current; }, get writes() { return writes; } };
}

test("HTTP snapshot writes enforce anonymous and non-admin deletion boundaries without persistence", async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request("/api/data/snapshot.json", "POST", snapshot())).status, 401);
  const leaderCookie = await f.login("leaderA"), memberCookie = await f.login("memberA"), adminCookie = await f.login("admin");
  for (const [cookie, actor] of [[leaderCookie, leader], [memberCookie, member]]) {
    for (const key of actor === member ? ["overtime", "leaveRequests"] : collections) {
      const incoming = scopedSnapshot(f.snapshot, actor);
      incoming[key] = [];
      assert.equal((await f.request("/api/data/snapshot.json", "POST", incoming, cookie)).status, 403);
    }
  }
  assert.equal(f.writes, 0);
  assert.deepEqual(f.snapshot, snapshot());
  const incoming = scopedSnapshot(f.snapshot, admin);
  incoming.attendance = []; incoming.overtime = []; incoming.leaveRequests = [];
  const response = await f.request("/api/data/snapshot.json", "POST", incoming, adminCookie);
  assert.equal(response.status, 200);
  assert.equal(f.writes, 1);
  for (const key of collections) assert.deepEqual(f.snapshot[key], []);
});
