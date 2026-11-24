'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/apply-ai-reporting.py');
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('ai_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'));exec(v['code'])
`;
const temporary = path.resolve(__dirname, '../.delivery/ai-reporting-deploy-tests');
fs.mkdirSync(temporary, {recursive: true});
function invoke(code) {
  const result = spawnSync(python, ['-c', bridge, script], {
    input: JSON.stringify({code}), encoding: 'utf8', timeout: 20000,
    env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const model = `import copy,pathlib,tempfile
def manifest():
 rows={}
 for name in m.CODE:
  row={'beforeSha256':None if name in m.NEW else 'a'*64,'afterSha256':'a'*64 if name in m.PRESERVE_FILES else 'b'*64}
  if name in m.PATCH_FILES:row['patches']=[{'old':'old '+name,'new':'new '+name}]
  rows[name]=row
 return {'schemaVersion':1,'relationalBaselineSha256':m.RELATIONAL_SHA256,'backupToolSha256':'c'*64,'files':rows}
def proof():
 return {'initialized':True,'model':'relational','schemaVersion':1,'revision':7,'contentSha256':'1'*64,'sourceDigest':'2'*64,'tablesSha256':'3'*64,'tables':['t%02d'%i for i in range(24)],'tableCounts':{'t%02d'%i:1 for i in range(24)}}
`;

test('AI manifest fixes nine code paths, three new modules and an immutable relational prerequisite', () => {
  assert.deepEqual(invoke(model + `
valid=manifest();assert len(m.CODE)==9 and len(m.NEW)==3 and m.validate_release(valid)==valid
bad=[]
for target in ['../../etc/shadow','server/config.json','server/data/ai-settings.json',m.HTML]:
 value=copy.deepcopy(valid);value['files'][target]=value['files'].pop(m.NEW[0]);bad.append(value)
value=copy.deepcopy(valid);value['relationalBaselineSha256']='0'*64;bad.append(value)
value=copy.deepcopy(valid);value['backupToolSha256']='invalid';bad.append(value)
value=copy.deepcopy(valid);value['files'][m.NEW[0]]['beforeSha256']='a'*64;bad.append(value)
value=copy.deepcopy(valid);value['files'][m.AUTH]['afterSha256']='b'*64;bad.append(value)
value=copy.deepcopy(valid);value['files'][m.SERVER]['afterSha256']='A'*64;bad.append(value)
for patches in [[],[{'old':'same','new':'same'}],[{'old':'x','new':'y'},{'old':'x','new':'z'}],[{'old':'x','new':'y','path':'/etc/shadow'}]]:
 value=copy.deepcopy(valid);value['files'][m.SERVER]['patches']=patches;bad.append(value)
for value in bad:
 try:m.validate_release(value)
 except m.Refused:pass
 else:raise AssertionError('unsafe manifest accepted')
value=copy.deepcopy(valid);value['files'][m.SERVER]['afterSha256']='a'*64;value['files'][m.SERVER]['patches']=[];m.validate_release(value)
print(json.dumps({'ok':True}))`), {ok: true});
});

test('a fixed raw digest and unique JSON properties are required before interpreting release entries', () => {
  assert.deepEqual(invoke(model + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);target=root/m.MANIFEST;target.parent.mkdir();raw=(json.dumps(manifest())+'\\n').encode();target.write_bytes(raw)
 assert m.load_release(root,m.raw_hash(raw))==manifest()
 for value,digest in [(raw,'0'*64),(b'{"schemaVersion":1,"schemaVersion":1}',None),(b'not json',None)]:
  target.write_bytes(value)
  try:m.load_release(root,digest or m.raw_hash(value))
  except m.Refused:pass
  else:raise AssertionError('unreviewed manifest accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('AI preflight accepts only a ready relational service and invokes read-only verification, never migration', () => {
  assert.deepEqual(invoke(model + `
calls=[]
m.rel.status=lambda port,readonly:calls.append(('status',port,readonly))
def verify(script,data,environment,mode):
 assert mode=='--verify';calls.append(('verify',mode));return proof()
m.rel.migration_command=verify
assert m.relational_prerequisite(8080,None,{})==m.rel.relation_proof(proof())
assert calls==[('status',8080,False),('verify','--verify')]
def refuse(*args):raise m.Refused('snapshot or uninitialized')
m.rel.status=refuse
try:m.relational_prerequisite(8080,None,{})
except m.Refused as error:assert 'does not migrate' in str(error) and 'first' in str(error)
else:raise AssertionError('unmigrated service accepted')
assert len(calls)==2
m.rel.status=lambda *args:None;m.rel.migration_command=lambda *args:dict(proof(),initialized=False)
try:m.relational_prerequisite(8080,None,{})
except m.Refused:pass
else:raise AssertionError('uninitialized tables accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('AI baseline is tied to the fixed relational package and already installed backup core', () => {
  assert.deepEqual(invoke(model + `
root=pathlib.Path(m.__file__).parent.parent;old=m.rel.load_manifest(root,m.RELATIONAL_SHA256);document=manifest()
document['backupToolSha256']=old['backupTool']['afterSha256']
for name,row in old['variants']['attendance-delete']['files'].items():
 if name in document['files']:document['files'][name]['beforeSha256']=row['afterSha256']
assert set(m.baseline_sources(root,document))==set(m.rel.CODE)
for field in ['backupToolSha256','files']:
 changed=copy.deepcopy(document)
 if field=='files':changed['files'][m.SERVER]['beforeSha256']='f'*64
 else:changed[field]='f'*64
 try:m.baseline_sources(root,changed)
 except m.Refused:pass
 else:raise AssertionError('different relational or backup baseline accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('candidate staging preserves installed authentication, applies exact patches and strips production HR settings from synthetic tests', () => {
  assert.deepEqual(invoke(model + `
import os
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);source=root/'source';source.mkdir();stage=root/'stage';stage.mkdir();document=manifest();current={}
 for name,row in document['files'].items():
  old=('old '+name+'\\n').encode();new=('new '+name+'\\n').encode()
  current[name]=None if name in m.NEW else old
  row['beforeSha256']=None if name in m.NEW else m.canonical_hash(old)
  row['afterSha256']=m.canonical_hash(old if name in m.PRESERVE_FILES else new)
  if name not in m.PRESERVE_FILES and name not in m.PATCH_FILES:
   target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(new)
 current[m.HTML]=b'old architecture'
 for name in (*m.DOCS,*m.TESTS,'scripts/generate-architecture.cjs',m.HTML):
  target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'public fixture')
 calls=[];m.helper.run=lambda args,**kwargs:calls.append((list(map(str,args)),kwargs)) or b''
 os.environ['HR_AI_API_KEY']='synthetic-secret';os.environ['HR_MYSQL_PASSWORD']='synthetic-secret'
 support={name:b'public production dependency' for name in m.TEST_DEPENDENCIES}
 candidate=m.freeze_release(source,stage,current,document,support)
 assert candidate[m.AUTH]==current[m.AUTH] and not (source/m.AUTH).exists()
 assert candidate[m.SERVER]==b'new server/server.js\\n'
 assert all((stage/name).read_bytes()==content for name,content in support.items()) and not any(name in candidate for name in support)
 tested=[row for row in calls if '--test' in row[0]];assert len(tested)==3
 for args,options in tested:
  env=options['env'];assert 'HR_AI_API_KEY' not in env and 'HR_MYSQL_PASSWORD' not in env
  assert env['HR_AI_REPORTING_MODULE']==str(stage/m.NEW[0]) and env['HR_AI_PROVIDER_MODULE']==str(stage/m.NEW[1]) and env['HR_AI_SERVICE_MODULE']==str(stage/m.NEW[2])
 assert calls[-1][0][-1]=='--check' and not any('systemctl' in args for args,options in calls)
print(json.dumps({'ok':True}))`), {ok: true});
});

test('source preflight refuses missing migration files, unexpected hashes and already present AI modules before publication', () => {
  assert.deepEqual(invoke(model + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();baseline={}
 for name in set((*m.EXISTING,*m.rel.CODE,m.HTML)):
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(('reviewed '+name).encode())
  if name in m.rel.CODE:baseline[name]=m.canonical_hash(target.read_bytes())
 m.protected_source=lambda *args,**kwargs:None
 current=m.capture_current(71,baseline);assert set(current)==set(m.FILES) and all(current[name] is None for name in m.NEW)
 target=m.APP/m.rel.SQL_MODULES[0];original=target.read_bytes();target.write_bytes(b'unknown relational module')
 try:m.capture_current(71,baseline)
 except m.Refused:pass
 else:raise AssertionError('unreviewed relation module accepted')
 target.write_bytes(original);target=m.APP/m.NEW[0];target.write_bytes(b'existing AI module')
 try:m.capture_current(71,baseline)
 except m.Refused:pass
 else:raise AssertionError('existing AI module accepted')
 target.unlink();(m.APP/m.rel.SQL_MODULES[0]).unlink()
 try:m.capture_current(71,baseline)
 except m.Refused:pass
 else:raise AssertionError('missing migration module accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('public verification never authenticates, calls a live model or exposes AI configuration', () => {
  assert.deepEqual(invoke(`
calls=[];candidates={name:('public '+name).encode() for name in (*m.FRONTEND,m.HTML)};gate=False
m.rel.status=lambda port,readonly:calls.append(('status',readonly))
def get(origin,route):
 calls.append(('GET',route))
 return (200,candidates[route[1:]]) if route[1:] in m.FRONTEND else (404,b'')
m.helper.get=get
def api(port,method,route):
 calls.append((method,route));return 503 if gate and method=='POST' else 401
m.base.api_status=api
for readonly in [True,False]:
 gate=readonly;m.public_check(8080,candidates,readonly)
assert ('GET','/server/config.json') in calls and ('GET','/server/data/ai-settings.json') in calls
assert ('GET','/'+m.urllib.parse.quote(m.HTML)) in calls
assert all(len(row)==2 for row in calls)
print(json.dumps({'ok':True}))`), {ok: true});
});

const transaction = model + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();data=root/'data';data.mkdir();backup=root/'recovery';backup.mkdir();full=root/'daily';full.mkdir();(full/'KEEP').write_bytes(b'complete daily backup')
 business=data/'synthetic.json';business.write_bytes(b'original business');config=m.APP/'server/config.json';config.parent.mkdir();config.write_bytes(b'original private config')
 m.rel.HOLD=root/'ai.hold';m.rel.APP=m.APP
 current={name:None if name in m.NEW else ('old '+name).encode() for name in m.FILES};candidates={name:(current[name] if name in m.PRESERVE_FILES else ('new '+name).encode()) for name in m.FILES}
 for name,content in current.items():
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True)
  if content is not None:target.write_bytes(content)
 tools={'managed':b'unchanged backup tool and units'};timer={'active':'active','enabled':'enabled'};trace=[];state={'active':'active','sql':'4'*64,'install':0,'failed':False}
 m.timer_state=lambda:dict(timer);m.rel.backup_state=lambda digest:dict(tools);m.protected_source=lambda *args,**kwargs:None
 m.base.sync_parent=lambda *args:None
 m.data_hashes=lambda where:{'runtime':m.helper.digest(business),'privateConfig':m.helper.digest(config)}
 m.rel.stable_sql_digest=lambda *args:state['sql']
 def relation(script,where,environment,action):
  assert action=='--verify';trace.append(('sql-verify',action));return proof()
 m.rel.migration_command=relation
 def run(args,**kwargs):
  trace.append(tuple(str(arg) for arg in args))
  if args[:2]==['systemctl','stop']:state['active']='inactive'
  if args[:2]==['systemctl','start']:state['active']='active'
  return b''
 m.helper.run=run;m.helper.system_value=lambda name:m.OWNER if name=='User' else state['active']
 def hold(gid):
  m.rel.HOLD.write_bytes(b'owned gate');return {'content':b'owned gate','identity':(m.rel.HOLD.stat().st_dev,m.rel.HOLD.stat().st_ino),'gid':gid}
 def clear(value):
  assert m.rel.HOLD.read_bytes()==value['content'];m.rel.HOLD.unlink();trace.append(('gate-clear',))
 m.rel.create_hold=hold;m.rel.clear_hold=clear
 def create(target,content,gid,on_created=None):
  assert not target.exists();target.write_bytes(content)
  if on_created:on_created((target.stat().st_dev,target.stat().st_ino))
 def remove(target,content,gid,identity):
  assert target.read_bytes()==content and (target.stat().st_dev,target.stat().st_ino)==identity
  target.unlink()
 m.base.install_new=create;m.base.remove_new=remove
 def install(target,content,gid):
  target.write_bytes(content);state['install']+=1;trace.append(('install',str(target)))
  if mode=='partial' and state['install']==2 and not state['failed']:
   state['failed']=True;raise m.Refused('synthetic partial install')
 m.atomic_install=install
 def public(port,values,readonly):
  trace.append(('public',readonly));assert m.rel.HOLD.exists()==readonly
  if readonly and mode in ('health','runtime','sql','private-config','foreign-source','foreign-new','foreign-gate'):
   if mode=='runtime':business.write_bytes(b'newer business data')
   elif mode=='sql':state['sql']='9'*64
   elif mode=='private-config':config.write_bytes(b'newer private key settings')
   elif mode=='foreign-source':(m.APP/m.SERVER).write_bytes(b'foreign maintained source')
   elif mode=='foreign-new':(m.APP/m.NEW[0]).write_bytes(b'foreign maintained module')
   elif mode=='foreign-gate':m.rel.HOLD.write_bytes(b'foreign gate')
   if mode in ('health','foreign-source','foreign-new','foreign-gate'):raise m.Refused('synthetic public check failure')
  elif not readonly and mode=='postcommit':
   state['sql']='9'*64;business.write_bytes(b'newer business data');config.write_bytes(b'newer private key settings');raise m.Refused('synthetic final connection failure')
 m.public_check=public;m.rel.status=lambda port,readonly:trace.append(('restored-healthy',readonly))
 try:result=m.publish(current,candidates,data,8080,'synthetic_db',71,{},timer,tools,'c'*64,backup,str(full));error=None
 except m.Refused as failure:result=None;error=str(failure)
 assert (full/'KEEP').read_bytes()==b'complete daily backup' and tools=={'managed':b'unchanged backup tool and units'} and timer=={'active':'active','enabled':'enabled'}
 assert all(row[2]==m.SERVICE for row in trace if row[0]=='systemctl')
 assert not any('--apply' in row or 'mysql' in row or 'mysqldump' in row for row in trace)
 if mode=='success':
  assert result['status']=='AI_REPORTING_OK' and not result['privateConfigurationWritten'] and not result['modelConnectionTested'] and not result['businessDataWritten']
  assert state['active']=='active' and not m.rel.HOLD.exists() and (backup/'integrity-proof.json').exists() and (backup/'AI_REPORTING_OK').exists()
  assert all((m.APP/name).read_bytes()==content for name,content in candidates.items())
 elif mode in ('foreign-source','foreign-new','foreign-gate'):
  assert error and (backup/'ROLLBACK_NEEDS_ATTENTION').exists() and state['active']=='inactive' and m.rel.HOLD.exists()
  if mode=='foreign-source':assert (m.APP/m.SERVER).read_bytes()==b'foreign maintained source'
  if mode=='foreign-new':assert (m.APP/m.NEW[0]).read_bytes()==b'foreign maintained module'
  if mode=='foreign-gate':assert m.rel.HOLD.read_bytes()==b'foreign gate'
 else:
  assert error and state['active']=='active' and not m.rel.HOLD.exists() and ('restored-healthy',False) in trace
  for name,content in current.items():
   if content is None:assert not (m.APP/name).exists()
   else:assert (m.APP/name).read_bytes()==content
 assert business.read_bytes()==(b'newer business data' if mode in ('runtime','postcommit') else b'original business')
 assert config.read_bytes()==(b'newer private key settings' if mode in ('private-config','postcommit') else b'original private config')
 assert state['sql']==('9'*64 if mode in ('sql','postcommit') else '4'*64)
 print(json.dumps({'ok':True,'trace':trace,'error':error}))
`;

test('publication freezes and verifies relational data and full SQL before releasing writes, retaining the daily backup', () => {
  const result = invoke("mode='success'\n" + transaction);
  assert.equal(result.ok, true);
  assert.equal(result.trace.at(-1)[0], 'public'); assert.equal(result.trace.at(-1)[1], false);
  assert.ok(result.trace.findIndex(row => row[0] === 'gate-clear') > result.trace.findIndex(row => row[0] === 'public' && row[1]));
});

test('partial installation or failed health checks restore only code, retaining original runtime and MySQL data', () => {
  for (const mode of ['partial', 'health']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
});

test('unexpected runtime, private settings or SQL updates are preserved through code rollback, including after gate release', () => {
  for (const mode of ['runtime', 'sql', 'private-config', 'postcommit']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
});

test('rollback preserves foreign source, module or maintenance-gate changes and stops for administrator review', () => {
  for (const mode of ['foreign-source', 'foreign-new', 'foreign-gate']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
});

test('new source installation is root-owned and cannot overwrite or delete a foreign module', {skip: process.platform === 'win32' ? 'POSIX ownership and directory fsync run on Linux CI' : false}, () => {
  assert.deepEqual(invoke(`
import pathlib,tempfile,stat
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);target=root/'ai-service.js';owners=[];m.base.os.fchown=lambda fd,uid,gid:owners.append((uid,gid))
 identities=[];m.base.install_new(target,b'public module',71,on_created=identities.append)
 assert owners==[(0,71)] and stat.S_IMODE(target.stat().st_mode)==0o640 and target.stat().st_nlink==1
 try:m.base.install_new(target,b'foreign replacement',71)
 except m.Refused:pass
 else:raise AssertionError('existing source overwritten')
 assert target.read_bytes()==b'public module'
 m.base.protected_source=lambda *args:None
 try:m.base.remove_new(target,b'public module',71,(-1,-1))
 except m.Refused:pass
 else:raise AssertionError('foreign identity removed')
 target.write_bytes(b'newer source')
 try:m.base.remove_new(target,b'public module',71,identities[0])
 except m.Refused:pass
 else:raise AssertionError('foreign content removed')
 assert target.read_bytes()==b'newer source'
print(json.dumps({'ok':True}))`), {ok: true});
});

test('AI publisher requires the fixed release hash and explicit apply mode before host inspection', () => {
  for (const args of [[], ['--source', '.'], ['--source', '.', '--expected-release-sha256', 'bad'], ['--source', '.', '--expected-release-sha256', 'a'.repeat(64), '--check', '--apply']]) {
    const result = spawnSync(python, [script, ...args], {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error); assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /Traceback|systemctl/);
  }
});
