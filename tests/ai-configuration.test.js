'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/configure-deepseek.py');
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('private_configuration',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'));exec(v['code'])
`;
function invoke(code) {
  const temporary = path.resolve(__dirname, '../.delivery/ai-configuration-test-tmp');
  fs.mkdirSync(temporary, {recursive: true});
  const result = spawnSync(python, ['-c', bridge, script], {input: JSON.stringify({code}), encoding: 'utf8', timeout: 15000,
    env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test('credential entry refuses redirected stdin, echo fallback and malformed input without returning private exception text', () => {
  assert.deepEqual(invoke(`import io,warnings
class Terminal(io.StringIO):
 def isatty(self):return True
m.sys.stdin=io.StringIO('must never be consumed');calls=[]
m.getpass.getpass=lambda prompt:calls.append(prompt) or 'SYNTHETIC_ONLY'
try:m.read_key()
except m.Refused:pass
else:raise AssertionError('redirected credential input accepted')
assert calls==[] and m.sys.stdin.tell()==0
m.sys.stdin=Terminal()
def fallback(prompt):warnings.warn('SYNTHETIC_PRIVATE_TEXT',m.getpass.GetPassWarning);raise AssertionError('fallback continued')
m.getpass.getpass=fallback
try:m.read_key()
except m.getpass.GetPassWarning as error:assert m.public_error(error)=={'errorClass':'GetPassWarning'}
else:raise AssertionError('echo fallback accepted')
for value in ['', 'space key', 'line\\nbreak', 'nul\\0byte', 'x'*4097]:
 m.getpass.getpass=lambda prompt,value=value:value
 try:m.read_key()
 except m.Refused:pass
 else:raise AssertionError('malformed credential accepted')
m.getpass.getpass=lambda prompt:'SYNTHETIC_ONLY';assert m.read_key()=='SYNTHETIC_ONLY'
assert m.public_error(RuntimeError('SYNTHETIC_PRIVATE_TEXT'))=={'errorClass':'Error'}
print(json.dumps({'ok':True}))`), {ok: true});
});

test('exported Node request uses a fixed synthetic prompt and 32-token cap and status returns only public booleans', async () => {
  const {node} = invoke('print(json.dumps({"node":m.NODE}))');
  const sandbox = {require, module: {exports: {}}, process: {argv: []}};
  vm.runInNewContext(node, sandbox);
  const input = {mode: 'test', model: 'synthetic-model', key: 'SYNTHETIC_ONLY', employees: ['must not be sent']};
  let chats = 0;
  const api = {createAIProvider(options) {
    assert.equal(Object.keys(options.env).length, 0);
    if (input.mode === 'test') assert.deepEqual(JSON.parse(JSON.stringify(options.getSettings())), {
      enabled: true, endpoint: 'https://api.deepseek.com/chat/completions', model: input.model, apiKey: input.key
    });
    return {chat: async (messages, settings) => {
      chats++; assert.equal(messages.length, 1); assert.equal(messages[0].role, 'user');
      assert.match(messages[0].content, /不含业务数据/); assert.doesNotMatch(JSON.stringify(messages), /must not be sent|SYNTHETIC_ONLY/);
      assert.equal(settings.maxTokens, 32); return {text: 'SYNTHETIC_PRIVATE_RESPONSE'};
    }, status: () => ({enabled: true, configured: true, apiKeyConfigured: true, endpoint: 'https://api.deepseek.com/chat/completions', model: input.model, apiKey: input.key, unexpected: 'private'})};
  }, createPrivateSettingsStore: ({file}) => {assert.equal(file, '/synthetic/settings'); return {get: () => ({})};}};
  assert.deepEqual(JSON.parse(JSON.stringify(await sandbox.module.exports.run(input, api))), {connected: true});
  input.mode = 'status'; input.file = '/synthetic/settings';
  assert.deepEqual(JSON.parse(JSON.stringify(await sandbox.module.exports.run(input, api))), {
    enabled: true, configured: true, apiKeyConfigured: true, endpointMatches: true, modelMatches: true
  });
  assert.equal(chats, 1);
  await assert.rejects(sandbox.module.exports.run({mode: 'unknown'}, api));
});

test('Node subprocess receives credentials only on stdin and accepts only exact bounded public responses', () => {
  assert.deepEqual(invoke(`import os,subprocess
m.provider_messages=lambda:{'HIDDEN','fixed reviewed diagnostic'}
os.environ['HR_AI_API_KEY']='SYNTHETIC_PARENT_SECRET';os.environ['HR_MYSQL_PASSWORD']='SYNTHETIC_DATABASE_SECRET';os.environ['NODE_OPTIONS']='unreviewed-loader'
calls=[];reply=[0,b'{"connected":true}',b'SYNTHETIC_PRIVATE_STDERR']
def run(args,**options):calls.append((args,options));return subprocess.CompletedProcess(args,*reply)
m.subprocess.run=run;payload={'mode':'test','model':'synthetic','key':'SYNTHETIC_ONLY'}
assert m.node_request(payload)=={'connected':True}
args,options=calls[0];assert 'SYNTHETIC_ONLY' not in str(args) and b'SYNTHETIC_ONLY' in options['input']
assert args[:6]==['runuser','-u',m.OWNER,'--','node','-e'] and args[6]==m.NODE
assert all('SYNTHETIC' not in value for value in options['env'].values()) and 'NODE_OPTIONS' not in options['env']
assert options['stdout']==subprocess.PIPE and options['stderr']==subprocess.PIPE and options['timeout']==60
for code,body in [(0,b'{"connected":1}'),(0,b'{"connected":true,"key":"private"}'),(0,b'private output'),(0,b' '*4097),(1,b'{"errorClass":"Error","message":"SYNTHETIC_PRIVATE_TEXT"}'),(1,b'{"errorClass":"Other","message":"HIDDEN"}'),(1,b'{"errorClass":"Error","message":"HIDDEN","stderr":"private"}')]:
 reply[:]=[code,body,b'SYNTHETIC_PRIVATE_STDERR']
 try:m.node_request(payload)
 except (m.Refused,ValueError):pass
 else:raise AssertionError('untrusted subprocess response accepted')
reply[:]=[1,b'{"errorClass":"AIError","message":"fixed reviewed diagnostic"}',b'private']
try:m.node_request(payload)
except m.NodeFailure as error:assert m.public_error(error)=={'errorClass':'AIError','message':'fixed reviewed diagnostic'}
else:raise AssertionError('failure accepted')
payload={'mode':'status','file':'/synthetic/settings','model':'synthetic'};valid={name:True for name in ('enabled','configured','apiKeyConfigured','endpointMatches','modelMatches')}
reply[:]=[0,json.dumps(valid).encode(),b'private'];assert m.node_request(payload)==valid
for invalid in [dict(valid,configured=False),dict(valid,key='private'),{'configured':True}]:
 reply[:]=[0,json.dumps(invalid).encode(),b'private']
 try:m.node_request(payload)
 except m.Refused:pass
 else:raise AssertionError('invalid private settings status accepted')
print(json.dumps({'ok':True}))`), {ok: true});
});

test('service process inspection refuses AI environment overrides, wrong owner, wrong cwd and unstable PID', () => {
  assert.deepEqual(invoke(`import types
state={'env':b'PATH=/usr/bin\\0HR_AI_API_KEY=\\0','cwd':m.APP,'owner':m.OWNER,'pids':['123','123']}
class Proc:
 def __init__(self,*parts):self.parts=parts
 def resolve(self):return state['cwd']
 def read_bytes(self):return state['env']
m.pathlib=types.SimpleNamespace(Path=Proc)
def value(name):return state['pids'].pop(0) if name=='MainPID' else state['owner']
helper=types.SimpleNamespace(system_value=value)
assert m.process_state(helper)=='123'
for change in [{'env':b'HR_AI_API_KEY=SYNTHETIC_ONLY\\0'},{'env':b'HR_AI_ENABLED=false\\0'},{'owner':'root'},{'cwd':'/wrong'},{'pids':['123','124']}]:
 previous=dict(state);state.update({'env':b'PATH=/usr/bin\\0','cwd':m.APP,'owner':m.OWNER,'pids':['123','123']});state.update(change)
 try:m.process_state(helper)
 except m.Refused:pass
 else:raise AssertionError('conflicting runtime accepted')
 state=previous
print(json.dumps({'ok':True}))`), {ok: true});
});

test('default command checks readiness without taking mutation locks, prompting or applying configuration', () => {
  assert.deepEqual(invoke(`import contextlib,io
m.prepare=lambda publication,model:{'model':model}
def forbidden(*args):raise AssertionError('read-only check attempted mutation or credential input')
m.lock=forbidden;m.apply=forbidden;m.read_key=forbidden;m.full_backup=forbidden
output=io.StringIO()
with contextlib.redirect_stdout(output):code=m.main(['--publication-backup','synthetic-publication'])
value=json.loads(output.getvalue());assert code==0 and value['status']=='DEEPSEEK_CONFIGURATION_CHECK' and value['readyToApply'] is True and value['applied'] is False
print(json.dumps({'ok':True}))`), {ok: true});
});

const transaction = `import contextlib,pathlib,tempfile,types
with tempfile.TemporaryDirectory() as folder:
 data=pathlib.Path(folder);target=data/'ai-settings.json';old=b'{"enabled":false,"apiKey":"SYNTHETIC_OLD"}\\n'
 if mode not in ('new-file','new-sync'):target.write_bytes(old)
 trace=[];state={'active':'active','pid':'101','backup':0,'start':0,'source':{'fixed':True},'timer':{'active':True},'locked':False,'locks':0}
 def settings(path,uid,gid):
  if not path.exists():return None
  info=path.stat();return {'raw':path.read_bytes(),'identity':(info.st_dev,info.st_ino),'uid':uid,'gid':gid,'mode':384,'times':(info.st_atime_ns,info.st_mtime_ns)}
 m.settings_state=settings
 helper=types.SimpleNamespace(system_value=lambda name:state['active'],runtime=lambda:(data,8080,'synthetic_database'),get=lambda base,route:(404,b''))
 context={'helper':helper,'data':data,'file':target,'port':8080,'database':'synthetic_database','pid':'101','uid':7,'gid':8,'model':'synthetic-model','sources':{'fixed':True},'timer':{'active':True},'original':settings(target,7,8)}
 @contextlib.contextmanager
 def lock(path):
  assert not state['locked'];state['locked']=True;state['locks']+=1;trace.append('lock')
  try:yield
  finally:state['locked']=False;trace.append('unlock')
 m.lock=lock;m.health=lambda *args:trace.append('health');m.source_state=lambda gid:dict(state['source']);m.timer_state=lambda:dict(state['timer']);m.process_state=lambda helper:state['pid']
 def sync(path):
  if mode=='new-sync' and not target.exists():raise OSError('private directory sync failed')
 m.sync_parent=sync
 def restore_times(path,**options):
  assert path==target and options=={'ns':context['original']['times'],'follow_symlinks':False};trace.append('restore-times')
 m.os.utime=restore_times
 def backup():
  assert not state['locked'];state['backup']+=1;trace.append('backup')
  if mode=='pre-backup':raise OSError('private')
  if mode=='post-backup' and state['backup']==2:raise OSError('SYNTHETIC_PRIVATE_BACKUP_ERROR')
  if mode=='post-restart' and state['backup']==2:state['pid']='501'
  if mode=='post-source' and state['backup']==2:state['source']['fixed']=False
  return '/synthetic/backup-'+str(state['backup'])
 m.full_backup=backup;m.read_key=lambda:'SYNTHETIC_ONLY'
 def request(payload):
  trace.append(payload['mode'])
  if payload['mode']=='test':
   assert payload['key']=='SYNTHETIC_ONLY'
   if mode=='connection-failure':raise m.NodeFailure('AIError','HIDDEN')
   if mode=='source-conflict':state['source']['fixed']=False
   if mode=='timer-conflict':state['timer']['active']=False
   if mode=='foreign-before':target.write_bytes(b'FOREIGN_BEFORE')
  return {'connected':True}
 m.node_request=request
 def command(args,**options):
  trace.append(args[1]);assert args==['systemctl',args[1],m.SERVICE] and state['locked']
  state['active']='inactive' if args[1]=='stop' else 'active'
  if args[1]=='start':
   state['start']+=1;state['pid']=str(101+state['start'])
   if mode=='foreign-after':target.write_bytes(b'FOREIGN_AFTER');raise OSError('private')
   if mode in ('restart-failure','new-file','restore-sync','new-sync') and state['start']==1:raise OSError('private')
  return b''
 m.command=command
 def install(ctx,raw,expected,committed):
  m.same_settings(ctx,expected);target.write_bytes(raw);committed(settings(target,7,8));trace.append('installed')
  if mode=='restore-sync' and raw==old:raise OSError('private directory sync failed after proven restore')
 m.install_settings=install
 result=m.apply(context)
 assert 'SYNTHETIC' not in json.dumps(result) and state['source']==({'fixed':False} if mode in ('source-conflict','post-source') else {'fixed':True})
 assert state['timer']==({'active':False} if mode=='timer-conflict' else {'active':True})
 if mode in ('success','post-backup','post-restart','post-source'):
  assert json.loads(target.read_bytes())['apiKey']=='SYNTHETIC_ONLY' and state['active']=='active'
  assert result['status']==('DEEPSEEK_CONFIGURATION_OK' if mode in ('success','post-restart') else 'DEEPSEEK_CONFIGURATION_APPLIED_NEEDS_ATTENTION') and result['applied']
  assert trace.count('stop')==1 and trace.count('start')==1
  if mode=='post-restart':assert result['pid']=='501'
  if mode=='post-backup':assert result['currentConfigurationVerified'] is True
  if mode=='post-source':assert result['currentConfigurationVerified'] is False and result['postConfigurationBackup']=='/synthetic/backup-2'
 elif mode=='foreign-after':
  assert target.read_bytes()==b'FOREIGN_AFTER' and result['status']=='DEEPSEEK_CONFIGURATION_NEEDS_ATTENTION' and result['stage']=='rollback'
 elif mode in ('source-conflict','timer-conflict','foreign-before','pre-backup','connection-failure'):
  assert 'stop' not in trace and result['status']=='DEEPSEEK_CONFIGURATION_STOPPED' and not result['applied']
  assert target.read_bytes()==(b'FOREIGN_BEFORE' if mode=='foreign-before' else old)
 elif mode in ('restore-sync','new-sync'):
  assert state['active']=='active' and result['status']=='DEEPSEEK_CONFIGURATION_NEEDS_ATTENTION',(result,trace)
  assert result['stage']=='rollback-durability' and result['serviceRecovered'] is True
  assert (not target.exists()) if mode=='new-sync' else target.read_bytes()==old
 else:
  assert result['status']=='DEEPSEEK_CONFIGURATION_STOPPED' and result['rolledBack'] and state['active']=='active',(result,trace)
  assert (not target.exists()) if mode=='new-file' else target.read_bytes()==old
 if mode in ('restart-failure','new-file','restore-sync','new-sync','foreign-after'):assert state['locks']==1 and not state['locked'],trace
 print(json.dumps({'ok':True,'trace':trace}))
`;
test('configuration transaction verifies status and private routes, preserves sources/timer, and keeps a committed configuration after backup failure', () => {
  for (const mode of ['success', 'post-backup', 'post-restart', 'post-source']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
});
test('restart failures restore an existing private file or remove only the newly created file', () => {
  for (const mode of ['restart-failure', 'new-file', 'restore-sync', 'new-sync']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
});
test('source, timer and private-file conflicts refuse mutation and foreign post-write configuration is retained', () => {
  for (const mode of ['source-conflict', 'timer-conflict', 'foreign-before', 'foreign-after', 'pre-backup', 'connection-failure']) assert.equal(invoke(`mode=${JSON.stringify(mode)}\n` + transaction).ok, true);
});

const rootFixture = {skip: typeof process.getuid !== 'function' || process.getuid() !== 0 ? 'Real ownership, atomic install and private modes run in Linux root CI' : false};
test('real source proof enforces root-owned protected directories/code and fingerprints public changes', rootFixture, () => {
  assert.deepEqual(invoke(`import pathlib,tempfile,os
with tempfile.TemporaryDirectory() as folder:
 m.APP=pathlib.Path(folder)/'app';(m.APP/'server').mkdir(parents=True);os.chmod(m.APP,0o750);os.chmod(m.APP/'server',0o750)
 for name in m.PUBLIC_CODE:
  target=m.APP/name;target.write_bytes(('// synthetic '+name+'\\n').encode());os.chmod(target,0o640)
 m.PROVIDER_SHA=m.digest(m.canonical((m.APP/'server/ai-provider.js').read_bytes()).encode());m.SERVER_SHA=m.digest(m.canonical((m.APP/'server/server.js').read_bytes()).encode())
 (m.APP/'server/config.json').write_bytes(b'{}');os.chmod(m.APP/'server/config.json',0o600)
 real=m.file_proof;unit=pathlib.Path('/etc/systemd/system')/m.SERVICE
 m.file_proof=lambda path:('synthetic-unit-proof',) if path==unit else real(path)
 expected=m.source_state(0);target=m.APP/'server/ai-service.js'
 for owner,mode in [(0,0o660),(65534,0o640)]:
  os.chown(target,owner,0);os.chmod(target,mode)
  try:m.source_state(0)
  except m.Refused:pass
  else:raise AssertionError('writable or application-owned source accepted')
 os.chown(target,0,0);os.chmod(target,0o640);target.write_bytes(target.read_bytes()+b'\\n// synthetic public change\\n')
 assert m.source_state(0)!=expected
print(json.dumps({'ok':True}))`), {ok: true});
});
test('real atomic configuration installation retains private ownership/mode and rejects foreign replacement and symbolic links', rootFixture, () => {
  assert.deepEqual(invoke(`import pathlib,tempfile,stat,os
with tempfile.TemporaryDirectory() as folder:
 data=pathlib.Path(folder);target=data/'ai-settings.json';context={'data':data,'file':target,'uid':0,'gid':0};installed=[]
 m.install_settings(context,b'SYNTHETIC_NEW',None,installed.append)
 assert target.read_bytes()==b'SYNTHETIC_NEW' and len(installed)==1
 assert target.stat().st_uid==0 and target.stat().st_gid==0 and stat.S_IMODE(target.stat().st_mode)==0o600
 expected=m.settings_state(target,0,0);m.install_settings(context,b'SYNTHETIC_REPLACEMENT',expected,installed.append)
 assert target.read_bytes()==b'SYNTHETIC_REPLACEMENT' and target.stat().st_nlink==1
 for stale in [None,expected]:
  try:m.install_settings(context,b'MUST_NOT_OVERWRITE',stale,installed.append)
  except m.Refused:pass
  else:raise AssertionError('foreign configuration overwritten')
 assert target.read_bytes()==b'SYNTHETIC_REPLACEMENT' and len(installed)==2
 target.unlink();elsewhere=data/'foreign';elsewhere.write_bytes(b'FOREIGN');target.symlink_to(elsewhere)
 try:m.install_settings(context,b'MUST_NOT_OVERWRITE',None,installed.append)
 except m.Refused:pass
 else:raise AssertionError('linked configuration accepted')
 assert elsewhere.read_bytes()==b'FOREIGN' and not list(data.glob('.hr-ai-private-*'))
print(json.dumps({'ok':True}))`), {ok: true});
});

test('real install records committed identity before unlink or directory-sync failure and fsyncs private metadata before publication', rootFixture, () => {
  assert.deepEqual(invoke(`import pathlib,tempfile,os,stat
unlink=pathlib.Path.unlink;sync=m.sync_parent;fsync=os.fsync;chown=os.fchown;chmod=os.fchmod
for fault in ('unlink','directory-sync','file-sync'):
 with tempfile.TemporaryDirectory() as folder:
  data=pathlib.Path(folder);target=data/'ai-settings.json';context={'data':data,'file':target,'uid':0,'gid':0};committed=[];events=[];failed=[False]
  def failing_unlink(path,*args,**options):
   if fault=='unlink' and path.name.startswith('.hr-ai-private-') and not failed[0]:failed[0]=True;raise OSError('synthetic unlink failure')
   return unlink(path,*args,**options)
  def sync_parent(path):
   if fault=='directory-sync':raise OSError('synthetic directory sync failure')
   return sync(path)
  def fchown(fd,uid,gid):events.append('chown');return chown(fd,uid,gid)
  def fchmod(fd,mode):events.append('chmod');return chmod(fd,mode)
  def file_sync(fd):
   if stat.S_ISREG(os.fstat(fd).st_mode):
    events.append('file-sync')
    if fault=='file-sync':raise OSError('synthetic prepublication sync failure')
   return fsync(fd)
  pathlib.Path.unlink=failing_unlink;m.sync_parent=sync_parent;os.fchown=fchown;os.fchmod=fchmod;os.fsync=file_sync
  try:
   try:m.install_settings(context,b'SYNTHETIC_ONLY',None,committed.append)
   except OSError:pass
   else:raise AssertionError('injected failure swallowed')
  finally:pathlib.Path.unlink=unlink;m.sync_parent=sync;os.fchown=chown;os.fchmod=chmod;os.fsync=fsync
  assert events[:3]==['chown','chmod','file-sync'] and not list(data.glob('.hr-ai-private-*'))
  if fault=='file-sync':assert not target.exists() and not committed
  else:
   assert len(committed)==1 and target.read_bytes()==b'SYNTHETIC_ONLY' and target.stat().st_nlink==1
   m.same_settings(context,committed[0])
print(json.dumps({'ok':True}))`), {ok: true});
});
