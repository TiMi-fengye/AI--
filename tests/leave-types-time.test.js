'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function fixture(role='user') {
  const people=[{id:1,name:'演示人员',company:'420',building:'A'},{id:2,name:'其他楼栋人员',building:'B'}];
  const records=[], state={modals:[],mutations:[],notices:[],toasts:[],alerts:[],closed:0};
  const elements={leaveEmployee:{value:'1'},leaveType:{value:'statutoryAnnual'},leaveStart:{value:'2026-11-18T09:15'},leaveEnd:{value:'2026-11-18T11:45'},leaveHours:{value:'1.5'},leaveReason:{value:'测试申请'},leaveHoursGroup:{hidden:true},leaveGuidance:{textContent:''}};
  const user={role,employeeId:1};
  const context=vm.createContext({
    Auth:{currentUser:()=>user,isAdmin:()=>role==='admin',isLeader:()=>role==='leader',canAccessEmployee:id=>role==='admin'||Number(id)===1,canManageEmployee:id=>role!=='user'&&Number(id)===1},
    Store:{getEmployees:()=>people,getLeaveRequests:()=>records,isCompensatoryLeave:r=>r.type==='compensatory',getTimeBalance:()=>({remainingHours:8}),_isOutsourced:()=>false,addLeaveRequest:r=>state.mutations.push(r),flushServerSync:async()=>true},
    App:{currentPage:'leave',toast:(...args)=>state.toasts.push(args),openModal:(...args)=>state.modals.push(args),closeModal:()=>state.closed++,navigate(){}},
    Feishu:{notifyLeave:(person,request)=>{state.notices.push({person,request});return Promise.resolve();}},
    window:{alert:message=>state.alerts.push(message)},
    document:{getElementById:id=>elements[id]||null}
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/leave.js'),'utf8')+'\nglobalThis.Leave=Leave;',context);
  return {Leave:context.Leave,state,elements,people,records};
}

test('leave form exposes the three new categories, preserves renamed legacy keys and requires minute selection',()=>{
  const f=fixture();f.Leave.showApplyModal();
  const html=f.state.modals[0][1], menu=html.match(/<select[^>]*id="leaveType"[^>]*>([\s\S]*?)<\/select>/)[1];
  for(const [type,label] of [['statutoryAnnual','法定年假'],['welfareAnnual','福利年假'],['paidSick','带薪病假'],['annual','年假（外包人员）'],['sick','病假（外包人员）']]) {
    assert.ok(menu.includes('<option value="'+type+'">'+label+'</option>'));
  }
  assert.doesNotMatch(menu,/>年假<|>病假</);
  for(const id of ['leaveStart','leaveEnd']) {
    const input=html.match(new RegExp('<input[^>]*id="'+id+'"[^>]*>'))[0];
    assert.match(input,/type="datetime-local"/);assert.match(input,/step="60"/);assert.match(input,/required/);
  }
  assert.match(html,/含首尾日/);assert.match(html,/调休按填写小时数/);
});

test('new and renamed categories save their stable keys and exact wall-clock minutes, and notify readable labels',async()=>{
  for(const [type,label] of [['statutoryAnnual','法定年假'],['welfareAnnual','福利年假'],['paidSick','带薪病假'],['annual','年假（外包人员）'],['sick','病假（外包人员）']]) {
    const f=fixture();f.elements.leaveType.value=type;await f.Leave.saveApply();
    assert.equal(f.state.mutations.length,1);const request=f.state.mutations[0];
    assert.equal(request.type,type);assert.equal(request.startDate,'2026-11-18T09:15');assert.equal(request.endDate,'2026-11-18T11:45');
    assert.equal(request.days,1);assert.equal(request.status,'pending');assert.equal(request.hours,0);
    assert.equal(f.state.notices[0].request.type,label);assert.equal(f.state.closed,1);
  }
});

test('request table shows minute precision and keeps legacy date-only requests without invented midnight',()=>{
  const f=fixture();
  f.records.push({id:1,employeeId:1,type:'annual',startDate:'2026-11-01',endDate:'2026-11-03',days:3,status:'approved'},
    {id:2,employeeId:1,type:'paidSick',startDate:'2026-11-18T09:15',endDate:'2026-11-18T11:45',days:1,status:'pending'},
    {id:3,employeeId:1,type:'sick',startDate:'2026-10-01',endDate:'2026-10-01',days:1,status:'approved'});
  const html=f.Leave._renderTable(f.records,f.people);
  assert.match(html,/2026-11-18 09:15 ~ 2026-11-18 11:45/);assert.match(html,/2026-11-01 ~ 2026-11-03/);
  assert.match(html,/年假（外包人员）/);assert.match(html,/病假（外包人员）/);assert.match(html,/带薪病假/);
  assert.doesNotMatch(html,/00:00|T09:15|T11:45/);
});

test('new submissions reject missing minutes, impossible calendar times, seconds, offsets and nonpositive periods',async()=>{
  const pairs=[
    ['2026-11-18','2026-11-19'],['','2026-11-18T11:45'],['2026-02-29T09:15','2026-03-01T11:45'],
    ['2026-04-31T09:15','2026-05-01T11:45'],['2026-13-01T09:15','2027-01-02T11:45'],
    ['2026-11-18T24:00','2026-11-19T11:45'],['2026-11-18T09:60','2026-11-18T11:45'],
    ['2026-11-18T09:15:00','2026-11-18T11:45'],['2026-11-18T09:15Z','2026-11-18T11:45'],
    ['2026-11-18T09:15+08:00','2026-11-18T11:45'],['2026-11-18T11:45','2026-11-18T11:45'],
    ['2026-11-18T11:46','2026-11-18T11:45'],['0000-11-18T09:15','0000-11-18T11:45']
  ];
  for(const [start,end] of pairs) {
    const f=fixture();f.elements.leaveStart.value=start;f.elements.leaveEnd.value=end;await f.Leave.saveApply();
    assert.equal(f.state.mutations.length,0,start+' / '+end);assert.equal(f.state.notices.length,0);
    assert.ok(f.state.toasts.some(([message])=>/有效起止时间/.test(message)));assert.equal(f.state.closed,0);
  }
});

test('cross-day leave retains inclusive calendar-day accounting rather than elapsed-hour rounding',async()=>{
  for(const [start,end,days] of [
    ['2026-11-18T23:59','2026-11-19T00:01',2],
    ['2026-11-18T08:00','2026-11-19T18:00',2],
    ['2028-02-28T23:59','2028-03-01T00:01',3],
    ['2026-12-31T23:59','2027-01-01T00:00',2]
  ]) {
    const f=fixture();f.elements.leaveStart.value=start;f.elements.leaveEnd.value=end;await f.Leave.saveApply();
    assert.equal(f.state.mutations.length,1);assert.equal(f.state.mutations[0].days,days);
  }
});

test('minute timestamps do not change compensatory hours, reminders or permission checks',async()=>{
  const f=fixture();f.elements.leaveType.value='compensatory';await f.Leave.saveApply();
  assert.equal(f.state.mutations[0].hours,1.5);assert.equal(f.state.mutations[0].days,1);assert.match(f.state.alerts[0],/邮件.*审批/);
  const denied=fixture();denied.elements.leaveEmployee.value='2';await denied.Leave.saveApply();
  assert.equal(denied.state.mutations.length,0);assert.equal(denied.state.notices.length,0);assert.equal(denied.state.alerts.length,0);
  const unknown=fixture();unknown.elements.leaveType.value='__proto__';await unknown.Leave.saveApply();
  assert.equal(unknown.state.mutations.length,0);assert.ok(unknown.state.toasts.some(([message])=>/有效请假类型/.test(message)));
});

test('rendered minute or historical values remain HTML escaped',()=>{
  const f=fixture();
  f.records.push({id:1,employeeId:1,type:'other',startDate:'<img src=x onerror=alert(1)>',endDate:'2026-11-18T11:45',reason:'<script>alert(1)</script>',status:'pending',days:1});
  const html=f.Leave._renderTable(f.records,f.people);
  assert.doesNotMatch(html,/<img|<script>/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);
});
