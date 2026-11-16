'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function storage() {
  const values={};Object.defineProperties(values,{
    getItem:{value:key=>Object.prototype.hasOwnProperty.call(values,key)?values[key]:null},
    setItem:{value:(key,value)=>{values[key]=String(value);}},removeItem:{value:key=>{delete values[key];}}
  });return values;
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function response(data,ok=true){return {ok,json:async()=>data};}
function fixture(role='leader') {
  const writes=[],localStorage=storage(),sessionStorage=storage(),events={focus:[],visibilitychange:[]};
  const context=vm.createContext({console,setTimeout,clearTimeout,localStorage,sessionStorage,
    fetch:async()=>{throw Error('Unexpected network request');},App:{toast(){}},window:{location:{},addEventListener:(name,fn)=>events[name].push(fn)},document:{visibilityState:'visible',addEventListener:(name,fn)=>events[name].push(fn)}});
  for(const [file,name] of [['store','Store'],['auth','Auth']]) vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/'+file+'.js'),'utf8')+'\nglobalThis.'+name+'='+name+';',context);
  context.Auth._user={username:'synthetic',name:'合成账号',role,employeeId:1,buildings:role==='leader'?['A']:[]};
  context.Auth._updateUI=()=>{};context.Store.clearSessionData();
  return {context,Store:context.Store,Auth:context.Auth,localStorage,sessionStorage,writes,events};
}
const syntheticEmployees=(count,size)=>Array.from({length:count},(_,i)=>({id:i+1,name:'合成人员'+(i+1),building:i%2?'B':'A',employeeNo:'000'+i,resumeData:'x'.repeat(size),credentialData:'',nested:{notes:['原始']}}));

test('detached JSON containers share immutable attachment strings without serialization',()=>{
  const f=fixture(),employees=syntheticEmployees(150,64*1024);f.Store.set('employees',employees);
  employees[0].nested.notes.push('外部修改');assert.deepEqual(Array.from(f.Store.getEmployees()[0].nested.notes),['原始']);
  vm.runInContext('globalThis.serializations=0;const stringify=JSON.stringify;JSON.stringify=function(value){globalThis.serializations++;return stringify.apply(this,arguments);};',f.context);
  const first=f.Store.getEmployees(),second=f.Store.getEmployees();
  assert.equal(f.context.serializations,0);assert.equal(first[0].resumeData.length,64*1024);assert.equal(first[0].resumeData,second[0].resumeData);
  first[0].name='仅副本';first[0].nested.notes.push('副本修改');first.push({id:999});
  assert.equal(second.length,150);assert.equal(second[0].name,'合成人员1');assert.deepEqual(Array.from(second[0].nested.notes),['原始']);
  assert.equal(f.localStorage.getItem('personnel_management_employees'),null);
});

test('safe clone follows JSON values for arrays/nonfinite numbers and cannot alter prototypes',()=>{
  const f=fixture();const sample=JSON.parse('{"__proto__":{"polluted":true},"constructor":{"flag":"kept"},"nested":{"value":1}}');
  sample.nan=NaN;sample.infinity=Infinity;sample.array=[undefined,NaN,()=>{}];sample.omitted=undefined;sample.func=()=>{};
  f.Store.set('employees',[sample]);const result=f.Store.getEmployees()[0];
  assert.equal(Object.prototype.hasOwnProperty.call(result,'__proto__'),true);assert.equal(result.__proto__.polluted,true);
  assert.equal(Object.prototype.polluted,undefined);assert.equal(result.constructor.flag,'kept');
  assert.equal(result.nan,null);assert.equal(result.infinity,null);assert.deepEqual(Array.from(result.array),[null,null,null]);assert.equal('omitted' in result,false);assert.equal('func' in result,false);
  result.nested.value=2;assert.equal(f.Store.getEmployees()[0].nested.value,1);
  const circular={};circular.self=circular;assert.throws(()=>f.Store.set('employees',[circular]),/循环引用/);
  assert.throws(()=>f.Store.set('employees',[{value:1n}]),/BigInt/);
});

test('150 permission checks use zero full personnel clones, preserve scope, and react to changed assignments',()=>{
  const f=fixture(),employees=syntheticEmployees(150,256*1024);f.Store.set('employees',employees);
  let fullReads=0;const get=f.Store.getEmployees;f.Store.getEmployees=function(){fullReads++;return get.call(this);};
  const visible=employees.filter(e=>f.Auth.canAccessEmployee(e.id));assert.equal(visible.length,75);assert.equal(fullReads,0);
  assert.equal(f.Auth.canManageEmployee('1'),true);assert.equal(f.Auth.canAccessEmployee(2),false);assert.equal(f.Auth.canAccessEmployee(999),false);
  f.Auth._user.buildings=['B'];assert.equal(f.Auth.canAccessEmployee(1),false);assert.equal(f.Auth.canManageEmployee(2),true);
  f.Store.updateEmployee(2,{building:'A'});assert.equal(f.Auth.canAccessEmployee(2),false);
  f.Auth._user={username:'other',role:'user',employeeId:1};assert.equal(f.Auth.canAccessEmployee(2),false);assert.equal(f.Auth.canAccessEmployee(1),true);
});

test('late snapshot responses cannot restore the prior account, overwrite newer reads, or survive logout',async()=>{
  const f=fixture('admin'),pending=[];f.context.fetch=()=>{const d=deferred();pending.push(d);return d.promise;};
  const first=f.Store.restoreFromServer(),second=f.Store.restoreFromServer();
  pending[1].resolve(response({employees:[{id:2,name:'最新范围'}],revision:2}));assert.equal(await second,true);
  pending[0].resolve(response({employees:[{id:1,name:'旧范围'}],revision:1}));assert.equal(await first,false);assert.equal(f.Store.getEmployees()[0].name,'最新范围');
  const logout=f.Store.restoreFromServer();f.Store.clearSessionData();f.Auth._user=null;
  pending[2].resolve(response({employees:[{id:1,name:'已退出资料'}]}));assert.equal(await logout,false);assert.equal(f.Store.getEmployees().length,0);
  f.Auth._user={username:'second',role:'user',employeeId:3};const changed=f.Store.restoreFromServer();f.Auth._user={username:'third',role:'user',employeeId:4};
  pending[3].resolve(response({employees:[{id:3,name:'另一账号'}]}));assert.equal(await changed,false);assert.equal(f.Store.getEmployees().length,0);
});

test('late authentication/session reads cannot replace newer login or the latest init',async()=>{
  const f=fixture(),pending=[];f.context.fetch=url=>{const d=deferred();pending.push({url,...d});return d.promise;};
  const first=f.Auth.init(),second=f.Auth.init();
  pending[2].resolve(response({user:{username:'new',role:'user',employeeId:2}}));pending[3].resolve(response({setupRequired:false}));await second;
  pending[0].resolve(response({user:{username:'old',role:'admin'}}));pending[1].resolve(response({setupRequired:false}));assert.equal(await first,null);assert.equal(f.Auth.currentUser().username,'new');
  const beforeLogin=f.Auth.init(),login=f.Auth.login('newer','synthetic password');
  pending[6].resolve(response({ok:true,user:{username:'newer',role:'leader',buildings:['B']}}));assert.equal((await login).success,true);
  pending[4].resolve(response({user:{username:'old',role:'admin'}}));pending[5].resolve(response({setupRequired:false}));assert.equal(await beforeLogin,null);assert.equal(f.Auth.currentUser().username,'newer');
});

test('logout invalidates an in-flight session read and late login responses',async()=>{
  const f=fixture(),pending=[];f.context.fetch=url=>{const d=deferred();pending.push({url,...d});return d.promise;};
  const init=f.Auth.init(),logout=f.Auth.logout();
  pending[2].resolve(response({ok:true}));await logout;assert.equal(f.Auth.currentUser(),null);
  pending[0].resolve(response({user:{username:'old',role:'admin'}}));pending[1].resolve(response({setupRequired:false}));assert.equal(await init,null);assert.equal(f.Auth.currentUser(),null);
  const login=f.Auth.login('late','synthetic password'),logoutAgain=f.Auth.logout();pending[4].resolve(response({ok:true}));await logoutAgain;
  pending[3].resolve(response({ok:true,user:{username:'late',role:'admin'}}));assert.equal((await login).success,false);assert.equal(f.Auth.currentUser(),null);
});

test('late save success cannot change a new account or its snapshot after session cleanup',async()=>{
  const f=fixture('admin');f.Store._hydrate({employees:[{id:1,name:'旧账号人员'}],revision:1});f.Store._serverSyncReady=true;f.Store._writeVersion=1;
  const pending=deferred();f.context.fetch=()=>pending.promise;const saving=f.Store.flushServerSync();
  f.Store.clearSessionData();f.Auth._user={username:'next',role:'user',employeeId:2};f.Store._hydrate({employees:[{id:2,name:'新账号人员'}],revision:9});f.Store._revision=9;
  pending.resolve(response({ok:true,user:{username:'synthetic',role:'admin'},revision:2}));await assert.rejects(saving,/登录状态已变化/);
  assert.equal(f.Auth.currentUser().username,'next');assert.equal(f.Store.getEmployees()[0].name,'新账号人员');assert.equal(f.Store._revision,9);
});

function bootFixture() {
  const f=fixture('admin'),elements={pageTitle:{textContent:''},pageContent:{textContent:'',innerHTML:'',classList:{remove(){}},appendChild(){}},dashboardBuildingHeadcount:{innerHTML:''},introVideoBtn:{hidden:false}},calls=[],pending=[];
  f.context.Employees={_escape:value=>f.Auth.escape(value)};
  f.context.document.getElementById=id=>elements[id]||null;f.context.document.querySelectorAll=()=>[];f.context.document.createElement=()=>({});
  for(const [file,name] of [['app','App'],['dashboard','Dashboard']]) vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/'+file+'.js'),'utf8')+'\nglobalThis.'+name+'='+name+';',f.context);
  f.context.Auth.init=async()=>({user:f.Auth.currentUser()});f.context.App._renderSidebar=()=>calls.push('sidebar');f.context.App._clock=()=>{};f.context.App._monthlyReminder=()=>{};f.context.App.toast=(message)=>calls.push(message);
  for(const method of ['_deductionCard','_increaseCard','_leaveCard','_otCard','_buildingTimeBalanceCard','_monthChangesCard','_newEmployeesCard','_updateLogCard']) f.context.Dashboard[method]=()=>'';
  f.Store.getOrCalcSettlement=()=>null;
  f.localStorage.setItem('personnel_data_owner','synthetic');
  f.context.fetch=(url)=>{const d=deferred();pending.push({url,...d});return d.promise;};
  const snapshot={employees:[{id:1,name:'合成首页人员',building:'A'}],revision:1};
  const organization={ok:true,options:{buildings:['A']},buildingLeaders:[{building:'A',leaders:'授权楼长'}],revision:1};
  return {...f,App:f.context.App,Dashboard:f.context.Dashboard,elements,calls,pending,snapshot,organization};
}
async function tick(){await new Promise(resolve=>setImmediate(resolve));}

test('startup snapshot and organization run concurrently; first dashboard reuses only that fresh response',async()=>{
  const f=bootFixture();const startup=f.App.init();await tick();
  assert.deepEqual(f.pending.map(p=>p.url).sort(),['/api/data/snapshot.json','/api/organization/settings']);
  assert.equal(f.calls.includes('sidebar'),false);
  f.pending.find(p=>p.url.includes('snapshot')).resolve(response(f.snapshot));await tick();assert.equal(f.calls.includes('sidebar'),false);
  f.pending.find(p=>p.url.includes('organization')).resolve(response(f.organization));await startup;
  assert.equal(f.pending.length,2,'first dashboard must not fetch organization a second time');assert.equal(f.App.currentPage,'dashboard');
  assert.match(f.elements.pageContent.innerHTML,/授权楼长/);assert.equal(f.Store._serverSyncReady,true);
  f.App.navigate('dashboard');await tick();assert.equal(f.pending.length,3,'later page entry reads current appointments');
  f.pending[2].resolve(response(f.organization));await tick();
  f.events.focus[0]();await tick();assert.equal(f.pending.length,4,'focus refresh is still live');f.pending[3].resolve(response(f.organization));await tick();
});

test('a retry invalidates the older startup and stale configuration cannot override the new response',async()=>{
  const f=bootFixture();const first=f.App.init();await tick();
  f.pending.find(p=>p.url.includes('snapshot')).reject(Error('临时读取失败'));await first;assert.match(f.elements.pageContent.textContent,/加载失败/);
  const retry=f.App.init();await tick();assert.equal(f.pending.length,4);
  f.pending[2].resolve(response({...f.organization,buildingLeaders:[{building:'A',leaders:'新任楼长'}]}));f.pending[3].resolve(response({...f.snapshot,employees:[{id:3,name:'重试当前人员',building:'A'}]}));await retry;
  f.pending[0].resolve(response(f.organization));await tick();
  assert.equal(f.Store.getEmployees()[0].name,'重试当前人员');assert.equal(f.calls.filter(c=>c==='sidebar').length,1);
  assert.match(f.elements.pageContent.innerHTML,/新任楼长/);assert.doesNotMatch(f.elements.pageContent.innerHTML,/授权楼长/);
});

test('overlapping initialization or logout cannot publish a late old home screen',async()=>{
  const f=bootFixture();const first=f.App.init();await tick();const second=f.App.init();await tick();
  f.pending[2].resolve(response(f.organization));f.pending[3].resolve(response(f.snapshot));await second;
  const fresh=f.elements.pageContent.innerHTML;
  f.pending[0].resolve(response({...f.organization,buildingLeaders:[{building:'A',leaders:'旧名单'}]}));f.pending[1].resolve(response({employees:[{id:7,name:'旧人员'}]}));await first;
  assert.equal(f.elements.pageContent.innerHTML,fresh);assert.equal(f.calls.filter(c=>c==='sidebar').length,1);
  const logout=bootFixture();const loading=logout.App.init();await tick();logout.Auth._user=null;logout.Store.clearSessionData();
  logout.pending[0].resolve(response(logout.organization));logout.pending[1].resolve(response(logout.snapshot));await loading;
  assert.equal(logout.calls.includes('sidebar'),false);assert.equal(logout.Store.getEmployees().length,0);
});
