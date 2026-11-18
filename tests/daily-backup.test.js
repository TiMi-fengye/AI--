'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.resolve(__dirname, '../deploy/daily-backup.py');
const setup = `import importlib.util,pathlib,tempfile,json,os,stat,copy,sys,hashlib,tarfile,io,datetime
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('daily_backup_test_module',sys.argv[1]);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
FIXTURES=pathlib.Path.cwd()/'.delivery'/'daily-backup-tests';FIXTURES.mkdir(parents=True,exist_ok=True)
def fixture(root):
 app=root/'runtime';app.mkdir()
 values={'snapshot.json':'{"employees":[{"id":"synthetic-person"}]}','auth-users.json':'{"users":[{"id":"synthetic-user"}]}','organization-settings.json':'{"buildings":["synthetic-building"]}','attachments/sample.bin':bytes(range(256))*4,'attachments/示例.txt':'SYNTHETIC ATTACHMENT'}
 for name,value in values.items():
  target=app/name;target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(value if isinstance(value,bytes) else value.encode('utf-8'))
 return app
def rejected(call):
 try:call()
 except m.Refused:return
 raise AssertionError('unsafe or inconsistent backup was accepted')
def make_backup(root,mysql=False):
 source=fixture(root);target=root/m.timestamp_name();target.mkdir()
 config=root/'system-config';(config/'etc/hr-system').mkdir(parents=True);(config/'etc/hr-system/runtime.env').write_text('HR_SYNTHETIC=ONLY',encoding='utf-8')
 config_rows=[dict(row,path='etc/hr-system'+('' if row['path']=='.' else '/'+row['path'])) for row in m.scan_tree(config/'etc/hr-system')]
 records=m.scan_tree(source);artifacts={}
 for name in sorted(m.TAR_ARTIFACTS):
  chosen=config_rows if name=='service-config.tar.gz' else records
  m.write_archive(target/name,config if name=='service-config.tar.gz' else source,chosen);artifacts[name]=m.artifact_record(target/name,'tar',chosen)
 (target/'runtime-environment.json').write_text('{"HR_TEST_SECRET":"SYNTHETIC ONLY"}',encoding='utf-8')
 artifacts['runtime-environment.json']=m.artifact_record(target/'runtime-environment.json','file')
 db={'enabled':mysql,'host':'127.0.0.1','port':3306,'database':'synthetic_hr'}
 if mysql:
  (target/'mysql.sql').write_text('SYNTHETIC SQL CONTENT',encoding='utf-8');artifacts['mysql.sql']=m.artifact_record(target/'mysql.sql','file')
 created=datetime.datetime.strptime(target.name.rsplit('-',1)[0],'%Y-%m-%d_%H-%M-%S%z').isoformat()
 document={'schemaVersion':1,'type':m.SCHEMA,'state':'complete','timestamp':target.name,'createdAt':created,'runtime':{'app':str(m.APP),'dataPath':str(m.DATA),'port':8080,'mysql':db},'artifacts':artifacts}
 publish_manifest(target,document)
 return target,document
def publish_manifest(target,document):
 raw=(json.dumps(document,sort_keys=True)+'\\n').encode();(target/'manifest.json').write_bytes(raw);(target/'COMPLETE').write_text(hashlib.sha256(raw).hexdigest()+'\\n',encoding='ascii')
`;
function run(body) {
  const result=spawnSync(python,['-c',setup+'\n'+body,script],{encoding:'utf8',timeout:30000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr || result.stdout);
  return result.stdout.trim();
}

test('backup timestamps use Beijing time across UTC date boundaries and do not collide',()=>{
  assert.equal(run(`moment=datetime.datetime(2026,11,17,18,0,0,tzinfo=datetime.timezone.utc)
names=[m.timestamp_name(moment) for _ in range(25)]
assert all(name.startswith('2026-11-18_02-00-00+0800-') for name in names)
assert len(set(names))==len(names)
assert m.timestamp_name(datetime.datetime(2026,11,17,16,0,0,tzinfo=datetime.timezone.utc)).startswith('2026-11-18_00-00-00+0800-')
print('ok')`),'ok');
});

test('backup member paths reject traversal, absolute names and ambiguous path spellings',()=>{
  assert.equal(run(`for name in ['../outside','/etc/passwd','C:/private','a/../b','a/./b','a//b','a\\\\b','a'+chr(0)+'b']:
 rejected(lambda name=name:m.safe_relative(name))
assert m.safe_relative('attachments/sample.bin')
print('ok')`),'ok');
});

test('timestamped archive round trip includes account, organization and binary attachment bytes',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='roundtrip-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);source=fixture(root);records=m.scan_tree(source)
 assert {'snapshot.json','auth-users.json','organization-settings.json','attachments/sample.bin','attachments/示例.txt'}<={row['path'] for row in records}
 before={name:(source/name).read_bytes() for name in ['snapshot.json','auth-users.json','organization-settings.json','attachments/sample.bin','attachments/示例.txt']}
 archive=root/'runtime-data.tar.gz';m.write_archive(archive,source,records);m.verify_archive(archive,records)
 with tarfile.open(archive,'r:gz') as bundle:
  for name,expected in before.items():
   assert bundle.extractfile(name).read()==expected
 assert before=={name:(source/name).read_bytes() for name in before}
 print('ok')`),'ok');
});

test('source changes after scanning cannot be silently packaged as a verified stable snapshot',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='changed-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);source=fixture(root);records=m.scan_tree(source)
 (source/'snapshot.json').write_text('{"changed":true}',encoding='utf-8')
 rejected(lambda:m.write_archive(root/'changed.tar.gz',source,records))
 print('ok')`),'ok');
});

test('archive verification rejects changed content, extra/missing files, traversal and link members',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='archive-safety-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);source=fixture(root);records=m.scan_tree(source)
 good=root/'good.tar.gz';m.write_archive(good,source,records)
 with tarfile.open(good,'r:gz') as bundle:
  members=[(copy.copy(row),bundle.extractfile(row).read() if row.isfile() else None) for row in bundle.getmembers()]
 def write_bad(label,alter):
  target=root/(label+'.tar.gz');rows=alter([(copy.copy(row),payload) for row,payload in members])
  with tarfile.open(target,'w:gz') as bundle:
   for row,payload in rows:
    if payload is not None:row.size=len(payload)
    bundle.addfile(row,io.BytesIO(payload) if payload is not None else None)
  rejected(lambda:m.verify_archive(target,records))
 def extra(name,kind=None):
  row=tarfile.TarInfo(name);row.mode=0o600
  if kind is not None:row.type=kind;row.linkname='../outside'
  return row,b'UNEXPECTED' if kind is None else None
 write_bad('missing',lambda rows:[pair for pair in rows if pair[0].name!='auth-users.json'])
 write_bad('changed',lambda rows:[(row,b'CHANGED') if row.name=='snapshot.json' else (row,payload) for row,payload in rows])
 write_bad('extra',lambda rows:rows+[extra('unexpected.json')])
 write_bad('duplicate',lambda rows:rows+[copy.copy(next(pair for pair in rows if pair[0].name=='auth-users.json'))])
 for index,name in enumerate(['../outside','/etc/passwd','C:/private','a\\\\b','a/./b','a//b']):
  write_bad('unsafe-'+str(index),lambda rows,name=name:rows+[extra(name)])
 write_bad('symlink',lambda rows:rows+[extra('link',tarfile.SYMTYPE)])
 write_bad('hardlink',lambda rows:rows+[extra('hard',tarfile.LNKTYPE)])
 write_bad('fifo',lambda rows:rows+[extra('pipe',tarfile.FIFOTYPE)])
 print('ok')`),'ok');
});

test('hard links in runtime data are refused before contents are copied',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='hardlink-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);source=fixture(root);os.link(source/'snapshot.json',source/'same-inode.json')
 rejected(lambda:m.scan_tree(source))
 print('ok')`),'ok');
});

test('symbolic links cannot make a runtime archive read outside its root', {skip:process.platform==='win32'?'Windows symlink creation requires developer-mode privileges':false},()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='symlink-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);source=fixture(root);outside=root/'outside';outside.write_text('PRIVATE OUTSIDE',encoding='utf-8')
 (source/'linked.json').symlink_to(outside)
 rejected(lambda:m.scan_tree(source))
 print('ok')`),'ok');
});

test('complete backup verification requires the manifest, completion digest, exact artifacts and unchanged payloads',()=>{
  assert.equal(run(`with tempfile.TemporaryDirectory(prefix='manifest-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);backup,document=make_backup(root,True)
 assert m.verify_backup(backup,require_root=False)['timestamp']==backup.name
 cases=[]
 for mutate in [lambda d:d.update(state='incomplete'),lambda d:d['runtime'].update(app='/other/app'),lambda d:d['artifacts'].pop('mysql.sql'),lambda d:d['artifacts'].__setitem__('../outside',copy.deepcopy(d['artifacts']['mysql.sql'])),lambda d:d['runtime']['mysql'].update(port=3307)]:
  bad=copy.deepcopy(document);mutate(bad);rejected(lambda bad=bad:m.validate_manifest(bad))
 bad=copy.deepcopy(document);bad['artifacts']['service-config.tar.gz']['records'][-1]['path']='etc/shadow';rejected(lambda:m.validate_manifest(bad))
 original=(backup/'mysql.sql').read_bytes();(backup/'mysql.sql').write_bytes(b'CORRUPTED SQL')
 rejected(lambda:m.verify_backup(backup,require_root=False));(backup/'mysql.sql').write_bytes(original)
 (backup/'unexpected').write_bytes(b'EXTRA PRIVATE ARTIFACT');rejected(lambda:m.verify_backup(backup,require_root=False));(backup/'unexpected').unlink()
 (backup/'COMPLETE').write_text('0'*64+'\\n',encoding='ascii');rejected(lambda:m.verify_backup(backup,require_root=False));publish_manifest(backup,document)
 (backup/'COMPLETE').unlink()
 try:m.verify_backup(backup,require_root=False)
 except (m.Refused,FileNotFoundError):pass
 else:raise AssertionError('missing completion marker was accepted')
 print('ok')`),'ok');
});

const onlineSetup = `from unittest.mock import patch
import types
def online_fixture(root,mysql=False):
 app=root/'app';app.mkdir();(app/'server.js').write_text('SYNTHETIC CODE',encoding='utf-8')
 data=fixture(root);config=root/'service-config';(config/'etc/hr-system').mkdir(parents=True);(config/'etc/hr-system/runtime.env').write_text('HR_SYNTHETIC=ONLY',encoding='utf-8')
 backups=root/'backups';backups.mkdir();(backups/'prior-complete').mkdir();(backups/'prior-complete/keep').write_bytes(b'EXISTING BACKUP')
 ctx={'app':app,'data':data,'pid':'1234','port':8080,'environment':{'HR_TEST_SECRET':'SYNTHETIC ONLY'},'mysql':{'enabled':mysql,'host':'127.0.0.1','port':3306,'database':'synthetic_hr'}}
 return ctx,config,backups
def online_patches(stack,ctx,config,inventory=None,dump=None):
 original_fstat=m.os.fstat;lock_fds=set();original_open=m.os.open;original_write=m.write_archive
 def open_file(path,*args,**kwargs):
  descriptor=original_open(path,*args,**kwargs)
  if str(path).endswith('.daily-backup.lock'):lock_fds.add(descriptor)
  return descriptor
 def info(descriptor):
  row=original_fstat(descriptor)
  if descriptor not in lock_fds:return row
  value=types.SimpleNamespace(**{name:getattr(row,name) for name in dir(row) if name.startswith('st_')});value.st_uid=0;value.st_mode=0o100600
  return value
 def inventories(context):
  service_rows=[dict(row,path='etc/hr-system'+('' if row['path']=='.' else '/'+row['path'])) for row in m.scan_tree(config/'etc/hr-system')]
  return {'app.tar.gz':m.scan_tree(ctx['app']),'runtime-data.tar.gz':m.scan_tree(ctx['data']),'service-config.tar.gz':service_rows}
 def archive(target,source,records):return original_write(target,config if target.name=='service-config.tar.gz' else source,records)
 stack.enter_context(patch.object(m,'ensure_backup_root',lambda root:None))
 stack.enter_context(patch.object(m.os,'O_NOFOLLOW',getattr(m.os,'O_NOFOLLOW',0),create=True))
 stack.enter_context(patch.object(m.os,'open',open_file));stack.enter_context(patch.object(m.os,'fstat',info))
 if os.name!='posix':stack.enter_context(patch.dict(sys.modules,{'fcntl':types.SimpleNamespace(LOCK_EX=1,LOCK_NB=2,flock=lambda *args:None)}))
 stack.enter_context(patch.object(m,'runtime',lambda:ctx));stack.enter_context(patch.object(m,'health',lambda context:None))
 stack.enter_context(patch.object(m,'inventories',inventory or inventories));stack.enter_context(patch.object(m,'write_archive',archive))
 stack.enter_context(patch.object(m.time,'sleep',lambda seconds:None))
 if dump:stack.enter_context(patch.object(m,'mysql_dump',dump))
 return inventories
from contextlib import ExitStack
`;

test('online backup retries a changing database, publishes only the matching SQL window and retains old backups',()=>{
  assert.equal(run(onlineSetup+`with tempfile.TemporaryDirectory(prefix='sql-window-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);ctx,config,backups=online_fixture(root,True)
 bodies=iter([b'FIRST DATABASE STATE',b'CHANGED DATABASE STATE',b'STABLE DATABASE STATE',b'STABLE DATABASE STATE'])
 calls=[]
 def dump(context,destination):calls.append(destination.name);destination.write_bytes(next(bodies))
 with ExitStack() as stack:
  online_patches(stack,ctx,config,dump=dump)
  result=m.run_backup(ctx,backups,attempts=2)
 backup=pathlib.Path(result['backup']);document=m.verify_backup(backup,require_root=False)
 assert result['status']=='DAILY_BACKUP_OK' and result['serviceRestarted'] is False
 assert document['consistency']['attempt']==2 and (backup/'mysql.sql').read_bytes()==b'STABLE DATABASE STATE'
 assert len(calls)==4 and (backups/'prior-complete/keep').read_bytes()==b'EXISTING BACKUP'
 assert {row.name for row in backups.iterdir()}=={'prior-complete',backup.name}
 print('ok')`),'ok');
});

test('persistent file changes never publish COMPLETE and cannot delete a previously completed backup',()=>{
  assert.equal(run(onlineSetup+`with tempfile.TemporaryDirectory(prefix='unstable-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);ctx,config,backups=online_fixture(root,False)
 with ExitStack() as stack:
  inventory=online_patches(stack,ctx,config)
  calls=[0]
  def changing(context):
   calls[0]+=1
   if calls[0]%3==0:(ctx['data']/'snapshot.json').write_text(json.dumps({'generation':calls[0]}),encoding='utf-8')
   return inventory(context)
  stack.enter_context(patch.object(m,'inventories',changing))
  rejected(lambda:m.run_backup(ctx,backups,attempts=2))
 assert {row.name for row in backups.iterdir()}=={'prior-complete'}
 assert (backups/'prior-complete/keep').read_bytes()==b'EXISTING BACKUP'
 print('ok')`),'ok');
});

test('backup interruption cleans only its incomplete stage and leaves earlier backups intact',()=>{
  assert.equal(run(onlineSetup+`with tempfile.TemporaryDirectory(prefix='interrupt-',dir=FIXTURES) as directory:
 root=pathlib.Path(directory);ctx,config,backups=online_fixture(root,False)
 with ExitStack() as stack:
  online_patches(stack,ctx,config)
  stack.enter_context(patch.object(m,'write_archive',side_effect=KeyboardInterrupt()))
  try:m.run_backup(ctx,backups,attempts=1)
  except KeyboardInterrupt:pass
  else:raise AssertionError('interruption was swallowed')
 assert {row.name for row in backups.iterdir()}=={'prior-complete'}
 print('ok')`),'ok');
});

test('SQL snapshots use deterministic transactional local-socket options without exposing passwords in process arguments',()=>{
  assert.equal(run(`from unittest.mock import patch
with tempfile.TemporaryDirectory(prefix='dump-',dir=FIXTURES) as directory:
 target=pathlib.Path(directory)/'mysql.sql';seen=[]
 def command(args,**kwargs):seen.extend(args);kwargs['output'].write(b'SYNTHETIC MYSQL DUMP')
 with patch.object(m,'run',command):m.mysql_dump({'mysql':{'database':'synthetic_hr'}},target)
 assert {'--protocol=socket','-uroot','--single-transaction','--skip-comments','--skip-dump-date','--routines','--triggers','--events'}<=set(seen)
 assert not any('password' in arg.lower() for arg in seen)
 assert target.read_bytes()==b'SYNTHETIC MYSQL DUMP'
 print('ok')`),'ok');
});
