"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const python = process.platform === "win32" ? "python" : "python3";
const script = path.resolve(__dirname, "../deploy/diagnose-mysql-relational.py");
const bridge = `import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('readonly_diagnostic',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'));exec(v['code'])
`;
function invoke(code) {
  const temporary = path.resolve(__dirname, "../.delivery/relational-diagnostics-test-tmp");
  fs.mkdirSync(temporary, {recursive:true});
  const output = spawnSync(python,["-c",bridge,script],{input:JSON.stringify({code}),encoding:"utf8",timeout:15000,
    env:{...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary}});
  assert.ifError(output.error);assert.equal(output.status,0,output.stderr);return JSON.parse(output.stdout);
}
const source = invoke("print(json.dumps(m.NODE_DIAGNOSTIC))");
const unit = {exports:{}};
new Function("require","module","exports",source)(require,unit,unit.exports);
const {diagnose,safeFailure,SQL} = unit.exports;
const modules = Object.fromEntries(["mysql-store.js","mysql-auth-store.js","migrate-mysql.js"].map(name=>[name,fs.readFileSync(path.resolve(__dirname,"../server",name),"utf8")]));
const poison = "SYNTHETIC_PRIVATE_VALUE_sql_password_phone";
async function fixture(options={},action) {
  const parent=path.resolve(__dirname,"../.delivery/relational-diagnostics-test-tmp");fs.mkdirSync(parent,{recursive:true});
  const directory=fs.mkdtempSync(path.join(parent,"readonly-"));
  const original={revision:7,employees:[{id:1,name:poison,phone:poison}],updateLogs:[{id:2,action:"add",operator:poison}]};
  const request={sourceDirectory:path.resolve(__dirname,"../server"),modules:{...modules},configPath:path.join(directory,"config.json"),dataDirectory:directory};
  const users=options.users||{synthetic:{name:poison,role:"admin",passwordHash:poison,employeeId:1,buildings:[],regions:[]}};
  const organization=options.organization||{schemaVersion:1,revision:2,options:{buildings:["synthetic"],departments:[]},buildingLeaders:[]};
  fs.writeFileSync(request.configPath,JSON.stringify({mysql:{enabled:true,host:"127.0.0.1",port:3306,database:"hr_synthetic",user:"synthetic",password:poison}}));
  fs.writeFileSync(path.join(directory,"auth-users.json"),JSON.stringify(users));
  fs.writeFileSync(path.join(directory,"organization-settings.json"),JSON.stringify(organization));
  const saved=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("HR_MYSQL_")));
  for(const key of Object.keys(process.env))if(key.startsWith("HR_MYSQL_"))delete process.env[key];
  const trace=[];let reads=0,connections=0;
  const connection={async query(sql){
    trace.push(sql);assert.ok(SQL.includes(sql),"unexpected real SQL");
    if(sql.startsWith("SELECT payload")) {
      reads++;if(options.changePrivate&&reads===2)fs.writeFileSync(path.join(directory,"auth-users.json"),JSON.stringify({changed:{role:"user"}}));
      const value=reads===2&&options.changedSource?{...original,revision:8}:options.business||original;
      return [[{payload:options.invalidJSON?poison:JSON.stringify(value)}]];
    }
    return [[]];
  },async end(){trace.push("END");}};
  const dependencies={async createConnection(){connections++;if(options.driverError)throw new Error(poison);return connection;}};
  try {return await action({request,dependencies,trace,connections:()=>connections});}
  finally {for(const key of Object.keys(process.env))if(key.startsWith("HR_MYSQL_"))delete process.env[key];Object.assign(process.env,saved);fs.rmSync(directory,{recursive:true,force:true});}
}

test("read-only compatibility diagnosis exercises original business roundtrip and auth validators without a real write or service operation",async()=>{
  await fixture({},async f=>{
    const value=await diagnose(f.request,f.dependencies);
    assert.equal(value.status,"MYSQL_RELATIONAL_COMPATIBILITY_OK");
    assert.deepEqual(f.trace,[...SQL.slice(0,4),"ROLLBACK",SQL[3],"END"]);
    assert.ok(!f.trace.some(sql=>/^(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COMMIT|systemctl)\b/.test(sql)));
    assert.equal(f.connections(),1);assert.equal(value.databaseWritten,false);assert.equal(value.serviceRestarted,false);
    assert.doesNotMatch(JSON.stringify(value),new RegExp(poison));
  });
});

test("duplicate typed record IDs are detected before any target write and only the static validation message is emitted",async()=>{
  await fixture({business:{revision:1,employees:[],updateLogs:[{id:1,operator:poison},{id:1,operator:poison}]}},async f=>{
    const value=await diagnose(f.request,f.dependencies);
    assert.equal(value.status,"MYSQL_RELATIONAL_COMPATIBILITY_ERROR");assert.equal(value.stage,"business-encode");
    assert.equal(value.message,"同一集合记录编号重复");assert.doesNotMatch(JSON.stringify(value),new RegExp(poison));
    assert.ok(f.trace.includes("ROLLBACK"));assert.equal(f.trace.filter(sql=>sql===SQL[3]).length,2);
  });
});

test("the original private account and organization shape checks run only against the memory adapter",async()=>{
  for(const [options,stage,message] of [
    [{users:{synthetic:{employeeId:"1",passwordHash:poison}}},"account-shape","账号字段类型无效，不能有损迁移"],
    [{organization:{options:{buildings:[1]}}},"organization-shape","组织选项结构无效"]
  ])await fixture(options,async f=>{
    const value=await diagnose(f.request,f.dependencies);
    assert.equal(value.stage,stage);assert.equal(value.message,message);
    assert.deepEqual(f.trace,[...SQL.slice(0,4),"ROLLBACK",SQL[3],"END"]);
  });
});

test("driver, JSON parser, and adversarial error contents cannot become diagnostic output",async()=>{
  for(const options of [{driverError:true},{invalidJSON:true}])await fixture(options,async f=>{
    const value=await diagnose(f.request,f.dependencies);
    assert.equal(value.status,"MYSQL_RELATIONAL_COMPATIBILITY_ERROR");
    assert.equal(value.message,"Private diagnostic details withheld");assert.doesNotMatch(JSON.stringify(value),new RegExp(poison));
  });
  const error=Object.assign(new Error(poison),{sql:poison,sqlMessage:poison,stack:poison,code:poison,cause:{secret:poison}});
  assert.deepEqual(safeFailure(error,"connect"),{status:"MYSQL_RELATIONAL_COMPATIBILITY_ERROR",stage:"connect",message:"Private diagnostic details withheld",readOnly:true,databaseWritten:false,serviceRestarted:false});
});

test("new legacy writes and changed private files require a new diagnosis even if a validation error was found",async()=>{
  for(const options of [{changedSource:true},{changePrivate:true},{changedSource:true,business:{employees:[],updateLogs:[{id:1},{id:1}]}}])
    await fixture(options,async f=>{
      const value=await diagnose(f.request,f.dependencies);
      assert.equal(value.status,"MYSQL_RELATIONAL_DIAGNOSTIC_RETRY");assert.equal(value.stage,"source-stability");
      assert.equal(value.message,"Source changed during diagnosis; rerun the read-only check");
      const rollback=f.trace.indexOf("ROLLBACK");assert.ok(rollback>0&&f.trace[rollback+1]===SQL[3]);
    });
});

test("public module tampering is rejected before a database connection",async()=>{
  await fixture({},async f=>{
    f.request.modules["mysql-store.js"]+="\n// unreviewed";
    const value=await diagnose(f.request,f.dependencies);
    assert.equal(value.stage,"public-code");assert.equal(f.connections(),0);assert.deepEqual(f.trace,[]);
  });
});

test("the actual Node subprocess entry emits only its bounded result using synthetic files and a synthetic local driver",async()=>{
  await fixture({},async f=>{
    const driver=path.join(f.request.dataDirectory,"node_modules/mysql2");fs.mkdirSync(driver,{recursive:true});
    const traceFile=path.join(f.request.dataDirectory,"queries.jsonl");
    fs.writeFileSync(path.join(driver,"promise.js"),`const fs=require('node:fs');module.exports.createConnection=async()=>({async query(sql){fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(sql)+'\\n');return sql.startsWith('SELECT payload')?[[{payload:JSON.stringify({employees:[{id:1,name:${JSON.stringify(poison)}}]})}]]:[[]];},async end(){}});`);
    const output=spawnSync(process.execPath,["-e",source,"hr-relational-read-only-diagnostic"],{input:JSON.stringify(f.request),encoding:"utf8",timeout:15000,
      env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("HR_")&&key!=="NODE_OPTIONS"&&key!=="NODE_PATH"))});
    assert.ifError(output.error);assert.equal(output.status,0,output.stderr);assert.equal(output.stderr,"");
    const value=JSON.parse(output.stdout);assert.equal(value.status,"MYSQL_RELATIONAL_COMPATIBILITY_OK");assert.doesNotMatch(output.stdout,new RegExp(poison));
    const queries=fs.readFileSync(traceFile,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    assert.deepEqual(queries,[...SQL.slice(0,4),"ROLLBACK",SQL[3]]);
  });
});

test("protected public paths reject links, shared writable children, and foreign owners while allowing only root's sticky /tmp ancestor",()=>{
  assert.deepEqual(invoke(`import pathlib,types,stat
Pure=pathlib.PurePosixPath
modes={'/':stat.S_IFDIR|0o755,'/tmp':stat.S_IFDIR|0o1777,'/tmp/package':stat.S_IFDIR|0o700,'/tmp/package/source.js':stat.S_IFREG|0o640}
owners={};links={}
class FakePath:
 def __init__(self,value):self.value=str(value)
 @property
 def parents(self):return tuple(FakePath(str(v)) for v in Pure(self.value).parents)
 def lstat(self):return types.SimpleNamespace(st_mode=modes[self.value],st_uid=owners.get(self.value,0),st_nlink=links.get(self.value,1))
 def __eq__(self,other):return isinstance(other,FakePath) and self.value==other.value
m.pathlib=types.SimpleNamespace(Path=FakePath)
m.os=types.SimpleNamespace(path=types.SimpleNamespace(abspath=lambda value:str(value)))
assert m.protected_path('/tmp/package/source.js').value=='/tmp/package/source.js'
for target,bad in [('/tmp/package',stat.S_IFDIR|0o777),('/tmp/package',stat.S_IFLNK|0o777),('/tmp/package/source.js',stat.S_IFREG|0o660)]:
 old=modes[target];modes[target]=bad
 try:m.protected_path('/tmp/package/source.js')
 except m.Refused:pass
 else:raise AssertionError('unsafe public path accepted')
 modes[target]=old
for setting in [owners,links]:
 setting['/tmp/package/source.js']=1001 if setting is owners else 2
 try:m.protected_path('/tmp/package/source.js')
 except m.Refused:pass
 else:raise AssertionError('unsafe file metadata accepted')
 setting.clear()
print(json.dumps({'ok':True}))`),{ok:true});
});

test("Python accepts only bounded allowlisted result fields and never forwards raw subprocess stderr",()=>{
  assert.deepEqual(invoke(`import copy
valid={'status':'MYSQL_RELATIONAL_COMPATIBILITY_ERROR','stage':'business-encode','message':'同一集合记录编号重复','readOnly':True,'databaseWritten':False,'serviceRestarted':False}
assert m.bounded_result(json.dumps(valid).encode())==valid
for key,bad in [('message','SYNTHETIC_PRIVATE_VALUE'),('stage','SYNTHETIC_PRIVATE_VALUE'),('status','SYNTHETIC_PRIVATE_VALUE'),('readOnly',1),('databaseWritten',True)]:
 value=copy.deepcopy(valid);value[key]=bad
 try:m.bounded_result(json.dumps(value).encode())
 except m.Refused:pass
 else:raise AssertionError('unbounded result accepted')
try:m.bounded_result(json.dumps(dict(valid,sql='SYNTHETIC_PRIVATE_VALUE')).encode())
except m.Refused:pass
else:raise AssertionError('private extra field accepted')
print(json.dumps({'ok':True}))`),{ok:true});
});

test("Python runtime inspection invokes one Node diagnosis and no publication, backup, stop, restart, or write-gate operation",()=>{
  assert.deepEqual(invoke(`import types,pathlib
m.os=types.SimpleNamespace(name='posix',geteuid=lambda:0)
m.reviewed_modules=lambda path:{'synthetic':'public'}
seen=[]
helper=types.SimpleNamespace(system_value=lambda name:seen.append(('system_value',name)) or '123',runtime=lambda:seen.append(('runtime',)) or (pathlib.Path('/synthetic/data'),8080,'synthetic'))
m.load_helper=lambda:helper
m.service_environment=lambda helper,pid:{'HR_MYSQL_PASSWORD':'SYNTHETIC_PRIVATE_VALUE'}
value={'status':'MYSQL_RELATIONAL_COMPATIBILITY_OK','stage':'finished','message':'Compatibility checks passed; real SQL constraints still require controlled migration verification','readOnly':True,'databaseWritten':False,'serviceRestarted':False}
def run(args,**kwargs):
 seen.append(('run',args));assert args==['node','-e',m.NODE_DIAGNOSTIC,'hr-relational-read-only-diagnostic'];assert kwargs['env']['HR_MYSQL_PASSWORD']=='SYNTHETIC_PRIVATE_VALUE'
 return types.SimpleNamespace(returncode=0,stdout=json.dumps(value).encode(),stderr=b'SYNTHETIC_PRIVATE_VALUE')
m.subprocess=types.SimpleNamespace(run=run,PIPE=-1)
assert m.diagnose('/synthetic/publication')==value
assert len([row for row in seen if row[0]=='run'])==1
assert all(row[0] in ('runtime','system_value','run') for row in seen)
print(json.dumps({'ok':True}))`),{ok:true});
});

test("Python preflight failures expose only a fixed phase and never the exception, path, or subprocess details",()=>{
  assert.deepEqual(invoke(`import types,pathlib,io,contextlib
m.os=types.SimpleNamespace(name='posix',geteuid=lambda:0)
poison='SYNTHETIC_PRIVATE_VALUE_exception_path_password'
def fail(*args,**kwargs):raise RuntimeError(poison)
valid={'status':'MYSQL_RELATIONAL_COMPATIBILITY_OK','stage':'finished','message':'Compatibility checks passed; real SQL constraints still require controlled migration verification','readOnly':True,'databaseWritten':False,'serviceRestarted':False}
for phase in ('publication-audit','helper-audit','runtime-check','environment-capture','node-execution','node-output'):
 m.reviewed_modules=fail if phase=='publication-audit' else lambda path:{'synthetic':'public'}
 helper=types.SimpleNamespace(system_value=lambda name:'123',runtime=fail if phase=='runtime-check' else lambda:(pathlib.Path('/synthetic/data'),8080,'synthetic'))
 m.load_helper=fail if phase=='helper-audit' else lambda:helper
 m.service_environment=fail if phase=='environment-capture' else lambda *args:{}
 m.subprocess=types.SimpleNamespace(PIPE=-1,run=fail if phase=='node-execution' else lambda *args,**kwargs:types.SimpleNamespace(returncode=0,stdout=poison.encode() if phase=='node-output' else json.dumps(valid).encode(),stderr=poison.encode()))
 output=io.StringIO()
 with contextlib.redirect_stdout(output):assert m.main(['--publication-backup','/synthetic/publication'])==2
 value=json.loads(output.getvalue());assert value['stage']==phase and value['status']=='MYSQL_RELATIONAL_DIAGNOSTIC_STOPPED'
 assert value['message']=='Diagnostic preflight failed; private details withheld'
 assert poison not in output.getvalue() and '/synthetic/' not in output.getvalue()
print(json.dumps({'ok':True}))`),{ok:true});
});
