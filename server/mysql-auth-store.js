"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const ACCOUNT_FIELDS = {
  name: "name", role: "role", employeeId: "employee_id", phone: "phone",
  passwordHash: "password_hash", passwordSalt: "password_salt", createdAt: "created_at"
};
const AUTH_TABLES = ["hr_auth_meta", "hr_accounts", "hr_account_buildings", "hr_account_regions", "hr_organization_option_keys", "hr_organization_options", "hr_organization_leaders"];
const ENGINE = " ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin";
const DDL = [
  "CREATE TABLE IF NOT EXISTS hr_auth_meta (meta_key VARCHAR(64) NOT NULL PRIMARY KEY, revision BIGINT UNSIGNED NOT NULL, schema_version INT NOT NULL, field_presence JSON NOT NULL, extra_fields JSON NOT NULL)" + ENGINE,
  "CREATE TABLE IF NOT EXISTS hr_accounts (username VARCHAR(80) NOT NULL PRIMARY KEY, row_order BIGINT UNSIGNED NOT NULL, name TEXT NULL, role VARCHAR(32) NULL, employee_id BIGINT UNSIGNED NULL, phone VARCHAR(32) NULL, password_hash VARCHAR(1024) NULL, password_salt VARCHAR(1024) NULL, created_at VARCHAR(64) NULL, field_presence JSON NOT NULL, extra_fields JSON NOT NULL, INDEX idx_hr_account_employee(employee_id), INDEX idx_hr_account_phone(phone), INDEX idx_hr_account_role(role))" + ENGINE,
  "CREATE TABLE IF NOT EXISTS hr_account_buildings (username VARCHAR(80) NOT NULL, ordinal BIGINT UNSIGNED NOT NULL, value TEXT NOT NULL, PRIMARY KEY(username,ordinal))" + ENGINE,
  "CREATE TABLE IF NOT EXISTS hr_account_regions (username VARCHAR(80) NOT NULL, ordinal BIGINT UNSIGNED NOT NULL, value TEXT NOT NULL, PRIMARY KEY(username,ordinal))" + ENGINE,
  "CREATE TABLE IF NOT EXISTS hr_organization_option_keys (option_key VARCHAR(100) NOT NULL PRIMARY KEY, row_order BIGINT UNSIGNED NOT NULL)" + ENGINE,
  "CREATE TABLE IF NOT EXISTS hr_organization_options (option_key VARCHAR(100) NOT NULL, ordinal BIGINT UNSIGNED NOT NULL, value TEXT NOT NULL, PRIMARY KEY(option_key,ordinal))" + ENGINE,
  "CREATE TABLE IF NOT EXISTS hr_organization_leaders (ordinal BIGINT UNSIGNED NOT NULL PRIMARY KEY, building TEXT NULL, leaders JSON NULL, field_presence JSON NOT NULL, extra_fields JSON NOT NULL)" + ENGINE
];
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function json(value) { return JSON.stringify(value); }
function decoded(value) { return typeof value === "string" ? JSON.parse(value) : Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : value; }
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => json(key) + ":" + stable(value[key])).join(",") + "}";
  return json(value);
}
function split(value, fields) {
  const presence = Object.keys(value), extra = {};
  for (const [key, item] of Object.entries(value)) if (!fields.includes(key)) Object.defineProperty(extra, key, { value: item, enumerable: true, writable: true, configurable: true });
  return { presence, extra };
}
function restore(row, fields, includeAssignedColumns = true) {
  const presence = decoded(row.field_presence), extra = decoded(row.extra_fields);
  if (!Array.isArray(presence) || !object(extra)) fail(503, "MySQL账号或组织数据结构无效");
  const value = {};
  for (const key of presence) {
    const item = Object.hasOwn(fields, key) ? row[fields[key]] : extra[key];
    Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  // Field-presence metadata preserves absent versus NULL on migration. A later
  // non-NULL SQL assignment is authoritative even when that field was absent.
  if (includeAssignedColumns) for (const [key, column] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key) && row[column] !== null && row[column] !== undefined) Object.defineProperty(value, key, { value: row[column], enumerable: true, writable: true, configurable: true });
  }
  return value;
}
function accountData(username, value, order) {
  if (typeof username !== "string" || !username || username.length > 80 || !object(value)) fail(400, "迁移账号结构无效");
  for (const [key, column] of Object.entries(ACCOUNT_FIELDS)) if (value[key] !== undefined && value[key] !== null) {
    if (key === "employeeId" ? !Number.isSafeInteger(value[key]) || value[key] < 0 : typeof value[key] !== "string") fail(400, "账号字段类型无效，不能有损迁移");
  }
  for (const key of ["buildings", "regions"]) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== "string"))) fail(400, "账号授权范围格式无效");
  const { presence, extra } = split(value, [...Object.keys(ACCOUNT_FIELDS), "buildings", "regions"]);
  return [username, order, ...Object.keys(ACCOUNT_FIELDS).map(key => value[key] === undefined ? null : value[key]), json(presence), json(extra)];
}

function createMySQLAuthStore(store, { isReadOnly = () => false } = {}) {
  if (!store || typeof store.query !== "function" || typeof store.transaction !== "function") throw new Error("Shared MySQL transaction store is required");
  function active() { try { return !!store.connection(); } catch (_) { return false; } }
  function writable() { if (isReadOnly()) fail(503, "数据库迁移校验中，暂不能写入账号或组织"); }
  function transaction(action) { return active() ? action() : store.transaction(action); }
  async function rows(sql, values = []) { const result = await store.query(sql, values); return result[0]; }
  async function createSchema() { for (const sql of DDL) await store.query(sql); }
  async function assertEmpty() {
    for (const table of AUTH_TABLES) {
      const result = await rows("SELECT COUNT(*) AS count FROM `" + table + "`");
      if (Number(result[0].count)) fail(409, "关系化账号或组织目标已有数据，停止迁移");
    }
  }
  async function readUsers() { return transaction(async () => {
    const accounts = await rows("SELECT username,row_order,name,role,employee_id,phone,password_hash,password_salt,created_at,CAST(field_presence AS CHAR) AS field_presence,CAST(extra_fields AS CHAR) AS extra_fields FROM hr_accounts ORDER BY row_order, username");
    const buildings = await rows("SELECT * FROM hr_account_buildings ORDER BY username, ordinal");
    const regions = await rows("SELECT * FROM hr_account_regions ORDER BY username, ordinal");
    const result = Object.create(null);
    for (const row of accounts) {
      const user = restore(row, ACCOUNT_FIELDS);
      if (Object.hasOwn(user, "employeeId") && user.employeeId !== null) user.employeeId = Number(user.employeeId);
      const presence = decoded(row.field_presence);
      if (presence.includes("buildings")) user.buildings = buildings.filter(item => item.username === row.username).map(item => item.value);
      if (presence.includes("regions")) user.regions = regions.filter(item => item.username === row.username).map(item => item.value);
      result[row.username] = user;
    }
    if ([...buildings, ...regions].some(row => !Object.hasOwn(result, row.username))) fail(503, "MySQL账号授权记录存在无效关联");
    return result;
  }); }
  async function writeUsers(next) { return transaction(async () => {
    writable();
    if (!object(next)) fail(400, "账号集合格式无效");
    const before = await readUsers(), previousOrder = Object.keys(before);
    const entries = Object.entries(next);
    // Validate all rows before changing any SQL row.
    const prepared = entries.map(([username, user], order) => accountData(username, user, order));
    let changed = false;
    for (const username of previousOrder) if (!Object.hasOwn(next, username)) {
      await store.query("DELETE FROM hr_account_buildings WHERE username = ?", [username]);
      await store.query("DELETE FROM hr_account_regions WHERE username = ?", [username]);
      await store.query("DELETE FROM hr_accounts WHERE username = ?", [username]); changed = true;
    }
    for (let order = 0; order < entries.length; order++) {
      const [username, user] = entries[order], old = before[username];
      if (!isDeepStrictEqual(old, user) || previousOrder.indexOf(username) !== order) {
        await store.query("INSERT INTO hr_accounts (username,row_order,name,role,employee_id,phone,password_hash,password_salt,created_at,field_presence,extra_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE row_order=VALUES(row_order),name=VALUES(name),role=VALUES(role),employee_id=VALUES(employee_id),phone=VALUES(phone),password_hash=VALUES(password_hash),password_salt=VALUES(password_salt),created_at=VALUES(created_at),field_presence=VALUES(field_presence),extra_fields=VALUES(extra_fields)", prepared[order]); changed = true;
      }
      for (const [field, table] of [["buildings", "hr_account_buildings"], ["regions", "hr_account_regions"]]) {
        if (isDeepStrictEqual(old && old[field], user[field])) continue;
        await store.query("DELETE FROM " + table + " WHERE username = ?", [username]);
        for (let ordinal = 0; ordinal < (user[field] || []).length; ordinal++) await store.query("INSERT INTO " + table + " (username,ordinal,value) VALUES (?,?,?)", [username, ordinal, user[field][ordinal]]);
      }
    }
    if (changed) await store.query("UPDATE hr_auth_meta SET revision = revision + 1 WHERE meta_key = 'users'");
  }); }
  async function readOrganization() { return transaction(async () => {
    const meta = (await rows("SELECT meta_key,revision,schema_version,CAST(field_presence AS CHAR) AS field_presence,CAST(extra_fields AS CHAR) AS extra_fields FROM hr_auth_meta WHERE meta_key = 'organization'"))[0];
    if (!meta) fail(503, "MySQL组织配置尚未显式迁移");
    // These non-null defaults are control metadata, not newly assigned business
    // fields; missing legacy schemaVersion/revision retain their original shape.
    const value = restore(meta, { schemaVersion: "schema_version", revision: "revision" }, false);
    if (Object.hasOwn(value, "schemaVersion")) value.schemaVersion = Number(value.schemaVersion);
    if (Object.hasOwn(value, "revision")) value.revision = Number(value.revision);
    const presence = decoded(meta.field_presence);
    const keys = await rows("SELECT * FROM hr_organization_option_keys ORDER BY row_order, option_key");
    const options = await rows("SELECT * FROM hr_organization_options ORDER BY option_key, ordinal");
    if (presence.includes("options")) {
      value.options = {};
      for (const row of keys) Object.defineProperty(value.options, row.option_key, { value: options.filter(item => item.option_key === row.option_key).map(item => item.value), enumerable: true, writable: true, configurable: true });
    }
    if (options.some(item => !keys.some(key => key.option_key === item.option_key))) fail(503, "MySQL组织选项存在无效关联");
    if (presence.includes("buildingLeaders")) value.buildingLeaders = (await rows("SELECT ordinal,building,CAST(leaders AS CHAR) AS leaders,CAST(field_presence AS CHAR) AS field_presence,CAST(extra_fields AS CHAR) AS extra_fields FROM hr_organization_leaders ORDER BY ordinal")).map(row => {
      const result = restore(row, { building: "building", leaders: "leaders" });
      if (Object.hasOwn(result, "leaders")) result.leaders = decoded(result.leaders);
      return result;
    });
    return value;
  }); }
  async function writeOrganization(next) { return transaction(async () => {
    writable();
    if (!object(next) || !object(next.options || {}) || (next.revision !== undefined && (!Number.isSafeInteger(next.revision) || next.revision < 0))) fail(400, "组织配置结构无效");
    const meta = (await rows("SELECT * FROM hr_auth_meta WHERE meta_key = 'organization'"))[0];
    const before = meta ? await readOrganization() : { options: {} };
    const oldKeys = Object.keys(before.options || {}), keys = Object.keys(next.options || {});
    for (const key of keys) if (!key || key.length > 100 || !Array.isArray(next.options[key]) || next.options[key].some(item => typeof item !== "string")) fail(400, "组织选项结构无效");
    if (next.buildingLeaders !== undefined && (!Array.isArray(next.buildingLeaders) || next.buildingLeaders.some(item => !object(item)))) fail(400, "楼栋配置结构无效");
    for (const key of oldKeys) if (!keys.includes(key)) {
      await store.query("DELETE FROM hr_organization_options WHERE option_key = ?", [key]);
      await store.query("DELETE FROM hr_organization_option_keys WHERE option_key = ?", [key]);
    }
    for (let order = 0; order < keys.length; order++) {
      const key = keys[order];
      if (!oldKeys.includes(key) || oldKeys.indexOf(key) !== order) await store.query("INSERT INTO hr_organization_option_keys (option_key,row_order) VALUES (?,?) ON DUPLICATE KEY UPDATE row_order=VALUES(row_order)", [key, order]);
      if (isDeepStrictEqual((before.options || {})[key], next.options[key])) continue;
      await store.query("DELETE FROM hr_organization_options WHERE option_key = ?", [key]);
      for (let ordinal = 0; ordinal < next.options[key].length; ordinal++) await store.query("INSERT INTO hr_organization_options (option_key,ordinal,value) VALUES (?,?,?)", [key, ordinal, next.options[key][ordinal]]);
    }
    const oldLeaders = before.buildingLeaders || [], leaders = next.buildingLeaders || [];
    for (let ordinal = 0; ordinal < Math.max(oldLeaders.length, leaders.length); ordinal++) {
      if (isDeepStrictEqual(oldLeaders[ordinal], leaders[ordinal])) continue;
      if (!leaders[ordinal]) { await store.query("DELETE FROM hr_organization_leaders WHERE ordinal = ?", [ordinal]); continue; }
      const { presence, extra } = split(leaders[ordinal], ["building", "leaders"]);
      await store.query("INSERT INTO hr_organization_leaders (ordinal,building,leaders,field_presence,extra_fields) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE building=VALUES(building),leaders=VALUES(leaders),field_presence=VALUES(field_presence),extra_fields=VALUES(extra_fields)", [ordinal, leaders[ordinal].building === undefined ? null : leaders[ordinal].building, leaders[ordinal].leaders === undefined ? null : json(leaders[ordinal].leaders), json(presence), json(extra)]);
    }
    const { presence, extra } = split(next, ["schemaVersion", "revision", "options", "buildingLeaders"]);
    await store.query("INSERT INTO hr_auth_meta (meta_key,revision,schema_version,field_presence,extra_fields) VALUES ('organization',?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),schema_version=VALUES(schema_version),field_presence=VALUES(field_presence),extra_fields=VALUES(extra_fields)", [next.revision === undefined ? 0 : next.revision, next.schemaVersion === undefined ? 1 : next.schemaVersion, json(presence), json(extra)]);
  }); }
  async function stageLegacy(users, organization) {
    if (!active()) throw new Error("Migration requires the shared outer MySQL transaction");
    await assertEmpty();
    await store.query("INSERT INTO hr_auth_meta (meta_key,revision,schema_version,field_presence,extra_fields) VALUES ('users',0,1,?,?)", ["[]", "{}"]);
    await writeUsers(users || {});
    await writeOrganization(organization || { schemaVersion: 1, revision: 0, options: {} });
  }
  async function verifyLegacy(users, organization) {
    const actualUsers = await readUsers(), actualOrganization = await readOrganization();
    if (stable(actualUsers) !== stable(users || {}) || stable(actualOrganization) !== stable(organization || { schemaVersion: 1, revision: 0, options: {} })) fail(409, "MySQL账号或组织逐字段校验未通过，停止迁移");
    return { users: Object.keys(actualUsers).length, optionLists: Object.keys(actualOrganization.options || {}).length, digest: crypto.createHash("sha256").update(stable({ users: actualUsers, organization: actualOrganization })).digest("hex") };
  }
  async function verifyInitialized() {
    const meta = await transaction(() => rows("SELECT meta_key,schema_version FROM hr_auth_meta ORDER BY meta_key"));
    if (meta.length !== 2 || !meta.some(row => row.meta_key === "users") || !meta.some(row => row.meta_key === "organization") || meta.some(row => Number(row.schema_version) !== 1)) fail(503, "MySQL账号与组织尚未完整迁移");
  }
  return { createSchema, assertEmpty, readUsers, writeUsers, readOrganization, writeOrganization, stageLegacy, verifyLegacy, verifyInitialized, transaction };
}

module.exports = { createMySQLAuthStore, AUTH_TABLES, DDL, stable };
