#!/usr/bin/env python3
"""Publish the reviewed relational MySQL migration with a final write-gate commit.

No private contents or process environment are printed. Failure before the gate
is released may restore code only after frozen sources and target proofs agree;
an ambiguous database state leaves the gate in place for administrator review.
"""
import argparse
import ast
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('relational_release_primitives', pathlib.Path(__file__).with_name('apply-approval-workflow.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
helper, require, Refused = base.helper, base.require, base.Refused
canonical_hash, raw_hash = base.canonical_hash, base.raw_hash
regular_file, protected_source = base.regular_file, base.protected_source
atomic_install, timer_state = base.atomic_install, base.timer_state
data_hashes, full_daily_backup = base.data_hashes, base.full_daily_backup
APP, SERVICE, OWNER, HTML = base.APP, base.SERVICE, base.OWNER, base.HTML
FRONTEND = base.FRONTEND
AUTH, SERVER = base.AUTH, base.SERVER
SQL_MODULES = ('server/mysql-store.js', 'server/mysql-auth-store.js', 'server/migrate-mysql.js')
SQL_HASHES = {
    'mysql-store.js': '84e37fc6d87d357bc13f74fd9fa2a985908e8abf361aeae39cd1a8c12e83f845',
    'mysql-auth-store.js': '47b4526df2d3fa4d77496ed1e81c9992dc47cbf6748bab422f15c78cb698bf6c',
    'migrate-mysql.js': '73b04b4489c1c17c5a93815dbfe63111ddb7c07e9f67ea25f5f573f8feda71ad'
}
DIAGNOSTIC_STAGES = frozenset(('cli', 'module-audit', 'database.connect', 'database.query', 'database.beginTransaction',
    'database.commit', 'database.rollback', 'database.close',
    *(f'business.{name}' for name in ('createSchema', 'assertTargetEmpty', 'stageLegacyBundle', 'verifyBundle', 'completeMigration', 'verifyInitialized', 'read')),
    *(f'identity.{name}' for name in ('createSchema', 'stageLegacy', 'verifyLegacy', 'verifyInitialized', 'readUsers', 'readOrganization'))))
DIAGNOSTIC_NAMES = frozenset(('Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'StorageError', 'MigrationError', 'HIDDEN'))
DIAGNOSTIC_PREFIX = 'HR_MYSQL_FAILURE '
NODE_MIGRATION_WRAPPER = r'''"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const expected = __SQL_HASHES__;
const filename = path.resolve(process.argv[1]);
const args = process.argv.slice(2), mode = args.at(-1);
const source = {}, cache = new Map(), messages = new Set(["HIDDEN"]);
const errors = new WeakMap(), connections = new WeakSet(), stack = [];
const names = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "StorageError", "MigrationError"]);
let fallback = "module-audit";
function phase() { return [...stack].reverse().find(item => item !== "cli" && !item.startsWith("database.")) || stack.at(-1) || fallback; }
function remember(error) { if (error && (typeof error === "object" || typeof error === "function") && !errors.has(error)) errors.set(error, phase()); }
async function tracked(label, action) {
  stack.push(label);
  try { return await action(); } catch (error) { remember(error); throw error; } finally { stack.pop(); }
}
function wrap(object, key, label) {
  const original = object[key];
  if (typeof original !== "function") throw new Error("Unrecognized reviewed migration method");
  object[key] = async function (...values) { return tracked(label, () => original.apply(this, values)); };
}
function business(store) {
  for (const key of ["createSchema", "assertTargetEmpty", "stageLegacyBundle", "verifyBundle", "completeMigration", "verifyInitialized", "read"]) wrap(store, key, "business." + key);
  // connection() remains synchronous: identity.active() relies on it.
  return store;
}
function identity(store) {
  for (const key of ["createSchema", "stageLegacy", "verifyLegacy", "verifyInitialized", "readUsers", "readOrganization"]) wrap(store, key, "identity." + key);
  return store;
}
function pool(value) {
  const original = value.getConnection;
  value.getConnection = async function (...values) {
    return tracked("database.connect", async () => {
      const connection = await original.apply(this, values);
      if (!connections.has(connection)) {
        connections.add(connection);
        for (const key of ["query", "beginTransaction", "commit", "rollback"]) wrap(connection, key, "database." + key);
      }
      return connection;
    });
  };
  wrap(value, "end", "database.close");
  return value;
}
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const location = path.join(path.dirname(filename), name), native = createRequire(location);
  const module = { exports: {}, filename: location };
  function local(request) {
    if (request === "./mysql-store") return load("mysql-store.js");
    if (request === "./mysql-auth-store") return load("mysql-auth-store.js");
    const value = native(request);
    if (request === "mysql2/promise") return { ...value, createPool: (...values) => pool(value.createPool(...values)) };
    return value;
  }
  Object.assign(local, native);
  const cli = new Function("require", "module", "exports", "__filename", "__dirname", source[name] + (name === "migrate-mysql.js" ? "\nreturn cli;" : ""))(local, module, module.exports, location, path.dirname(location));
  const valueOriginal = module.exports;
  let value = valueOriginal;
  if (name === "mysql-store.js") value = { ...value, createMySQLStore: (...values) => business(valueOriginal.createMySQLStore(...values)) };
  if (name === "mysql-auth-store.js") value = { ...value, createMySQLAuthStore: (...values) => identity(valueOriginal.createMySQLAuthStore(...values)) };
  if (name === "migrate-mysql.js") value = cli;
  cache.set(name, value);
  return value;
}
function code(value) {
  return typeof value === "string" && value.length <= 64 && /^(?:(?:ER_|PROTOCOL_|WARN_)[A-Z0-9_]+|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)$/.test(value) ? value : null;
}
function number(value, maximum) { return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null; }
(async () => {
  try {
    if (path.basename(filename) !== "migrate-mysql.js" || !["--check", "--apply", "--verify"].includes(mode)) throw new Error("Unrecognized reviewed migration mode");
    for (const [name, digest] of Object.entries(expected)) {
      const location = path.join(path.dirname(filename), name), info = fs.lstatSync(location);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unrecognized reviewed migration source");
      const text = fs.readFileSync(location, "utf8");
      if (crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n").trimEnd() + "\n").digest("hex") !== digest) throw new Error("Unrecognized reviewed migration digest");
      source[name] = text;
      for (const token of text.match(/"(?:[^"\\]|\\.)*"/g) || []) { try { const value = JSON.parse(token); if (typeof value === "string" && value.length <= 400 && !/[\r\n\0]/.test(value)) messages.add(value); } catch (_) {} }
    }
    fallback = "cli";
    const cli = load("migrate-mysql.js");
    const result = await tracked("cli", () => cli(args));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const value = error && (typeof error === "object" || typeof error === "function") ? error : {};
    const detail = { schemaVersion: 1, mode, stage: errors.get(value) || fallback,
      name: names.has(value.name) ? value.name : "HIDDEN", code: code(value.code), errno: number(value.errno, 65535),
      sqlState: typeof value.sqlState === "string" && /^[A-Z0-9]{5}$/.test(value.sqlState) ? value.sqlState : null,
      status: number(value.status, 599), message: messages.has(value.message) ? value.message : "HIDDEN" };
    process.stderr.write("HR_MYSQL_FAILURE " + JSON.stringify(detail) + "\n"); process.exitCode = 1;
  }
})();
'''
CODE = (*base.CODE, *SQL_MODULES)
FILES = (*CODE, HTML)
PATCH_FILES = base.PATCH_FILES
VARIANTS = {'attendance-delete': frozenset((*base.NEW, *SQL_MODULES)), 'approval-workflow': frozenset(SQL_MODULES)}
MANIFEST = 'deploy/mysql-relational-release.json'
BACKUP_SOURCE = 'deploy/daily-backup.py'
INSTALL = pathlib.Path('/usr/local/lib/hr-system-backup')
TOOL, TOOL_MANIFEST = INSTALL / 'daily-backup.py', INSTALL / 'installation.json'
WRAPPER = pathlib.Path('/usr/local/sbin/hr-system-backup')
UNITS = pathlib.Path('/etc/systemd/system')
MANAGED = {TOOL: 0o600, WRAPPER: 0o700, UNITS / 'hr-system-backup.service': 0o644, UNITS / 'hr-system-backup.timer': 0o644}
HOLD = pathlib.Path('/run/hr-system-relational-migration.hold')
SHA = re.compile(r'[0-9a-f]{64}')
DOCS = ('README.md', '2026-11-23.md', 'updates/2026-11-23.md', '技术文档/系统开发架构.source.json',
        '技术文档/13-MySQL关系化存储与迁移.md', '技术文档/05-阿里云部署手册.md',
        '技术文档/07-手机号账号与数据权限.md', '技术文档/11-每日备份与恢复.md',
        'deploy/approval-sms.env.example', 'server/config.example.json', MANIFEST, BACKUP_SOURCE,
        'deploy/apply-mysql-relational.py', '.github/workflows/architecture-docs.yml')


def validate_manifest(document):
    require(isinstance(document, dict) and set(document) == {'schemaVersion', 'variants', 'backupTool'} and
            type(document['schemaVersion']) is int and document['schemaVersion'] == 1, 'Invalid relational release schema')
    variants = document['variants']
    require(isinstance(variants, dict) and set(variants) == set(VARIANTS), 'Exactly two reviewed production variants are required')
    for variant, model in variants.items():
        require(isinstance(model, dict) and set(model) == {'files'} and isinstance(model['files'], dict) and
                set(model['files']) == set(CODE), 'Unexpected relational source paths')
        for name, row in model['files'].items():
            require(isinstance(row, dict) and set(row) == ({'beforeSha256', 'afterSha256', 'patches'} if name in PATCH_FILES else {'beforeSha256', 'afterSha256'}), 'Invalid relational source entry')
            require(isinstance(row['afterSha256'], str) and SHA.fullmatch(row['afterSha256']), 'Invalid relational candidate digest')
            require(row['beforeSha256'] is None if name in VARIANTS[variant] else isinstance(row['beforeSha256'], str) and SHA.fullmatch(row['beforeSha256']), 'Invalid variant baseline or new-file declaration')
            if name in PATCH_FILES:
                patches = row['patches']
                require(isinstance(patches, list) and len(patches) <= 100 and (patches or row['beforeSha256'] == row['afterSha256']), 'Missing reviewed production patches')
                seen = set()
                for patch in patches:
                    require(isinstance(patch, dict) and set(patch) == {'old', 'new'}, 'Invalid production patch')
                    old, new = patch['old'], patch['new']
                    require(isinstance(old, str) and isinstance(new, str) and old and new and old != new and old not in seen and
                            max(len(old), len(new)) <= 1024 * 1024 and '\0' not in old + new and '\r' not in old + new,
                            'Unsafe or duplicate production patch')
                    seen.add(old)
    tool = document['backupTool']
    require(isinstance(tool, dict) and set(tool) == {'beforeSha256', 'afterSha256'} and
            all(isinstance(value, str) and SHA.fullmatch(value) for value in tool.values()), 'Invalid managed backup tool digests')
    return document


def load_manifest(source, expected):
    path = regular_file(source / MANIFEST)
    require(path.stat().st_size <= 8 * 1024 * 1024, 'Relational manifest is too large')
    raw = path.read_bytes()
    require(raw_hash(raw) == expected, 'Relational manifest differs from the fixed reviewed version')
    try:
        return validate_manifest(json.loads(raw.decode('utf-8'), object_pairs_hook=base.unique_object))
    except (UnicodeError, ValueError):
        raise Refused('Relational manifest is not valid UTF-8 JSON')


def capture_sources(gid):
    for path in (APP, APP / 'server', APP / 'js'):
        protected_source(path, gid, directory=True)
    current = {}
    for name in FILES:
        path = APP / name
        if path.exists() or path.is_symlink():
            protected_source(path, gid)
            current[name] = regular_file(path).read_bytes()
        else:
            base.require_absent(path)
            current[name] = None
    require(current[HTML] is not None, 'Protected architecture HTML is missing')
    return current


def select_variant(current, document):
    choices = []
    for variant, model in document['variants'].items():
        if all((current[name] is None if item['beforeSha256'] is None else current[name] is not None and canonical_hash(current[name]) == item['beforeSha256']) for name, item in model['files'].items()):
            choices.append(variant)
    require(len(choices) == 1, 'Production source matches no unique reviewed variant')
    return choices[0]


def build_candidates(source, current, model):
    candidates = {}
    for name, row in model['files'].items():
        if name in PATCH_FILES:
            candidates[name] = base.patch_source(current[name], row)
        else:
            candidates[name] = regular_file(source / name).read_bytes()
            require(canonical_hash(candidates[name]) == row['afterSha256'], 'Relational candidate source differs: ' + name)
    candidates[HTML] = regular_file(source / HTML).read_bytes()
    tool = regular_file(source / BACKUP_SOURCE).read_bytes()
    ast.parse(tool.decode('utf-8-sig'), filename='daily-backup.py')
    for name in DOCS:
        regular_file(source / name)
    return candidates, tool


def stage_candidates(stage, candidates):
    for name, content in candidates.items():
        target = stage / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(content)
        os.chmod(target, 0o600)
        if name.endswith('.js'):
            helper.run(['node', '--check', target])


def verify_candidate_code(source, stage, candidates):
    stage_candidates(stage, candidates)
    environment = {key: value for key, value in os.environ.items() if not key.startswith('HR_')}
    environment.update(HR_APPROVAL_AUTH_TEST_MODULE=str(stage / AUTH),
                       HR_APPROVAL_WORKFLOW_MODULE=str(stage / base.NEW[0]),
                       HR_APPROVAL_NOTIFICATIONS_MODULE=str(stage / base.NEW[1]),
                       HR_MYSQL_AUTH_TEST_MODULE=str(stage / AUTH))
    helper.run(['node', '--test', regular_file(source / 'tests/approval-workflow.test.js')], env=environment, cwd=source)
    helper.run(['node', '--test', regular_file(source / 'tests/mysql-auth-store.test.js')], env=environment, cwd=source)
    helper.run(['node', regular_file(source / 'scripts/generate-architecture.cjs'), '--check'], env=environment, cwd=source)


def service_environment():
    pid = helper.system_value('MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid) and pathlib.Path('/proc', pid, 'cwd').resolve() == APP, 'Unexpected existing application process')
    values = {}
    for item in pathlib.Path('/proc', pid, 'environ').read_bytes().split(b'\0'):
        key, separator, value = item.partition(b'=')
        if separator and key.startswith(b'HR_'):
            values[key.decode('ascii')] = value.decode('utf-8')
    require(values.get('HR_STORAGE_MODE', 'mysql') == 'mysql', 'An explicit file storage override needs review')
    require(helper.system_value('MainPID') == pid, 'Application restarted during environment capture')
    return values


def migration_command(script, data, environment, mode):
    require(mode in ('--check', '--apply', '--verify'), 'Unreviewed migration mode')
    script = regular_file(pathlib.Path(script))
    require(script.name == 'migrate-mysql.js', 'Unreviewed migration entry point')
    messages = {'HIDDEN'}
    for name, digest in SQL_HASHES.items():
        raw = regular_file(script.parent / name).read_bytes()
        require(canonical_hash(raw) == digest, 'Migration source differs from the fixed reviewed module')
        for token in re.findall(r'"(?:[^"\\]|\\.)*"', raw.decode('utf-8')):
            try:
                value = json.loads(token)
                if isinstance(value, str) and len(value) <= 400 and not any(char in value for char in '\r\n\0'):
                    messages.add(value)
            except ValueError:
                pass
    env = {key: value for key, value in os.environ.items() if not key.startswith('HR_')}
    env.update(environment)
    env['NODE_PATH'] = str(APP / 'server/node_modules')
    wrapper = NODE_MIGRATION_WRAPPER.replace('__SQL_HASHES__', json.dumps(SQL_HASHES))
    result = subprocess.run(['node', '-e', wrapper, str(script), '--config', str(APP / 'server/config.json'), '--data-dir', str(data), mode],
                            env=env, cwd=APP, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
    if result.returncode != 0:
        detail = migration_failure(result.stderr, mode, messages)
        raise Refused('MySQL migration failure ' + json.dumps(detail, sort_keys=True) if detail else 'Node migration failed; private diagnostics hidden')
    raw = result.stdout
    result = json.loads(raw.decode().splitlines()[-1])
    require(isinstance(result, dict) and isinstance(result.get('contentSha256'), str) and SHA.fullmatch(result['contentSha256']) and
            isinstance(result.get('sourceDigest'), str) and SHA.fullmatch(result['sourceDigest']), 'Migration did not provide a bounded source proof')
    return result


def migration_failure(raw, mode, messages):
    try:
        require(len(raw) <= 16384, 'Oversized private diagnostic')
        lines = raw.decode('utf-8').strip().splitlines()
        require(len(lines) == 1 and lines[0].startswith(DIAGNOSTIC_PREFIX), 'Unrecognized private diagnostic')
        value = json.loads(lines[0][len(DIAGNOSTIC_PREFIX):], object_pairs_hook=base.unique_object)
        require(isinstance(value, dict) and set(value) == {'schemaVersion', 'mode', 'stage', 'name', 'code', 'errno', 'sqlState', 'status', 'message'}, 'Unexpected private diagnostic fields')
        require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['mode'] == mode and
                value['stage'] in DIAGNOSTIC_STAGES and value['name'] in DIAGNOSTIC_NAMES and value['message'] in messages, 'Unrecognized private diagnostic values')
        require(value['code'] is None or isinstance(value['code'], str) and len(value['code']) <= 64 and re.fullmatch(r'(?:(?:ER_|PROTOCOL_|WARN_)[A-Z0-9_]+|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)', value['code']), 'Invalid diagnostic code')
        require(value['sqlState'] is None or isinstance(value['sqlState'], str) and re.fullmatch(r'[A-Z0-9]{5}', value['sqlState']), 'Invalid diagnostic SQL state')
        require(all(value[key] is None or type(value[key]) is int and 0 <= value[key] <= maximum for key, maximum in (('errno', 65535), ('status', 599))), 'Invalid diagnostic number')
        return value
    except (Refused, ValueError, TypeError, KeyError, UnicodeError):
        return None


def relation_proof(result):
    require(result.get('initialized') is True and result.get('model') == 'relational' and result.get('schemaVersion') == 1 and
            isinstance(result.get('tablesSha256'), str) and SHA.fullmatch(result['tablesSha256']) and
            isinstance(result.get('tables'), list) and len(result['tables']) == 24 and len(set(result['tables'])) == 24 and
            isinstance(result.get('tableCounts'), dict) and set(result['tableCounts']) == set(result['tables']) and
            all(type(value) is int and value >= 0 for value in result['tableCounts'].values()) and
            type(result.get('revision')) is int and result['revision'] >= 0, 'Incomplete relational database proof')
    return {key: result[key] for key in ('contentSha256', 'sourceDigest', 'tablesSha256', 'tableCounts', 'revision')}


def backup_state(expected):
    info = helper.checked_path(INSTALL, 'dir').stat()
    require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Managed backup tool directory is not private')
    content = {}
    for path, mode in {**MANAGED, TOOL_MANIFEST: 0o600}.items():
        info = regular_file(path).stat()
        require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode, 'Managed backup tool permissions changed')
        content[path] = path.read_bytes()
    document = json.loads(content[TOOL_MANIFEST])
    require(isinstance(document, dict) and set(document) == {'schemaVersion', 'type', 'files'} and document['schemaVersion'] == 1 and
            document['type'] == 'hr-system-daily-backup-installation' and isinstance(document['files'], dict) and
            set(document['files']) == {str(path) for path in MANAGED}, 'Unrecognized managed backup installation')
    require(all(document['files'][str(path)] == raw_hash(content[path]) for path in MANAGED), 'Managed backup installation digest mismatch')
    require(raw_hash(content[TOOL]) == expected, 'Managed backup core differs from the reviewed baseline')
    return content


def replace_tool_file(target, content):
    require(target in (TOOL, TOOL_MANIFEST), 'Unexpected backup tool write destination')
    regular_file(target)
    descriptor, name = tempfile.mkstemp(prefix='.relational-tool-', dir=target.parent)
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), 0o600)
        os.replace(pending, target)
        base.sync_parent(target)
    finally:
        if pending.exists():
            pending.unlink()


def revised_backup_state(current, candidate):
    before, after = raw_hash(current[TOOL]), raw_hash(candidate)
    raw = current[TOOL_MANIFEST]
    require(raw.count(before.encode()) == 1, 'Managed backup core digest is ambiguous')
    revised = raw.replace(before.encode(), after.encode())
    require(json.loads(revised)['files'][str(TOOL)] == after, 'Managed backup digest update failed')
    return {**current, TOOL: candidate, TOOL_MANIFEST: revised}


def install_backup_tool(current, candidate):
    require(all(path.read_bytes() == raw for path, raw in current.items()), 'Managed backup installation changed during preflight')
    revised = revised_backup_state(current, candidate)
    replace_tool_file(TOOL, candidate)
    replace_tool_file(TOOL_MANIFEST, revised[TOOL_MANIFEST])
    return revised


class MaintenanceLock:
    def __init__(self, path):
        self.path, self.stream, self.locked = path, None, False
    def acquire(self):
        import fcntl
        if self.stream is None:
            helper.checked_path(self.path.parent, 'dir')
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            self.stream = os.fdopen(fd, 'a+b')
            info = os.fstat(self.stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe maintenance lock')
        if not self.locked:
            try:
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('Another backup or installation is running')
            self.locked = True
        return self
    def release(self):
        import fcntl
        if self.locked:
            fcntl.flock(self.stream, fcntl.LOCK_UN)
            self.locked = False
    def __enter__(self):
        return self.acquire()
    def __exit__(self, *args):
        self.release()
        if self.stream is not None:
            self.stream.close()


def create_hold(gid):
    base.require_absent(HOLD)
    content = ('hr-relational-migration-v1:' + secrets.token_hex(24) + '\n').encode()
    created = []
    base.install_new(HOLD, content, gid, on_created=created.append)
    return {'identity': created[0], 'content': content, 'gid': gid}


def hold_intact(hold):
    protected_source(HOLD, hold['gid'])
    info = regular_file(HOLD).stat()
    require((info.st_dev, info.st_ino) == hold['identity'] and HOLD.read_bytes() == hold['content'], 'Maintenance gate changed; preserve it for review')


def clear_hold(hold, on_commit=None):
    hold_intact(hold)
    HOLD.unlink()
    if on_commit:
        on_commit()
    base.sync_parent(HOLD)


def sql_digest(database, backup):
    descriptor, name = tempfile.mkstemp(prefix='.sql-proof-', dir=backup)
    path = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            helper.run(['mysqldump', '--protocol=socket', '-uroot', '--single-transaction', '--skip-lock-tables',
                        '--no-tablespaces', '--routines', '--triggers', '--events', '--hex-blob', '--order-by-primary',
                        '--skip-comments', '--skip-dump-date', '--set-gtid-purged=OFF', '--column-statistics=0',
                        '--default-character-set=utf8mb4', database], output=stream, timeout=600)
        return helper.digest(path)
    finally:
        path.unlink(missing_ok=True)


def stable_sql_digest(database, backup):
    one, two = sql_digest(database, backup), sql_digest(database, backup)
    require(one == two, 'Database changed during the maintenance proof window')
    return one


def legacy_row_hash(database):
    query = "SELECT SHA2(CAST(JSON_OBJECT('snapshot_key',snapshot_key,'payload',payload,'updated_at',updated_at) AS CHAR),256) FROM system_snapshots WHERE snapshot_key='default'"
    result = helper.run(['mysql', '--protocol=socket', '-uroot', database, '-NBe', query]).strip()
    require(re.fullmatch(rb'[0-9a-f]{64}', result), 'Expected one frozen legacy business row')
    return result


def status(port, readonly):
    for _ in range(30):
        try:
            code, body = helper.get('http://127.0.0.1:' + str(port), '/api/auth/status')
            value = json.loads(body)
            if code == 200 and value.get('ok') is True and value.get('setupRequired') is False and value.get('storage') == {'backend': 'mysql', 'model': 'relational', 'readOnly': readonly}:
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise Refused('Relational service did not report the expected storage and write-gate state')


def public_check(port, candidates, readonly):
    status(port, readonly)
    for name in FRONTEND:
        code, body = helper.get('http://127.0.0.1:' + str(port), '/' + name)
        require(code == 200 and body == candidates[name], 'Relational frontend is not served: ' + name)
    require(base.api_status(port, 'GET', '/api/data/snapshot.json') == 401, 'Anonymous data read boundary changed')
    require(base.api_status(port, 'POST', '/api/data/snapshot.json') == (503 if readonly else 401), 'Migration write-gate boundary changed')
    for path in SQL_MODULES:
        require(helper.get('http://127.0.0.1:' + str(port), '/' + path)[0] == 404, 'Private SQL module is publicly served')


def verify_frozen(state, data, database):
    require(data_hashes(data) == state['files'] and legacy_row_hash(database) == state['legacy'], 'Frozen legacy files or MySQL row changed')


def verify_relation(script, data, environment, expected):
    observed = migration_command(script, data, environment, '--verify')
    require(relation_proof(observed) == expected, 'Relational database changed while writes were gated')


def safe_rollback_database(script, data, environment, state):
    try:
        observed = migration_command(script, data, environment, '--verify')
        proof = relation_proof(observed)
        require(proof['contentSha256'] == state['source']['contentSha256'] and proof['sourceDigest'] == state['source']['sourceDigest'], 'Relational data differs from frozen migration source')
        if state.get('relation'):
            require(proof == state['relation'], 'Relational data changed after migration')
    except Refused:
        if state.get('relation'):
            raise
        check = migration_command(script, data, environment, '--check')
        require(check.get('readyToApply') is True and check.get('initialized') is not True and
                check['sourceDigest'] == state['source']['sourceDigest'] and check['contentSha256'] == state['source']['contentSha256'],
                'Cannot prove empty uninitialized migration targets')


def transact(current, candidates, tool_state, tool_candidate, data, port, database, gid, environment, timer, backup, full_backup, lock, stage_script):
    state = {'committed': False, 'changed': [], 'created': {}, 'toolChanged': False, 'migrationAttempted': False}
    hold = None
    try:
        require(timer_state() == timer, 'Daily backup timer changed before migration')
        for name, original in current.items():
            if original is None:
                base.require_absent(APP / name)
            else:
                protected_source(APP / name, gid)
                require((APP / name).read_bytes() == original, 'Source changed during migration preflight')
        hold = create_hold(gid)
        helper.run(['systemctl', 'stop', SERVICE])
        require(helper.system_value('ActiveState') == 'inactive', 'Application did not stop for migration')
        state.update(files=data_hashes(data), legacy=legacy_row_hash(database), sqlBefore=stable_sql_digest(database, backup))
        state['source'] = migration_command(stage_script, data, environment, '--check')
        for name in (*SQL_MODULES, *base.NEW, *base.EXISTING, HTML):
            state['changed'].append(name)
            if current[name] is None:
                base.install_new(APP / name, candidates[name], gid, on_created=lambda identity, name=name: state['created'].__setitem__(name, identity))
            else:
                atomic_install(APP / name, candidates[name], gid)
            protected_source(APP / name, gid)
        script = APP / 'server/migrate-mysql.js'
        state['migrationAttempted'] = True
        migrated = migration_command(script, data, environment, '--apply')
        state['relation'] = relation_proof(migrated)
        require(migrated['contentSha256'] == state['source']['contentSha256'] and migrated['sourceDigest'] == state['source']['sourceDigest'], 'Migration changed frozen source content')
        verify_frozen(state, data, database)
        state['sqlAfter'] = stable_sql_digest(database, backup)
        state['toolExpected'] = revised_backup_state(tool_state, tool_candidate)
        state['toolChanged'] = True
        updated_tool = install_backup_tool(tool_state, tool_candidate)
        helper.run(['systemctl', 'start', SERVICE])
        public_check(port, candidates, True)
        verify_relation(script, data, environment, state['relation'])
        verify_frozen(state, data, database)
        require(stable_sql_digest(database, backup) == state['sqlAfter'], 'Database changed after relational startup')
        lock.release()
        post_backup = full_daily_backup()
        hold_intact(hold)
        verify_relation(script, data, environment, state['relation'])
        verify_frozen(state, data, database)
        require(stable_sql_digest(database, backup) == state['sqlAfter'], 'Database changed during post-migration backup')
        require(backup_state(raw_hash(tool_candidate)) == updated_tool and timer_state() == timer, 'Backup installation or timer changed during migration')
        for name in FILES:
            protected_source(APP / name, gid)
            require((APP / name).read_bytes() == candidates[name], 'Installed relational source changed')
        proof_document = {key: value for key, value in state.items() if key not in ('created', 'committed', 'toolExpected')}
        proof_document['legacy'] = state['legacy'].decode('ascii')
        (backup / 'precommit-proof.json').write_text(json.dumps(proof_document) + '\n', encoding='utf-8')
        clear_hold(hold, on_commit=lambda: state.__setitem__('committed', True))
        public_check(port, candidates, False)
        result = {'status': 'MYSQL_RELATIONAL_OK', 'backup': str(backup), 'dataBackup': full_backup,
                  'postMigrationBackup': post_backup, 'storageModel': 'relational', 'migration': {key: migrated[key] for key in ('counts', 'contentSha256', 'sourceDigest', 'tablesSha256', 'tableCounts')},
                  'sourceProtected': True, 'dailyBackupTimerPreserved': True, 'automaticBackupEnabled': True,
                  'dailyTime': '02:00', 'timezone': 'Asia/Shanghai', 'serviceRestarted': True, 'legacySourcesPreserved': True}
        (backup / 'MYSQL_RELATIONAL_OK').write_text(json.dumps(result) + '\n', encoding='utf-8')
        return result
    except BaseException:
        if state['committed']:
            (backup / 'COMMITTED_NEEDS_ATTENTION').write_text('Write gate was released. Preserve relational code and data; do not restart old code.\n', encoding='utf-8')
            raise Refused('Relational migration committed; final checks need review, old code was not restored')
        try:
            require(hold is not None, 'Migration did not create a maintenance gate')
            hold_intact(hold)
            helper.run(['systemctl', 'stop', SERVICE])
            lock.acquire()
            if 'files' in state:
                verify_frozen(state, data, database)
                if state['migrationAttempted']:
                    require(not state.get('relation') or 'sqlAfter' in state, 'No stable full-database proof was established after migration')
                    safe_rollback_database(APP / 'server/migrate-mysql.js', data, environment, state)
                    if 'sqlAfter' in state:
                        require(stable_sql_digest(database, backup) == state['sqlAfter'], 'Database changed since the migration proof')
                else:
                    require(stable_sql_digest(database, backup) == state['sqlBefore'], 'Database changed before migration')
            if state['toolChanged']:
                require(all(regular_file(target).read_bytes() in (tool_state[target], state['toolExpected'][target])
                            for target in (TOOL, TOOL_MANIFEST)), 'Backup tool changed; preserve it for review')
                for target in (TOOL, TOOL_MANIFEST):
                    replace_tool_file(target, tool_state[target])
            for name in reversed(state['changed']):
                target = APP / name
                if current[name] is None:
                    if name in state['created']:
                        base.remove_new(target, candidates[name], gid, state['created'][name])
                else:
                    observed = regular_file(target).read_bytes()
                    require(observed in (current[name], candidates[name]), 'Source changed; preserve it for review')
                    if observed != current[name]:
                        atomic_install(target, current[name], gid)
                    protected_source(target, gid)
            clear_hold(hold)
            helper.run(['systemctl', 'start', SERVICE])
            base.wait_health(port)
        except BaseException:
            if not HOLD.exists() and not HOLD.is_symlink():
                try:
                    create_hold(gid)
                except BaseException:
                    pass
            (backup / 'ROLLBACK_NEEDS_ATTENTION').write_text('Maintenance gate and recovery material retained; do not enable old code until database state is reviewed.\n', encoding='utf-8')
            raise Refused('Migration rollback cannot prove frozen data; maintenance gate retained for administrator review')
        raise


def save_release(backup, current, candidates, tool_state, source):
    for prefix, values in (('previous-code', current), ('reviewed-release', candidates)):
        for name, content in values.items():
            if content is not None:
                target = backup / prefix / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(content)
    for target in (TOOL, TOOL_MANIFEST):
        (backup / ('previous-' + target.name)).write_bytes(tool_state[target])
    for name in DOCS:
        target = backup / 'reviewed-release' / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((source / name).read_bytes())
    audit_publication_tool(backup)


def audit_publication_tool(backup):
    """Retain the actual executing publisher separately from business sources."""
    expected = ('apply-mysql-relational.py', 'apply-approval-workflow.py',
                'apply-leave-types-time.py', 'apply-organization-fix.py')
    paths = tuple(pathlib.Path(value).absolute() for value in
                  (__file__, base.__file__, base.primitives.__file__, helper.__file__))
    directory = pathlib.Path(__file__).absolute().parent
    require(tuple(path.name for path in paths) == expected and all(path.parent == directory for path in paths),
            'Unexpected publication tool dependency location')
    contents = {path.name: regular_file(path).read_bytes() for path in paths}
    target = backup / 'publication-tool'
    base.require_absent(target)
    target.mkdir(mode=0o700)
    contents['manifest.json'] = (json.dumps({'schemaVersion': 1, 'files':
        {name: raw_hash(content) for name, content in contents.items()}}) + '\n').encode('utf-8')
    for name, content in contents.items():
        descriptor = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        base.sync_parent(target / name)
    base.sync_parent(target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-release-sha256', required=True, type=base.reviewed_hash)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    source = helper.checked_path(args.source, 'dir')
    document = load_manifest(source, args.expected_release_sha256)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    require(source != APP and APP not in source.parents and source not in APP.parents, 'Release must be separate from the production application')
    import grp
    gid = grp.getgrnam(OWNER).gr_gid
    with base.publication_lock() if args.apply else contextlib.nullcontext():
        with MaintenanceLock(pathlib.Path('/run/hr-system-backup-install.lock')) if args.apply else contextlib.nullcontext():
            base.require_absent(HOLD)
            data, port, database = helper.runtime()
            environment, timer, current = service_environment(), timer_state(), capture_sources(gid)
            variant = select_variant(current, document)
            tool_state = backup_state(document['backupTool']['beforeSha256'])
            candidates, tool_candidate = build_candidates(source, current, document['variants'][variant])
            require(raw_hash(tool_candidate) == document['backupTool']['afterSha256'], 'Reviewed backup tool candidate differs')
            with tempfile.TemporaryDirectory(prefix='hr-relational-preflight-') as temporary:
                stage = pathlib.Path(temporary)
                verify_candidate_code(source, stage, candidates)
                check = migration_command(stage / 'server/migrate-mysql.js', data, environment, '--check')
                if not args.apply:
                    result = {'status': 'MYSQL_RELATIONAL_CHECK', 'readyToApply': True, 'variant': variant, 'counts': check['counts'], 'sourceDigest': check['sourceDigest'], 'serviceRestarted': False}
                else:
                    full_backup = full_daily_backup()
                    helper.checked_path(helper.BACKUPS)
                    helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
                    require(helper.BACKUPS.stat().st_uid == 0 and stat.S_IMODE(helper.BACKUPS.stat().st_mode) == 0o700, 'Publication backups must be root-private')
                    backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-mysql-relational-%H%M%S-'), dir=helper.BACKUPS))
                    save_release(backup, current, candidates, tool_state, source)
                    with MaintenanceLock(pathlib.Path('/var/backups/hr-system/.daily-backup.lock')) as lock:
                        result = transact(current, candidates, tool_state, tool_candidate, data, port, database, gid, environment, timer, backup, full_backup, lock, stage / 'server/migrate-mysql.js')
                    result['variant'] = variant
                print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    def interrupted(signum, frame):
        raise KeyboardInterrupt()
    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print('Relational publication stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
