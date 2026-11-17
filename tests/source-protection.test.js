'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/protect-web-source.py');
const setup = `import importlib.util,pathlib,tempfile,json,os,stat,copy,sys,hashlib
s=importlib.util.spec_from_file_location('source_guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
FIXTURES=pathlib.Path.cwd()/'.delivery'/'source-protection-tests';FIXTURES.mkdir(parents=True,exist_ok=True)
def fixture(root):
 app=root/'app';app.mkdir()
 for folder in ['server/data','server/repair-backup','server/node_modules/driver','js','css','assets','deploy','scripts','.github/workflows','updates','技术文档']:(app/folder).mkdir(parents=True,exist_ok=True)
 values={'index.html':'<html>public</html>','AGENTS.md':'owner rule','.gitignore':'server/data/','manifest.json':'{}','LICENSE-SheetJS.txt':'public license','js/app.js':'public JS','css/style.css':'body{}','assets/icon.png':'public icon','deploy/update.py':'public update','scripts/build.cjs':'public build','.github/CODEOWNERS':'* @owner','.github/workflows/check.yml':'public workflow','技术文档/公开.md':'public docs','updates/2026-11-17.md':'public update','server/server.js':'public server','server/auth-service.js':'public auth','server/config.example.json':'{}','server/package.json':'{}','server/node_modules/driver/index.js':'public dependency','server/data/personnel.json':'PRIVATE PERSONNEL','server/config.json':'PRIVATE CONFIG','server/repair-backup/private.js':'PRIVATE BACKUP','private.log':'PRIVATE LOG','server/secret.env':'PRIVATE ENV'}
 for name,value in values.items():(app/name).write_text(value,encoding='utf-8')
 return app
def document(app,records):return {'schemaVersion':1,'type':m.MANIFEST_TYPE,'app':str(app),'records':records}
`;
function run(body) {
  const result=spawnSync(python,['-c',setup+'\n'+body,script],{encoding:'utf8',timeout:15000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}

test('source plan opens only public allowlisted files and leaves private metadata untouched',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);app=fixture(root)
 private=['server/data','server/data/personnel.json','server/config.json','server/repair-backup/private.js','server/secret.env','private.log']
 before={name:(app/name).stat() for name in private}
 original_digest=m.file_digest
 def public_digest(target,info):
  relative=target.relative_to(app).as_posix();assert relative not in private,relative
  return original_digest(target,info)
 m.file_digest=public_digest
 records,issues=m.build_plan(app);assert not any(issues.values())
 names={r['path'] for r in records}
 assert {'.','server','server/server.js','server/config.example.json','server/node_modules/driver/index.js','.github/CODEOWNERS','.gitignore','AGENTS.md','技术文档/公开.md','updates/2026-11-17.md'}<=names
 assert not names.intersection(private)
 for name,old in before.items():
  now=(app/name).stat();assert (old.st_uid,old.st_gid,old.st_mode,old.st_mtime_ns)==(now.st_uid,now.st_gid,now.st_mode,now.st_mtime_ns)
 m.validate_manifest(document(app,records),app)
 assert records[0]['path']=='.'
 assert all(r['kind']=='directory' for r in records[:sum(r['kind']=='directory' for r in records)])
 print('ok')`),'ok');
});

test('public directory descendants never authorize secrets, backups, archives or runtime files',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory))
 private=['deploy/sms.env','scripts/.env','.github/sub/credentials.json','assets/private/records.json','scripts/backup/old.js','deploy/archive/release.js','js/__pycache__/hidden.json','assets/employees.json','deploy/source.zip','js/config.json']
 for name in private:
  path=app/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('PRIVATE SENTINEL',encoding='utf-8')
 before={name:(app/name).stat() for name in private}
 (app/'deploy/sms.env.example').write_text('PUBLIC TEMPLATE',encoding='utf-8')
 (app/'server/node_modules/driver/native.node').write_bytes(b'PUBLIC NATIVE MODULE')
 for module in ['attendance','employees','overtime','performance']:
  (app/('js/'+module+'.js')).write_text('PUBLIC BUSINESS MODULE',encoding='utf-8')
 original=m.file_digest
 def public_digest(path,info):
  assert path.relative_to(app).as_posix() not in private,'private file opened for hashing'
  return original(path,info)
 m.file_digest=public_digest
 records,issues=m.build_plan(app);assert not any(issues.values())
 names={row['path'] for row in records};assert not names.intersection(private)
 assert 'deploy/sms.env.example' in names and 'server/node_modules/driver/native.node' in names
 assert {'js/'+module+'.js' for module in ['attendance','employees','overtime','performance']}<=names
 for name in private:
  for kind in ['file','directory']:
   if kind=='file':assert not m.allowed_relative(name,kind),name
  old=before[name];now=(app/name).stat();assert (old.st_uid,old.st_gid,old.st_mode,old.st_mtime_ns)==(now.st_uid,now.st_gid,now.st_mode,now.st_mtime_ns)
  bad=document(app,copy.deepcopy(records));row=copy.deepcopy(next(row for row in records if row['kind']=='file'));row['path']=name;bad['records'].append(row)
  try:m.validate_manifest(bad,app)
  except m.Refused:pass
  else:raise AssertionError('private rollback path accepted: '+name)
 print('ok')`),'ok');
});

test('four individually reviewed production source paths are protected without authorizing private or unknown copies',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory))
 reviewed=['server/node_modules/mysql2/lib/tls_session_cache.js','server/node_modules/undici-types/cache-interceptor.d.ts','server/node_modules/undici-types/cache.d.ts','server/stop.bat']
 excluded=['server/data/tls_session_cache.js','server/private/stop.bat','server/node_modules/driver/tls_session_cache.js','server/node_modules/unknown-types/cache-interceptor.d.ts','server/node_modules/unknown-types/cache.d.ts','server/node_modules/mysql2/private/tls_session_cache.js','server/node_modules/undici-types/private/cache.d.ts','scripts/private/stop.bat','server/tools/stop.bat','server/other-stop.bat']
 for name in reviewed+excluded:
  target=app/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('PUBLIC REVIEWED' if name in reviewed else 'PRIVATE OR UNREVIEWED SENTINEL',encoding='utf-8')
 all_files=reviewed+excluded+['server/config.json','server/data/personnel.json','js/app.js','server/server.js']
 before={name:(app/name).stat() for name in all_files}
 original=m.file_digest;hashed=set()
 def digest(target,info):
  relative=target.relative_to(app).as_posix();assert relative not in excluded+['server/config.json','server/data/personnel.json'],'private or unknown content was opened'
  hashed.add(relative);return original(target,info)
 # A check constructs an observed plan; it cannot mutate source ownership or
 # permissions, even for these previously application-owned 0644 files.
 from contextlib import ExitStack
 from unittest.mock import patch
 with ExitStack() as stack:
  stack.enter_context(patch.object(m,'file_digest',digest))
  stack.enter_context(patch.object(m,'change_metadata',side_effect=AssertionError('check mutated source metadata')))
  for operation in ['chmod','chown','fchmod','fchown']:
   if hasattr(m.os,operation):stack.enter_context(patch.object(m.os,operation,side_effect=AssertionError('check mutated source permissions')))
  unprotected=[];records,issues=m.build_plan(app,unprotected)
 names={row['path'] for row in records};unprotected_names={row['path'] for row in unprotected}
 assert not any(issues.values());assert set(reviewed)<=names and set(reviewed)<=hashed
 assert not set(reviewed).intersection(unprotected_names)
 assert not names.intersection(excluded)
 for name in reviewed:assert m.allowed_relative(name,'file'),name
 for name in excluded:assert not m.allowed_relative(name,'file'),name
 # Unknown executable copies remain metadata-only review candidates; private
 # directories are not traversed and do not authorize the files inside them.
 assert {'server/node_modules/driver/tls_session_cache.js','server/node_modules/unknown-types/cache-interceptor.d.ts','server/node_modules/unknown-types/cache.d.ts','server/other-stop.bat'}<=unprotected_names
 assert not any('sha256' in row for row in unprotected)
 for name,old in before.items():
  now=(app/name).stat();assert (old.st_uid,old.st_gid,old.st_mode,old.st_ino,old.st_mtime_ns,old.st_ctime_ns)==(now.st_uid,now.st_gid,now.st_mode,now.st_ino,now.st_mtime_ns,now.st_ctime_ns),name
  if name not in reviewed and name!='js/app.js' and name!='server/server.js':assert old.st_atime_ns==now.st_atime_ns,name
 m.validate_manifest(document(app,records),app)
 print('ok')`),'ok');
});

test('protected modes provide only root write and service-group read access, with no other access',()=>{
  assert.equal(run(`assert m.desired_mode({'kind':'directory','mode':0o700})==0o750
assert m.desired_mode({'kind':'file','mode':0o600})==0o640
assert m.desired_mode({'kind':'file','mode':0o755})==0o750
for kind in ['file','directory']:
 for original in [0o600,0o644,0o700,0o750,0o755,0o777]:
  mode=m.desired_mode({'kind':kind,'mode':original});assert mode&0o7==0 and mode&0o020==0
print('ok')`),'ok');
});

test('excluded executable source and unreviewed dependency directories block apply before any metadata changes',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory));unknown=['server/node_modules/driver/connection_config.js','js/credentials.js','server/config.js','scripts/password.py']
 for name in unknown:
  target=app/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('PRIVATE UNREVIEWED',encoding='utf-8')
 (app/'server/node_modules/driver/config').mkdir()
 (app/'server/node_modules/driver/config/nested.js').write_text('DO NOT TRAVERSE',encoding='utf-8')
 for name in m.PUBLIC_KNOWN_SOURCE:
  target=app/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('REVIEWED PUBLIC DRIVER SOURCE',encoding='utf-8')
 original=m.file_digest
 def digest(target,info):
  assert target.relative_to(app).as_posix() not in unknown
  assert 'driver/config' not in target.as_posix()
  return original(target,info)
 m.file_digest=digest;unprotected=[];records,issues=m.build_plan(app,unprotected)
 assert not any(issues.values());names={row['path'] for row in records};assert m.PUBLIC_KNOWN_SOURCE<=names
 assert not names.intersection(unknown)
 assert {row['path'] for row in unprotected}==set(unknown)|{'server/node_modules/driver/config'}
 for row in unprotected:row['uid']=1234;row['mode']=0o600 if row['kind']=='file' else 0o550
 review=m.unprotected_source_issues(unprotected,1234,[False]*len(unprotected))
 assert review=={'writableUnprotectedSource':4,'unreviewedDependencyDirectories':1}
 file_row=next(row for row in unprotected if row['kind']=='file');file_row=dict(file_row,uid=0,mode=0o640)
 assert m.unprotected_source_issues([file_row],1234,[False])['writableUnprotectedSource']==0
 assert m.unprotected_source_issues([file_row],1234,[True])['writableUnprotectedSource']==1
 assert m.unprotected_source_issues([dict(file_row,mode=0o660)],1234,[False])['writableUnprotectedSource']==1
 assert m.unprotected_source_issues([dict(file_row,uid=1234,mode=0o400)],1234,[False])['writableUnprotectedSource']==1
 assert m.unprotected_source_issues([dict(file_row,uid=5678,mode=0o400)],1234,[False])['writableUnprotectedSource']==1
 # Exercise the real CLI orchestration with host/inspection calls replaced;
 # a rejected preflight must reach neither backups nor metadata mutations.
 import types
 real_require=m.require
 def host_require(condition,message):
  if message!='Run as root on the existing Linux host':real_require(condition,message)
 class FixedApp:
  parent=types.SimpleNamespace(stat=lambda:types.SimpleNamespace(st_uid=0,st_mode=0o755))
  def __eq__(self,other):return str(other)==str(pathlib.Path('/opt/hr-system'))
 m.APP=FixedApp();m.require=host_require;m.checked_path=lambda value:value
 m.service_identity=lambda:'123';m.service_group=lambda:1234;m.private_write_state=lambda:{};m.public_response_state=lambda:{}
 m.build_plan=lambda **kwargs:([{'path':'server/server.js','kind':'file','uid':0,'gid':1234,'mode':0o640}],{'symlinks':0,'hardlinks':0,'unsupported':0})
 m.inspect_unprotected_source=lambda rows:review
 def forbidden(*args,**kwargs):raise AssertionError('preflight performed a mutation')
 m.save_manifest=forbidden;m.change_metadata=forbidden;m.restore_records=forbidden
 try:m.main(['--apply'])
 except m.Refused as error:assert 'writableUnprotectedSource' in str(error) and 'no permissions were changed' in str(error)
 else:raise AssertionError('unreviewed source accepted')
 print('ok')`),'ok');
});

test('rollback validation rejects private paths, traversal, duplicate paths and hostile metadata before changes',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory));records,_=m.build_plan(app)
 for path in ['server/data','server/data/personnel.json','server/config.json','server/repair-backup/private.js','server/secret.env','../outside.js','/etc/passwd','js/../server/config.json','js\\\\outside.js','js//outside.js','js/./outside.js']:
  bad=copy.deepcopy(document(app,records));row=copy.deepcopy(next(r for r in records if r['kind']=='file'));row['path']=path;bad['records'].append(row)
  try:m.validate_manifest(bad,app)
  except m.Refused:pass
  else:raise AssertionError(path)
 for field,value in [('uid',-1),('gid',2**32),('mode',0o4755),('inode',True),('sha256','invalid')]:
  bad=copy.deepcopy(document(app,records));row=next(r for r in bad['records'] if r['kind']=='file');row[field]=value
  try:m.validate_manifest(bad,app)
  except m.Refused:pass
  else:raise AssertionError(field)
 bad=copy.deepcopy(document(app,records));bad['records'].append(copy.deepcopy(bad['records'][0]))
 try:m.validate_manifest(bad,app)
 except m.Refused:pass
 else:raise AssertionError('duplicate')
 bad=copy.deepcopy(document(app,records));bad['app']='/different'
 try:m.validate_manifest(bad,app)
 except m.Refused:pass
 else:raise AssertionError('wrong installation')
 for group in [True,-1,2**32]:
  bad=copy.deepcopy(document(app,records));bad['protectedGid']=group
  try:m.validate_manifest(bad,app)
  except m.Refused:pass
  else:raise AssertionError('invalid protected group')
 print('ok')`),'ok');
});

test('content or inode changes refuse stale permission application and rollback',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory));records,_=m.build_plan(app)
 m.assert_unchanged(records,app)
 source=app/'js/app.js';original=source.read_bytes();source.write_bytes(b'changed code')
 try:m.assert_unchanged(records,app)
 except m.Refused:pass
 else:raise AssertionError('changed content')
 source.write_bytes(original)
 new=app/'js/new.tmp';new.write_bytes(original);os.replace(new,source)
 try:m.assert_unchanged(records,app)
 except m.Refused:pass
 else:raise AssertionError('replaced inode')
 print('ok')`),'ok');
});

test('hardlinked public source is counted and not opened; dependencies are covered',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory));target=app/'server/data/personnel.json';os.link(target,app/'js/linked.js')
 original=m.file_digest
 def digest(path,info):
  assert path.name!='linked.js'
  return original(path,info)
 m.file_digest=digest
 records,issues=m.build_plan(app)
 assert issues['hardlinks']==1
 assert 'js/linked.js' not in {r['path'] for r in records}
 assert 'server/node_modules/driver/index.js' in {r['path'] for r in records}
 print('ok')`),'ok');
});

test('code links are counted without following their private or outside target', {skip:process.platform==='win32'?'Windows symlink creation requires developer-mode privileges':false},()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);app=fixture(root)
 (app/'js/linked.js').symlink_to(app/'server/data/personnel.json')
 (app/'server/node_modules/linked-dir').symlink_to(app/'server/data',target_is_directory=True)
 records,issues=m.build_plan(app)
 assert issues['symlinks']==2
 assert not any('personnel' in r['path'] or 'linked' in r['path'] for r in records)
 print('ok')`),'ok');
});

test('metadata changes use inode-bound descriptors and are reversible without changing file bytes', {skip:process.platform==='win32'?'POSIX fchown/fchmod and directory descriptors are unavailable on Windows':false},()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hr-source-protection-',dir=FIXTURES) as directory:
 app=fixture(pathlib.Path(directory));records,_=m.build_plan(app)
 for row in records:
  m.change_metadata(row,row['uid'],row['gid'],m.desired_mode(row),app)
 for row in records:
  assert stat.S_IMODE((app/row['path']).stat().st_mode)==m.desired_mode(row)
 m.restore_records(records,app);m.assert_unchanged(records,app)
 print('ok')`),'ok');
});

test('CLI is explicitly fixed to one installation and check/apply/rollback are mutually exclusive',()=>{
  for(const args of [['--app','/tmp/elsewhere'],['--apply','--rollback','/tmp/fake'],['--check','--apply'],['--rollback']]) {
    const result=spawnSync(python,[script,...args],{encoding:'utf8',timeout:10000});assert.ifError(result.error);assert.equal(result.status,2,result.stderr);assert.doesNotMatch(result.stderr,/Traceback|systemctl/);
  }
  const help=spawnSync(python,[script,'--help'],{encoding:'utf8',timeout:10000});assert.equal(help.status,0);assert.match(help.stdout,/--check/);assert.match(help.stdout,/--apply/);assert.match(help.stdout,/--rollback/);assert.match(help.stdout,/Default:/);
});
