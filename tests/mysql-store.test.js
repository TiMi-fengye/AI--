"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMySQLStore, TABLES, schemaStatements, encodeBundle, decodeBundle, stable } = require("../server/mysql-store");

function fixture() {
  return { revision: 8, employees: [
    { id: 2, employeeNo: "000002", name: "合成人员甲", building: "A栋", region: "华北", phone: "13800000001", resumeData: "data:text/plain;base64,c3ludGhldGlj", credentialData: "", resumeName: "合成.txt", legacyField: { retain: true }, joinDate: "2026-11-23", empty: null },
    { id: 1, employeeNo: "", name: "同名", phone: "", status: "在职", leaveDate: "", aiProfile: "合成附件说明" }
  ], attendance: [{ id: 1, employeeId: 99, date: "2026-11-20", checkIn: "09:00", checkOut: "18:30" }],
  overtime: [{ id: 1, employeeId: 2, date: "2026-11-23", hours: 2, status: "approved", overtimeType: "compensatory", approvalStage: "complete", approvalHistory: [{ stage: "leader", decision: "approved", name: "合成楼长", role: "leader", at: "2026-11-23T09:00:00Z" }, { stage: "regional", decision: "approved", legacyAudit: 42 }] }],
  leaveRequests: [{ id: 1, employeeId: 2, type: "compensatory", startDate: "2026-11-23T09:05", endDate: "2026-11-23T10:35", days: 1, hours: "1.50", status: "approved", approvalHistory: [{ stage: "leader", decision: "approved", name: "合成楼长" }] }, { id: "legacy-string-id", employeeId: "2", type: "annual", startDate: "2026-01-01", endDate: "2026-01-02", days: 2, status: "approved" }],
  settlements: [{ id: 10, yearMonth: "2026-11", totalFee: 30.25, records: [{ employeeId: 2, name: "合成人员甲", otHours: 2, feeBalance: 30.25, legacyAmount: "keep" }] }],
  departments: ["设施运维", "123", "null", "{\"looks\":\"json\"}", "设施运维", { id: 1, name: "组织部门", parentId: null }],
  updateLogs: [{ id: 4, employeeId: 2, building: "A栋", yearMonth: "2026-11", late: false, changes: ["name"] }],
  performance: [{ id: 3, employeeId: 2, yearMonth: "2026-11", name: "合成人员甲", dept: "设施", pos: "维护", scores: { "运维质量": 90, "工单": "08.00" }, total: 98 }],
  orgStructure: { id: 1, name: "合成组织", type: "company", children: [{ id: 2, name: "华北", children: [] }, { id: 3, name: "华东" }] },
  approvalOutbox: [{ id: "notice-a", kind: "leaveRequests", recordId: 1, employeeId: 2, region: "华北", status: "uncertain", reason: "delivery_unknown", attempts: 1, payload: { employee: "合成人员甲", type: "调休请假", start: "2026-11-23T09:05", end: "2026-11-23T10:35", hours: "1.5" }, deliveries: { "合成经理": { status: "uncertain", reason: "delivery_unknown" } } }],
  exportedAt: "2026-11-23T01:00:00Z", customRoot: { compatibility: true } };
}
function duplicateFixture() {
  const source = fixture();
  source.updateLogs.push({ ...source.updateLogs[0], changes: ["building"], legacyMarker: "second" }, { ...source.updateLogs[0], changes: [], legacyMarker: "third" });
  source.overtime.push({ ...structuredClone(source.overtime[0]), hours: "03.00", approvalHistory: [{ id: 7, stage: "leader", decision: "rejected" }, { id: 7, stage: "regional", decision: "approved" }] });
  source.leaveRequests.push({ ...structuredClone(source.leaveRequests[0]), reason: "duplicate request retained", approvalHistory: [{ id: 7, stage: "regional" }] });
  source.settlements.push({ id: 10, records: [{ id: 7, employeeId: 2, otPay: 1 }, { id: 7, employeeId: 2, otPay: 2 }] });
  source.performance.push({ id: 3, employeeId: 2, scores: { "运维质量": 3, "工单": "04.00" } });
  source.approvalOutbox.push({ ...structuredClone(source.approvalOutbox[0]), payload: { employee: "second", hours: "2.0" }, deliveries: { "合成经理": { status: "pending" } } });
  return source;
}
function fakePool() {
  const pool = { state: { meta: null, tables: Object.fromEntries(TABLES.slice(1).map(table => [table, []])) }, trace: [], afterMutation: null, failTable: null };
  let tail = Promise.resolve();
  pool.getConnection = async () => {
    let state, unlock, active = false;
    const conn = {
      async beginTransaction() { const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous; state = structuredClone(pool.state); active = true; pool.trace.push({ sql: "BEGIN" }); },
      async commit() { if (!active) return; pool.state = state; active = false; unlock(); pool.trace.push({ sql: "COMMIT" }); },
      async rollback() { if (!active) return; active = false; unlock(); pool.trace.push({ sql: "ROLLBACK" }); },
      release() { assert.equal(active, false, "a connection must not escape its transaction"); },
      async query(sql, values = []) {
        pool.trace.push({ sql, values: structuredClone(values) });
        const db = active ? state : pool.state;
        if (sql.startsWith("CREATE TABLE") || sql.startsWith("SET TRANSACTION")) return [[], []];
        if (sql.startsWith("INSERT IGNORE INTO `hr_schema_meta`")) { if (!db.meta) db.meta = { id: 1, schema_version: values[0], initialized: 0, revision: 0, migrated_at: null, migration_digest: null }; return [{ affectedRows: 1 }]; }
        if (sql.startsWith("SELECT * FROM `hr_schema_meta`")) return [[...(db.meta ? [structuredClone(db.meta)] : [])], []];
        if (sql.startsWith("UPDATE `hr_schema_meta`")) {
          if (sql.includes("`initialized` = 1")) Object.assign(db.meta, { initialized: 1, migrated_at: "synthetic", migration_digest: values[0] });
          else db.meta.revision = values[0];
          if (pool.afterMutation) pool.afterMutation(sql); return [{ affectedRows: 1 }];
        }
        const match = /(?:FROM|INTO|UPDATE) `([^`]+)`/.exec(sql); assert.ok(match, "recognized SQL: " + sql.slice(0, 120)); const table = match[1];
        assert.ok(TABLES.includes(table), "only reviewed tables are accessed");
        if (sql.startsWith("SELECT COUNT")) return [[{ count: db.tables[table].length }], []];
        if (sql.startsWith("SELECT")) return [structuredClone(db.tables[table]), []];
        if (pool.failTable === table) throw new Error("Synthetic transactional failure");
        if (sql.startsWith("INSERT")) {
          const fields = /\(([^)]+)\) VALUES/.exec(sql)[1].split(",").map(field => field.replace(/`/g, ""));
          db.tables[table].push(Object.fromEntries(fields.map((field, i) => [field, values[i]])));
        } else if (sql.startsWith("DELETE")) db.tables[table] = db.tables[table].filter(row => row.row_key !== values[0]);
        else if (sql.startsWith("UPDATE")) {
          const fields = sql.split(" SET ")[1].split(" WHERE ")[0].split(",").map(field => /`([^`]+)`/.exec(field)[1]);
          const row = db.tables[table].find(row => row.row_key === values.at(-1)); assert.ok(row);
          fields.forEach((field, i) => { row[field] = values[i]; });
        } else assert.fail("Unsupported synthetic SQL");
        if (pool.afterMutation) pool.afterMutation(sql); return [{ affectedRows: 1 }];
      }
    }; return conn;
  };
  return pool;
}
async function initialized(options) { const pool = fakePool(), store = createMySQLStore(pool, options); await store.migrateFromLegacy(fixture()); pool.trace = []; return { pool, store }; }

test("normalized entity rows preserve all fields, attachments, orphan IDs, ordering, minute strings and sparse arrays", () => {
  const original = fixture(), before = structuredClone(original), encoded = encodeBundle(original);
  assert.deepEqual(decodeBundle(encoded.tables, encoded.revision), original); assert.deepEqual(original, before);
  assert.equal(encoded.tables.hr_approval_history.length, 3, "overlapping overtime and leave IDs have distinct history rows");
  assert.equal(new Set(encoded.tables.hr_approval_history.map(row => row.row_key)).size, 3);
  assert.equal(encoded.tables.hr_settlement_records.length, 1); assert.equal(encoded.tables.hr_performance_scores.length, 2);
  assert.equal(encoded.tables.hr_organization_nodes.length, 3); assert.equal(encoded.tables.hr_notification_deliveries.length, 1);
  const employee = encoded.tables.hr_employees[0];
  assert.equal(employee.v_name, original.employees[0].name); assert.equal(employee.v_resume_data, original.employees[0].resumeData);
  assert.deepEqual(JSON.parse(employee.extras), { empty: null, legacyField: { retain: true } });
  assert.ok(!stable(employee.field_state).includes(original.employees[0].name));
  assert.equal(encoded.tables.hr_overtime[0].v_hours, 2);
  assert.ok(!TABLES.includes("system_snapshots")); assert.ok(schemaStatements().every(sql => !/payload|TRUNCATE|system_snapshots/.test(sql)));
});

test("known SQL columns are authoritative rather than JSON shadows, with lossless legacy numeric strings", () => {
  const encoded = encodeBundle(fixture());
  encoded.tables.hr_employees[0].v_name = "数据库直接维护的新姓名";
  encoded.tables.hr_overtime[0].v_hours = 7.5;
  encoded.tables.hr_leave_requests[0].v_hours = 3;
  const result = decodeBundle(encoded.tables, encoded.revision);
  assert.equal(result.employees[0].name, "数据库直接维护的新姓名"); assert.equal(result.overtime[0].hours, 7.5);
  assert.equal(result.leaveRequests[0].hours, "3");
});

test("direct SQL values override null or missing metadata while SQL NULL stays null for numeric text and booleans", () => {
  const source = fixture(); source.employees[0].name = null; delete source.employees[1].name; source.leaveRequests[0].hours = "0.00";
  const encoded = encodeBundle(source);
  assert.deepEqual(decodeBundle(encoded.tables, encoded.revision), source, "unchanged null and missing fields remain distinct");
  encoded.tables.hr_employees[0].v_name = "原NULL字段现在有值";
  encoded.tables.hr_employees[1].v_name = "原缺省字段现在有值";
  encoded.tables.hr_leave_requests[0].v_hours = null;
  encoded.tables.hr_update_logs[0].v_late = null;
  encoded.tables.hr_overtime[0].v_hours = null;
  const result = decodeBundle(encoded.tables, encoded.revision);
  assert.equal(result.employees[0].name, "原NULL字段现在有值");
  assert.equal(result.employees[1].name, "原缺省字段现在有值");
  assert.equal(result.leaveRequests[0].hours, null);
  assert.equal(result.updateLogs[0].late, null);
  assert.equal(result.overtime[0].hours, null);
});

test("malformed values and cyclic data fail before any database write", () => {
  for (const change of [bundle => { bundle.employees[0].hours = Infinity; }, bundle => { bundle.employees = {}; }, bundle => { bundle.self = bundle; }]) { const input = fixture(); change(input); assert.throws(() => encodeBundle(input)); }
  const input = fixture(); input.departments.push(null, true, 123, ["nested", 1]); assert.deepEqual(decodeBundle(encodeBundle(input).tables, input.revision), input);
});

test("repeated typed IDs retain every record and occurrence while unique and first-occurrence keys keep their existing values", () => {
  const source = { revision: 1, employees: [{ id: 1 }, { id: "1" }, { name: "without id" }] };
  const previous = ["b824aa9f0adf7e5566e10d86dff0cb8babe4f754ac92f43a4ba1b53f888fb24d", "f2bc160e4e524503f770fe582cea41176af55300a38f3ef378f2d53897060595", "97f0015454e0f3b9758cdfd6b3e773bbf67fb8de2d8d0975316cb3f1678633df"];
  assert.deepEqual(encodeBundle(source).tables.hr_employees.map(row => row.row_key), previous);
  source.employees.push({ id: 1, name: "numeric second" }, { id: "1", name: "text second" }, { id: true }, { id: "true" }, { id: true }, { id: null }, { id: "null" }, { id: null }, { id: [1] }, { id: [1] });
  const before = structuredClone(source), encoded = encodeBundle(source), rows = encoded.tables.hr_employees;
  assert.deepEqual(decodeBundle(encoded.tables, encoded.revision), before); assert.deepEqual(source, before);
  assert.deepEqual(rows.slice(0, 3).map(row => row.row_key), previous);
  assert.equal(new Set(rows.map(row => row.row_key)).size, rows.length);
  assert.deepEqual(rows.map(row => row.ordinal), rows.map((_, index) => index));
  assert.deepEqual(encodeBundle(decodeBundle(encoded.tables, encoded.revision)), encoded);
});

test("duplicate logs, requests and settlements keep separate histories, child records, score maps and delivery rows", () => {
  const source = duplicateFixture(), encoded = encodeBundle(source);
  assert.deepEqual(decodeBundle(encoded.tables, encoded.revision), source);
  for (const rows of Object.values(encoded.tables)) assert.equal(new Set(rows.map(row => row.row_key)).size, rows.length);
  assert.equal(encoded.tables.hr_approval_history.length, 6);
  assert.equal(encoded.tables.hr_settlement_records.length, 3);
  assert.equal(encoded.tables.hr_performance_scores.length, 4);
  assert.equal(encoded.tables.hr_notification_deliveries.length, 2);
  assert.equal(encoded.tables.hr_notification_parameters.length, 2);
  assert.deepEqual(encodeBundle(decodeBundle(encoded.tables, encoded.revision)), encoded);
});

test("duplicate occurrence rows migrate and roundtrip after reordering, edits and deletion without orphaning their children", async () => {
  const pool = fakePool(), store = createMySQLStore(pool), source = duplicateFixture();
  await store.migrateFromLegacy(source); assert.deepEqual(await store.read(), source);
  const reordered = await store.read(); reordered.revision++;
  for (const key of ["updateLogs", "overtime", "leaveRequests", "settlements", "performance", "approvalOutbox"]) reordered[key].reverse();
  reordered.overtime[0].approvalHistory[0].decision = "approved";
  await store.write(reordered); assert.deepEqual(await store.read(), reordered);
  const removed = await store.read(); removed.revision++;
  for (const key of ["updateLogs", "overtime", "leaveRequests", "settlements", "performance", "approvalOutbox"]) removed[key].splice(0, 1);
  await store.write(removed); assert.deepEqual(await store.read(), removed);
  const encoded = encodeBundle(removed);
  for (const table of TABLES.slice(1)) {
    const order = rows => rows.slice().sort((a, b) => a.row_key.localeCompare(b.row_key));
    assert.deepEqual(order(pool.state.tables[table]), order(encoded.tables[table]), "no stale duplicate or child row remains in " + table);
  }
});

test("migration stages in an explicit transaction and verifies round-trip before setting initialized", async () => {
  const pool = fakePool(), store = createMySQLStore(pool); await store.createSchema();
  await assert.rejects(store.verifyInitialized(), error => error.status === 503);
  const conn = await pool.getConnection(); await conn.beginTransaction();
  await store.withConnection(conn, async () => {
    await store.assertTargetEmpty(); await store.stageLegacyBundle(fixture());
    assert.equal((await store.query("SELECT * FROM `hr_schema_meta` WHERE `id` = 1"))[0][0].initialized, 0);
    await store.verifyBundle(fixture()); await store.completeMigration(fixture(), { sourceDigest: "a".repeat(64) });
  });
  assert.equal(pool.state.meta.initialized, 0, "the owner has not committed yet"); await conn.commit(); conn.release();
  assert.equal(pool.state.meta.migration_digest, "a".repeat(64)); assert.deepEqual(await store.read(), fixture());
  assert.deepEqual(await store.verifyInitialized(), { schemaVersion: 1, revision: 8, initialized: true });
  await assert.rejects(store.migrateFromLegacy(fixture()), error => error.status === 409);
});

test("whole-bundle sync only changes the modified row and metadata, never rewrites unrelated entity tables", async () => {
  const { pool, store } = await initialized(); const next = await store.read(); next.revision++; next.employees[0].name = "姓名已修改"; pool.trace = [];
  await store.write(next, { expectedRevision: 8 });
  const mutations = pool.trace.filter(row => /^(INSERT|UPDATE|DELETE)/.test(row.sql));
  assert.equal(mutations.length, 2); assert.match(mutations[0].sql, /^UPDATE `hr_employees` /); assert.match(mutations[1].sql, /^UPDATE `hr_schema_meta` /);
  assert.deepEqual(await store.read(), next);
  pool.trace = []; const unchanged = structuredClone(next); unchanged.revision++; await store.write(unchanged);
  assert.equal(pool.trace.filter(row => /^(INSERT|UPDATE|DELETE)/.test(row.sql)).length, 1);
});

test("partial SQL failures rollback every row and revision; failure during migration never marks a half migration complete", async () => {
  const { pool, store } = await initialized(); const next = fixture(); next.revision++; next.employees[0].name = "must rollback"; next.overtime[0].hours = 9; pool.failTable = "hr_overtime";
  await assert.rejects(store.write(next), /Synthetic transactional failure/); pool.failTable = null; assert.deepEqual(await store.read(), fixture());
  const emptyPool = fakePool(), emptyStore = createMySQLStore(emptyPool); emptyPool.failTable = "hr_leave_requests";
  await assert.rejects(emptyStore.migrateFromLegacy(fixture()), /Synthetic transactional failure/);
  assert.equal(emptyPool.state.meta.initialized, 0); assert.ok(Object.values(emptyPool.state.tables).every(rows => rows.length === 0));
});

test("concurrent stale bundles cannot overwrite a previously committed change across store instances", async () => {
  const { pool, store } = await initialized(); const other = createMySQLStore(pool);
  const one = fixture(), two = fixture(); one.revision++; two.revision++; one.employees[0].name = "winner"; two.employees[1].name = "stale";
  const results = await Promise.allSettled([store.write(one), other.write(two)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.find(row => row.status === "rejected").reason.status, 409);
  assert.deepEqual(await store.read(), one); assert.ok(pool.trace.some(row => /FOR UPDATE$/.test(row.sql)));
});

test("nested business/auth transactions share one connection and do not commit their inner work", async () => {
  const { pool, store } = await initialized(); let innerConnection; pool.trace = [];
  await store.transaction(async () => {
    innerConnection = store.connection(); const next = await store.read(); next.revision++; next.employees[0].name = "same transaction";
    await store.transaction(async () => { assert.equal(store.connection(), innerConnection); await store.write(next); });
    assert.equal(pool.trace.filter(row => row.sql === "COMMIT").length, 0);
    throw new Error("synthetic account write failed");
  }).then(() => assert.fail("must reject"), error => assert.match(error.message, /account write failed/));
  assert.deepEqual(await store.read(), fixture()); assert.throws(() => store.connection(), error => error.status === 500);
});

test("maintenance gate blocks mutations and rolls back if it rises during a write, while reads still work", async () => {
  let held = false; const { pool, store } = await initialized({ isReadOnly: () => held });
  const next = fixture(); next.revision++; next.employees[0].name = "not committed"; held = true;
  await assert.rejects(store.write(next), error => error.status === 503); assert.deepEqual(await store.read(), fixture());
  held = false; pool.afterMutation = () => { held = true; };
  await assert.rejects(store.write(next), error => error.status === 503); pool.afterMutation = null;
  assert.deepEqual(await store.read(), fixture());
});

module.exports = { fixture };
