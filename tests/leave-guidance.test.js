'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function fixture(role='user') {
  const people=[{id:1,name:'演示甲',company:'420',building:'A'},{id:2,name:'演示乙',company:'联想外包',building:'A'},{id:3,name:'不可见人员',company:'420',building:'B'}];
  const balances={1:0,2:0,3:8},state={alerts:[],toasts:[],modals:[],mutations:[],closed:0};
  const elements={leaveEmployee:{value:'1'},leaveType:{value:'compensatory'},leaveStart:{value:'2026-11-16T09:00'},leaveEnd:{value:'2026-11-16T18:00'},leaveHours:{value:'1'},leaveReason:{value:'保留此原因'},leaveHoursGroup:{hidden:true},leaveGuidance:{textContent:''}};
  const user={role,employeeId:1,company:'420'};
  const context=vm.createContext({
    window:{alert:message=>state.alerts.push(message)},
    Auth:{currentUser:()=>user,isAdmin:()=>role==='admin',isLeader:()=>role==='leader',canAccessEmployee:id=>role==='admin'||(role==='leader'?people.some(p=>p.id===Number(id)&&p.building==='A'):Number(id)===1),canManageEmployee:()=>role!=='user'},
    Store:{getEmployees:()=>people,getTimeBalance:id=>({remainingHours:balances[id]}),getLeaveRequests:()=>[],_isOutsourced:()=>false,addLeaveRequest:r=>state.mutations.push(r),flushServerSync:async()=>true},
    App:{currentPage:'leave',today:()=> '2026-11-16',toast:(...args)=>state.toasts.push(args),openModal:(...args)=>state.modals.push(args),closeModal:()=>state.closed++,navigate(){}},
    document:{getElementById:id=>elements[id]||null}
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/leave.js'),'utf8')+'\nglobalThis.Leave=Leave;',context);
  return {Leave:context.Leave,context,state,elements,people,balances,user};
}

test('420 zero balance alerts ERP leave categories and retains the whole application form',async()=>{
  const f=fixture();f.Leave.updateHoursField();
  assert.equal(f.elements.leaveHoursGroup.hidden,false);assert.match(f.state.alerts[0],/ERP.*法定年假、福利年假或带薪病假/);
  assert.equal(f.elements.leaveReason.value,'保留此原因');assert.equal(f.elements.leaveStart.value,'2026-11-16T09:00');assert.equal(f.state.modals.length,0);assert.equal(f.state.closed,0);
  await f.Leave.saveApply();assert.equal(f.state.mutations.length,0);assert.equal(f.state.closed,0);
});
test('non-420 zero or negative balance directs the selected person to the leader and own platform',()=>{
  const f=fixture('admin');f.elements.leaveEmployee.value='2';f.balances[2]=-2;f.Leave.updateHoursField();
  assert.match(f.state.alerts[0],/联系楼长.*所属平台/);assert.doesNotMatch(f.state.alerts[0],/ERP|法定年假|邮件/);
});
test('420 uses exact trimmed personnel nature instead of current account, employee number or substring',()=>{
  const f=fixture('admin');f.elements.leaveEmployee.value='2';
  for(const company of [' 420 ',420]){f.people[1].company=company;f.Leave._guidanceKey='';f.Leave.updateHoursField();assert.match(f.state.alerts.at(-1),/ERP/);}
  for(const company of ['420外包','世纪互联','',null]){f.people[1].company=company;f.people[1].employeeNo='420';f.Leave._guidanceKey='';f.Leave.updateHoursField();assert.match(f.state.alerts.at(-1),/联系楼长/);}
});
test('positive balance reminds email approval once and still creates only a pending request',async()=>{
  const f=fixture();f.balances[1]=8;f.Leave.updateHoursField();f.Leave.updateHoursField();assert.equal(f.state.alerts.length,1);assert.match(f.state.alerts[0],/8\.0.*发送.*邮件.*审批/);
  await f.Leave.saveApply();assert.equal(f.state.alerts.length,1);assert.equal(f.state.mutations.length,1);assert.equal(f.state.mutations[0].status,'pending');assert.equal(f.state.mutations[0].hours,1);
});
test('direct submit cannot bypass zero-balance reminder; positive submit also receives its email reminder',async()=>{
  const f=fixture();await f.Leave.saveApply();assert.match(f.state.alerts[0],/ERP/);assert.equal(f.state.mutations.length,0);
  f.balances[1]=2;await f.Leave.saveApply();assert.match(f.state.alerts[1],/邮件/);assert.equal(f.state.mutations.length,1);
});
test('positive but insufficient balance preserves the existing limit and does not misdirect to ERP',async()=>{
  const f=fixture();f.balances[1]=0.5;f.Leave.updateHoursField();await f.Leave.saveApply();
  assert.match(f.state.alerts[0],/邮件/);assert.ok(f.state.toasts.some(x=>/调休时长不足/.test(x[0])));assert.equal(f.state.mutations.length,0);assert.ok(f.state.alerts.every(x=>!x.includes('ERP')));
});
test('selection changes show the correct reminder while other leave types do not show guidance',async()=>{
  const f=fixture('leader');f.Leave.updateHoursField();f.elements.leaveEmployee.value='2';f.Leave.updateHoursField();assert.match(f.state.alerts[1],/联系楼长/);
  f.elements.leaveType.value='annual';f.Leave.updateHoursField();assert.equal(f.elements.leaveHoursGroup.hidden,true);await f.Leave.saveApply();assert.equal(f.state.alerts.length,2);assert.equal(f.state.mutations[0].type,'annual');
  f.elements.leaveType.value='compensatory';f.Leave.updateHoursField();assert.equal(f.state.alerts.length,3);
});
test('unknown or inaccessible person cannot reveal a reminder or submit; invalid balances block safely',async()=>{
  const f=fixture('leader');f.elements.leaveEmployee.value='3';f.Leave.updateHoursField();await f.Leave.saveApply();assert.equal(f.state.alerts.length,0);assert.equal(f.state.mutations.length,0);
  f.elements.leaveEmployee.value='1';for(const value of [NaN,Infinity,undefined]){f.balances[1]=value;await f.Leave.saveApply();assert.match(f.state.alerts.at(-1),/读取异常/);}assert.equal(f.state.mutations.length,0);
});
test('opening a fresh application resets reminder state and binds employee changes',()=>{
  const f=fixture();f.Leave._guidanceKey='old';f.Leave.showApplyModal();assert.equal(f.Leave._guidanceKey,'');assert.match(f.state.modals[0][1],/id="leaveEmployee" onchange="Leave.updateHoursField\(\)"/);
});
