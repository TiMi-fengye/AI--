'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/apply-attendance-delete.py');
const canonical = value => value.replace(/\r\n/g, '\n').trimEnd() + '\n';
const sha = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('attendance_delete_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'))
if v['op']=='patches': print(json.dumps(m.PATCHES))
elif v['op']=='patch':
 try: print(json.dumps({'ok':True,'text':m.patch_auth(v['text'].encode('utf-8'),v['sha']).decode('utf-8')}))
 except (m.Refused,UnicodeError) as e: print(json.dumps({'ok':False,'error':str(e)}))
else:
 exec(v['code'])
`;
function invoke(value, timeout = 15000) {
  const result = spawnSync(python, ['-c', bridge, script], {input: JSON.stringify(value), encoding: 'utf8', timeout});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const patches = invoke({op: 'patches'});

test('administrator deletion deployment changes only the reviewed merge guard and retains minute validation and other auth behavior', () => {
  const current = canonical(fs.readFileSync(path.resolve(__dirname, '../server/auth-service.js'), 'utf8'));
  let baseline = current;
  for (const [old, replacement] of [...patches].reverse()) {
    assert.equal(baseline.split(replacement).length, 2); baseline = baseline.replace(replacement, old);
  }
  for (const text of [baseline, baseline.replace(/\n/g, '\r\n') + '  ']) {
    assert.deepEqual(invoke({op: 'patch', text, sha: sha(baseline)}), {ok: true, text: current});
  }
  assert.equal(invoke({op: 'patch', text: baseline, sha: sha(current)}).ok, false);
  assert.equal(invoke({op: 'patch', text: current, sha: sha(current)}).ok, false);
  assert.match(current, /function leaveTimestamp/);
});

test('production-specific code survives deletion patch and ambiguous or unsafe baselines stop before installation', () => {
  const baseline = '/* production-only accounts, no SMS deployment */\n' + patches.map(p => p[0]).join('\n') + '\n/* production-only export and session code */\n';
  const good = invoke({op: 'patch', text: baseline, sha: sha(baseline)});
  assert.equal(good.ok, true);
  assert.ok(good.text.startsWith('/* production-only accounts, no SMS deployment */\n'));
  assert.ok(good.text.endsWith('/* production-only export and session code */\n'));
  for (const [old] of patches) {
    for (const altered of [baseline.replace(old, '// missing'), baseline + old + '\n', baseline + '\0']) {
      assert.equal(invoke({op: 'patch', text: altered, sha: sha(altered)}).ok, false);
    }
  }
});

test('every frontend baseline is checked before production candidate tests or backup access', () => {
  const result = invoke({op: 'exec', code: `import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder)
 current={name:b'public source\\n' for name in m.FILES}
 expected={name:m.canonical_hash(current[name]) for name in m.FRONTEND}
 calls=[];m.helper.run=lambda *args,**kwargs:calls.append(args)
 for name in m.FRONTEND:
  bad=dict(expected);bad[name]='0'*64
  try:m.freeze_release(root,root,current,'0'*64,bad)
  except m.Refused:pass
  else:raise AssertionError('wrong frontend baseline accepted')
  assert calls==[]
 try:m.freeze_release(root,root,current,'0'*64,{})
 except m.Refused:pass
 else:raise AssertionError('missing frontend baselines accepted')
 print(json.dumps({'ok':True}))`});
  assert.deepEqual(result, {ok: true});
});

test('read-only staging tests the patched candidate with sanitized settings before any source can be published', () => {
  const result = invoke({op: 'exec', code: `import pathlib,tempfile,os
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);source=root/'release';source.mkdir();stage=root/'candidate';stage.mkdir()
 for name in (*m.FRONTEND,m.HTML,*m.DOCS,'tests/attendance-delete-permissions.test.js','scripts/generate-architecture.cjs'):
  target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'public fixture\\n')
 current={name:b'old public fixture\\n' for name in m.FRONTEND};current[m.AUTH]=m.OLD_CLEANUP.encode()
 expected={name:m.canonical_hash(current[name]) for name in m.FRONTEND}
 calls=[]
 def run(arguments,**kwargs):
  calls.append(([str(v) for v in arguments],kwargs))
  return b''
 m.helper.run=run;os.environ['HR_DATA_DIR']='/private/unused';os.environ['HR_MYSQL_PASSWORD']='synthetic-not-a-real-password'
 candidates=m.freeze_release(source,stage,current,m.canonical_hash(current[m.AUTH]),expected)
 assert set(candidates)==set(m.FILES)
 assert candidates[m.AUTH]==m.ADMIN_DELETE_GUARD.encode()
 tests=[row for row in calls if '--test' in row[0]]
 assert len(tests)==1 and tests[0][1]['env']['HR_ATTENDANCE_AUTH_TEST_MODULE']==str(stage/m.AUTH)
 assert set(key for key in tests[0][1]['env'] if key.startswith('HR_'))=={'HR_ATTENDANCE_AUTH_TEST_MODULE'}
 assert calls[-1][0][-1]=='--check' and calls[-1][0][1].endswith('generate-architecture.cjs')
 assert all('systemctl' not in row[0] and 'hr-system-backup' not in row[0] for row in calls)
 assert all(current[name]==b'old public fixture\\n' for name in m.FRONTEND)
 print(json.dumps({'ok':True}))`});
  assert.deepEqual(result, {ok: true});
});

const publicationFixture = `import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();data=root/'data';data.mkdir();business=data/'synthetic.json';business.write_bytes(b'keep current data')
 backup=root/'publication-backup';backup.mkdir();full=root/'verified-daily-backup';full.mkdir();(full/'KEEP').write_bytes(b'verified backup')
 current={name:('old '+name).encode() for name in m.FILES};candidates={name:('new '+name).encode() for name in m.FILES}
 for name,content in current.items():
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
 trace=[];state={'active':'active','install':0,'failed':False};timer={'active':'active','enabled':'enabled'}
 m.timer_state=lambda:dict(timer)
 m.protected_source=lambda p,gid,**kw:trace.append(('protected',str(p.relative_to(m.APP)),gid))
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
  assert gid==71
  trace.append(('install',str(target.relative_to(m.APP)),content.decode(),gid));target.write_bytes(content);state['install']+=1
  if mode=='partial-install' and state['install']==3 and not state['failed']:
   state['failed']=True;raise OSError('synthetic partial installation')
 m.atomic_install=install
 def verify(*args):
  assert state['active']=='active';trace.append(('verify',))
  if mode=='health':raise m.Refused('synthetic startup check failure')
  if mode=='new-business':business.write_bytes(b'newer business data')
 m.helper.verify=verify
 m.helper.get=lambda base,route:(200,candidates[route[1:]]) if route[1:] in m.FRONTEND else (401,b'')
 m.wait_health=lambda port:trace.append(('previous-code-healthy',))
 try:result=m.publish(current,candidates,data,8080,'synthetic_db',71,timer,backup,str(full));error=None
 except (m.Refused,OSError) as e:result=None;error=type(e).__name__
 assert business.read_bytes()==(b'newer business data' if mode=='new-business' else b'keep current data')
 assert (full/'KEEP').read_bytes()==b'verified backup'
 assert timer=={'active':'active','enabled':'enabled'} and state['active']=='active'
 assert all(row[2]==m.SERVICE for row in trace if row[0]=='systemctl')
 if mode=='success':
  assert result['status']=='ATTENDANCE_DELETE_OK' and result['serviceRestarted'] is True
  assert result['sourceProtected'] is True and result['dailyBackupTimerPreserved'] is True and result['businessDataWritten'] is False
  assert set(result['frontendSha256'])==set(m.FRONTEND)
  assert all((m.APP/name).read_bytes()==value for name,value in candidates.items())
  assert (backup/'ATTENDANCE_DELETE_OK').is_file()
 else:
  assert error is not None and all((m.APP/name).read_bytes()==value for name,value in current.items())
  assert ('previous-code-healthy',) in trace and not (backup/'ATTENDANCE_DELETE_OK').exists()
 print(json.dumps({'ok':True,'trace':trace}))
`;
test('administrator deletion publishes all five files with root ownership checks while leaving the daily timer and business data alone', () => {
  const result = invoke({op: 'exec', code: "mode='success'\n" + publicationFixture});
  assert.equal(result.ok, true);
  assert.equal(result.trace.filter(x => x[0] === 'install').length, 5);
  assert.equal(result.trace.filter(x => x[0] === 'systemctl' && x[1] === 'stop').length, 1);
  assert.ok(result.trace.filter(x => x[0] === 'install').every(x => x[3] === 71));
});

test('partial installation, failed health checks or later business changes roll back only code and retain every newer business byte', () => {
  for (const mode of ['partial-install', 'health', 'new-business']) {
    const result = invoke({op: 'exec', code: `mode=${JSON.stringify(mode)}\n` + publicationFixture});
    assert.equal(result.ok, true);
    assert.ok(result.trace.some(x => x[0] === 'install' && x[2].startsWith('old ')));
  }
});

test('attendance delete publisher requires all four reviewed hashes before inspecting the server', () => {
  const complete = ['--source', '.', '--expected-auth-sha256', 'a'.repeat(64), '--expected-attendance-sha256', 'b'.repeat(64), '--expected-overtime-sha256', 'c'.repeat(64), '--expected-leave-sha256', 'd'.repeat(64)];
  const variants = [[], ['--source', '.'], complete.slice(0, -2), [...complete.slice(0, -1), 'bad'], [...complete, '--check', '--apply']];
  for (const args of variants) {
    const result = spawnSync(python, [script, ...args], {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error); assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /Traceback|systemctl/);
  }
  const help = spawnSync(python, [script, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0); assert.match(help.stdout, /--check/); assert.match(help.stdout, /--apply/);
});
