"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const { createMySQLStore, TABLES } = require("../server/mysql-store");
const required = process.env.HR_REQUIRE_MYSQL_TESTS === "true";
const configured = !!process.env.HR_TEST_MYSQL_URL;

test("real MySQL relational migration, SQL-column authority, sparse preservation and multi-connection CAS", { skip: !configured && !required }, async () => {
  assert.ok(configured, "HR_TEST_MYSQL_URL is required for the MySQL integration job");
  let driver;
  try { driver = require(require.resolve("mysql2/promise", { paths: [path.join(__dirname, "../server")] })); }
  catch (_) { assert.fail("The integration job must install the existing mysql2 dependency"); }
  const url = new URL(process.env.HR_TEST_MYSQL_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Integration tests only use a loopback MySQL service");
  const options = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), connectionLimit: 4, charset: "utf8mb4" };
  const database = "hr_store_test_" + crypto.randomBytes(8).toString("hex");
  const admin = driver.createPool(options); let pool;
  try {
    await admin.query("CREATE DATABASE `" + database + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    pool = driver.createPool({ ...options, database }); const store = createMySQLStore(pool);
    const source = { revision: 7, employees: [{ id: 1, employeeNo: "00001", name: "合成人员", phone: "13800000001", region: "华北", resumeData: "data:text/plain;base64," + Buffer.from("synthetic attachment").toString("base64"), legacy: { preserve: true } }], attendance: [{ id: 6, employeeId: 99, date: "2026-01-01" }], overtime: [{ id: 8, employeeId: 1, date: "2026-11-23", hours: 2, status: "approved", approvalHistory: [{ stage: "leader", decision: "approved" }] }], leaveRequests: [{ id: 8, employeeId: 1, startDate: "2026-11-23T09:05", endDate: "2026-11-23T10:35", hours: "1.50", days: 1, approvalHistory: [{ stage: "regional", decision: "approved" }] }], departments: ["null", "123", "{\"keep\":true}", "设施", "设施"], settlements: [{ id: 4, records: [{ employeeId: 1, otPay: 25.5, arbitrary: false }] }], performance: [{ id: 3, employeeId: 1, scores: { quality: 95.5, operations: "08.00" }, total: 103.5 }], updateLogs: [], orgStructure: { id: 1, name: "组织", children: [{ id: 2, name: "部门", children: [] }] }, approvalOutbox: [{ id: "synthetic-event", payload: { employee: "合成人员", hours: "1.5" }, deliveries: { syntheticManager: { status: "uncertain" } } }] };
    source.employees.push({ id: 2, name: null }, { id: 3 });
    source.leaveRequests.push({ id: 9, employeeId: 1, hours: "0.00" });
    source.updateLogs.push({ id: 2, late: false });
    await store.migrateFromLegacy(source); assert.deepEqual(await store.read(), source);
    const [tables] = await pool.query("SHOW TABLES"); assert.equal(tables.length, TABLES.length); assert.ok(!tables.some(row => Object.values(row).includes("system_snapshots")));
    await pool.query("UPDATE `hr_employees` SET `v_name` = ? WHERE `v_id` = ?", ["SQL列修改", "1"]);
    await pool.query("UPDATE `hr_overtime` SET `v_hours` = ? WHERE `v_id` = ?", [5.5, "8"]);
    await pool.query("UPDATE `hr_employees` SET `v_name` = ? WHERE `v_id` = ?", ["原NULL的新值", "2"]);
    await pool.query("UPDATE `hr_employees` SET `v_name` = ? WHERE `v_id` = ?", ["原缺省的新值", "3"]);
    await pool.query("UPDATE `hr_leave_requests` SET `v_hours` = NULL WHERE `v_id` = ?", ["9"]);
    await pool.query("UPDATE `hr_update_logs` SET `v_late` = NULL WHERE `v_id` = ?", ["2"]);
    let current = await store.read(); assert.equal(current.employees[0].name, "SQL列修改"); assert.equal(current.overtime[0].hours, 5.5);
    assert.equal(current.employees[1].name, "原NULL的新值"); assert.equal(current.employees[2].name, "原缺省的新值");
    assert.equal(current.leaveRequests[1].hours, null); assert.equal(current.updateLogs[0].late, null);
    const first = structuredClone(current), second = structuredClone(current); first.revision++; second.revision++; first.employees[0].email = "synthetic@example.com"; second.employees[0].email = "stale@example.com";
    const concurrent = await Promise.allSettled([store.write(first), createMySQLStore(pool).write(second)]);
    assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1); assert.equal(concurrent.find(row => row.status === "rejected").reason.status, 409);
    current = await store.read(); const before = structuredClone(current);
    await assert.rejects(store.transaction(async () => { const next = await store.read(); next.revision++; next.employees[0].name = "rolled back"; await store.write(next); throw new Error("synthetic account failure"); }), /synthetic account failure/);
    assert.deepEqual(await store.read(), before);
    await assert.rejects(store.migrateFromLegacy(source), error => error.status === 409);
  } finally {
    if (pool) await pool.end();
    assert.match(database, /^hr_store_test_[a-f0-9]{16}$/);
    await admin.query("DROP DATABASE IF EXISTS `" + database + "`"); await admin.end();
  }
});
