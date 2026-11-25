'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/apply-resume-text.py');
const temporary = path.resolve(__dirname, '../.delivery/resume-text-deploy-tests');
fs.mkdirSync(temporary, {recursive: true});
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('resume_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'));exec(v['code'])
`;
function invoke(code) {
  const result = spawnSync(python, ['-c', bridge, script], {
    input: JSON.stringify({code}), encoding: 'utf8', timeout: 20000,
    env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const model = `import copy,pathlib,tempfile,os,stat
def manifest():
 return {'schemaVersion':1,'files':{name:{'beforeSha256':'a'*64,'afterSha256':'b'*64} for name in m.FRONTEND},'architectureSha256':'c'*64}
`;

test('resume manifest admits only two fixed frontend paths and fixes the raw offline HTML digest', () => {
  assert.deepEqual(invoke(model + String.raw`
valid=manifest();assert m.validate_release(valid)==valid and len(m.FILES)==3
bad=[]
for target in ['server/server.js','server/config.json','server/data/ai-settings.json','../js/employees.js',m.HTML]:
 value=copy.deepcopy(valid);value['files'][target]=value['files'].pop(m.FRONTEND[0]);bad.append(value)
for key,value in [('schemaVersion',True),('architectureSha256','C'*64),('architectureSha256',None)]:
 changed=copy.deepcopy(valid);changed[key]=value;bad.append(changed)
for row in [{'beforeSha256':None,'afterSha256':'b'*64},{'beforeSha256':'a'*64,'afterSha256':'a'*64},{'beforeSha256':'a'*64,'afterSha256':'B'*64},{'beforeSha256':'a'*64,'afterSha256':'b'*64,'patches':[]}]:
 changed=copy.deepcopy(valid);changed['files'][m.FRONTEND[0]]=row;bad.append(changed)
value=copy.deepcopy(valid);value['restart']=True;bad.append(value)
for value in bad:
 try:m.validate_release(value)
 except m.Refused:pass
 else:raise AssertionError('unsafe manifest accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('raw manifest digest, unique JSON properties and canonical before digests are checked', () => {
  assert.deepEqual(invoke(model + String.raw`
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);target=root/m.MANIFEST;target.parent.mkdir();raw=(json.dumps(manifest())+'\n').encode();target.write_bytes(raw)
 assert m.load_release(root,m.raw_hash(raw))==manifest()
 for value,digest in [(raw,'0'*64),(raw+b' ',m.raw_hash(raw)),(b'{"schemaVersion":1,"schemaVersion":1}',None),(b'not json',None)]:
  target.write_bytes(value)
  try:m.load_release(root,digest or m.raw_hash(value))
  except m.Refused:pass
  else:raise AssertionError('unreviewed manifest accepted')
assert m.canonical_hash(b'var a=1;\r\n  ')==m.raw_hash(b'var a=1;\n')
for raw in [b'a\0b',b'a\rb',b'\xff']:
 try:m.canonical_hash(raw)
 except (m.Refused,UnicodeDecodeError):pass
 else:raise AssertionError('bad public encoding accepted')
assert m.raw_hash(pathlib.Path(m.helper.__file__).read_bytes())==m.HELPER_SHA256
assert m.raw_hash((pathlib.Path(m.__file__).parent.parent/m.GENERATOR).read_bytes())==m.GENERATOR_SHA256
print(json.dumps({'ok':True}))`), {ok: true});
});

test('staging pins exact candidate bytes, checks both JS files and keeps HR environment out of public checks', () => {
  assert.deepEqual(invoke(model + String.raw`
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);source=root/'source';source.mkdir();document=manifest();payload={name:('candidate '+name+'\n').encode() for name in m.FILES}
 for name,content in payload.items():
  target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
  if name in m.FRONTEND:document['files'][name]['afterSha256']=m.raw_hash(content)
  else:document['architectureSha256']=m.raw_hash(content)
 for name in (*m.DOCS,m.GENERATOR):
  target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'public documentation')
 m.GENERATOR_SHA256=m.raw_hash((source/m.GENERATOR).read_bytes())
 calls=[];m.helper.run=lambda args,**kwargs:calls.append((list(map(str,args)),kwargs)) or b''
 def run_generator(args,**kwargs):
  calls.append((list(map(str,args)),kwargs));return m.types.SimpleNamespace(returncode=0)
 m.subprocess.run=run_generator
 os.environ['HR_AI_API_KEY']='synthetic-secret';os.environ['HR_DATA_DIR']='synthetic-data';stage=root/'stage';stage.mkdir()
 candidates,docs=m.freeze_release(source,stage,document)
 assert candidates==payload and set(docs)==set(m.DOCS)
 assert [row[0][1] for row in calls]==['--check','--check','-']
 for args,options in calls:assert not any(key.startswith('HR_') for key in options['env'])
 assert calls[-1][0]==['node','-','--check'] and calls[-1][1]['cwd']==source/'scripts'
 assert calls[-1][1]['input']==b'public documentation' and m.raw_hash(calls[-1][1]['input'])==m.GENERATOR_SHA256
 assert calls[-1][1]['stdout']==m.subprocess.PIPE and calls[-1][1]['stderr']==m.subprocess.PIPE and calls[-1][1]['timeout']==300
 assert all((stage/name).read_bytes()==raw for name,raw in payload.items())
 (source/m.FRONTEND[0]).write_bytes(payload[m.FRONTEND[0]]+b' ');stage=root/'bad';stage.mkdir()
 try:m.freeze_release(source,stage,document)
 except m.Refused:pass
 else:raise AssertionError('raw candidate drift accepted')
 assert len(calls)==3
 (source/m.FRONTEND[0]).write_bytes(payload[m.FRONTEND[0]]);(source/m.GENERATOR).write_bytes(b'foreign executable');stage=root/'unsafe';stage.mkdir()
 try:m.freeze_release(source,stage,document)
 except m.Refused:pass
 else:raise AssertionError('unpinned root-run generator accepted')
 assert len(calls)==3
 (source/m.GENERATOR).write_bytes(b'public documentation');stage=root/'failed-check';stage.mkdir()
 m.subprocess.run=lambda *args,**kwargs:m.types.SimpleNamespace(returncode=1,stderr=b'synthetic private diagnostic')
 try:m.freeze_release(source,stage,document)
 except m.Refused as error:assert str(error)=='Architecture documentation check failed'
 else:raise AssertionError('failed architecture verification accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('public verification checks exact JS bytes while the installed offline HTML retains the production 404 boundary', () => {
  assert.deepEqual(invoke(`
calls=[];values={name:('public '+name).encode() for name in m.FILES};storage={'backend':'mysql','model':'relational','readOnly':False};wrong=False
def get(origin,route):
 assert origin==m.ORIGIN;calls.append(route)
 if route=='/api/auth/status':return 200,json.dumps({'ok':True,'setupRequired':False,'storage':storage}).encode()
 name=m.urllib.parse.unquote(route[1:])
 if name in m.FRONTEND:return 200,b'wrong bytes' if wrong else values[name]
 if name==m.HTML:return (200,values[name]) if exposed else (404,b'Not Found')
 return 401,b'{}'
m.helper.get=get;exposed=False;m.public_check(values)
assert len(calls)==8 and '/'+m.urllib.parse.quote(m.HTML) in calls
assert not any('/api/ai/chat' in route or '/api/auth/login' in route for route in calls)
for mode in ['readonly','snapshot','bytes','html-exposed']:
 storage={'backend':'mysql','model':'relational','readOnly':mode=='readonly'}
 if mode=='snapshot':storage['model']='snapshot'
 wrong=mode=='bytes'
 exposed=mode=='html-exposed'
 try:m.public_check(values)
 except m.Refused:pass
 else:raise AssertionError('incorrect production health, JS bytes or HTML whitelist accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('full backup validates the installed command receipts and refuses outside paths or failed verification', () => {
  assert.deepEqual(invoke(`
location='/var/backups/hr-system/daily/2026-11-25_15-30-00+0800-123456abcdef';calls=[]
def run(args,**kwargs):
 calls.append(list(map(str,args)))
 return json.dumps({'status':'DAILY_BACKUP_OK' if '--run' in args else 'DAILY_BACKUP_VERIFIED','backup':location}).encode()
m.helper.run=run;assert m.full_daily_backup()==location
assert calls==[[str(m.COMMAND),'--run'],[str(m.COMMAND),'--verify',location]]
for bad in ['/root/private-backup','/var/backups/hr-system/daily/../../etc/shadow','/var/backups/hr-system/daily/not-a-timestamp']:
 location=bad
 try:m.full_daily_backup()
 except m.Refused:pass
 else:raise AssertionError('unsafe backup receipt accepted')
location='/var/backups/hr-system/daily/2026-11-25_15-30-00+0800-123456abcdef'
m.helper.run=lambda *args,**kwargs:json.dumps({'status':'DAILY_BACKUP_OK','backup':location}).encode()
try:m.full_daily_backup()
except m.Refused:pass
else:raise AssertionError('unverified backup accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

const transaction = `import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();backup=root/'recovery';backup.mkdir();daily=root/'daily';daily.mkdir();(daily/'KEEP').write_bytes(b'verified full backup')
 current={name:('old '+name).encode() for name in m.FILES};candidates={name:('new '+name).encode() for name in m.FILES}
 for name,content in current.items():
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
 private=m.APP/'server/config.json';private.parent.mkdir();private.write_bytes(b'existing configuration');data=m.APP/'server/data';data.mkdir();business=data/'personnel.json';business.write_bytes(b'existing business');ai=data/'ai-settings.json';ai.write_bytes(b'existing AI settings and key')
 trace=[];state={'pid':'123','timer':'unchanged','install':0,'failed':False}
 m.protected_source=lambda *args,**kwargs:None;m.timer_state=lambda:state['timer'];m.process_state=lambda:state['pid']
 def forbidden(*args,**kwargs):raise AssertionError('private runtime helper called')
 m.helper.runtime=forbidden;m.helper.mysql_snapshot=forbidden;m.helper.protected_hashes=forbidden
 m.helper.run=lambda args,**kwargs:trace.append(tuple(map(str,args))) or b''
 def install(target,content,gid,expected):
  assert target.read_bytes()==expected;target.write_bytes(content);state['install']+=1
  if mode=='partial' and state['install']==2 and not state['failed']:
   state['failed']=True;raise m.Refused('synthetic failure after replacement')
 m.atomic_install=install
 def verify(values):
  trace.append(('verify',))
  assert all((m.APP/name).read_bytes()==content for name,content in values.items())
  if mode=='foreign':(m.APP/m.FRONTEND[0]).write_bytes(b'newer maintained public source')
  if mode=='business':business.write_bytes(b'newer ordinary business data');ai.write_bytes(b'newer AI settings')
  if mode=='pid':state['pid']='456'
  if mode=='timer':state['timer']='newer installation'
  if mode in ('health','foreign','business'):raise m.Refused('synthetic public check failure')
 m.public_check=verify
 try:result=m.publish(current,candidates,71,'123','unchanged',backup,str(daily));error=None
 except m.Refused as failure:result=None;error=str(failure)
 assert all(row[0]=='runuser' or row==('verify',) for row in trace)
 assert private.read_bytes()==b'existing configuration' and (daily/'KEEP').read_bytes()==b'verified full backup'
 if mode=='success':
  assert result['status']=='RESUME_TEXT_OK' and result['serviceRestarted'] is False and result['sourceProtected'] is True
  assert result['installedFiles']==list(m.FILES) and result['businessDataWritten'] is False and result['privateConfigurationWritten'] is False
  assert (backup/'RESUME_TEXT_OK').is_file() and all((m.APP/name).read_bytes()==content for name,content in candidates.items())
 else:
  assert result is None and error
  for name,content in current.items():
   assert (m.APP/name).read_bytes()==(b'newer maintained public source' if mode=='foreign' and name==m.FRONTEND[0] else content)
  assert (backup/'ROLLBACK_NEEDS_ATTENTION').exists()==(mode=='foreign')
 assert business.read_bytes()==(b'newer ordinary business data' if mode=='business' else b'existing business')
 assert ai.read_bytes()==(b'newer AI settings' if mode=='business' else b'existing AI settings and key')
 print(json.dumps({'ok':True}))
`;
for (const mode of ['success', 'partial', 'health', 'foreign', 'business', 'pid', 'timer']) {
  test(`static resume publication ${mode} preserves business data, AI settings, daily backups and service state`, () => {
    assert.deepEqual(invoke(`mode=${JSON.stringify(mode)}\n` + transaction), {ok: true});
  });
}

test('production capture refuses a drifted frontend while keeping directory and file protection checks', () => {
  assert.deepEqual(invoke(model + String.raw`
with tempfile.TemporaryDirectory() as folder:
 m.APP=pathlib.Path(folder);document=manifest();checks=[]
 for name in m.FILES:
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(('before '+name+'\r\n').encode())
  if name in m.FRONTEND:document['files'][name]['beforeSha256']=m.canonical_hash(target.read_bytes())
 m.protected_source=lambda path,gid,**kw:checks.append((str(path),gid,kw.get('directory',False)))
 current=m.capture_current(71,document);assert set(current)==set(m.FILES) and len(checks)==5
 target=m.APP/m.FRONTEND[0];target.write_bytes(b'foreign maintained source')
 try:m.capture_current(71,document)
 except m.Refused:pass
 else:raise AssertionError('production baseline drift accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('real Linux atomic installation and rollback retain root ownership, 0750 directories and 0640 files', t => {
  const result = invoke(`
import os,pathlib,stat,tempfile
if os.name!='posix' or os.geteuid()!=0:print(json.dumps({'skipped':True}))
else:
 with tempfile.TemporaryDirectory() as folder:
  root=pathlib.Path(folder);os.chmod(root,0o750);target=root/'source.js';target.write_bytes(b'old');os.chmod(target,0o640);gid=os.getgid()
  original_fsync=m.os.fsync;flushed=[]
  def checked_fsync(descriptor):
   info=os.fstat(descriptor)
   if stat.S_ISREG(info.st_mode):
    assert info.st_uid==0 and info.st_gid==gid and stat.S_IMODE(info.st_mode)==0o640
    flushed.append('protected-file')
   else:flushed.append('directory')
   return original_fsync(descriptor)
  m.os.fsync=checked_fsync
  m.atomic_install(target,b'new',gid,b'old');m.protected_source(target,gid)
  assert flushed==['protected-file','directory']
  assert target.read_bytes()==b'new' and stat.S_IMODE(root.stat().st_mode)==0o750
  m.atomic_install(target,b'old',gid,b'new');m.protected_source(target,gid)
  assert target.read_bytes()==b'old'
  target.write_bytes(b'foreign')
  try:m.atomic_install(target,b'new',gid,b'old')
  except m.Refused:pass
  else:raise AssertionError('foreign source overwritten')
  assert target.read_bytes()==b'foreign' and not list(root.glob('.resume-text-*'))
  linked=root/'linked';os.link(target,linked)
  try:m.regular_file(target)
  except m.Refused:pass
  else:raise AssertionError('multi-link source accepted')
  linked.unlink();symbolic=root/'symlink';symbolic.symlink_to(target)
  try:m.regular_file(symbolic)
  except m.Refused:pass
  else:raise AssertionError('symlink source accepted')
 print(json.dumps({'ok':True}))`);
  if (result.skipped) t.skip('requires Linux root; synthetic transaction checks run on every platform');
  else assert.deepEqual(result, {ok: true});
});

test('CLI rejects missing or malformed reviewed hashes before any Linux production operation', () => {
  for (const args of [[], ['--source', '.'], ['--source', '.', '--expected-release-sha256', 'bad']]) {
    const result = spawnSync(python, [script, ...args], {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error); assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /Traceback|systemctl/);
  }
  const result = spawnSync(python, [script, '--help'], {encoding: 'utf8', timeout: 10000});
  assert.ifError(result.error); assert.equal(result.status, 0); assert.match(result.stdout, /without restarting/);
});
