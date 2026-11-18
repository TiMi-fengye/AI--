'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/apply-leave-types-time.py');
const canonical = value => value.replace(/\r\n/g, '\n').trimEnd() + '\n';
const sha = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('leave_minutes_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
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

test('leave deployment patches only reviewed validation in the actual auth module and tolerates source line endings', () => {
  const current = canonical(fs.readFileSync(path.resolve(__dirname, '../server/auth-service.js'), 'utf8'));
  let baseline = current;
  for (const [old, replacement] of [...patches].reverse()) {
    assert.equal(baseline.split(replacement).length, 2); baseline = baseline.replace(replacement, old);
  }
  for (const input of [baseline, baseline.replace(/\n/g, '\r\n') + '  ']) {
    assert.deepEqual(invoke({op: 'patch', text: input, sha: sha(baseline)}), {ok: true, text: current});
  }
  assert.equal(invoke({op: 'patch', text: baseline, sha: sha(current)}).ok, false);
  assert.equal(invoke({op: 'patch', text: current, sha: sha(current)}).ok, false);
});

test('leave deployment preserves production-only auth code and refuses missing, duplicate or unsafe patch anchors', () => {
  // Production has no development SMS integration. Only the two reviewed blocks
  // are required; unrelated authentication code must remain byte-for-byte intact.
  const baseline = '/* existing production account logic; no SMS deployment */\n' + patches.map(p => p[0]).join('\n') + '\n/* existing permission and export logic */\n';
  const good = invoke({op: 'patch', text: baseline, sha: sha(baseline)});
  assert.equal(good.ok, true); assert.ok(good.text.startsWith('/* existing production account logic; no SMS deployment */\n'));
  assert.ok(good.text.endsWith('/* existing permission and export logic */\n'));
  for (const [old] of patches) {
    for (const altered of [baseline.replace(old, '// missing'), baseline + old + '\n', baseline + '\0']) {
      assert.equal(invoke({op: 'patch', text: altered, sha: sha(altered)}).ok, false);
    }
  }
});

test('root-protected atomic publication retains mode 0640 and leaves original bytes intact on a failed replacement', {skip: process.platform === 'win32' ? 'directory fsync and fchown are Linux deployment operations' : false}, () => {
  const result = invoke({op: 'exec', code: `import pathlib,tempfile,stat
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);target=root/'auth.js';target.write_bytes(b'original')
 calls=[]
 m.os.fchown=lambda fd,uid,gid:calls.append((uid,gid))
 m.atomic_install(target,b'candidate',71)
 assert target.read_bytes()==b'candidate' and stat.S_IMODE(target.stat().st_mode)==0o640
 assert calls==[(0,71)]
 replace=m.os.replace
 def fail_replace(*args): raise OSError('synthetic replacement failure')
 m.os.replace=fail_replace
 try: m.atomic_install(target,b'wrong',71)
 except OSError: pass
 else: raise AssertionError('replacement failure ignored')
 assert target.read_bytes()==b'candidate'
 assert sorted(p.name for p in root.iterdir())==['auth.js']
 m.os.replace=replace
 m.atomic_install(target,b'original',71)
 assert target.read_bytes()==b'original' and calls[-1]==(0,71)
 print(json.dumps({'ok':True}))`});
  assert.deepEqual(result, {ok: true});
});

const publicationFixture = `import pathlib,tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);m.APP=root/'app';m.APP.mkdir();data=root/'data';data.mkdir();business=data/'synthetic.json';business.write_bytes(b'keep current data')
 backup=root/'publication-backup';backup.mkdir();full=root/'successful-daily-backup';full.mkdir();(full/'KEEP').write_bytes(b'complete backup')
 current={name:('old '+name).encode() for name in m.FILES};candidates={name:('new '+name).encode() for name in m.FILES}
 for name,content in current.items():
  target=m.APP/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
 trace=[];state={'active':'active','install':0,'failed':False};timer={'active':'active','enabled':'enabled'}
 m.timer_state=lambda:dict(timer)
 m.protected_source=lambda p,gid,**kw: trace.append(('protected',str(p.relative_to(m.APP)),gid))
 m.data_hashes=lambda location:{'synthetic':m.helper.digest(business)}
 m.helper.mysql_snapshot=lambda database:b'unchanged synthetic snapshot'
 m.helper.system_value=lambda name:state['active'] if name=='ActiveState' else ''
 def run(arguments,**kwargs):
  trace.append(tuple(str(v) for v in arguments))
  if arguments[:2]==['systemctl','stop']: state['active']='inactive'
  if arguments[:2]==['systemctl','start']: state['active']='active'
  return b''
 m.helper.run=run
 def install(target,content,gid):
  assert gid==71
  trace.append(('install',str(target.relative_to(m.APP)),content.decode(),gid));target.write_bytes(content);state['install']+=1
  if mode=='partial-install' and state['install']==2 and not state['failed']:
   state['failed']=True;raise OSError('synthetic partial installation')
 m.atomic_install=install
 def verify(*args):
  assert state['active']=='active'
  trace.append(('verify',))
  if mode=='health': raise m.Refused('synthetic failed health validation')
 m.helper.verify=verify
 m.helper.get=lambda base,route:(200,candidates[m.LEAVE]) if route=='/js/leave.js' else (401,b'')
 m.wait_health=lambda port:trace.append(('previous-code-healthy',))
 try:
  result=m.publish(current,candidates,data,8080,'synthetic_db',71,timer,backup,str(full));error=None
 except (m.Refused,OSError) as e: result=None;error=type(e).__name__
 assert business.read_bytes()==b'keep current data' and (full/'KEEP').read_bytes()==b'complete backup'
 assert timer=={'active':'active','enabled':'enabled'} and state['active']=='active'
 assert all(not (row[0]=='systemctl' and row[2]!=m.SERVICE) for row in trace if len(row)>2)
 if mode=='success':
  assert result['status']=='LEAVE_TYPES_TIME_OK' and result['serviceRestarted'] is True and result['dailyBackupTimerPreserved'] is True
  assert all((m.APP/name).read_bytes()==value for name,value in candidates.items())
  assert (backup/'LEAVE_TYPES_TIME_OK').is_file()
 else:
  assert error is not None and all((m.APP/name).read_bytes()==value for name,value in current.items())
  assert ('previous-code-healthy',) in trace and not (backup/'LEAVE_TYPES_TIME_OK').exists()
 print(json.dumps({'ok':True,'trace':trace}))
`;
test('targeted leave publication preserves business files, root source ownership contract and the daily timer', () => {
  const result = invoke({op: 'exec', code: "mode='success'\n" + publicationFixture});
  assert.equal(result.ok, true);
  const events = result.trace.map(x => x[0]);
  assert.ok(events.indexOf('install') > events.indexOf('systemctl'));
  assert.equal(result.trace.filter(x => x[0] === 'systemctl' && x[1] === 'stop').length, 1);
  assert.ok(result.trace.filter(x => x[0] === 'install').every(x => x[3] === 71));
});

test('partial installs and failed startup verification restore original code without restoring old business data', () => {
  for (const mode of ['partial-install', 'health']) {
    const result = invoke({op: 'exec', code: `mode=${JSON.stringify(mode)}\n` + publicationFixture});
    assert.equal(result.ok, true);
    assert.ok(result.trace.some(x => x[0] === 'install' && x[2].startsWith('old ')));
  }
});

test('a complete private daily backup must be verified at its exact timestamp location before it can be used', () => {
  const result = invoke({op: 'exec', code: `import types,stat
valid='/var/backups/hr-system/daily/2026-11-18_20-00-23+0800-38e49892be93'
m.regular_file=lambda path:types.SimpleNamespace(stat=lambda:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o700))
for value,verification,accepted in [(valid,True,True),(valid,False,False),('/tmp/other-backup',True,False),(valid+'/../elsewhere',True,False)]:
 calls=[]
 def run(arguments,**kwargs):
  calls.append([str(v) for v in arguments])
  output={'status':'DAILY_BACKUP_OK','backup':value} if '--run' in arguments else {'status':'DAILY_BACKUP_VERIFIED' if verification else 'bad','backup':value}
  return json.dumps(output).encode()
 m.helper.run=run
 try: actual=m.full_daily_backup()
 except m.Refused: assert not accepted
 else: assert accepted and actual==valid and len(calls)==2 and calls[1][-2:]==['--verify',valid]
print(json.dumps({'ok':True}))`});
  assert.deepEqual(result, {ok: true});
});

test('leave publisher requires both reviewed hashes and exposes check/apply before host access', () => {
  for (const args of [[], ['--source', '.'], ['--source', '.', '--expected-auth-sha256', 'bad'], ['--source', '.', '--expected-auth-sha256', 'a'.repeat(64)]]) {
    const result = spawnSync(python, [script, ...args], {encoding: 'utf8', timeout: 10000});
    assert.ifError(result.error); assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /Traceback|systemctl/);
  }
  const help = spawnSync(python, [script, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0); assert.match(help.stdout, /--check/); assert.match(help.stdout, /--apply/);
});
