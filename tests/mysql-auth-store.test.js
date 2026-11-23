"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const { createAuthService, emptySnapshot } = require(process.env.HR_MYSQL_AUTH_TEST_MODULE || "../server/auth-service");
const { createMySQLAuthStore } = require("../server/mysql-auth-store");

const password = "synthetic-mysql-auth-password", salt = "synthetic-mysql-auth-salt";
const hash = crypto.scryptSync(password, salt, 64).toString("hex");
const copy = value => structuredClone(value);

test("account SQL assignments are authoritative for previously absent non-null fields while NULL preserves absence", async () => {
  const row = { username: "synthetic", row_order: 0, name: "合成账号", role: "user", employee_id: "42", phone: "13800000105", password_hash: null, password_salt: null, created_at: null, field_presence: '["name","role"]', extra_fields: '{}' };
  const store = createMySQLAuthStore({
    connection: () => ({}), transaction: action => action(),
    query: async sql => [sql.startsWith("SELECT username,") ? [row] : [], []]
  });
  const users = await store.readUsers();
  assert.equal(users.synthetic.phone, "13800000105"); assert.equal(users.synthetic.employeeId, 42);
  assert.equal(Object.hasOwn(users.synthetic, "passwordHash"), false);
  assert.equal(Object.hasOwn(users.synthetic, "createdAt"), false);
  assert.equal(Object.hasOwn(users.synthetic, "buildings"), false);
});

test("normal startup requires enabled initialized MySQL and never falls back to available legacy JSON files", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-mysql-required-"));
  t.after(() => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.match(path.basename(resolved), /^hr-mysql-required-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  const code = path.join(directory, "server"), data = path.join(directory, "synthetic-data"); fs.mkdirSync(code); fs.mkdirSync(data);
  for (const file of ["server.js", "auth-service.js", "approval-workflow.js", "approval-notifications.js", "sms-verification.js", "sms-aliyun.js", "mysql-store.js", "mysql-auth-store.js"]) fs.copyFileSync(path.join(__dirname, "../server", file), path.join(code, file));
  fs.writeFileSync(path.join(code, "config.json"), JSON.stringify({ mysql: { enabled: false } }));
  for (const name of ["snapshot.json", "auth-users.json", "organization-settings.json"]) fs.writeFileSync(path.join(data, name), "available-but-must-not-be-used");
  const env = { HR_DATA_DIR: data, HR_NO_OPEN: "1" }; if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawnSync(process.execPath, ["-e", "require('./server/server').initStorage().then(()=>process.exitCode=9,error=>{console.log(error.message);process.exitCode=2;})"], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
  assert.ifError(child.error); assert.equal(child.status, 2); assert.match(child.stdout, /必须启用并配置MySQL/); assert.doesNotMatch(child.stderr, /available-but-must-not-be-used|SyntaxError/);
  for (const name of ["snapshot.json", "auth-users.json", "organization-settings.json"]) assert.equal(fs.readFileSync(path.join(data, name), "utf8"), "available-but-must-not-be-used");
});

async function fixture(t, { sender } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-mysql-auth-"));
  // Poisoned file-mode sources prove that the SQL persistence boundary never
  // reads or updates legacy account/organization files at runtime.
  for (const name of ["auth-users.json", "organization-settings.json"]) fs.writeFileSync(path.join(directory, name), "not runtime SQL data");
  const context = new AsyncLocalStorage();
  let database = {
    users: { admin: { name: "合成管理员", role: "admin", passwordHash: hash, passwordSalt: salt } },
    organization: { schemaVersion: 1, revision: 0, options: { buildings: ["楼A"], regions: ["北区"] } },
    bundle: { ...emptySnapshot(), employees: [{ id: 1, name: "合成人员", phone: "13800000101", building: "楼A", region: "北区" }] }
  };
  const flags = { failAccounts: false, readonly: false, accountWrites: 0, bundleWrites: 0, organizationWrites: 0, revokeOnSending: false };
  let queue = Promise.resolve();
  function state() { return context.getStore() || database; }
  const persistence = {
    async transaction(action) {
      if (context.getStore()) return action();
      const task = queue.then(async () => {
        const pending = copy(database);
        const result = await context.run(pending, action);
        database = pending;
        return result;
      });
      queue = task.catch(() => {});
      return task;
    },
    async readUsers() { return copy(state().users); },
    async writeUsers(next) { assert.ok(context.getStore(), "accounts and business must share a transaction"); flags.accountWrites++; if (flags.failAccounts) throw new Error("synthetic account SQL failure"); state().users = copy(next); },
    async readOrganization() { return copy(state().organization); },
    async writeOrganization(next) { assert.ok(context.getStore()); flags.organizationWrites++; state().organization = copy(next); }
  };
  const service = createAuthService({
    dataDir: directory, authStore: persistence, isReadOnly: () => flags.readonly,
    storageStatus: () => ({ backend: "mysql", model: "relational", readOnly: flags.readonly }),
    approvalSmsSender: sender,
    readSnapshot: async () => copy(state().bundle),
    writeSnapshot: async next => {
      assert.ok(context.getStore(), "business and accounts must share a transaction");
      if (flags.readonly) { const error = new Error("readonly"); error.status = 503; throw error; }
      flags.bundleWrites++; state().bundle = copy(next);
      if (flags.revokeOnSending && next.approvalOutbox?.some(event => Object.values(event.deliveries).some(delivery => delivery.status === "sending"))) state().users.regional.role = "user";
    }
  });
  const server = http.createServer(async (req, res) => { if (!(await service.handle(req, res, new URL(req.url, "http://localhost").pathname))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.match(path.basename(resolved), /^hr-mysql-auth-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(route, method = "GET", body, cookie = "") {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  async function login(username = "admin") { const result = await request("/api/auth/login", "POST", { username, password }); assert.equal(result.status, 200); return result.cookie; }
  return { request, login, flags, directory, get database() { return database; }, mutate(action) { action(database); } };
}

test("SQL accounts and person registration commit together, and account failure leaves no orphan person or account", async t => {
  const f = await fixture(t), body = { phone: "13800000102", password, employee: { name: "合成注册" } };
  f.flags.failAccounts = true;
  const failed = await f.request("/api/auth/register", "POST", body);
  assert.equal(failed.status, 500); assert.equal(f.database.users[body.phone], undefined);
  assert.equal(f.database.bundle.employees.length, 1); assert.equal(f.database.bundle.revision, 0);
  f.flags.failAccounts = false;
  const saved = await f.request("/api/auth/register", "POST", body);
  assert.equal(saved.status, 201);
  assert.equal(f.database.users[body.phone].employeeId, f.database.bundle.employees[1].id);
  assert.equal((await f.request("/api/data/snapshot.json", "GET", undefined, saved.cookie)).data.employees.length, 1);
  for (const name of ["auth-users.json", "organization-settings.json"]) assert.equal(fs.readFileSync(path.join(f.directory, name), "utf8"), "not runtime SQL data");
});

test("a changed account in another SQL instance immediately removes old permissions and password changes invalidate its session", async t => {
  const f = await fixture(t), cookie = await f.login();
  assert.equal((await f.request("/api/auth/users", "GET", undefined, cookie)).status, 200);
  f.mutate(database => { database.users.admin.role = "user"; });
  assert.equal((await f.request("/api/auth/users", "GET", undefined, cookie)).status, 403);
  f.mutate(database => { database.users.admin.role = "admin"; database.users.admin.passwordHash = "a changed hash in another instance"; });
  assert.equal((await f.request("/api/auth/session", "GET", undefined, cookie)).data.user, null);
});

test("SQL current-account password reset returns a fresh session and invalidates the previous one", async t => {
  const f = await fixture(t), cookie = await f.login();
  const result = await f.request("/api/auth/password", "POST", { oldPassword: password, newPassword: "synthetic-new-mysql-password" }, cookie);
  assert.equal(result.status, 200); assert.ok(result.cookie);
  assert.equal((await f.request("/api/auth/session", "GET", undefined, cookie)).data.user, null);
  assert.equal((await f.request("/api/auth/session", "GET", undefined, result.cookie)).data.user.role, "admin");
});

test("migration hold rejects every API mutation before writes while authenticated GET remains available", async t => {
  const f = await fixture(t), cookie = await f.login();
  const before = copy(f.database), writes = [f.flags.accountWrites, f.flags.bundleWrites, f.flags.organizationWrites];
  f.flags.readonly = true;
  const attempts = [
    ["/api/auth/register", { phone: "13800000103", password, employee: { name: "不应注册" } }],
    ["/api/approvals/overtime/1", { decision: "approved", expectedRevision: 0 }],
    ["/api/data/snapshot.json", before.bundle],
    ["/api/auth/users", { username: "must-not-exist", name: "不应创建", role: "admin", password }],
    ["/api/organization/settings", { revision: 0, options: { buildings: [] } }]
  ];
  for (const [route, body] of attempts) assert.equal((await f.request(route, "POST", body, cookie)).status, 503, route);
  assert.deepEqual(f.database, before);
  assert.deepEqual([f.flags.accountWrites, f.flags.bundleWrites, f.flags.organizationWrites], writes);
  assert.equal((await f.request("/api/data/snapshot.json", "GET", undefined, cookie)).status, 200);
  assert.deepEqual((await f.request("/api/auth/status")).data.storage, { backend: "mysql", model: "relational", readOnly: true });
});

test("organization updates use the SQL repository and stale revisions never overwrite configured empty lists", async t => {
  const f = await fixture(t), cookie = await f.login();
  const result = await f.request("/api/organization/settings", "POST", { revision: 0, options: { buildings: [] } }, cookie);
  assert.equal(result.status, 200); assert.deepEqual(f.database.organization.options.buildings, []);
  assert.equal((await f.request("/api/organization/settings", "POST", { revision: 0, options: { buildings: ["stale"] } }, cookie)).status, 409);
  assert.deepEqual(f.database.organization.options.buildings, []);
  assert.equal(fs.readFileSync(path.join(f.directory, "organization-settings.json"), "utf8"), "not runtime SQL data");
});

test("notification delivery rechecks current SQL manager permission after persistence and never sends to a revoked manager", async t => {
  let sends = 0;
  const f = await fixture(t, { sender: async () => { sends++; return { ok: true }; } });
  f.mutate(database => {
    database.users.regional = { name: "合成区域经理", role: "region_manager", regions: ["北区"], phone: "13800000104", passwordHash: hash, passwordSalt: salt };
    database.bundle.leaveRequests.push({ id: 10, employeeId: 1, type: "shift", startDate: "2026-11-23T09:00", endDate: "2026-11-23T10:00", days: 1, hours: 0, status: "pending" });
  });
  const cookie = await f.login(); f.flags.revokeOnSending = true;
  const approved = await f.request("/api/approvals/leaveRequests/10", "POST", { decision: "approved", expectedRevision: 0 }, cookie);
  assert.equal(approved.status, 200);
  for (let i = 0; i < 150 && !f.database.bundle.approvalOutbox?.[0]?.deliveries?.regional?.reason; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.database.users.regional.role, "user"); assert.equal(sends, 0);
  assert.equal(f.database.bundle.approvalOutbox[0].status, "uncertain");
});
