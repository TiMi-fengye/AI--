#!/usr/bin/env python3
"""Read-only compatibility diagnosis using the reviewed migration's public code.

Only a fixed legacy SELECT reaches MySQL. Identity validation uses an isolated
memory adapter, never the real connection. No source, service, gate, backup,
configuration or business data is changed. Results contain no private values.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import types

sys.dont_write_bytecode = True
APP = pathlib.Path('/opt/hr-system')
BACKUPS = pathlib.Path('/root/hr-system-backups')
MANIFEST_SHA = '83e9e6a03a0599fee90a892bfbabb9b800d529b60d66c8dadfae1013426e6e63'
HELPER_SHA = 'c69e757105b89d0ec7ffa54a430c8144832e08cacde9ff35785057224d1d0795'
MODULE_SHA = {
    'mysql-store.js': '84e37fc6d87d357bc13f74fd9fa2a985908e8abf361aeae39cd1a8c12e83f845',
    'mysql-auth-store.js': '47b4526df2d3fa4d77496ed1e81c9992dc47cbf6748bab422f15c78cb698bf6c',
    'migrate-mysql.js': '73b04b4489c1c17c5a93815dbfe63111ddb7c07e9f67ea25f5f573f8feda71ad',
}
AUDIT_SHA = {
    'apply-mysql-relational.py': 'd38eab365e5bf76a9defc5f5fe359af1a9b98f57fb83cbb7d993b8b0e7ee241d',
    'apply-approval-workflow.py': '13481bb18c7a1ca9f825609c407907e288eed56155d0a7ea215cc39ace36a731',
    'apply-leave-types-time.py': '902f487fda272924eb67ba685e24cfebd73b78c98b942438f3cb936f3dffa4a9',
    'apply-organization-fix.py': HELPER_SHA,
}
STAGES = frozenset(('public-code', 'private-inputs', 'connect', 'read-source',
                    'business-encode', 'business-roundtrip', 'account-shape',
                    'organization-shape', 'source-stability', 'finished', 'preflight',
                    'publication-audit', 'helper-audit', 'runtime-check',
                    'environment-capture', 'node-execution', 'node-output'))
SAFE_MESSAGES = frozenset((
    'Compatibility checks passed; real SQL constraints still require controlled migration verification',
    'Source changed during diagnosis; rerun the read-only check',
    'Private diagnostic details withheld',
    'Diagnostic preflight failed; private details withheld',
    'Business round-trip validation failed',
    '同一集合记录编号重复', '整包同步数据必须是对象', '同步版本无效', '同步集合必须是数组',
    '数据包含不能保存的值', '数据包含循环引用', '迁移账号结构无效',
    '账号字段类型无效，不能有损迁移', '账号授权范围格式无效', '账号集合格式无效',
    '组织配置结构无效', '组织选项结构无效', '楼栋配置结构无效',
))
STATUSES = frozenset(('MYSQL_RELATIONAL_COMPATIBILITY_OK', 'MYSQL_RELATIONAL_COMPATIBILITY_ERROR',
                      'MYSQL_RELATIONAL_DIAGNOSTIC_RETRY', 'MYSQL_RELATIONAL_DIAGNOSTIC_STOPPED'))

NODE_DIAGNOSTIC = r'''
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const {createRequire} = require("node:module"), {isDeepStrictEqual} = require("node:util");
const expected = {
  "mysql-store.js":"84e37fc6d87d357bc13f74fd9fa2a985908e8abf361aeae39cd1a8c12e83f845",
  "mysql-auth-store.js":"47b4526df2d3fa4d77496ed1e81c9992dc47cbf6748bab422f15c78cb698bf6c",
  "migrate-mysql.js":"73b04b4489c1c17c5a93815dbfe63111ddb7c07e9f67ea25f5f573f8feda71ad"
};
const messages = new Set([
  "Business round-trip validation failed", "同一集合记录编号重复", "整包同步数据必须是对象", "同步版本无效", "同步集合必须是数组",
  "数据包含不能保存的值", "数据包含循环引用", "迁移账号结构无效", "账号字段类型无效，不能有损迁移", "账号授权范围格式无效",
  "账号集合格式无效", "组织配置结构无效", "组织选项结构无效", "楼栋配置结构无效"
]);
const LEGACY_SELECT = "SELECT payload FROM system_snapshots WHERE snapshot_key='default'";
const SQL = Object.freeze([
  "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "SET TRANSACTION READ ONLY", "START TRANSACTION", LEGACY_SELECT, "ROLLBACK"
]);
const flags = Object.freeze({readOnly:true, databaseWritten:false, serviceRestarted:false});
function result(status, stage, message) {return {status,stage,message,...flags};}
function safeFailure(error, stage) {
  return result("MYSQL_RELATIONAL_COMPATIBILITY_ERROR",stage,messages.has(error && error.message)?error.message:"Private diagnostic details withheld");
}
function assert(value) {if(!value)throw new Error("Private diagnostic details withheld");}
function canonical(value) {return value.replace(/^\uFEFF/, "").replace(/\r\n/g,"\n");}
function hash(value) {return crypto.createHash("sha256").update(value).digest("hex");}
function publicModules(request) {
  assert(path.isAbsolute(request.sourceDirectory) && request.modules && Object.keys(request.modules).length===3);
  const loaded = {};
  for(const [name, sha] of Object.entries(expected)) {
    const source=request.modules[name];
    assert(typeof source==="string" && hash(canonical(source))===sha);
    const filename=path.join(request.sourceDirectory,name), unit={exports:{},filename};
    // A separate CommonJS module prevents the original CLI main from running.
    new Function("require","module","exports","__filename","__dirname",canonical(source))(
      createRequire(filename),unit,unit.exports,filename,path.dirname(filename));
    loaded[name]=unit.exports;
  }
  return loaded;
}
function memoryIdentityStore() {
  // This adapter has no connection or reference to the real MySQL driver.
  const marker={};
  return {
    connection(){return marker;}, transaction(action){return action();},
    async query(sql){
      assert(typeof sql==="string");
      if(/^SELECT\b/.test(sql))return [[]];
      if(/^(?:INSERT|UPDATE|DELETE)\b/.test(sql))return [{affectedRows:1}];
      throw new Error("Private diagnostic details withheld");
    }
  };
}
async function diagnose(request, dependencies={}) {
  let stage="public-code", connection=null, transaction=false, migration, privateState, source, failure=null;
  let query;
  try {
    const modules=publicModules(request), store=modules["mysql-store.js"], auth=modules["mysql-auth-store.js"];
    migration=modules["migrate-mysql.js"];
    stage="private-inputs";
    assert(path.isAbsolute(request.configPath) && path.isAbsolute(request.dataDirectory));
    const config=migration.checkedFile(request.configPath,1024*1024).value;
    assert(config && typeof config==="object" && !Array.isArray(config));
    privateState=migration.legacyFiles(request.dataDirectory);
    const mysql=config.mysql||{}, env=process.env;
    const options={host:env.HR_MYSQL_HOST||mysql.host||"127.0.0.1",port:Number(env.HR_MYSQL_PORT||mysql.port||3306),
      database:env.HR_MYSQL_DATABASE||mysql.database||"hr_system",user:env.HR_MYSQL_USER||mysql.user||"hrsystem",
      password:env.HR_MYSQL_PASSWORD||mysql.password||"",charset:"utf8mb4"};
    assert(String(env.HR_MYSQL_ENABLED||(mysql.enabled?"true":"false")).toLowerCase()==="true" &&
      ["localhost","127.0.0.1"].includes(options.host) && options.port===3306 && options.password &&
      /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(options.database));
    stage="connect";
    const createConnection=dependencies.createConnection||createRequire(request.configPath)("mysql2/promise").createConnection;
    connection=await createConnection(options);
    query=async sql=>{assert(SQL.includes(sql));return connection.query(sql);};
    await query(SQL[0]);await query(SQL[1]);await query(SQL[2]);transaction=true;
    stage="read-source";
    const read=async()=>{
      const [rows]=await query(LEGACY_SELECT);
      assert(rows.length===1 && typeof rows[0].payload==="string" && Buffer.byteLength(rows[0].payload)<=64*1024*1024);
      const value=JSON.parse(rows[0].payload);assert(value && typeof value==="object" && !Array.isArray(value) && Array.isArray(value.employees));
      return value;
    };
    source=await read();
    try {
      stage="business-encode";const encoded=store.encodeBundle(source);
      stage="business-roundtrip";
      if(!isDeepStrictEqual(store.decodeBundle(encoded.tables,encoded.revision),store.normalizeBundle(source)))
        throw new Error("Business round-trip validation failed");
      const identity=auth.createMySQLAuthStore(memoryIdentityStore());
      stage="account-shape";await identity.writeUsers(privateState.users);
      stage="organization-shape";await identity.writeOrganization(privateState.organization);
    } catch(error) {failure=safeFailure(error,stage);}
    stage="source-stability";
    await query("ROLLBACK");transaction=false;
    // A new autocommit SELECT can see writes made while the read-only snapshot
    // was being checked; a SELECT in the old repeatable-read snapshot cannot.
    const after=await read();
    let stable=migration.digest(after)===migration.digest(source);
    try {privateState.verifyUnchanged();}catch(_){stable=false;}
    if(!stable)return result("MYSQL_RELATIONAL_DIAGNOSTIC_RETRY",stage,"Source changed during diagnosis; rerun the read-only check");
    return failure||result("MYSQL_RELATIONAL_COMPATIBILITY_OK","finished","Compatibility checks passed; real SQL constraints still require controlled migration verification");
  } catch(error) {return safeFailure(error,stage);}
  finally {
    if(connection) {
      if(transaction) {try {await query("ROLLBACK");}catch(_) {}}
      try {await connection.end();}catch(_) {}
    }
  }
}
module.exports={diagnose,safeFailure,SQL};
if(process.argv[1]==="hr-relational-read-only-diagnostic") {
  Promise.resolve().then(()=>JSON.parse(fs.readFileSync(0,"utf8"))).then(request=>diagnose(request)).then(
    value=>process.stdout.write(JSON.stringify(value)+"\n"),
    ()=>process.stdout.write(JSON.stringify(result("MYSQL_RELATIONAL_COMPATIBILITY_ERROR","public-code","Private diagnostic details withheld"))+"\n")
  );
}
'''


class Refused(Exception):
    def __init__(self, phase='preflight'):
        super().__init__()
        self.phase = phase


def require(value):
    if not value:
        raise Refused()


def protected_path(value, directory=False):
    target = pathlib.Path(os.path.abspath(value))
    for entry in (*reversed(target.parents), target):
        info = entry.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0)
        if entry != target or directory:
            require(stat.S_ISDIR(info.st_mode))
            temporary_root = entry == pathlib.Path('/tmp') and bool(info.st_mode & stat.S_ISVTX)
            require(not info.st_mode & 0o022 or temporary_root)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022)
    return target


def public_bytes(value, expected=None, canonical=False):
    path = protected_path(value)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and not info.st_mode & 0o022 and info.st_size <= 8 * 1024 * 1024)
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(8 * 1024 * 1024 + 1)
        require(len(raw) <= 8 * 1024 * 1024)
        normalized = raw.decode('utf-8-sig').replace('\r\n', '\n').encode('utf-8') if canonical else raw
        require(expected is None or hashlib.sha256(normalized).hexdigest() == expected)
        return raw
    finally:
        os.close(descriptor)


def reviewed_modules(publication):
    publication = pathlib.Path(os.path.abspath(publication))
    require(publication.parent == BACKUPS and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}-mysql-relational-[0-9]{6}-[a-z0-9_]+', publication.name))
    protected_path(publication, directory=True)
    for name, sha in AUDIT_SHA.items():
        public_bytes(publication / 'publication-tool' / name, sha)
    source = publication / 'reviewed-release'
    document = json.loads(public_bytes(source / 'deploy/mysql-relational-release.json', MANIFEST_SHA))
    for model in document['variants'].values():
        require(all(model['files']['server/' + name]['afterSha256'] == sha for name, sha in MODULE_SHA.items()))
    return {name: public_bytes(source / 'server' / name, sha, canonical=True).decode('utf-8-sig') for name, sha in MODULE_SHA.items()}


def load_helper():
    filename = pathlib.Path(__file__).absolute().with_name('apply-organization-fix.py')
    raw = public_bytes(filename, HELPER_SHA)
    helper = types.ModuleType('reviewed_readonly_runtime')
    helper.__file__ = str(filename)
    exec(compile(raw, str(filename), 'exec'), helper.__dict__)
    return helper


def service_environment(helper, pid):
    require(re.fullmatch(r'[1-9][0-9]*', pid) and pathlib.Path('/proc', pid, 'cwd').resolve() == APP)
    allowed = {'HR_DATA_DIR', 'HR_MYSQL_ENABLED', 'HR_MYSQL_HOST', 'HR_MYSQL_PORT',
               'HR_MYSQL_DATABASE', 'HR_MYSQL_USER', 'HR_MYSQL_PASSWORD'}
    actual = {}
    for item in pathlib.Path('/proc', pid, 'environ').read_bytes().split(b'\0'):
        key, separator, value = item.partition(b'=')
        if separator and key == b'HR_STORAGE_MODE':
            require(value == b'mysql')
        if separator and key.decode('ascii', 'ignore') in allowed:
            actual[key.decode('ascii')] = value.decode('utf-8')
    require(helper.system_value('MainPID') == pid)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith('HR_') and key not in ('NODE_OPTIONS', 'NODE_PATH')}
    environment.update(actual)
    environment['NODE_PATH'] = str(APP / 'server/node_modules')
    return environment


def bounded_result(raw):
    require(isinstance(raw, bytes) and len(raw) <= 4096)
    value = json.loads(raw.decode('utf-8'))
    require(isinstance(value, dict) and set(value) == {'status', 'stage', 'message', 'readOnly', 'databaseWritten', 'serviceRestarted'})
    require(value['status'] in STATUSES and value['stage'] in STAGES and value['message'] in SAFE_MESSAGES)
    require(value['readOnly'] is True and value['databaseWritten'] is False and value['serviceRestarted'] is False)
    return value


def diagnose(publication):
    phase = 'preflight'
    try:
        require(os.name == 'posix' and os.geteuid() == 0)
        phase = 'publication-audit'
        modules = reviewed_modules(publication)
        phase = 'helper-audit'
        helper = load_helper()
        phase = 'runtime-check'
        pid = helper.system_value('MainPID')
        data, _, _ = helper.runtime()
        phase = 'environment-capture'
        environment = service_environment(helper, pid)
        request = {'modules': modules, 'sourceDirectory': str(pathlib.Path(publication) / 'reviewed-release/server'),
                   'configPath': str(APP / 'server/config.json'), 'dataDirectory': str(data)}
        phase = 'node-execution'
        process = subprocess.run(['node', '-e', NODE_DIAGNOSTIC, 'hr-relational-read-only-diagnostic'],
                                 input=json.dumps(request).encode('utf-8'), cwd=APP, env=environment,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        phase = 'node-output'
        require(process.returncode == 0)
        value = bounded_result(process.stdout)
        phase = 'runtime-check'
        require(helper.system_value('MainPID') == pid)
        return value
    except (Exception, KeyboardInterrupt):
        raise Refused(phase) from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication-backup', required=True)
    args = parser.parse_args(argv)
    try:
        value = diagnose(args.publication_backup)
    except (Exception, KeyboardInterrupt) as error:
        phase = error.phase if isinstance(error, Refused) and error.phase in STAGES else 'preflight'
        value = {'status': 'MYSQL_RELATIONAL_DIAGNOSTIC_STOPPED', 'stage': phase,
                 'message': 'Diagnostic preflight failed; private details withheld',
                 'readOnly': True, 'databaseWritten': False, 'serviceRestarted': False}
    print(json.dumps(value, ensure_ascii=False), flush=True)
    return 0 if value['status'] == 'MYSQL_RELATIONAL_COMPATIBILITY_OK' else 2


if __name__ == '__main__':
    sys.exit(main())
