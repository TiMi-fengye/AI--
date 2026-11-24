'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/apply-mysql-relational.py');
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('relational_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'));exec(v['code'])
`;
function invoke(code) {
  const temporary = path.resolve(__dirname, '../.delivery/relational-deployment-test-tmp');
  fs.mkdirSync(temporary, {recursive: true});
  const result = spawnSync(python, ['-c', bridge, script], {input: JSON.stringify({code}), encoding: 'utf8', timeout: 15000,
    env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const model = `import copy,pathlib,tempfile
def manifest():
 variants={}
 for variant,new in m.VARIANTS.items():
  rows={}
  for name in m.CODE:
   item={'beforeSha256':None if name in new else 'a'*64,'afterSha256':'b'*64}
   if name in m.PATCH_FILES:item['patches']=[{'old':'old '+variant,'new':'new '+variant}]
   rows[name]=item
  variants[variant]={'files':rows}
 return {'schemaVersion':1,'variants':variants,'backupTool':{'beforeSha256':'c'*64,'afterSha256':'d'*64}}
def proof():
 return {'status':'MYSQL_RELATIONAL_VERIFIED','initialized':True,'model':'relational','schemaVersion':1,'revision':4,'contentSha256':'1'*64,'sourceDigest':'2'*64,'tablesSha256':'3'*64,'tables':['t%02d'%i for i in range(24)],'tableCounts':{'t%02d'%i:1 for i in range(24)},'counts':{'employees':2}}
`;

test('relational manifest allows only two fixed fourteen-code variants and reviewed raw backup-tool digests', () => {
  const result = invoke(model + `
valid=manifest();assert m.validate_manifest(valid)==valid
bad=[]
for target in ['../../etc/shadow','server/config.json',m.HTML]:
 value=copy.deepcopy(valid);rows=value['variants']['attendance-delete']['files'];rows[target]=rows.pop(m.SQL_MODULES[0]);bad.append(value)
value=copy.deepcopy(valid);del value['variants']['approval-workflow'];bad.append(value)
value=copy.deepcopy(valid);value['variants']['unknown']=value['variants']['approval-workflow'];bad.append(value)
value=copy.deepcopy(valid);value['variants']['attendance-delete']['files'][m.SQL_MODULES[0]]['beforeSha256']='a'*64;bad.append(value)
value=copy.deepcopy(valid);value['variants']['approval-workflow']['files'][m.base.NEW[0]]['beforeSha256']=None;bad.append(value)
value=copy.deepcopy(valid);value['backupTool']['path']='/etc/shadow';bad.append(value)
for patches in [[],[{'old':'x','new':'x'}],[{'old':'x','new':'y'},{'old':'x','new':'z'}]]:
 value=copy.deepcopy(valid);value['variants']['attendance-delete']['files'][m.AUTH]['patches']=patches;bad.append(value)
for value in bad:
 try:m.validate_manifest(value)
 except m.Refused:pass
 else:raise AssertionError('unsafe manifest accepted')
unchanged=copy.deepcopy(valid);row=unchanged['variants']['attendance-delete']['files'][m.AUTH];row['afterSha256']=row['beforeSha256'];row['patches']=[]
assert m.validate_manifest(unchanged)==unchanged
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('variant selection requires exact source bytes and new module absence rather than accepting partial deployments', () => {
  const result = invoke(model + `
document=manifest();old=b'fixed public baseline\\n';digest=m.canonical_hash(old)
for variant,new in m.VARIANTS.items():
 current={name:None if name in new else old for name in m.CODE};current[m.HTML]=b'html'
 for name,row in document['variants'][variant]['files'].items():
  if row['beforeSha256'] is not None:row['beforeSha256']=digest
 assert m.select_variant(current,document)==variant
 changed=dict(current);changed[m.AUTH]=old+b'changed'
 try:m.select_variant(changed,document)
 except m.Refused:pass
 else:raise AssertionError('unknown source accepted')
 changed=dict(current);changed[m.SQL_MODULES[0]]=b'existing unknown module'
 try:m.select_variant(changed,document)
 except m.Refused:pass
 else:raise AssertionError('partial deployment accepted')
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('backup tool manifest revision changes only the managed core digest while preserving wrapper and unit hashes and formatting', () => {
  const result = invoke(`import pathlib,json
old=b'old backup core';new=b'new relational core';rows={str(m.TOOL):m.raw_hash(old),str(m.WRAPPER):'a'*64,str(m.UNITS/'hr-system-backup.service'):'b'*64,str(m.UNITS/'hr-system-backup.timer'):'c'*64}
document={'schemaVersion':1,'type':'hr-system-daily-backup-installation','files':rows}
raw=(json.dumps(document,indent=2)+'\\n').encode();current={m.TOOL:old,m.TOOL_MANIFEST:raw,m.WRAPPER:b'wrapper'}
revised=m.revised_backup_state(current,new)
assert revised[m.TOOL]==new and revised[m.WRAPPER]==b'wrapper'
assert revised[m.TOOL_MANIFEST]==raw.replace(m.raw_hash(old).encode(),m.raw_hash(new).encode())
assert json.loads(revised[m.TOOL_MANIFEST])['files']==dict(rows,**{str(m.TOOL):m.raw_hash(new)})
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('preflight runs only isolated public approval and SQL authorization tests with production HR settings removed', () => {
  const result = invoke(`import pathlib,tempfile,os
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);source=root/'release';source.mkdir();stage=root/'candidate';stage.mkdir()
 for name in ('tests/approval-workflow.test.js','tests/mysql-auth-store.test.js','scripts/generate-architecture.cjs'):
  target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'public test fixture')
 os.environ['HR_MYSQL_PASSWORD']='synthetic-not-a-real-password';os.environ['HR_DATA_DIR']='/private/not-used'
 calls=[];m.stage_candidates=lambda *args:None
 m.helper.run=lambda args,**kwargs:calls.append((list(map(str,args)),kwargs)) or b''
 m.verify_candidate_code(source,stage,{})
 assert len(calls)==3 and all('systemctl' not in row[0] for row in calls)
 assert calls[0][0][-1].endswith('approval-workflow.test.js') and calls[1][0][-1].endswith('mysql-auth-store.test.js') and calls[2][0][-1]=='--check'
 for args,options in calls:
  env=options['env'];assert 'HR_MYSQL_PASSWORD' not in env and 'HR_DATA_DIR' not in env
  assert env['HR_APPROVAL_AUTH_TEST_MODULE']==str(stage/m.AUTH) and env['HR_MYSQL_AUTH_TEST_MODULE']==str(stage/m.AUTH)
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('rollback proof refuses modified or foreign relational rows and permits only unchanged initialized or proven empty targets', () => {
  const result = invoke(model + `
source={'contentSha256':'1'*64,'sourceDigest':'2'*64};initial=proof();state={'source':source,'relation':m.relation_proof(initial)}
m.migration_command=lambda *args:initial
m.safe_rollback_database(None,None,None,state)
for changed in [dict(initial,tablesSha256='4'*64),dict(initial,contentSha256='5'*64)]:
 m.migration_command=lambda *args,row=changed:row
 try:m.safe_rollback_database(None,None,None,state)
 except m.Refused:pass
 else:raise AssertionError('changed relation accepted for rollback')
def empty(script,data,environment,mode):
 if mode=='--verify':raise m.Refused('uninitialized')
 return dict(source,readyToApply=True)
m.migration_command=empty;m.safe_rollback_database(None,None,None,{'source':source})
def uncertain(*args):raise m.Refused('unknown target rows')
m.migration_command=uncertain
try:m.safe_rollback_database(None,None,None,{'source':source})
except m.Refused:pass
else:raise AssertionError('unknown database state accepted')
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('real maintenance gate and backup-core replacement request root ownership and private permissions without overwriting unknown files', {skip: process.platform === 'win32' ? 'POSIX fchown and directory fsync are verified on Linux' : false}, () => {
  const result = invoke(`import pathlib,tempfile,stat
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.HOLD=root/'migration.hold';owners=[];m.os.fchown=lambda fd,uid,gid:owners.append((uid,gid))
 hold=m.create_hold(71);assert stat.S_IMODE(m.HOLD.stat().st_mode)==0o640 and owners==[(0,71)]
 m.protected_source=lambda *args,**kwargs:None
 committed=[];m.clear_hold(hold,on_commit=lambda:committed.append(True));assert committed==[True] and not m.HOLD.exists()
 m.TOOL=root/'daily-backup.py';m.TOOL_MANIFEST=root/'installation.json';m.TOOL.write_bytes(b'old')
 m.replace_tool_file(m.TOOL,b'candidate');assert m.TOOL.read_bytes()==b'candidate' and stat.S_IMODE(m.TOOL.stat().st_mode)==0o600 and owners[-1]==(0,0)
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

const transaction = model + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();data=root/'data';data.mkdir();business=data/'synthetic.json';business.write_bytes(b'frozen original data')
 m.HOLD=root/'migration.hold';backup=root/'recovery';backup.mkdir();full=root/'full-backup';full.mkdir();(full/'KEEP').write_bytes(b'complete backup')
 m.TOOL=root/'daily-backup.py';m.TOOL_MANIFEST=root/'installation.json';wrapper=root/'wrapper';wrapper.write_bytes(b'unchanged wrapper')
 old_tool=b'old backup core';new_tool=b'new relational backup core';m.TOOL.write_bytes(old_tool)
 metadata=(json.dumps({'files':{str(m.TOOL):m.raw_hash(old_tool),str(wrapper):m.raw_hash(wrapper.read_bytes())}},indent=2)+'\\n').encode();m.TOOL_MANIFEST.write_bytes(metadata)
 tools={m.TOOL:old_tool,m.TOOL_MANIFEST:metadata,wrapper:wrapper.read_bytes()}
 current={name:None if name in m.VARIANTS['attendance-delete'] else ('old '+name).encode() for name in m.FILES};candidates={name:('new '+name).encode() for name in m.FILES}
 for name,content in current.items():
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True)
  if content is not None:target.write_bytes(content)
 state={'active':'active','migrated':False,'external':False,'sqlExternal':False,'install':0,'public':0,'lock':True,'failed':False};trace=[];timer={'active':'active','enabled':'enabled'}
 class Lock:
  def release(self):state['lock']=False;trace.append(('lock-release',))
  def acquire(self):state['lock']=True;trace.append(('lock-acquire',))
 lock=Lock()
 m.timer_state=lambda:dict(timer);m.protected_source=lambda *args,**kwargs:None
 m.base.sync_parent=lambda *args:None
 m.data_hashes=lambda where:{'business':m.helper.digest(business)};m.legacy_row_hash=lambda db:b'legacy frozen digest'
 def sql(*args):return ('9' if state['sqlExternal'] else '7' if state['migrated'] else '6')*64
 m.stable_sql_digest=sql
 def run(arguments,**kwargs):
  trace.append(tuple(str(v) for v in arguments))
  if arguments[:2]==['systemctl','stop']:state['active']='inactive'
  if arguments[:2]==['systemctl','start']:state['active']='active'
  return b''
 m.helper.run=run;m.helper.system_value=lambda name:state['active']
 def hold(gid):m.HOLD.write_bytes(b'hold');return {'gid':gid,'content':b'hold','identity':(m.HOLD.stat().st_dev,m.HOLD.stat().st_ino)}
 m.create_hold=hold
 def create(target,content,gid,on_created=None):
  target.write_bytes(content)
  if on_created:on_created((target.stat().st_dev,target.stat().st_ino))
 m.base.install_new=create
 def remove(target,content,gid,identity):
  assert (target.stat().st_dev,target.stat().st_ino)==identity and target.read_bytes()==content
  target.unlink()
 m.base.remove_new=remove
 def install(target,content,gid):
  target.write_bytes(content);state['install']+=1;trace.append(('install',str(target),content.decode()))
  if mode=='partial' and state['install']==2 and not state['failed']:
   state['failed']=True;raise m.Refused('synthetic code install failure')
 m.atomic_install=install
 def migrate(script,where,environment,action):
  trace.append(('migration',action))
  if action=='--apply':
   if mode=='migration-empty':raise m.Refused('synthetic uncommitted migration failure')
   state['migrated']=True
   if mode=='migration-lost-output' and not state['failed']:
    state['failed']=True;raise m.Refused('synthetic lost successful migration output')
  if action=='--verify' and not state['migrated']:raise m.Refused('target uninitialized')
  if action=='--check' and not state['migrated']:return {'readyToApply':True,'contentSha256':'1'*64,'sourceDigest':'2'*64,'counts':{'employees':2}}
  result=proof()
  if state['external']:result['tablesSha256']='8'*64
  return result
 m.migration_command=migrate
 def public(port,values,readonly):
  trace.append(('public',readonly));assert m.HOLD.exists()==readonly
  if readonly:
   if mode=='health':raise m.Refused('synthetic unhealthy relational startup')
   if mode=='external':state['external']=True
   if mode=='sql-external':state['sqlExternal']=True
   if mode=='data-external':business.write_bytes(b'newer external business bytes')
  elif mode=='postcommit':raise m.Refused('synthetic postcommit network failure')
 m.public_check=public
 def replace(target,content):trace.append(('backup-tool',target.name));target.write_bytes(content)
 m.replace_tool_file=replace
 m.backup_state=lambda expected:{target:target.read_bytes() for target in tools}
 def full_backup():
  assert not state['lock'] and m.HOLD.exists();trace.append(('post-backup',))
  if mode=='backup':raise m.Refused('synthetic backup failure')
  return str(full/'post')
 m.full_daily_backup=full_backup;m.base.wait_health=lambda port:trace.append(('old-healthy',))
 try:result=m.transact(current,candidates,tools,new_tool,data,8080,'synthetic_db',71,{},timer,backup,str(full),lock,m.APP/'staged-migrate.js');error=None
 except m.Refused as failure:result=None;error=str(failure)
 assert (full/'KEEP').read_bytes()==b'complete backup' and wrapper.read_bytes()==b'unchanged wrapper' and timer=={'active':'active','enabled':'enabled'}
 assert all(row[2]==m.SERVICE for row in trace if row[0]=='systemctl')
 if mode in ('success','postcommit'):
  assert not m.HOLD.exists() and all((m.APP/name).read_bytes()==raw for name,raw in candidates.items())
  assert m.TOOL.read_bytes()==new_tool and state['active']=='active' and state['migrated']
  if mode=='success':assert result['status']=='MYSQL_RELATIONAL_OK' and result['storageModel']=='relational' and (backup/'MYSQL_RELATIONAL_OK').is_file()
  else:assert error and (backup/'COMMITTED_NEEDS_ATTENTION').is_file() and not any(row[0]=='old-healthy' for row in trace)
 elif mode in ('external','sql-external','data-external'):
  assert error and m.HOLD.exists() and state['active']=='inactive' and (backup/'ROLLBACK_NEEDS_ATTENTION').is_file()
  assert not any(row[0]=='old-healthy' for row in trace)
 else:
  assert error and not m.HOLD.exists() and state['active']=='active' and m.TOOL.read_bytes()==old_tool and m.TOOL_MANIFEST.read_bytes()==metadata
  assert any(row[0]=='old-healthy' for row in trace)
  for name,raw in current.items():
   if raw is None:assert not (m.APP/name).exists()
   else:assert (m.APP/name).read_bytes()==raw
 if mode=='data-external':assert business.read_bytes()==b'newer external business bytes'
 else:assert business.read_bytes()==b'frozen original data'
 print(json.dumps({'ok':True,'trace':trace,'error':error}))
`;

test('relational commit verifies data, new backup and timer before releasing writes', () => {
  const result = invoke("mode='success'\n" + transaction);
  assert.equal(result.ok, true);
  assert.ok(result.trace.findIndex(row => row[0] === 'post-backup') > result.trace.findIndex(row => row[0] === 'lock-release'));
  assert.equal(result.trace.at(-1)[0], 'public'); assert.equal(result.trace.at(-1)[1], false);
});

test('precommit failures restore old source and backup tool only when the database is provably frozen, retaining migrated tables and all backups', () => {
  for (const mode of ['partial', 'migration-empty', 'migration-lost-output', 'health', 'backup']) {
    assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
  }
});

test('unexplained relational, legacy-file or full-SQL changes fail closed with the maintenance gate and recovery material retained', () => {
  for (const mode of ['external', 'sql-external', 'data-external']) {
    assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
  }
});

test('an error after the final gate release never restores old code or old backup tools', () => {
  const result = invoke("mode='postcommit'\n" + transaction);
  assert.equal(result.ok, true); assert.match(result.error, /committed/);
});

const mainFixture = model + `
import contextlib,io,os,re,stat,types
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);tool=root/'repaired-tool';tool.mkdir();business=root/'original-business';business.mkdir()
 executing=pathlib.Path(m.__file__)
 for name in ('apply-mysql-relational.py','apply-approval-workflow.py','apply-leave-types-time.py','apply-organization-fix.py'):
  (tool/name).write_bytes((executing.parent/name).read_bytes())
 spec=importlib.util.spec_from_file_location('separate_repaired_relational',tool/executing.name)
 m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 assert pathlib.Path(m.base.__file__).parent==tool and pathlib.Path(m.base.primitives.__file__).parent==tool and pathlib.Path(m.helper.__file__).parent==tool
 if os.name!='posix':m.os=types.SimpleNamespace(**{**vars(os),'name':'posix','geteuid':lambda:0})
 sys.modules['grp']=types.SimpleNamespace(getgrnam=lambda name:types.SimpleNamespace(gr_gid=71))
 m.APP=root/'application';m.APP.mkdir();m.HOLD=root/'gate';data=root/'data';data.mkdir();m.helper.BACKUPS=root/'publication-backups'
 current={name:None if name in m.VARIANTS['attendance-delete'] else ('// old '+name+'\\n').encode() for name in m.CODE};current[m.HTML]=b'old offline architecture'
 candidate={name:('// new '+name+'\\n').encode() for name in m.CODE};candidate[m.HTML]=b'new offline architecture'
 document=manifest();document['backupTool']['afterSha256']=m.raw_hash(b'# reviewed public backup core\\n')
 for variant,model in document['variants'].items():
  for name,row in model['files'].items():
   row['beforeSha256']=None if name in m.VARIANTS[variant] else m.canonical_hash(current[name] or b'// existing module\\n')
   row['afterSha256']=m.canonical_hash(candidate[name])
   if name in m.PATCH_FILES:row['patches']=[{'old':'old '+name,'new':'new '+name}]
 for name in m.DOCS:
  target=business/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'public original-package documentation')
 for name,content in candidate.items():
  target=business/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
 old_publisher=b'raise RuntimeError("old business publisher must not execute")\\n';(business/'deploy/apply-mysql-relational.py').write_bytes(old_publisher)
 (business/m.BACKUP_SOURCE).write_bytes(b'# reviewed public backup core\\n')
 raw=(json.dumps(document)+'\\n').encode();(business/m.MANIFEST).write_bytes(raw)
 tools={m.TOOL:b'old private backup tool',m.TOOL_MANIFEST:b'old private installation metadata'};timer={'active':'active','enabled':'enabled'};trace=[]
 m.helper.runtime=lambda:(data,8080,'synthetic_db');m.service_environment=lambda:{};m.timer_state=lambda:dict(timer);m.capture_sources=lambda gid:dict(current);m.backup_state=lambda expected:dict(tools)
 m.base.publication_lock=lambda:contextlib.nullcontext()
 class Lock:
  def __init__(self,path):self.path=path
  def __enter__(self):trace.append(('lock-enter',str(self.path)));return self
  def __exit__(self,*args):trace.append(('lock-exit',str(self.path)))
 m.MaintenanceLock=Lock
 def run(args,**kwargs):
  assert args[0]=='node','host mutation was attempted';trace.append(('isolated-command',str(args[1])));return b''
 m.helper.run=run
 def verify(source,stage,values):
  assert source==business and values==candidate;m.stage_candidates(stage,values);trace.append(('preflight',))
  if mode=='preflight-fails':raise m.Refused('synthetic preflight refusal')
 m.verify_candidate_code=verify
 def migration(script,where,environment,action):
  assert action=='--check' and script.name=='migrate-mysql.js' and script.parent.parent!=m.APP and script.exists()
  trace.append(('read-only-migration-check',));return {'counts':{'employees':2},'sourceDigest':'2'*64}
 m.migration_command=migration
 full=root/'verified-daily';full.mkdir(mode=0o700);(full/'KEEP').write_bytes(b'complete daily backup');os.chmod(full/'KEEP',0o600)
 def backup():
  trace.append(('full-backup-verified',))
  if mode=='backup-fails':raise m.Refused('synthetic full backup refusal')
  return str(full)
 m.full_daily_backup=backup
 real_save=m.save_release
 def save(backup,current_arg,candidate_arg,tools_arg,source):
  assert source==business and current_arg==current and candidate_arg==candidate and tools_arg==tools
  assert re.match(r'\\d{4}-\\d{2}-\\d{2}-mysql-relational-\\d{6}-',backup.name)
  info=backup.stat();assert info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700
  trace.append(('save-release-before',str(backup)));real_save(backup,current_arg,candidate_arg,tools_arg,source)
  assert (backup/'reviewed-release/deploy/apply-mysql-relational.py').read_bytes()==old_publisher
  actual=backup/'publication-tool';audit=json.loads((actual/'manifest.json').read_text())
  assert set(audit['files'])=={'apply-mysql-relational.py','apply-approval-workflow.py','apply-leave-types-time.py','apply-organization-fix.py'}
  assert (actual/'apply-mysql-relational.py').read_bytes()==(tool/'apply-mysql-relational.py').read_bytes()!=old_publisher
  assert all(m.raw_hash((actual/name).read_bytes())==digest for name,digest in audit['files'].items())
  assert all(item.stat().st_uid==0 and stat.S_IMODE(item.stat().st_mode)==0o600 for item in backup.rglob('*') if item.is_file())
  trace.append(('save-release-after',str(backup)))
  if mode=='save-fails':raise m.Refused('synthetic save refusal')
 m.save_release=save
 def transaction(current_arg,candidate_arg,tools_arg,tool_candidate,where,port,database,gid,environment,timer_arg,backup,full_backup,lock,script):
  trace.append(('transact',str(backup)));assert current_arg==current and candidate_arg==candidate and tools_arg==tools and timer_arg==timer
  assert where==data and port==8080 and database=='synthetic_db' and gid==71 and full_backup==str(full)
  assert (backup/'previous-code'/m.AUTH).read_bytes()==current[m.AUTH] and script.exists() and not m.HOLD.exists()
  if mode=='transact-fails':raise m.Refused('synthetic transact refusal')
  return {'status':'MYSQL_RELATIONAL_OK','backup':str(backup),'serviceRestarted':True}
 m.transact=transaction
 flags=[] if mode=='default-check' else ['--check'] if mode=='check' else ['--apply'];output=io.StringIO();old_mask=os.umask(0o077)
 try:
  with contextlib.redirect_stdout(output):m.main(['--source',str(business),'--expected-release-sha256',m.raw_hash(raw),*flags])
  error=None;result=json.loads(output.getvalue())
 except m.Refused as failure:error=str(failure);result=None
 finally:os.umask(old_mask)
 assert (full/'KEEP').read_bytes()==b'complete daily backup' and not m.HOLD.exists()
 if mode in ('check','default-check'):
  assert not error and result['status']=='MYSQL_RELATIONAL_CHECK' and not result['serviceRestarted'] and not m.helper.BACKUPS.exists()
  assert not any(row[0] in ('full-backup-verified','save-release-before','transact') for row in trace)
 elif mode=='apply':
  assert not error and result['status']=='MYSQL_RELATIONAL_OK' and result['variant']=='attendance-delete'
  assert [row[0] for row in trace if row[0] in ('full-backup-verified','save-release-before','save-release-after','transact')]==['full-backup-verified','save-release-before','save-release-after','transact']
 else:
  assert error
  if mode in ('preflight-fails','backup-fails'):assert not m.helper.BACKUPS.exists()
  if mode in ('preflight-fails','backup-fails','save-fails'):assert not any(row[0]=='transact' for row in trace)
  if mode in ('save-fails','transact-fails'):assert list(m.helper.BACKUPS.glob('*/publication-tool/manifest.json'))
 print(json.dumps({'ok':True,'trace':trace,'error':error}))
`;

test('real main check and default mode read the separate business package without backup or transaction', () => {
  for (const mode of ['check', 'default-check']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + mainFixture).ok, true);
});

const rootFixture = {skip: typeof process.getuid !== 'function' || process.getuid() !== 0 ? 'POSIX root fixture runs in the protected-source CI step' : false};

test('real main apply uses datetime, creates a private release directory and audits the repaired tool separately from original business sources', rootFixture, () => {
  assert.equal(invoke("mode='apply'\n" + mainFixture).ok, true);
});

test('real main failures before publication retain the verified backup and never reach the stop/migrate transaction', rootFixture, () => {
  for (const mode of ['preflight-fails', 'backup-fails', 'save-fails', 'transact-fails']) {
    assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + mainFixture).ok, true);
  }
});

test('publication tool audit rejects foreign dependency locations, symbolic links and existing audit directories', {skip: process.platform === 'win32' ? 'POSIX source and directory safety run on Linux CI' : false}, () => {
  assert.deepEqual(invoke(`import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);backup=root/'backup';backup.mkdir(mode=0o700);original=m.helper.__file__
 m.helper.__file__=str(root/'private-config.json')
 try:m.audit_publication_tool(backup)
 except m.Refused:pass
 else:raise AssertionError('foreign dependency accepted')
 assert not (backup/'publication-tool').exists();m.helper.__file__=original
 target=root/'symlink-tool';target.mkdir()
 for name in ('apply-mysql-relational.py','apply-approval-workflow.py','apply-leave-types-time.py','apply-organization-fix.py'):
  (target/name).write_bytes((pathlib.Path(m.__file__).parent/name).read_bytes())
 spec=importlib.util.spec_from_file_location('symlink_audit_tool',target/'apply-mysql-relational.py');copy=importlib.util.module_from_spec(spec);spec.loader.exec_module(copy)
 helper=target/'apply-organization-fix.py';helper.unlink();helper.symlink_to(pathlib.Path(original).absolute())
 try:copy.audit_publication_tool(backup)
 except copy.Refused:pass
 else:raise AssertionError('linked dependency accepted')
 assert not (backup/'publication-tool').exists()
 (backup/'publication-tool').mkdir();(backup/'publication-tool/KEEP').write_bytes(b'foreign audit')
 try:m.audit_publication_tool(backup)
 except m.Refused:pass
 else:raise AssertionError('existing audit directory overwritten')
 assert (backup/'publication-tool/KEEP').read_bytes()==b'foreign audit'
print(json.dumps({'ok':True}))`), {ok: true});
});

test('relational publisher requires the reviewed manifest hash before host inspection', () => {
  for (const args of [[], ['--source', '.'], ['--source', '.', '--expected-release-sha256', 'bad'], ['--source', '.', '--expected-release-sha256', 'a'.repeat(64), '--check', '--apply']]) {
    const result = spawnSync(python, [script, ...args], {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error); assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /Traceback|systemctl/);
  }
});
