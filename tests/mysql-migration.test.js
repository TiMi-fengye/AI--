"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { migrate, verify, tableProof, digest, checkedFile, legacyFiles, argumentsFor, exportForRollback } = require("../server/migrate-mysql");

function fixture(options = {}) {
  const original = { revision: 7, employees: [{ id: 1, name: "合成员工", phone: "13800000001", employeeNo: "0007", resumeData: "data:application/pdf;base64,AP8=" }], overtime: [{ id: 3, employeeId: 1, hours: 2, status: "approved" }], leaveRequests: [] };
  const privateState = { users: { synthetic: { role: "admin", passwordHash: "SYNTHETIC_HASH" } }, organization: { revision: 2, options: { buildings: ["合成楼栋"], departments: [] } }, verifyUnchanged() { trace.push("verify-files"); if (options.changedFiles) throw new Error("synthetic changed private inputs"); } };
  const db = { tables: ["system_snapshots"], legacy: structuredClone(original), meta: null, business: null, users: null, organization: null };
  const trace = []; let tx = null;
  const current = () => tx || db;
  const connection = {
    async query(sql) {
      trace.push(sql);
      if (sql === "SELECT DATABASE() AS name") return [[{ name: "hr_test_synthetic" }]];
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: options.busy ? 0 : 1 }]];
      if (sql.includes("information_schema.tables")) return [db.tables.map(name => ({ name }))];
      if (sql.startsWith("SELECT schema_version")) return [[...(current().meta ? [{ ...structuredClone(current().meta), table_count: 1 }] : [])]];
      if (sql.startsWith("SELECT payload")) return [[{ payload: JSON.stringify(current().legacy) }]];
      if (sql.startsWith("SELECT COUNT")) return [[{ count: options.occupied ? 1 : 0 }]];
      if (sql === "DO RELEASE_ALL_LOCKS()") return [[]];
      if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ") return [[]];
      if (sql.startsWith("SELECT * FROM `hr_schema_meta`")) return [[structuredClone(current().meta)]];
      if (sql.startsWith("SELECT * FROM `hr_employees`")) return [structuredClone(current().business.employees)];
      if (sql.startsWith("SELECT * FROM `hr_auth_meta`")) return [[{ meta_key: "users", schema_version: 1 }, { meta_key: "organization", schema_version: 1 }]];
      if (sql.startsWith("SELECT * FROM `hr_accounts`")) return [Object.entries(current().users).map(([username, fields]) => ({ username, ...structuredClone(fields) }))];
      throw new Error("Unexpected synthetic SQL");
    },
    async beginTransaction() { trace.push("BEGIN"); assert.equal(tx, null); tx = structuredClone(db); },
    async commit() { trace.push("COMMIT"); if (options.fail === "commit") throw new Error("synthetic commit failure"); Object.assign(db, tx); tx = null; },
    async rollback() { trace.push("ROLLBACK"); tx = null; },
    release() { trace.push("RELEASE"); }
  };
  const store = {
    async createSchema() { trace.push("CREATE-BUSINESS"); assert.equal(tx, null); db.tables.push("hr_schema_meta", "hr_employees"); db.meta = { schema_version: 1, initialized: 0, revision: 0 }; },
    async withConnection(conn, fn) { assert.equal(conn, connection); return fn(); },
    async transaction(fn) { await connection.beginTransaction(); try { const value = await fn(); await connection.commit(); return value; } catch (error) { await connection.rollback(); throw error; } },
    async assertTargetEmpty() { trace.push("ASSERT-EMPTY"); assert.equal(current().business, null); },
    async stageLegacyBundle(business) { trace.push("BUSINESS"); assert.ok(tx); current().business = structuredClone(business); if (options.fail === "business") throw new Error("synthetic business failure"); },
    async verifyBundle(business) { trace.push("VERIFY-BUSINESS"); assert.deepEqual(current().business, business); if (options.fail === "verify") throw new Error("synthetic verification failure"); },
    async completeMigration(business, { sourceDigest }) { trace.push("MARKER"); assert.ok(tx); current().meta = { schema_version: 1, initialized: 1, revision: business.revision, migration_digest: sourceDigest }; if (options.fail === "marker") throw new Error("synthetic marker failure"); },
    async verifyInitialized() { assert.equal(current().meta.initialized, 1); return { revision: current().meta.revision }; },
    async read() { return structuredClone(current().business); }
  };
  const identity = {
    async createSchema() { trace.push("CREATE-IDENTITY"); assert.equal(tx, null); db.tables.push("hr_auth_meta", "hr_accounts"); },
    async stageLegacy(users, organization) { trace.push("IDENTITY"); assert.ok(tx); current().users = structuredClone(users); current().organization = structuredClone(organization); if (options.fail === "identity") throw new Error("synthetic identity failure"); },
    async verifyLegacy(users, organization) { trace.push("VERIFY-IDENTITY"); assert.deepEqual(current().users, users); assert.deepEqual(current().organization, organization); },
    async verifyInitialized() { assert.ok(current().users); },
    async readUsers() { return structuredClone(current().users); },
    async readOrganization() { return structuredClone(current().organization); }
  };
  const params = { pool: { getConnection: async () => connection }, createStore: () => store, createIdentityStore: () => identity, tables: ["hr_schema_meta", "hr_employees"], identityTables: ["hr_auth_meta", "hr_accounts"], privateState };
  return { params, db, trace, original, connection };
}

test("migration preflight is read-only and prints only fixed counts and aggregate digests", async () => {
  const f = fixture(); const result = await migrate(f.params);
  assert.equal(result.status, "MYSQL_RELATIONAL_MIGRATION_CHECK"); assert.equal(result.applied, false);
  assert.deepEqual(f.db.tables, ["system_snapshots"]); assert.equal(f.db.business, null);
  assert.ok(!f.trace.some(row => /^(?:CREATE|BEGIN|MARKER|BUSINESS|IDENTITY|COMMIT)/.test(row)));
  assert.doesNotMatch(JSON.stringify(result), /合成员工|13800000001|SYNTHETIC_HASH|resumeData/);
  assert.equal(result.counts.employees, 1); assert.equal(result.counts.accounts, 1);
  assert.equal(f.trace.at(-1), "RELEASE");
});

test("DDL precedes the transaction, business and identity verify together, marker commits last and legacy remains frozen", async () => {
  const f = fixture(); const result = await migrate({ ...f.params, apply: true });
  assert.equal(result.status, "MYSQL_RELATIONAL_MIGRATED"); assert.equal(result.legacyTablePreserved, true);
  assert.match(result.tablesSha256, /^[a-f0-9]{64}$/); assert.equal(result.tableCounts.hr_accounts, 1);
  assert.deepEqual(f.db.legacy, f.original); assert.deepEqual(f.db.business, f.original);
  assert.ok(f.trace.indexOf("CREATE-BUSINESS") < f.trace.indexOf("BEGIN"));
  assert.ok(f.trace.indexOf("CREATE-IDENTITY") < f.trace.indexOf("BEGIN"));
  assert.ok(f.trace.indexOf("VERIFY-BUSINESS") < f.trace.indexOf("MARKER"));
  assert.ok(f.trace.indexOf("VERIFY-IDENTITY") < f.trace.indexOf("MARKER"));
  assert.ok(f.trace.indexOf("MARKER") < f.trace.indexOf("COMMIT"));
  assert.equal(f.db.meta.migration_digest, digest({ business: f.original, users: f.params.privateState.users, organization: f.params.privateState.organization }));
  assert.ok(!f.trace.some(sql => /DROP|TRUNCATE|UPDATE system_snapshots|DELETE FROM system_snapshots/.test(sql)));
});

test("each data-stage failure rolls back all relation inserts while preserving DDL and original sources for a safe retry", async () => {
  for (const failure of ["business", "identity", "verify", "marker", "commit"]) {
    const f = fixture({ fail: failure });
    await assert.rejects(migrate({ ...f.params, apply: true }));
    assert.equal(f.db.business, null); assert.equal(f.db.users, null); assert.equal(f.db.meta.initialized, 0);
    assert.deepEqual(f.db.legacy, f.original); assert.ok(f.db.tables.includes("hr_employees"));
    assert.ok(f.trace.includes("ROLLBACK")); assert.equal(f.trace.at(-1), "RELEASE");
  }
});

test("busy lock, unknown tables, occupied targets and changed private inputs are rejected without replacing any business data", async () => {
  for (const options of [{ busy: true }, { occupied: true }, { changedFiles: true }]) {
    const f = fixture(options);
    if (options.occupied) f.db.tables.push("hr_employees");
    await assert.rejects(migrate({ ...f.params, apply: true }));
    assert.equal(f.db.business, null); assert.deepEqual(f.db.legacy, f.original);
  }
  const f = fixture(); f.db.tables.push("unreviewed_business");
  await assert.rejects(migrate({ ...f.params, apply: true }), /Unknown database tables/);
  assert.ok(!f.trace.includes("CREATE-BUSINESS"));
});

test("completed reruns preserve newer relational writes and refuse changed legacy business, accounts or organization sources", async () => {
  const f = fixture(); await migrate({ ...f.params, apply: true });
  f.db.business.employees[0].name = "合成迁移后新资料";
  const before = structuredClone(f.db); f.trace.length = 0;
  const result = await migrate({ ...f.params, apply: true });
  assert.equal(result.status, "MYSQL_RELATIONAL_ALREADY_INITIALIZED"); assert.equal(result.applied, false);
  assert.deepEqual(f.db, before); assert.ok(!f.trace.includes("CREATE-BUSINESS")); assert.ok(!f.trace.includes("MARKER"));
  for (const field of ["business", "accounts", "organization"]) {
    const item = fixture(); await migrate({ ...item.params, apply: true });
    if (field === "business") item.db.legacy.revision++;
    if (field === "accounts") item.params.privateState.users.synthetic.name = "changed";
    if (field === "organization") item.params.privateState.organization.revision++;
    const keep = structuredClone(item.db);
    await assert.rejects(migrate({ ...item.params, apply: true }), /sources changed/);
    assert.deepEqual(item.db, keep);
  }
});

test("private migration inputs reject hard links and content changes without returning sensitive bytes", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hr-migration-files-"));
  try {
    fs.writeFileSync(path.join(folder, "auth-users.json"), '{"synthetic":{"passwordHash":"ONLY-SYNTHETIC"}}');
    fs.writeFileSync(path.join(folder, "organization-settings.json"), '{"options":{"buildings":[]}}');
    const state = legacyFiles(folder); state.verifyUnchanged();
    fs.writeFileSync(path.join(folder, "organization-settings.json"), '{"options":{"buildings":["CHANGED"]}}');
    assert.throws(() => state.verifyUnchanged(), /changed/);
    fs.linkSync(path.join(folder, "auth-users.json"), path.join(folder, "linked.json"));
    assert.throws(() => checkedFile(path.join(folder, "auth-users.json")), /ordinary file/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("CLI arguments default to check and never permit ambiguous migration/export modes", () => {
  assert.equal(argumentsFor([]).apply, false);
  assert.equal(argumentsFor(["--apply"]).apply, true);
  assert.equal(argumentsFor(["--verify"]).verify, true);
  for (const argv of [["--apply", "--check"], ["--apply", "--verify"], ["--apply", "--export-rollback", "/private/result.json"], ["--verify", "--export-rollback", "/private/result.json"], ["--config"], ["--config", "a", "--config", "b"], ["--unknown"]]) assert.throws(() => argumentsFor(argv));
});

test("online verify reads only relational tables in one consistent transaction, returns matching proofs and does not need legacy sources", async () => {
  const f = fixture(), check = await migrate(f.params), applied = await migrate({ ...f.params, apply: true });
  assert.equal(check.contentSha256, applied.contentSha256); assert.equal(check.sourceDigest, applied.sourceDigest);
  f.trace.length = 0; f.db.legacy = null; delete f.params.privateState;
  const result = await verify(f.params);
  assert.equal(result.status, "MYSQL_RELATIONAL_VERIFIED"); assert.equal(result.databaseWritten, false);
  assert.equal(result.contentSha256, applied.contentSha256); assert.equal(result.tablesSha256, applied.tablesSha256);
  assert.deepEqual(result.tableCounts, applied.tableCounts);
  assert.ok(!f.trace.some(sql => /SELECT payload|GET_LOCK|CREATE|MARKER|BUSINESS|IDENTITY|COMMIT/.test(sql)));
  assert.ok(f.trace.includes("BEGIN")); assert.ok(f.trace.includes("ROLLBACK"));
  f.db.meta.extraAdministrativeColumn = "a SQL-row change outside the bundle";
  const changed = await verify(f.params); assert.equal(changed.contentSha256, result.contentSha256); assert.notEqual(changed.tablesSha256, result.tablesSha256);
});

test("SQL table fingerprints normalize dates and binary values, ignore result-row order and cover every supplied column", async () => {
  const rows = [{ id: 1, date: new Date("2026-11-23T02:00:00Z"), data: Buffer.from([0, 255]) }, { id: 2, value: { nested: "合成" } }];
  const first = await tableProof({ query: async () => [rows] }, ["hr_synthetic"]);
  const reordered = await tableProof({ query: async () => [rows.slice().reverse()] }, ["hr_synthetic"]);
  assert.equal(first.tablesSha256, reordered.tablesSha256);
  rows[0].data = Buffer.from([0, 254]);
  assert.notEqual((await tableProof({ query: async () => [rows] }, ["hr_synthetic"])).tablesSha256, first.tablesSha256);
  await assert.rejects(tableProof({ query: async () => assert.fail("must reject before I/O") }, ["../outside"]));
});

test("rollback export is a private, non-overwriting current relational recovery package without old-source writes", { skip: process.platform === "win32" || !process.getuid || process.getuid() !== 0 ? "Requires POSIX root ownership and directory fsync" : false }, async () => {
  const f = fixture(); await migrate({ ...f.params, apply: true });
  f.db.business.employees[0].name = "合成最新业务";
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hr-relational-export-")); fs.chmodSync(folder, 0o700);
  const destination = path.join(folder, "current-recovery.json"), before = structuredClone(f.db);
  try {
    const result = await exportForRollback({ ...f.params, destination });
    assert.equal(result.databaseWritten, false); assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    const content = JSON.parse(fs.readFileSync(destination, "utf8")); assert.equal(content.business.employees[0].name, "合成最新业务");
    assert.deepEqual(content.users, f.params.privateState.users); assert.deepEqual(f.db, before);
    await assert.rejects(exportForRollback({ ...f.params, destination }));
    assert.doesNotMatch(JSON.stringify(result), /合成最新业务|SYNTHETIC_HASH|13800000001/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
