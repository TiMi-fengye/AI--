"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { migrate, verify } = require("../server/migrate-mysql");
const { createMySQLStore, TABLES } = require("../server/mysql-store");
const { createMySQLAuthStore, AUTH_TABLES } = require("../server/mysql-auth-store");
const configured = !!process.env.HR_TEST_MYSQL_URL;
const required = process.env.HR_REQUIRE_MYSQL_TESTS === "true";

test("real MySQL migration keeps every entity, identity and attachment atomic, refuses stale retries and retains the frozen source", { skip: !configured && !required ? "Set HR_TEST_MYSQL_URL for an isolated local MySQL test server" : false, timeout: 60000 }, async () => {
  assert.ok(configured, "Required MySQL integration database was not configured");
  const url = new URL(process.env.HR_TEST_MYSQL_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Integration MySQL must use loopback");
  const mysql = require("../server/node_modules/mysql2/promise");
  const options = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), charset: "utf8mb4", connectionLimit: 4 };
  const bootstrap = await mysql.createConnection(options);
  const database = "hr_migration_test_" + crypto.randomBytes(8).toString("hex");
  assert.match(database, /^hr_migration_test_[a-f0-9]{16}$/);
  let pool;
  const business = {
    revision: 18,
    employees: [{ id: 1, name: "合成甲🦄", employeeNo: "000017", region: "合成区域", building: "合成楼栋", phone: "13800000001", resumeData: "data:application/pdf;base64,AP8BAg==", credentialData: "data:image/png;base64,/wAB", extraField: { preserve: true } }],
    attendance: [{ id: 2, employeeId: 1, date: "2026-11-23", checkIn: "09:05", checkOut: "18:30" }],
    overtime: [{ id: 3, employeeId: 99, date: "2026-11-22", status: "approved", hours: "02.50", overtimeType: "compensatory", approvalHistory: [{ stage: "leader", decision: "approved", name: "合成楼长", role: "leader", at: "2026-11-22T09:00:00Z" }] }],
    leaveRequests: [{ id: 4, employeeId: 1, type: "statutoryAnnual", startDate: "2026-11-23T09:05", endDate: "2026-11-23T10:35", days: 1, status: "pending" }],
    settlements: [{ id: "synthetic-period", records: [{ employeeId: 1, name: "合成甲🦄", otPay: 12.5 }], totalFee: 12.5 }],
    departments: ["合成部门", '{"string":"must remain text"}', { id: 5, name: "另一个部门" }],
    updateLogs: [{ id: "log1", building: "合成楼栋", date: "2026-11-23", late: false }],
    performance: [{ id: 6, employeeId: 1, scores: { safety: 5, service: 4 } }],
    orgStructure: { id: "root", name: "合成组织", children: [{ id: 1, name: "合成甲🦄", employeeId: 1, children: [] }] },
    approvalOutbox: [{ id: "synthetic-notice", kind: "leaveRequests", recordId: 4, employeeId: 1, region: "合成区域", status: "blocked", reason: "sms_not_configured", attempts: 0, payload: { employee: "合成甲🦄", type: "调休请假", start: "2026-11-23T09:05", end: "2026-11-23T10:35", hours: "1.5" }, deliveries: { synthetic_manager: { status: "blocked", reason: "manager_phone_missing" } } }],
    customMetadata: { key: "synthetic-only" }
  };
  const privateState = { users: { synthetic_admin: { name: "合成管理员", role: "admin", passwordHash: "SYNTHETIC_HASH", passwordSalt: "SYNTHETIC_SALT", regions: [], buildings: [] }, synthetic_manager: { name: "合成经理", role: "region_manager", phone: "13800000002", regions: ["合成区域"], buildings: [] } }, organization: { schemaVersion: 1, revision: 3, options: { buildings: ["合成楼栋"], regions: ["合成区域"], departments: [] }, buildingLeaders: [{ building: "合成楼栋", leaders: "旧合成条目" }] }, verifyUnchanged() {} };
  const source = JSON.stringify(business);
  try {
    await bootstrap.query("CREATE DATABASE `" + database + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
    pool = mysql.createPool({ ...options, database });
    await pool.query("CREATE TABLE system_snapshots (snapshot_key VARCHAR(64) NOT NULL PRIMARY KEY,payload LONGTEXT NOT NULL,updated_at DATETIME(3) NOT NULL) ENGINE=InnoDB CHARACTER SET utf8mb4");
    await pool.query("INSERT INTO system_snapshots VALUES ('default',?,UTC_TIMESTAMP(3))", [source]);
    const params = { pool, createStore: createMySQLStore, createIdentityStore: createMySQLAuthStore, tables: TABLES, identityTables: AUTH_TABLES, privateState };
    const checked = await migrate(params); assert.equal(checked.applied, false);
    const [beforeTables] = await pool.query("SHOW TABLES"); assert.equal(beforeTables.length, 1);
    // Inject a failure after real account/organization inserts: the business,
    // identity rows and completion marker must all roll back together.
    const brokenIdentity = store => {
      const identity = createMySQLAuthStore(store);
      return { ...identity, async stageLegacy(...args) { await identity.stageLegacy(...args); throw new Error("Synthetic failure after identity insert"); } };
    };
    await assert.rejects(migrate({ ...params, createIdentityStore: brokenIdentity, apply: true }), /Synthetic failure/);
    const [[meta]] = await pool.query("SELECT initialized FROM hr_schema_meta WHERE id=1"); assert.equal(meta.initialized, 0);
    for (const name of [...TABLES.filter(name => name !== "hr_schema_meta"), ...AUTH_TABLES]) {
      const [[count]] = await pool.query("SELECT COUNT(*) AS count FROM `" + name + "`"); assert.equal(Number(count.count), 0);
    }
    const done = await migrate({ ...params, apply: true }); assert.equal(done.applied, true);
    assert.equal(done.contentSha256, checked.contentSha256); assert.equal(done.sourceDigest, checked.sourceDigest);
    assert.equal(done.tables.length, TABLES.length + AUTH_TABLES.length); assert.match(done.tablesSha256, /^[a-f0-9]{64}$/);
    const readOnly = await verify(params); assert.equal(readOnly.databaseWritten, false); assert.equal(readOnly.tablesSha256, done.tablesSha256); assert.equal(readOnly.contentSha256, done.contentSha256);
    const store = createMySQLStore(pool), identity = createMySQLAuthStore(store);
    assert.deepEqual(await store.read(), business);
    // Account maps deliberately have no prototype, including after SQL reads.
    // Preserve that security property while checking every migrated field.
    assert.deepEqual(await identity.readUsers(), Object.assign(Object.create(null), privateState.users));
    assert.deepEqual(await identity.readOrganization(), privateState.organization);
    const [[frozen]] = await pool.query("SELECT payload FROM system_snapshots WHERE snapshot_key='default'"); assert.equal(frozen.payload, source);
    const next = await store.read(); next.revision++; next.employees[0].name = "合成迁移后新业务";
    await store.write(next, { expectedRevision: 18 });
    const updatedProof = await verify(params); assert.notEqual(updatedProof.tablesSha256, done.tablesSha256); assert.notEqual(updatedProof.contentSha256, done.contentSha256);
    const rerun = await migrate({ ...params, apply: true }); assert.equal(rerun.applied, false); assert.equal(rerun.status, "MYSQL_RELATIONAL_ALREADY_INITIALIZED"); assert.deepEqual(await store.read(), next);
    const changedSource = { ...business, revision: 19 }; await pool.query("UPDATE system_snapshots SET payload=? WHERE snapshot_key='default'", [JSON.stringify(changedSource)]);
    await assert.rejects(migrate({ ...params, apply: true }), /sources changed/); assert.deepEqual(await store.read(), next);
    assert.doesNotMatch(JSON.stringify(done), /合成甲|SYNTHETIC_HASH|13800000001|resumeData/);
  } finally {
    if (pool) await pool.end();
    // Only the randomly-created integration database can be dropped.
    assert.match(database, /^hr_migration_test_[a-f0-9]{16}$/);
    await bootstrap.query("DROP DATABASE IF EXISTS `" + database + "`"); await bootstrap.end();
  }
});
