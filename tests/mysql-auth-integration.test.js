"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), http = require("node:http");
const { once } = require("node:events");
const { createMySQLStore } = require("../server/mysql-store");
const { createMySQLAuthStore, AUTH_TABLES } = require("../server/mysql-auth-store");
const { createAuthService, emptySnapshot } = require("../server/auth-service");
const required = process.env.HR_REQUIRE_MYSQL_TESTS === "true", configured = !!process.env.HR_TEST_MYSQL_URL;

test("real MySQL accounts and organization retain every field, share business transactions, and refresh permissions across instances", { skip: !configured && !required }, async t => {
  assert.ok(configured, "HR_TEST_MYSQL_URL is mandatory in the relational integration job");
  let driver;
  try { driver = require(require.resolve("mysql2/promise", { paths: [path.join(__dirname, "../server")] })); }
  catch (_) { assert.fail("The relational integration job must install the declared mysql2 dependency"); }
  const url = new URL(process.env.HR_TEST_MYSQL_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a loopback test MySQL service is allowed");
  const settings = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), charset: "utf8mb4", connectionLimit: 5, supportBigNumbers: true, bigNumberStrings: true };
  const database = "hr_auth_test_" + crypto.randomBytes(8).toString("hex"), admin = driver.createPool(settings);
  let pool, server;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-sql-auth-integration-"));
  try {
    await admin.query("CREATE DATABASE `" + database + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
    pool = driver.createPool({ ...settings, database });
    const mutations = [];
    const tracedPool = { async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, { get(target, key) {
        if (key === "query") return (sql, values) => { if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) mutations.push({ sql, values }); return target.query(sql, values); };
        const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    let readonly = false;
    const store = createMySQLStore(tracedPool, { isReadOnly: () => readonly }), accounts = createMySQLAuthStore(store, { isReadOnly: () => readonly });
    await store.createSchema(); await accounts.createSchema();
    const password = "synthetic-sql-account-password", salt = "synthetic-sql-salt", hash = crypto.scryptSync(password, salt, 64).toString("hex");
    const source = { ...emptySnapshot(), revision: 7, employees: [{ id: 1, name: "人员甲", phone: "13800000201", building: "楼A", region: "北区", employeeNo: "00001", resumeData: "data:text/plain;base64,c3ludGhldGlj" }] };
    const users = {
      Admin: { name: "保留大小写账号", role: "admin", passwordHash: hash, passwordSalt: salt, extraLegacy: { retained: true }, buildings: [] },
      admin: { name: "管理员", role: "admin", passwordHash: hash, passwordSalt: salt, createdAt: "2026-11-23T00:00:00.123Z" },
      member: { name: "人员甲", role: "user", employeeId: 1, phone: "13800000201", passwordHash: hash, passwordSalt: salt, buildings: [], regions: [] },
      regional: { name: "区域经理", role: "region_manager", employeeId: null, phone: "13800000202", passwordHash: hash, passwordSalt: salt, regions: ["北区", "南区"] }
    };
    const organization = { schemaVersion: 1, revision: 8, options: { buildings: ["楼A", "空楼栋"], departments: [], regions: ["北区", "南区"] }, buildingLeaders: [{ building: "空楼栋", leaders: "null", extra: ["保留"] }, { building: "楼A", leaders: ["甲", "乙"] }], legacyNote: { retained: true } };
    await store.transaction(async () => {
      await store.stageLegacyBundle(source); await accounts.stageLegacy(users, organization);
      await store.verifyBundle(source); await accounts.verifyLegacy(users, organization); await store.completeMigration(source);
    });
    await store.verifyInitialized(); await accounts.verifyInitialized();
    assert.deepEqual(JSON.parse(JSON.stringify(await accounts.readUsers())), users);
    assert.deepEqual(await accounts.readOrganization(), organization);
    const [names] = await pool.query("SHOW TABLES");
    for (const name of AUTH_TABLES) assert.ok(names.some(row => Object.values(row).includes(name)));
    assert.ok(!names.some(row => Object.values(row).includes("system_snapshots")));
    await pool.query("UPDATE hr_accounts SET name = ? WHERE username = ?", ["SQL列权威", "Admin"]);
    assert.equal((await accounts.readUsers()).Admin.name, "SQL列权威");
    assert.equal(Object.hasOwn((await accounts.readUsers()).Admin, "phone"), false);
    await pool.query("UPDATE hr_accounts SET phone = ? WHERE username = ?", ["13800000204", "Admin"]);
    assert.equal((await accounts.readUsers()).Admin.phone, "13800000204");
    mutations.length = 0;
    await store.transaction(async () => { const current = await accounts.readUsers(); current.Admin.name = "仅改此账号"; await accounts.writeUsers(current); });
    assert.equal(mutations.filter(row => row.sql.startsWith("INSERT INTO hr_accounts")).length, 1);
    assert.equal(mutations.find(row => row.sql.startsWith("INSERT INTO hr_accounts")).values[0], "Admin");
    assert.equal(mutations.filter(row => /hr_account_(?:buildings|regions)/.test(row.sql)).length, 0);
    const original = await store.read(), originalUsers = await accounts.readUsers();
    await assert.rejects(store.transaction(async () => {
      const next = await store.read(); next.employees.push({ id: 2, name: "应回滚人员" }); next.revision++; await store.write(next);
      const nextUsers = await accounts.readUsers(); nextUsers.orphan = { name: "应回滚账号", role: "user", employeeId: 2 }; await accounts.writeUsers(nextUsers);
      throw new Error("synthetic transaction failure");
    }), /synthetic transaction failure/);
    assert.deepEqual(await store.read(), original); assert.deepEqual(await accounts.readUsers(), originalUsers);
    await assert.rejects(store.transaction(() => accounts.stageLegacy(users, organization)), error => error.status === 409);
    readonly = true;
    await assert.rejects(accounts.writeUsers(users), error => error.status === 503);
    await assert.rejects(accounts.writeOrganization(organization), error => error.status === 503);
    assert.deepEqual(await accounts.readOrganization(), organization); readonly = false;
    // Real HTTP registration uses the same SQL unit of work, not filesystem
    // accounts. Cross-instance account changes must affect the next request.
    for (const name of ["auth-users.json", "organization-settings.json"]) fs.writeFileSync(path.join(directory, name), "not SQL runtime state");
    const service = createAuthService({ dataDir: directory, authStore: accounts, isReadOnly: () => readonly, readSnapshot: () => store.read(), writeSnapshot: next => store.write(next, { expectedRevision: next.revision - 1 }) });
    server = http.createServer(async (req, res) => { if (!(await service.handle(req, res, new URL(req.url, "http://localhost").pathname))) { res.writeHead(404); res.end(); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    async function request(route, method = "GET", body, cookie = "") {
      const response = await fetch(base + route, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
    }
    const login = await request("/api/auth/login", "POST", { username: "admin", password }); assert.equal(login.status, 200);
    assert.equal((await request("/api/auth/users", "GET", undefined, login.cookie)).status, 200);
    const secondStore = createMySQLStore(pool), secondAccounts = createMySQLAuthStore(secondStore);
    await secondStore.transaction(async () => { const current = await secondAccounts.readUsers(); current.admin.role = "user"; await secondAccounts.writeUsers(current); });
    assert.equal((await request("/api/auth/users", "GET", undefined, login.cookie)).status, 403);
    const registered = await request("/api/auth/register", "POST", { phone: "13800000203", password, employee: { name: "SQL原子注册" } }); assert.equal(registered.status, 201);
    const registeredUser = (await accounts.readUsers())["13800000203"];
    assert.ok((await store.read()).employees.some(employee => employee.id === registeredUser.employeeId));
    for (const name of ["auth-users.json", "organization-settings.json"]) assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), "not SQL runtime state");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (pool) await pool.end();
    assert.match(database, /^hr_auth_test_[a-f0-9]{16}$/); await admin.query("DROP DATABASE IF EXISTS `" + database + "`"); await admin.end();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^hr-sql-auth-integration-/); fs.rmSync(directory, { recursive: true, force: true });
  }
});
