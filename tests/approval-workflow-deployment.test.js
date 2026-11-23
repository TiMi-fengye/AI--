'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/apply-approval-workflow.py');
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('approval_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'))
exec(v['code'])
`;
function invoke(code) {
  const result = spawnSync(python, ['-c', bridge, script], {input: JSON.stringify({code}), encoding: 'utf8', timeout: 15000});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const fixture = `import copy,pathlib,tempfile,os
def model():
 current={};candidates={};entries={}
 for name in m.CODE:
  old=('/* production '+name+' */\\nconst value="old";\\n').encode()
  new=old.replace(b'"old"',b'"new"')
  current[name]=None if name in m.NEW else old
  candidates[name]=new
  entry={'beforeSha256':None if name in m.NEW else m.canonical_hash(old),'afterSha256':m.canonical_hash(new)}
  if name in m.PATCH_FILES:entry['patches']=[{'old':'const value="old";','new':'const value="new";'}]
  entries[name]=entry
 current[m.HTML]=b'old architecture';candidates[m.HTML]=b'new architecture'
 return current,candidates,{'schemaVersion':1,'files':entries}
`;

test('fixed manifest restricts all eleven code destinations and disallows runtime, missing, extra or ambiguous declarations', () => {
  const result = invoke(fixture + `
current,candidates,valid=model();assert m.validate_release(valid)==valid
variants=[]
for bad in ['../../etc/shadow','server/config.json','server/data/auth-users.json',m.HTML]:
 value=copy.deepcopy(valid);value['files'][bad]=value['files'].pop(m.NEW[0]);variants.append(value)
value=copy.deepcopy(valid);del value['files'][m.AUTH];variants.append(value)
value=copy.deepcopy(valid);value['files']['extra.js']=copy.deepcopy(value['files'][m.NEW[0]]);variants.append(value)
for name in [m.AUTH,m.NEW[0]]:
 for digest in ['bad',None,True,'A'*64]:
  value=copy.deepcopy(valid);value['files'][name]['afterSha256']=digest;variants.append(value)
value=copy.deepcopy(valid);value['files'][m.NEW[0]]['beforeSha256']='0'*64;variants.append(value)
value=copy.deepcopy(valid);value['files'][m.AUTH]['beforeSha256']=None;variants.append(value)
value=copy.deepcopy(valid);value['files'][m.FRONTEND[1]]['patches']=[];variants.append(value)
for patches in [[],[{'old':'','new':'x'}],[{'old':'x','new':'x'}],[{'old':'x','new':'y'},{'old':'x','new':'z'}],[{'old':'x\\0','new':'y'}]]:
 value=copy.deepcopy(valid);value['files'][m.AUTH]['patches']=patches;variants.append(value)
value=copy.deepcopy(valid);value['schemaVersion']=True;variants.append(value)
value=copy.deepcopy(valid);value['unexpected']=1;variants.append(value)
for value in variants:
 try:m.validate_release(value)
 except m.Refused:pass
 else:raise AssertionError('unsafe manifest accepted')
print(json.dumps({'ok':True,'refused':len(variants)}))`);
  assert.equal(result.ok, true); assert.ok(result.refused >= 20);
});

test('manifest byte hash and duplicate JSON properties are checked before host access', () => {
  const result = invoke(fixture + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);target=root/m.MANIFEST;target.parent.mkdir()
 _,_,document=model();raw=json.dumps(document).encode();target.write_bytes(raw)
 assert m.load_release(root,m.raw_hash(raw))==document
 for raw,expected in [(raw+b' ',m.raw_hash(raw)),(b'{"schemaVersion":1,"schemaVersion":1,"files":{}}',None),(b'not-json',None)]:
  target.write_bytes(raw)
  try:m.load_release(root,expected or m.raw_hash(raw))
  except m.Refused:pass
  else:raise AssertionError('unreviewed or duplicate manifest accepted')
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('production patches preserve unrelated account code and require exact baseline, unique anchors and reviewed result', () => {
  const result = invoke(fixture + `
current,candidates,document=model();entry=document['files'][m.AUTH]
assert m.patch_source(current[m.AUTH],entry)==candidates[m.AUTH]
assert m.patch_source(current[m.AUTH].replace(b'\\n',b'\\r\\n')+b'  ',entry)==candidates[m.AUTH]
for source,changes in [(current[m.AUTH],{'beforeSha256':'0'*64}),(current[m.AUTH],{'afterSha256':'0'*64}),(current[m.AUTH].replace(b'value',b'missing'),{}),(current[m.AUTH]+b'const value="old";',{}),(candidates[m.AUTH],{})]:
 item=copy.deepcopy(entry);item.update(changes)
 if source!=current[m.AUTH]:item['beforeSha256']=m.canonical_hash(source)
 try:m.patch_source(source,item)
 except m.Refused:pass
 else:raise AssertionError('unsafe production patch accepted')
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('new module absence checks preserve any existing file instead of silently replacing it', () => {
  const result = invoke(`import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 target=pathlib.Path(folder)/'approval-workflow.js';m.require_absent(target)
 target.write_bytes(b'existing module')
 try:m.require_absent(target)
 except m.Refused:pass
 else:raise AssertionError('existing module replacement accepted')
 assert target.read_bytes()==b'existing module'
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('candidate staging checks all source digests and runs isolated workflow tests without production HR settings', () => {
  const result = invoke(fixture + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);source=root/'release';source.mkdir();stage=root/'candidate';stage.mkdir()
 current,candidates,document=model()
 for name in (*m.CODE,m.HTML,*m.DOCS,m.TEST,'scripts/generate-architecture.cjs'):
  target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(candidates.get(name,b'public fixture'))
 calls=[];m.helper.run=lambda arguments,**kwargs:calls.append(([str(v) for v in arguments],kwargs)) or b''
 os.environ['HR_DATA_DIR']='/private/not-used';os.environ['HR_MYSQL_PASSWORD']='synthetic-not-a-real-secret'
 result=m.freeze_release(source,stage,current,document)
 assert result==candidates and len(result)==12
 test=[row for row in calls if '--test' in row[0]]
 assert len(test)==1 and test[0][1]['env']['HR_APPROVAL_AUTH_TEST_MODULE']==str(stage/m.AUTH)
 assert test[0][1]['env']['HR_APPROVAL_WORKFLOW_MODULE']==str(stage/m.NEW[0])
 assert test[0][1]['env']['HR_APPROVAL_NOTIFICATIONS_MODULE']==str(stage/m.NEW[1])
 assert set(key for key in test[0][1]['env'] if key.startswith('HR_'))=={'HR_APPROVAL_AUTH_TEST_MODULE','HR_APPROVAL_WORKFLOW_MODULE','HR_APPROVAL_NOTIFICATIONS_MODULE'}
 assert calls[-1][0][-1]=='--check' and calls[-1][0][1].endswith('generate-architecture.cjs')
 assert all('systemctl' not in row[0] and 'hr-system-backup' not in row[0] for row in calls)
 calls.clear();bad=copy.deepcopy(document);bad['files'][m.FRONTEND[1]]['afterSha256']='0'*64
 try:m.freeze_release(source,stage,current,bad)
 except m.Refused:pass
 else:raise AssertionError('wrong candidate source accepted')
 assert calls==[]
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('new modules publish atomically with root 0640 intent and never overwrite a raced-in file', {skip: process.platform === 'win32' ? 'POSIX root ownership and directory fsync are tested on Linux' : false}, () => {
  const result = invoke(`import pathlib,tempfile,stat
with tempfile.TemporaryDirectory() as folder:
 target=pathlib.Path(folder)/'module.js';owners=[];created=[]
 m.os.fchown=lambda fd,uid,gid:owners.append((uid,gid))
 m.install_new(target,b'candidate',71,on_created=created.append)
 assert target.read_bytes()==b'candidate' and stat.S_IMODE(target.stat().st_mode)==0o640 and owners==[(0,71)]
 assert created==[(target.stat().st_dev,target.stat().st_ino)]
 m.protected_source=lambda *args,**kwargs:None
 m.remove_new(target,b'candidate',71,created[0]);assert not target.exists()
 link=m.os.link
 def raced(source,destination):
  pathlib.Path(destination).write_bytes(b'unknown later file')
  return link(source,destination)
 m.os.link=raced
 try:m.install_new(target,b'wrong',71)
 except FileExistsError:pass
 else:raise AssertionError('raced-in file overwritten')
 assert target.read_bytes()==b'unknown later file' and sorted(p.name for p in target.parent.iterdir())==['module.js']
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

test('new module removal rejects changed content and changed inode, even if replacement bytes happen to match', () => {
  const result = invoke(`import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);target=root/'module.js';target.write_bytes(b'candidate')
 identity=(target.stat().st_dev,target.stat().st_ino);m.protected_source=lambda *args,**kwargs:None
 target.write_bytes(b'changed')
 try:m.remove_new(target,b'candidate',71,identity)
 except m.Refused:pass
 else:raise AssertionError('changed module removed')
 assert target.read_bytes()==b'changed'
 other=root/'replacement';other.write_bytes(b'candidate');other.replace(target)
 assert (target.stat().st_dev,target.stat().st_ino)!=identity
 try:m.remove_new(target,b'candidate',71,identity)
 except m.Refused:pass
 else:raise AssertionError('replacement module removed')
 assert target.read_bytes()==b'candidate'
print(json.dumps({'ok':True}))`);
  assert.deepEqual(result, {ok: true});
});

const publication = fixture + `
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();data=root/'data';data.mkdir();business=data/'synthetic.json';business.write_bytes(b'keep current data')
 backup=root/'backup';backup.mkdir();full=root/'full-backup';full.mkdir();(full/'KEEP').write_bytes(b'verified backup')
 current,candidates,_=model()
 for name,content in current.items():
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True)
  if content is not None:target.write_bytes(content)
 trace=[];state={'active':'active','installs':0,'failed':False};timer={'active':'active','enabled':'enabled'}
 m.sync_parent=lambda target:trace.append(('synced-parent',str(target.relative_to(m.APP))))
 m.timer_state=lambda:dict(timer)
 m.protected_source=lambda path,gid,**kwargs:trace.append(('protected',str(path.relative_to(m.APP)),gid))
 m.data_hashes=lambda location:{'synthetic':m.helper.digest(business)}
 m.helper.mysql_snapshot=lambda database:b'unchanged synthetic snapshot'
 m.helper.system_value=lambda name:state['active'] if name=='ActiveState' else ''
 def run(arguments,**kwargs):
  trace.append(tuple(str(v) for v in arguments))
  if arguments[:2]==['systemctl','stop']:state['active']='inactive'
  if arguments[:2]==['systemctl','start']:state['active']='active'
  return b''
 m.helper.run=run
 def install(target,content,gid):
  assert gid==71;trace.append(('install',str(target.relative_to(m.APP)),gid));target.write_bytes(content);state['installs']+=1
  if mode=='partial' and state['installs']==3 and not state['failed']:
   state['failed']=True;raise OSError('synthetic installation failure')
 def create(target,content,gid,on_created=None):
  if mode=='raced' and target.name=='approval-workflow.js':
   target.write_bytes(b'unknown later file');raise FileExistsError('synthetic race')
  install(target,content,gid)
  on_created((target.stat().st_dev,target.stat().st_ino))
 m.atomic_install=install;m.install_new=create
 def verify(*args):
  assert state['active']=='active';trace.append(('verify',))
  if mode=='health':raise m.Refused('synthetic unhealthy startup')
  if mode=='new-data':business.write_bytes(b'newer current data')
 m.helper.verify=verify
 m.helper.get=lambda base,route:(200,candidates[route[1:]]) if route[1:] in m.FRONTEND else (404,b'')
 m.api_status=lambda port,method,route:503 if mode=='api' else 401
 m.wait_health=lambda port:trace.append(('previous-code-healthy',))
 try:result=m.publish(current,candidates,data,8080,'synthetic_db',71,timer,backup,str(full));error=None
 except (m.Refused,OSError) as e:result=None;error=type(e).__name__
 assert business.read_bytes()==(b'newer current data' if mode=='new-data' else b'keep current data')
 assert (full/'KEEP').read_bytes()==b'verified backup' and timer=={'active':'active','enabled':'enabled'}
 assert state['active']=='active' and all(row[2]==m.SERVICE for row in trace if row[0]=='systemctl')
 if mode=='success':
  assert result['status']=='APPROVAL_WORKFLOW_OK' and len(result['installedFiles'])==12
  assert result['sourceProtected'] and result['dailyBackupTimerPreserved'] and not result['businessDataWritten']
  assert set(result['newFiles'])==set(m.NEW) and all((m.APP/name).read_bytes()==value for name,value in candidates.items())
  assert (backup/'APPROVAL_WORKFLOW_OK').is_file()
 else:
  assert error is not None and not (backup/'APPROVAL_WORKFLOW_OK').exists()
  assert all((m.APP/name).read_bytes()==current[name] for name in (*m.EXISTING,m.HTML))
  for name in m.NEW:
   target=m.APP/name
   if mode=='raced' and name==m.NEW[0]:assert target.read_bytes()==b'unknown later file'
   else:assert not target.exists()
  assert ('previous-code-healthy',) in trace
 print(json.dumps({'ok':True,'trace':trace}))
`;
test('workflow transaction installs all twelve protected files and verifies public routes without touching data or the daily timer', () => {
  const result = invoke("mode='success'\n" + publication);
  assert.equal(result.ok, true);
  assert.equal(result.trace.filter(x => x[0] === 'install').length, 12);
  assert.equal(result.trace.filter(x => x[0] === 'systemctl' && x[1] === 'stop').length, 1);
});

test('failed workflow publication restores old code, removes only this release new modules, and retains newer business writes', () => {
  for (const mode of ['partial', 'health', 'api', 'new-data', 'raced']) {
    assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + publication).ok, true);
  }
});

test('workflow publisher requires a fixed manifest hash and explicit apply selection before any host inspection', () => {
  for (const args of [[], ['--source', '.'], ['--source', '.', '--expected-release-sha256', 'bad'], ['--source', '.', '--expected-release-sha256', 'a'.repeat(64), '--check', '--apply']]) {
    const result = spawnSync(python, [script, ...args], {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error); assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /Traceback|systemctl/);
  }
  const help = spawnSync(python, [script, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0); assert.match(help.stdout, /--check/); assert.match(help.stdout, /--apply/);
});
