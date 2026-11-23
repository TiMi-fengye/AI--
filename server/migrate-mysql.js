"use strict";

// Explicit maintenance only. Importing this file never reads config or data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

class MigrationError extends Error {}
function requireState(value, message) { if (!value) throw new MigrationError(message); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function summary(business, users, organization) {
  business = { ...business, revision: business.revision === undefined ? 0 : business.revision };
  const counts = Object.fromEntries(["employees", "attendance", "overtime", "leaveRequests", "settlements", "departments", "updateLogs", "performance", "approvalOutbox"].filter(key => Array.isArray(business[key])).map(key => [key, business[key].length]));
  counts.accounts = Object.keys(users || {}).length;
  counts.organizationOptionGroups = Object.keys(organization && organization.options || {}).length;
  return { counts, contentSha256: digest({ business, users, organization }) };
}
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function checkedFile(filename, max = 32 * 1024 * 1024) {
  requireState(path.isAbsolute(filename), "Private input must use an absolute path");
  requireState(fs.realpathSync(filename) === filename, "Private input paths cannot contain symbolic links");
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(descriptor);
    requireState(info.isFile() && info.nlink === 1 && info.size <= max, "Private input must be a bounded ordinary file");
    const raw = fs.readFileSync(descriptor);
    return { value: JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")), sha256: crypto.createHash("sha256").update(raw).digest("hex") };
  } finally { fs.closeSync(descriptor); }
}
function legacyFiles(dataDirectory) {
  const usersPath = path.join(dataDirectory, "auth-users.json");
  const organizationPath = path.join(dataDirectory, "organization-settings.json");
  const users = checkedFile(usersPath), organization = checkedFile(organizationPath);
  requireState(plain(users.value) && plain(organization.value), "Legacy account or organization shape is invalid");
  return {
    users: users.value, organization: organization.value,
    verifyUnchanged() {
      requireState(checkedFile(usersPath).sha256 === users.sha256 && checkedFile(organizationPath).sha256 === organization.sha256,
        "Legacy account or organization data changed during migration");
    }
  };
}

async function tableNames(connection) {
  const [rows] = await connection.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE'");
  return rows.map(row => row.name).sort();
}
async function metadata(connection, tables) {
  if (!tables.includes("hr_schema_meta")) return null;
  const [rows] = await connection.query("SELECT schema_version,initialized,revision,migration_digest,(SELECT COUNT(*) FROM hr_schema_meta) AS table_count FROM hr_schema_meta WHERE id=1");
  requireState(rows.length <= 1 && (!rows.length || Number(rows[0].table_count) === 1 && Number(rows[0].schema_version) === 1), "Relational migration metadata is ambiguous or unsupported");
  if (!rows.length) {
    const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM hr_schema_meta");
    requireState(Number(row.count) === 0, "Relational migration metadata has unrecognized rows");
  }
  return rows[0] || null;
}
async function legacyBusiness(connection, locked = false) {
  const [rows] = await connection.query("SELECT payload FROM system_snapshots WHERE snapshot_key='default'" + (locked ? " FOR UPDATE" : ""));
  requireState(rows.length === 1 && typeof rows[0].payload === "string", "Exactly one legacy business record is required");
  let bundle;
  try { bundle = JSON.parse(rows[0].payload); } catch (_) { throw new MigrationError("Legacy business data is not valid JSON"); }
  requireState(plain(bundle) && Array.isArray(bundle.employees), "Legacy business data has an invalid shape");
  return bundle;
}

function sqlValues(value) {
  if (value instanceof Date) return { type: "datetime", value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { type: "binary", value: value.toString("base64") };
  if (typeof value === "bigint") return { type: "bigint", value: String(value) };
  if (Array.isArray(value)) return value.map(sqlValues);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sqlValues(item)]));
  return value;
}
async function tableProof(connection, names) {
  const tables = [...new Set(names)].sort(), tableCounts = {}, hashes = {};
  requireState(tables.length === names.length && tables.every(name => /^hr_[a-z_]+$/.test(name)), "Relational table proof contains an unsafe identifier");
  for (const name of tables) {
    const [rows] = await connection.query("SELECT * FROM `" + name + "`");
    const canonicalRows = rows.map(row => JSON.stringify(stable(sqlValues(row)))).sort();
    tableCounts[name] = rows.length;
    hashes[name] = { count: rows.length, sha256: digest(canonicalRows) };
  }
  return { tables, tableCounts, tablesSha256: digest(hashes) };
}
async function proofInside(connection, store, identity, names) {
  const marker = await store.verifyInitialized();
  await identity.verifyInitialized();
  const business = await store.read(), users = await identity.readUsers(), organization = await identity.readOrganization();
  const state = await metadata(connection, await tableNames(connection));
  requireState(state && Number(state.initialized) === 1 && /^[a-f0-9]{64}$/.test(state.migration_digest || ""), "Relational migration marker is invalid");
  const present = await tableNames(connection), expected = new Set([...names, "system_snapshots"]);
  requireState(names.every(name => present.includes(name)) && present.every(name => expected.has(name)), "Relational table inventory is incomplete or unreviewed");
  return { initialized: true, model: "relational", schemaVersion: 1, revision: marker.revision === undefined ? business.revision || 0 : marker.revision,
    sourceDigest: state.migration_digest, ...summary(business, users, organization), ...await tableProof(connection, names) };
}

async function verify({ pool, createStore, createIdentityStore, tables, identityTables }) {
  const connection = await pool.getConnection(), store = createStore(pool), identity = createIdentityStore(store);
  let transaction = false;
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction(); transaction = true;
    const result = await store.withConnection(connection, () => proofInside(connection, store, identity, [...tables, ...identityTables]));
    await connection.rollback(); transaction = false;
    return { status: "MYSQL_RELATIONAL_VERIFIED", applied: false, databaseWritten: false, ...result };
  } finally {
    if (transaction) { try { await connection.rollback(); } catch (_) {} }
    connection.release();
  }
}

/** Caller supplies public storage modules and one pool; no credentials returned. */
async function migrate({ pool, createStore, createIdentityStore, tables, identityTables, privateState, apply = false }) {
  const connection = await pool.getConnection();
  let locked = false, transaction = false;
  try {
    const [[database]] = await connection.query("SELECT DATABASE() AS name");
    requireState(database && typeof database.name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(database.name), "Migration database is invalid");
    const lockName = "hr-relational-migration-" + crypto.createHash("sha256").update(database.name).digest("hex").slice(0, 32);
    const [[lock]] = await connection.query("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
    requireState(lock && Number(lock.acquired) === 1, "Another database migration is running");
    locked = true;
    const store = createStore(pool), identity = createIdentityStore(store);
    const known = new Set(["system_snapshots", ...tables, ...identityTables]);
    let present = await tableNames(connection);
    requireState(present.every(name => known.has(name)), "Unknown database tables require review before migration");
    const state = await metadata(connection, present);
    if (state && Number(state.initialized) === 1) {
      requireState(privateState && plain(privateState.users) && plain(privateState.organization) && present.includes("system_snapshots"), "Frozen migration sources are required for an initialized migration check");
      const source = await legacyBusiness(connection);
      requireState(state.migration_digest === digest({ business: source, users: privateState.users, organization: privateState.organization }), "Legacy migration sources changed after initialization; review required before retry");
      privateState.verifyUnchanged();
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.beginTransaction(); transaction = true;
      const result = await store.withConnection(connection, async () => {
        return { status: "MYSQL_RELATIONAL_ALREADY_INITIALIZED", applied: false, databaseWritten: false,
          ...await proofInside(connection, store, identity, [...tables, ...identityTables]) };
      });
      await connection.rollback(); transaction = false;
      return result;
    }
    requireState(!state || Number(state.initialized) === 0, "Migration metadata has an unknown state");
    requireState(present.includes("system_snapshots"), "Legacy MySQL business source is missing");
    requireState(privateState && plain(privateState.users) && plain(privateState.organization), "Legacy identity inputs are required");
    const source = await legacyBusiness(connection);
    // Preflight must not create even empty schema objects. Partially-created
    // tables may remain after a failed DDL; only empty target tables can resume.
    for (const name of present.filter(name => name !== "system_snapshots" && name !== "hr_schema_meta")) {
      requireState(/^[a-z_]+$/.test(name), "Unexpected relational table name");
      const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM `" + name + "`");
      requireState(Number(row.count) === 0, "Existing relational data requires review; migration will not overwrite it");
    }
    if (!apply) {
      privateState.verifyUnchanged();
      return { status: "MYSQL_RELATIONAL_MIGRATION_CHECK", applied: false, readyToApply: true, targetModel: "relational", schemaVersion: 1,
        sourceDigest: digest({ business: source, users: privateState.users, organization: privateState.organization }),
        ...summary(source, privateState.users, privateState.organization) };
    }
    // MySQL DDL implicitly commits. Create tables before the data transaction;
    // all inserts, fidelity checks and the final marker share one transaction.
    await store.createSchema();
    await identity.createSchema();
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction(); transaction = true;
    const result = await store.withConnection(connection, async () => {
      await store.assertTargetEmpty();
      const business = await legacyBusiness(connection, true);
      requireState(digest(business) === digest(source), "Legacy business data changed before migration");
      await store.stageLegacyBundle(business);
      await identity.stageLegacy(privateState.users, privateState.organization);
      await store.verifyBundle(business);
      await identity.verifyLegacy(privateState.users, privateState.organization);
      await identity.verifyInitialized();
      privateState.verifyUnchanged();
      await store.completeMigration(business, { sourceDigest: digest({ business, users: privateState.users, organization: privateState.organization }) });
      return { status: "MYSQL_RELATIONAL_MIGRATED", applied: true, legacyTablePreserved: true,
        ...await proofInside(connection, store, identity, [...tables, ...identityTables]) };
    });
    await connection.commit(); transaction = false;
    return result;
  } catch (error) {
    if (transaction) { try { await connection.rollback(); } catch (_) {} }
    throw error;
  } finally {
    if (locked) { try { await connection.query("DO RELEASE_ALL_LOCKS()"); } catch (_) {} }
    connection.release();
  }
}

async function exportForRollback({ pool, createStore, createIdentityStore, destination }) {
  requireState(typeof process.getuid === "function" && process.getuid() === 0, "Rollback export requires root");
  requireState(path.isAbsolute(destination), "Rollback export requires an absolute destination");
  const directory = fs.realpathSync(path.dirname(destination)), info = fs.statSync(directory);
  requireState(directory === path.dirname(destination) && info.uid === 0 && (info.mode & 0o777) === 0o700, "Rollback destination must be a root-owned 0700 directory");
  const store = createStore(pool), identity = createIdentityStore(store);
  const contents = await store.transaction(async () => {
    await store.verifyInitialized();
    await identity.verifyInitialized();
    return { schemaVersion: 1, type: "hr-relational-rollback-export", business: await store.read(), users: await identity.readUsers(), organization: await identity.readOrganization() };
  });
  const raw = Buffer.from(JSON.stringify(contents));
  const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(descriptor, raw); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  return { status: "MYSQL_RELATIONAL_ROLLBACK_EXPORTED", destination, sha256: crypto.createHash("sha256").update(raw).digest("hex"), ...summary(contents.business, contents.users, contents.organization), databaseWritten: false };
}

function argumentsFor(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply" || arg === "--check" || arg === "--verify") { requireState(!args.mode, "Choose exactly one migration mode"); args.mode = arg; args.apply = arg === "--apply"; args.verify = arg === "--verify"; }
    else if (["--config", "--data-dir", "--export-rollback"].includes(arg)) { requireState(argv[i + 1] && !argv[i + 1].startsWith("--"), "Missing migration argument"); requireState(!args[arg], "Duplicate migration argument"); args[arg] = argv[++i]; }
    else throw new MigrationError("Unknown migration argument");
  }
  requireState(!(args["--export-rollback"] && args.mode), "Rollback export cannot be combined with migration");
  return args;
}
async function cli(argv) {
  const args = argumentsFor(argv);
  const config = checkedFile(path.resolve(args["--config"] || path.join(__dirname, "config.json")), 1024 * 1024).value;
  requireState(plain(config), "Private server configuration is invalid");
  const mysql = config.mysql || {};
  const enabled = String(process.env.HR_MYSQL_ENABLED || (mysql.enabled ? "true" : "false")).toLowerCase() === "true";
  const options = { host: process.env.HR_MYSQL_HOST || mysql.host || "127.0.0.1", port: Number(process.env.HR_MYSQL_PORT || mysql.port || 3306), database: process.env.HR_MYSQL_DATABASE || mysql.database || "hr_system", user: process.env.HR_MYSQL_USER || mysql.user || "hrsystem", password: process.env.HR_MYSQL_PASSWORD || mysql.password || "", charset: "utf8mb4", connectionLimit: 3 };
  requireState(enabled && ["localhost", "127.0.0.1"].includes(options.host) && options.port === 3306 && options.password && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(options.database), "Use the existing enabled local MySQL configuration");
  if (args.apply || args["--export-rollback"]) {
    let state;
    try { state = execFileSync("systemctl", ["show", "hr-system.service", "-p", "ActiveState", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (_) { throw new MigrationError("Cannot verify the stopped application service"); }
    requireState(state === "inactive", "Stop the application service before migrating or exporting rollback data");
  }
  const { createMySQLStore, TABLES } = require("./mysql-store");
  const authModule = require("./mysql-auth-store");
  const { createMySQLAuthStore } = authModule;
  const identityTables = authModule.AUTH_TABLES || authModule.TABLES;
  requireState(Array.isArray(TABLES) && Array.isArray(identityTables), "Storage table manifest is missing");
  const pool = require("mysql2/promise").createPool(options);
  try {
    const params = { pool, createStore: createMySQLStore, createIdentityStore: createMySQLAuthStore };
    if (args["--export-rollback"]) return await exportForRollback({ ...params, destination: args["--export-rollback"] });
    if (args.verify) return await verify({ ...params, tables: TABLES, identityTables });
    // A retry must recognize old-code writes after a rollback and refuse to
    // silently regard stale relational rows as synchronized.
    const privateState = legacyFiles(path.resolve(args["--data-dir"] || process.env.HR_DATA_DIR || path.join(__dirname, "data")));
    return await migrate({ ...params, tables: TABLES, identityTables, privateState, apply: args.apply });
  } finally { await pool.end(); }
}

if (require.main === module) cli(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => {
  process.stderr.write("MySQL migration stopped: " + (error instanceof MigrationError ? error.message : "storage operation failed; no private details printed") + "\n"); process.exitCode = 1;
});
module.exports = { MigrationError, digest, summary, checkedFile, legacyFiles, migrate, verify, tableProof, exportForRollback, argumentsFor };
