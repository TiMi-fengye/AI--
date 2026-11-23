"use strict";

// The HTTP bundle is a transport format. No table stores a business bundle.
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const SCHEMA_VERSION = 1;
const META_TABLE = "hr_schema_meta";
const COLLECTIONS = ["employees", "attendance", "overtime", "leaveRequests", "settlements", "departments", "updateLogs", "performance", "approvalOutbox"];
const EMPLOYEE_FIELDS = ["id", "name", "employeeNo", "gender", "position", "company", "personAttribute", "workAttribute", "department", "status", "region", "room", "building", "phone", "email", "joinDate", "leaveDate", "aiProfile", "resumeData", "resumeName", "credentialData", "credentialName", "_resumeText", "createdAt", "updatedAt"];
const definitions = {
  employees: ["hr_employees", EMPLOYEE_FIELDS],
  attendance: ["hr_attendance", ["id", "employeeId", "date", "status", "checkIn", "checkOut", "hours", "remark", "createdAt", "updatedAt"]],
  overtime: ["hr_overtime", ["id", "employeeId", "date", "hours", "reason", "status", "overtimeType", "otPay", "otRate", "approvalStage", "approvalRegion", "createdAt", "updatedAt"]],
  leaveRequests: ["hr_leave_requests", ["id", "employeeId", "type", "startDate", "endDate", "days", "hours", "reason", "status", "lvDeduct", "lvRate", "approvalStage", "approvalRegion", "createdAt", "updatedAt"]],
  settlements: ["hr_settlements", ["id", "settlementType", "settlementVersion", "yearMonth", "totalEmployees", "totalOtPay", "totalLvDeduct", "totalFee", "createdAt", "updatedAt"]],
  departments: ["hr_departments", ["id", "name", "parentId", "description"]],
  updateLogs: ["hr_update_logs", ["id", "employeeId", "name", "building", "yearMonth", "date", "updatedAt", "createdAt", "late"]],
  performance: ["hr_performance", ["id", "employeeId", "name", "dept", "pos", "yearMonth", "month", "score", "total", "rating", "comment", "createdAt", "updatedAt"]],
  approvalOutbox: ["hr_approval_notifications", ["id", "kind", "recordId", "employeeId", "region", "status", "reason", "attempts", "createdAt", "updatedAt"]],
  approvalHistory: ["hr_approval_history", ["stage", "decision", "actorId", "name", "role", "at"]],
  settlementRecords: ["hr_settlement_records", ["employeeId", "name", "department", "position", "building", "company", "otHours", "otPay", "lvDays", "lvHours", "lvDeduct", "otRate", "lvRate", "feeBalance"]],
  notificationDeliveries: ["hr_notification_deliveries", ["username", "status", "reason", "at"]],
  notificationParameters: ["hr_notification_parameters", ["employee", "type", "start", "end", "hours"]],
  performanceScores: ["hr_performance_scores", ["score"]],
  organizationNodes: ["hr_organization_nodes", ["id", "name", "type", "employeeId", "building", "region", "department", "position"]],
  properties: ["hr_sync_properties", ["name", "kind", "value"]]
};
const numericFields = new Set(["hours", "days", "otPay", "lvDeduct", "settlementVersion", "totalEmployees", "totalOtPay", "totalLvDeduct", "totalFee", "attempts", "score", "total", "otHours", "lvDays", "lvHours", "feeBalance"]);
const indexedFields = new Set(["id", "employeeId", "building", "region", "department", "status", "date", "startDate", "yearMonth", "approvalStage", "phone", "employeeNo", "name"]);
const descriptors = Object.fromEntries(Object.entries(definitions).map(([key, [table, fields]]) => [key, { table, fields }]));
const TABLES = Object.freeze([META_TABLE, ...Object.values(descriptors).map(d => d.table)]);
const quote = name => "`" + name + "`";
const column = field => "v_" + field.replace(/^_/, "").replace(/[A-Z]/g, c => "_" + c.toLowerCase());
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function put(object, key, value) { Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true }); }
class StorageError extends Error { constructor(status, message) { super(message); this.status = status; } }
function requireValue(condition, status, message) { if (!condition) throw new StorageError(status, message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  function sort(item, seen) {
    requireValue(item !== undefined && typeof item !== "bigint" && typeof item !== "function" && typeof item !== "symbol" && !(typeof item === "number" && !Number.isFinite(item)), 400, "数据包含不能保存的值");
    if (item === null || typeof item !== "object") return item;
    requireValue(!seen.has(item), 400, "数据包含循环引用"); seen.add(item);
    let result;
    if (Array.isArray(item)) result = item.map(child => sort(child, seen));
    else { result = Object.create(null); for (const key of Object.keys(item).sort()) put(result, key, sort(item[key], seen)); }
    seen.delete(item); return result;
  }
  return JSON.stringify(sort(value, new Set()));
}
function parse(value) { return typeof value === "string" ? JSON.parse(value) : value; }
function normalizeBundle(value) {
  requireValue(plain(value), 400, "整包同步数据必须是对象");
  const result = JSON.parse(stable(value));
  if (result.revision === undefined) result.revision = 0;
  requireValue(Number.isSafeInteger(result.revision) && result.revision >= 0, 400, "同步版本无效");
  for (const key of COLLECTIONS) if (own(result, key)) requireValue(Array.isArray(result[key]), 400, "同步集合必须是数组");
  return result;
}
function encodeField(value, field) {
  if (value === null) return [null, { type: "null" }];
  if (numericFields.has(field)) {
    if (typeof value === "number" && Number.isFinite(value)) return [value, { type: "number" }];
    // Legacy numeric text must retain its exact formatting and type.
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return [Number(value), { type: "numeric-string", format: value }];
    return [null, { type: "literal", value }];
  }
  if (typeof value === "string") return [value, { type: "string" }];
  if (typeof value === "number") return [String(value), { type: "number" }];
  if (typeof value === "boolean") return [value ? "1" : "0", { type: "boolean" }];
  return [null, { type: "literal", value }];
}
function decodeField(value, state) {
  if (value === null) return state.type === "literal" ? state.value : null;
  if (state.type === "literal") return value;
  if (state.type === "numeric-string") return Number(state.format) === Number(value) ? state.format : String(value);
  if (state.type === "null") return value;
  if (state.type === "number") return Number(value);
  if (state.type === "boolean") return value === "1" || value === 1;
  return value;
}
function entityKey(record, ordinal) { return hash(plain(record) && own(record, "id") ? "id:" + stable(record.id) : "ordinal:" + ordinal); }
function encodedRow(descriptor, record, rowKey, ordinal, parentKey = null, parentKind = null, itemKey = null) {
  const row = { row_key: rowKey, ordinal, parent_key: parentKey, parent_kind: parentKind, item_key: itemKey, row_kind: plain(record) ? "object" : "scalar", field_state: {}, extras: {}, scalar_value: null };
  for (const field of descriptor.fields) row[column(field)] = null;
  if (!plain(record)) { row.scalar_value = record; return row; }
  for (const [field, value] of Object.entries(record)) {
    if (descriptor.fields.includes(field)) {
      const [stored, state] = encodeField(value, field); row[column(field)] = stored; put(row.field_state, field, state);
    } else put(row.extras, field, value);
  }
  return row;
}
function decodedRow(descriptor, input) {
  if (input.row_kind === "scalar") return parse(input.scalar_value);
  const result = {}, extras = parse(input.extras) || {}, states = parse(input.field_state) || {};
  for (const [key, value] of Object.entries(extras)) put(result, key, value);
  for (const field of descriptor.fields) {
    const value = input[column(field)];
    if (own(states, field)) put(result, field, decodeField(value, states[field]));
    else if (value !== null && value !== undefined) put(result, field, value);
  }
  return result;
}
function encodeBundle(input) {
  const bundle = normalizeBundle(input), tables = Object.fromEntries(TABLES.slice(1).map(table => [table, []]));
  function add(key, record, rowKey, ordinal, parentKey, parentKind, itemKey) {
    const descriptor = descriptors[key], copy = plain(record) ? { ...record } : record;
    const children = [];
    const explode = (field, kind, list) => {
      if (!plain(copy) || !own(copy, field)) return;
      children.push({ field, kind, list }); delete copy[field];
    };
    if (plain(copy) && (key === "overtime" || key === "leaveRequests") && Array.isArray(copy.approvalHistory)) explode("approvalHistory", "approvalHistory", copy.approvalHistory);
    if (plain(copy) && key === "settlements" && Array.isArray(copy.records)) explode("records", "settlementRecords", copy.records);
    if (plain(copy) && key === "performance" && plain(copy.scores)) explode("scores", "performanceScores", copy.scores);
    if (plain(copy) && key === "approvalOutbox") {
      if (plain(copy.deliveries)) explode("deliveries", "notificationDeliveries", copy.deliveries);
      if (plain(copy.payload)) explode("payload", "notificationParameters", copy.payload);
    }
    if (key === "organizationNodes" && plain(copy) && Array.isArray(copy.children)) explode("children", "organizationNodes", copy.children);
    const row = encodedRow(descriptor, copy, rowKey, ordinal, parentKey, parentKind, itemKey);
    for (const child of children) put(row.field_state, child.field, { type: "relation", kind: child.kind });
    tables[descriptor.table].push(row);
    for (const child of children) {
      if (child.kind === "performanceScores") Object.entries(child.list).forEach(([dimension, value], i) => add(child.kind, { score: value }, hash(key + ":" + rowKey + ":score:" + dimension), i, rowKey, key, dimension));
      else if (child.kind === "notificationDeliveries") Object.entries(child.list).forEach(([username, value], i) => add(child.kind, value, hash(key + ":" + rowKey + ":recipient:" + username), i, rowKey, key, username));
      else if (child.kind === "notificationParameters") add(child.kind, child.list, hash(key + ":" + rowKey + ":parameters"), 0, rowKey, key);
      else child.list.forEach((value, i) => add(child.kind, value, hash(key + ":" + rowKey + ":" + child.field + ":" + i), i, rowKey, key));
    }
  }
  for (const [key, value] of Object.entries(bundle)) {
    if (key === "revision") continue;
    let kind = "value";
    if (COLLECTIONS.includes(key)) {
      kind = "collection";
      const keys = new Set();
      value.forEach((record, ordinal) => { const rowKey = entityKey(record, ordinal); requireValue(!keys.has(rowKey), 400, "同一集合记录编号重复"); keys.add(rowKey); add(key, record, rowKey, ordinal); });
    } else if (key === "orgStructure") { kind = "organization"; add("organizationNodes", value, hash("organization-root"), 0); }
    add("properties", { name: key, kind, ...(kind === "value" ? { value } : {}) }, hash("property:" + key), tables.hr_sync_properties.length);
  }
  return { revision: bundle.revision, tables: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.map(sqlRow)])) };
}
function decodeBundle(tables, revision) {
  function records(kind, parentKey = null, parentKind = null) {
    const descriptor = descriptors[kind];
    return (tables[descriptor.table] || []).filter(row => row.parent_key === parentKey && row.parent_kind === parentKind).slice().sort((a, b) => Number(a.ordinal) - Number(b.ordinal)).map(row => {
      const result = decodedRow(descriptor, row), states = parse(row.field_state) || {};
      for (const [field, state] of Object.entries(states)) if (state.type === "relation") {
        let children;
        if (state.kind === "notificationDeliveries" || state.kind === "performanceScores") {
          children = {};
          for (const item of (tables[descriptors[state.kind].table] || []).filter(item => item.parent_key === row.row_key && item.parent_kind === kind).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))) {
            const decoded = decodedRow(descriptors[state.kind], item);
            put(children, item.item_key, state.kind === "performanceScores" ? decoded.score : decoded);
          }
        } else if (state.kind === "notificationParameters") children = records(state.kind, row.row_key, kind)[0];
        else children = records(state.kind, row.row_key, kind);
        put(result, field, children);
      }
      return result;
    });
  }
  const bundle = { revision };
  for (const property of records("properties")) {
    if (property.kind === "collection") { requireValue(COLLECTIONS.includes(property.name), 503, "关系表集合标记无效"); put(bundle, property.name, records(property.name)); }
    else if (property.kind === "organization") put(bundle, property.name, records("organizationNodes")[0]);
    else put(bundle, property.name, property.value);
  }
  return bundle;
}
function schemaStatements() {
  const statements = ["CREATE TABLE IF NOT EXISTS `hr_schema_meta` (`id` TINYINT NOT NULL PRIMARY KEY, `schema_version` INT NOT NULL, `initialized` TINYINT NOT NULL, `revision` BIGINT UNSIGNED NOT NULL, `migrated_at` DATETIME(3) NULL, `migration_digest` CHAR(64) NULL) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"];
  for (const descriptor of Object.values(descriptors)) {
    const columns = ["`row_key` CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY", "`ordinal` BIGINT UNSIGNED NOT NULL", "`parent_key` CHAR(64) CHARACTER SET ascii NULL", "`parent_kind` VARCHAR(40) NULL", "`item_key` LONGTEXT NULL", "`row_kind` VARCHAR(12) NOT NULL", "`field_state` JSON NOT NULL", "`extras` JSON NOT NULL", "`scalar_value` JSON NULL"];
    for (const field of descriptor.fields) columns.push(quote(column(field)) + (numericFields.has(field) ? " DOUBLE NULL" : " LONGTEXT NULL"));
    columns.push("KEY `idx_parent_order` (`parent_key`,`parent_kind`,`ordinal`)");
    for (const field of descriptor.fields.filter(field => indexedFields.has(field))) columns.push("KEY " + quote("idx_" + column(field)) + " (" + quote(column(field)) + "(100))");
    statements.push("CREATE TABLE IF NOT EXISTS " + quote(descriptor.table) + " (" + columns.join(",") + ") ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
  }
  return statements;
}
const jsonColumns = new Set(["field_state", "extras", "scalar_value"]);
function sqlRow(row) { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonColumns.has(key) && value !== null ? stable(value) : value])); }
function comparable(row) {
  const value = { ...row, ordinal: Number(row.ordinal) };
  for (const field of jsonColumns) if (value[field] !== null) value[field] = parse(value[field]);
  return stable(value);
}

function createMySQLStore(pool, { isReadOnly = () => false } = {}) {
  requireValue(pool && typeof pool.getConnection === "function", 500, "MySQL连接池无效");
  const context = new AsyncLocalStorage();
  const dirty = new WeakSet();
  function writable() { requireValue(!isReadOnly(), 503, "数据库迁移校验期间暂停写入，请稍后重试"); }
  function connection() { const current = context.getStore(); requireValue(current, 500, "数据库操作缺少事务上下文"); return current; }
  async function withConnection(conn, action) {
    const current = context.getStore();
    requireValue(!current || current === conn, 500, "不能切换活动数据库事务");
    if (current) return action();
    try { return await context.run(conn, action); } finally { dirty.delete(conn); }
  }
  async function query(sql, values = []) {
    const current = context.getStore();
    const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE|CREATE)\b/i.test(sql);
    if (mutation) writable();
    if (!current && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return transaction(() => query(sql, values));
    if (current) { if (mutation) dirty.add(current); return current.query(sql, values); }
    const conn = await pool.getConnection();
    try { return await conn.query(sql, values); } finally { conn.release(); }
  }
  async function meta(lock = false) {
    const [rows] = await query("SELECT * FROM `hr_schema_meta` WHERE `id` = 1" + (lock ? " FOR UPDATE" : ""));
    requireValue(rows.length === 1 && Number(rows[0].schema_version) === SCHEMA_VERSION, 503, "MySQL关系表尚未迁移或结构版本不匹配");
    requireValue(Number.isSafeInteger(Number(rows[0].revision)), 503, "MySQL同步版本超出安全范围");
    return { ...rows[0], revision: Number(rows[0].revision), initialized: Number(rows[0].initialized) };
  }
  async function transaction(action) {
    if (context.getStore()) return action();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      return await withConnection(conn, async () => {
        await meta(true);
        try { const result = await action(); if (dirty.has(conn)) writable(); await conn.commit(); return result; }
        catch (error) { await conn.rollback(); throw error; }
      });
    } catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
    finally { conn.release(); }
  }
  async function createSchema() {
    requireValue(!context.getStore(), 500, "建表不能在业务事务中执行");
    const conn = await pool.getConnection();
    try {
      for (const statement of schemaStatements()) await conn.query(statement);
      await conn.query("INSERT IGNORE INTO `hr_schema_meta` (`id`,`schema_version`,`initialized`,`revision`) VALUES (1,?,0,0)", [SCHEMA_VERSION]);
    } finally { conn.release(); }
  }
  async function readTables() {
    const tables = {};
    for (const descriptor of Object.values(descriptors)) {
      const fields = ["row_key", "ordinal", "parent_key", "parent_kind", "item_key", "row_kind", "field_state", "extras", "scalar_value", ...descriptor.fields.map(column)];
      // mysql2 may decode a JSON string to a JavaScript string. CAST makes JSON
      // decoding unambiguous even for a department that itself looks like JSON.
      const select = fields.map(field => jsonColumns.has(field) ? "CAST(" + quote(field) + " AS CHAR) AS " + quote(field) : quote(field)).join(",");
      const [rows] = await query("SELECT " + select + " FROM " + quote(descriptor.table) + " ORDER BY `ordinal`,`row_key`"); tables[descriptor.table] = rows;
    }
    return tables;
  }
  async function readInside() { const state = await meta(); return decodeBundle(await readTables(), state.revision); }
  async function read() {
    if (context.getStore()) return readInside();
    const conn = await pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction();
      const result = await withConnection(conn, readInside); await conn.commit(); return result;
    } catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
    finally { conn.release(); }
  }
  async function synchronize(tables) {
    const oldTables = await readTables();
    // No foreign-key cascades: legacy orphan records and their IDs are retained.
    for (const table of TABLES.slice(1)) {
      const before = new Map(oldTables[table].map(row => [row.row_key, row]));
      const after = new Map(tables[table].map(row => [row.row_key, row]));
      for (const key of before.keys()) if (!after.has(key)) await query("DELETE FROM " + quote(table) + " WHERE `row_key` = ?", [key]);
      for (const [key, row] of after) {
        if (before.has(key) && comparable(before.get(key)) === comparable(row)) continue;
        const record = row, fields = Object.keys(record);
        if (before.has(key)) {
          const changed = fields.filter(field => field !== "row_key");
          await query("UPDATE " + quote(table) + " SET " + changed.map(field => quote(field) + " = ?").join(",") + " WHERE `row_key` = ?", [...changed.map(field => record[field]), key]);
        } else await query("INSERT INTO " + quote(table) + " (" + fields.map(quote).join(",") + ") VALUES (" + fields.map(() => "?").join(",") + ")", fields.map(field => record[field]));
      }
    }
  }
  async function write(next, { expectedRevision = next && next.revision - 1 } = {}) {
    const encoded = encodeBundle(next);
    return transaction(async () => {
      writable();
      const current = await meta(true);
      requireValue(current.initialized === 1, 503, "MySQL关系表尚未完成迁移");
      requireValue(Number.isSafeInteger(expectedRevision) && expectedRevision === current.revision && encoded.revision === current.revision + 1, 409, "数据已更新，请刷新后重试");
      await synchronize(encoded.tables);
      await query("UPDATE `hr_schema_meta` SET `revision` = ? WHERE `id` = 1", [encoded.revision]);
      return { revision: encoded.revision };
    });
  }
  async function verifyInitialized() { const current = await meta(); requireValue(current.initialized === 1, 503, "MySQL关系表尚未完成迁移，请先运行迁移工具"); return { schemaVersion: SCHEMA_VERSION, revision: current.revision, initialized: true }; }
  async function assertTargetEmpty() {
    const current = await meta(true); requireValue(current.initialized === 0, 409, "MySQL关系表已迁移，禁止覆盖");
    for (const table of TABLES.slice(1)) { const [rows] = await query("SELECT COUNT(*) AS `count` FROM " + quote(table)); requireValue(Number(rows[0].count) === 0, 409, "MySQL目标关系表已有数据，禁止覆盖"); }
  }
  async function stageLegacyBundle(bundle) { connection(); await assertTargetEmpty(); const encoded = encodeBundle(bundle); await synchronize(encoded.tables); await query("UPDATE `hr_schema_meta` SET `revision` = ? WHERE `id` = 1", [encoded.revision]); return { revision: encoded.revision }; }
  async function verifyBundle(bundle) {
    const actual = await read(); requireValue(isDeepStrictEqual(actual, normalizeBundle(bundle)), 500, "关系表迁移逐字段校验失败");
    return { digest: hash(stable(actual)), counts: Object.fromEntries(COLLECTIONS.map(key => [key, (actual[key] || []).length])) };
  }
  async function completeMigration(bundle, { sourceDigest } = {}) {
    connection(); const current = await meta(true); requireValue(current.initialized === 0, 409, "MySQL关系表已迁移，禁止覆盖");
    const result = await verifyBundle(bundle);
    requireValue(sourceDigest === undefined || typeof sourceDigest === "string" && /^[a-f0-9]{64}$/.test(sourceDigest), 400, "迁移源摘要无效");
    await query("UPDATE `hr_schema_meta` SET `initialized` = 1, `migrated_at` = UTC_TIMESTAMP(3), `migration_digest` = ? WHERE `id` = 1", [sourceDigest || result.digest]);
    return result;
  }
  async function migrateFromLegacy(bundle, { beforeCommit } = {}) {
    await createSchema();
    return transaction(async () => { await stageLegacyBundle(bundle); if (beforeCommit) await beforeCommit(); return completeMigration(bundle); });
  }
  async function stats() { const state = await meta(), result = {}; for (const table of TABLES.slice(1)) { const [rows] = await query("SELECT COUNT(*) AS `count` FROM " + quote(table)); result[table] = Number(rows[0].count); } return { schemaVersion: SCHEMA_VERSION, revision: state.revision, initialized: state.initialized === 1, tables: result }; }
  return { createSchema, verifyInitialized, read, readBundle: read, write, writeBundle: write, transaction, withConnection, connection, query, assertTargetEmpty, stageLegacyBundle, verifyBundle, completeMigration, migrateFromLegacy, stats, exportForRollback: read };
}

module.exports = { SCHEMA_VERSION, META_TABLE, TABLES, COLLECTIONS, createMySQLStore, normalizeBundle, schemaStatements, encodeBundle, decodeBundle, stable, StorageError };
