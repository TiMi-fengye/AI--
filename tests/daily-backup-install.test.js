'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/install-daily-backup.py');
const setup = `import importlib.util,pathlib,tempfile,sys,datetime,types,json
from unittest.mock import patch
from contextlib import ExitStack
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('backup_install_test_module',sys.argv[1]);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
FIXTURES=pathlib.Path.cwd()/'.delivery'/'daily-backup-install-tests';FIXTURES.mkdir(parents=True,exist_ok=True)
def rejected(call):
 try:call()
 except m.Refused:return
 raise AssertionError('unsafe installation was accepted')
FIRST='2026-11-18_02-00-00+0800-abcdef123456'
SECOND='2026-11-18_02-00-01+0800-abcdef123457'
def exercise(root,fail=None):
 events=[];home=root/'tool';home.mkdir()
 state={'existing':True,'enabled':True,'active':True,'directoryExisted':True};host={'pid':'4242','sourcePermissions':['unchanged']};previous={'saved':'old tools and timer state'}
 first=m.BACKUP_DIRECTORY.as_posix()+'/'+FIRST;second=m.BACKUP_DIRECTORY.as_posix()+'/'+SECOND
 list_calls=[0];host_calls=[0]
 def command(args,**kwargs):
  args=tuple(str(value) for value in args);events.append(('command',args))
  if fail=='enable' and args[:3]==('systemctl','enable','--now'):raise m.Refused('SYNTHETIC ENABLE FAILURE')
  return types.SimpleNamespace(stdout=b'enabled\\n',returncode=0)
 def core(tool,args):
  args=tuple(args);events.append(('core',args))
  if args==('--run',):
   if fail=='backup':raise m.Refused('SYNTHETIC BACKUP FAILURE')
   return {'status':'DAILY_BACKUP_OK','backup':first}
  if args[0]=='--verify':return {'status':'BAD' if fail=='verify' else 'DAILY_BACKUP_VERIFIED','backup':args[1]}
  raise AssertionError('unexpected core operation')
 def listing(tool):
  list_calls[0]+=1;events.append(('listing',list_calls[0]));return {FIRST} if list_calls[0]==1 or fail=='no-unit-backup' else {FIRST,SECOND}
 def system(unit,name):
  if unit==m.SERVICE:return {'ActiveState':'inactive','Result':'failed' if fail=='unit' else 'success','ExecMainStatus':'0'}[name]
  return {'ActiveState':'active','NextElapseUSecRealtime':'future trigger'}[name]
 def host_value():
  host_calls[0]+=1
  return {'pid':'different','sourcePermissions':['unchanged']} if fail=='host' else host
 with ExitStack() as stack:
  stack.enter_context(patch.object(m,'INSTALL',home))
  stack.enter_context(patch.object(m,'save_previous',lambda value:events.append(('save',value)) or previous))
  stack.enter_context(patch.object(m,'atomic_write',lambda target,content,mode:events.append(('write',str(target),mode))))
  stack.enter_context(patch.object(m,'restore_previous',lambda value:events.append(('rollback',value))))
  stack.enter_context(patch.object(m,'run',command));stack.enter_context(patch.object(m,'run_core',core));stack.enter_context(patch.object(m,'completed_backups',listing))
  stack.enter_context(patch.object(m,'system_value',system));stack.enter_context(patch.object(m,'host_state',host_value));stack.enter_context(patch.object(m,'next_trigger',lambda value:'2026-11-19T02:00:00+08:00'))
  release={'tool':b'PUBLIC SYNTHETIC TOOL','wrapper':m.wrapper_contents(),'units':m.unit_contents()}
  if fail:rejected(lambda:m.install(release,state,host));result=None
  else:result=m.install(release,state,host)
 return result,events,previous,first,second
`;
function run(body) {
  const result=spawnSync(python,['-c',setup+'\n'+body,script],{encoding:'utf8',timeout:30000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr || result.stdout);return result.stdout.trim();
}

test('systemd backup timer targets 02:00 Beijing time explicitly and restricts writes to its private backup area',()=>{
  assert.equal(run(`units=m.unit_contents();timer=units[m.TIMER].decode();service=units[m.SERVICE].decode();wrapper=m.wrapper_contents().decode()
assert 'OnCalendar=*-*-* 02:00:00 Asia/Shanghai' in timer and 'Persistent=true' in timer
assert 'RandomizedDelaySec=0' in timer and 'AccuracySec=1s' in timer
assert 'User=root' in service and 'UMask=0077' in service and 'ProtectSystem=strict' in service
assert 'ReadOnlyPaths=/opt/hr-system' in service and 'ReadWritePaths=/var/backups/hr-system' in service
assert '/usr/local/lib/hr-system-backup/daily-backup.py --run' in service
assert '"$@"' in wrapper and '/usr/bin/python3 -I' in wrapper
print('ok')`),'ok');
});

test('first-backup locations and completed listings cannot point outside the protected timestamp directory',()=>{
  assert.equal(run(`valid=m.BACKUP_DIRECTORY.as_posix()+'/'+FIRST
assert m.verified_backup_name({'status':'DAILY_BACKUP_OK','backup':valid})==valid
for candidate in ['/tmp/'+FIRST,m.BACKUP_DIRECTORY.as_posix()+'/nested/'+FIRST,m.BACKUP_DIRECTORY.as_posix()+'/../'+FIRST,m.BACKUP_DIRECTORY.as_posix()+'/incomplete']:
 rejected(lambda candidate=candidate:m.verified_backup_name({'status':'DAILY_BACKUP_OK','backup':candidate}))
for names in [[FIRST,FIRST],['../outside'],[123]]:
 with patch.object(m,'run_core',lambda tool,args,names=names:{'status':'DAILY_BACKUP_LIST','directory':m.BACKUP_DIRECTORY.as_posix(),'backups':names}):rejected(lambda:m.completed_backups(m.TOOL))
print('ok')`),'ok');
});

test('next trigger must be a future 02:00 Beijing instant rather than the host timezone or a stale time',()=>{
  assert.equal(run(`Real=datetime.datetime
class Frozen(Real):
 @classmethod
 def now(cls,tz=None):
  value=Real(2026,11,17,12,0,0,tzinfo=datetime.timezone.utc)
  return value.astimezone(tz) if tz else value.replace(tzinfo=None)
with patch.object(m.dt,'datetime',Frozen):
 assert m.next_trigger('Tue 2026-11-17 18:00:00 UTC')=='2026-11-18T02:00:00+08:00'
 for value in ['Tue 2026-11-17 19:00:00 UTC','Mon 2026-11-16 18:00:00 UTC','Tue 2026-11-17 18:00:00 CST','n/a']:
  rejected(lambda value=value:m.next_trigger(value))
print('ok')`),'ok');
});

test('timer is enabled only after CLI and installed-systemd backups both verify, while application service remains untouched',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='success-',dir=FIXTURES) as directory:
 result,events,previous,first,second=exercise(pathlib.Path(directory))
 assert result['status']=='DAILY_BACKUP_READY' and result['scheduledServiceTested'] is True
 assert result['serviceRestarted'] is False and result['sourcePermissionsChanged'] is False and result['latestBackup']==SECOND
 commands=[row[1] for row in events if row[0]=='command'];enable=('systemctl','enable','--now',m.TIMER);unit_start=('systemctl','start',m.SERVICE)
 assert events.index(('core',('--run',)))<events.index(('core',('--verify',first)))<events.index(('command',unit_start))<events.index(('core',('--verify',second)))<events.index(('command',enable))
 assert not any(row[0]=='rollback' for row in events)
 assert not any(m.APP_SERVICE in args for args in commands)
 assert not any(str(m.APP) in row[1] for row in events if row[0]=='write')
 assert events[0][0]=='save'
 print('ok')`),'ok');
});

test('backup, verification, unit, new-output or source-identity failures restore installation before a timer can be enabled',()=>{
  assert.equal(run(`for failure in ['backup','verify','unit','no-unit-backup','host']:
 with tempfile.TemporaryDirectory(prefix='failure-',dir=FIXTURES) as directory:
  result,events,previous,first,second=exercise(pathlib.Path(directory),failure)
  assert events[-1]==('rollback',previous),failure
  assert not any(row==('command',('systemctl','enable','--now',m.TIMER)) for row in events),failure
  assert not any(m.APP_SERVICE in row[1] for row in events if row[0]=='command'),failure
print('ok')`),'ok');
});

test('a failed timer activation restores the prior installation and prior timer state',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='enable-failure-',dir=FIXTURES) as directory:
 result,events,previous,first,second=exercise(pathlib.Path(directory),'enable')
 assert events[-1]==('rollback',previous)
 assert ('core',('--verify',second)) in events
 assert not any(m.APP_SERVICE in row[1] for row in events if row[0]=='command')
 print('ok')`),'ok');
});

test('installer CLI rejects incompatible operations without starting host inspection',()=>{
  for(const args of [['--check','--apply'],['--app','/tmp/other']]) {
    const result=spawnSync(python,[script,...args],{encoding:'utf8',timeout:10000});
    assert.ifError(result.error);assert.equal(result.status,2,result.stderr);assert.doesNotMatch(result.stderr,/Traceback|Daily backup installation stopped/);
  }
});
