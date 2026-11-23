'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(role='leader') {
  const employees=[
    {id:1,name:'合成甲',building:'A',region:'北区'},
    {id:2,name:'合成乙',building:'B',region:'南区'},
    {id:3,name:'合成丙',building:'C',region:'北区'},
    {id:4,name:'合成本人',building:'B',region:'南区'}
  ];
  const overtime=[
    {id:11,employeeId:1,status:'pending',overtimeType:'fee',date:'2026-11-23',hours:2},
    {id:12,employeeId:1,status:'pending',approvalStage:'regional',overtimeType:'compensatory',date:'2026-11-23',hours:3},
    {id:13,employeeId:1,status:'approved',date:'2026-11-23',hours:4},
    {id:14,employeeId:1,status:'approved',approvalStage:'complete',date:'2026-11-23',hours:5},
    {id:15,employeeId:2,status:'pending',approvalStage:'regional',date:'2026-11-23',hours:2},
    {id:16,employeeId:3,status:'pending',approvalStage:'regional',date:'2026-11-23',hours:2},
    {id:17,employeeId:4,status:'pending',approvalStage:'regional',date:'2026-11-23',hours:2}
  ];
  const leaves=overtime.map(row=>({...row,id:row.id+10,type:'statutoryAnnual',startDate:'2026-11-23T09:15',endDate:'2026-11-23T10:45',days:1,hours:1}));
  const elements={};
  const state={role,employeeId:4,remainingHours:8,calls:[],mutations:[],toasts:[],modals:[],navigations:[],confirm:true,confirmations:[],notifications:[],requests:[]};
  const scoped=id=>employees.some(e=>e.id===Number(id) && (state.role==='admin'||(state.role==='leader'&&e.building==='A')||(state.role==='region_manager'&&e.region==='北区')));
  const access=id=>scoped(id)||(state.role==='user'||state.role==='region_manager')&&Number(id)===state.employeeId;
  const find=(kind,id)=>(kind==='overtime'?overtime:leaves).find(row=>row.id===Number(id));
  state.submit=async(kind,id,decision)=>{
    const row=find(kind,id), twoStage=kind==='overtime'||['statutoryAnnual','welfareAnnual','paidSick'].includes(row.type);
    if (decision==='approved'&&twoStage&&(row.approvalStage||'leader')==='leader') {row.status='pending';row.approvalStage='regional';}
    else {row.status=decision;row.approvalStage='complete';}
    return {ok:true,record:row,notification:state.notification||null};
  };
  state.fetch=async(url,options)=>({ok:true,json:async()=>({ok:true,notifications:state.notifications})});
  const context=vm.createContext({
    Auth:{isAdmin:()=>state.role==='admin',isLeader:()=>state.role==='leader',isRegionalManager:()=>state.role==='region_manager',
      currentUser:()=>({username:'合成账号',role:state.role,employeeId:state.employeeId,buildings:['A'],regions:['北区']}),
      canAccessEmployee:access,canApproveEmployee:scoped,
      canManageEmployee:id=>(state.role==='admin'||state.role==='leader')&&scoped(id)||state.role==='region_manager'&&Number(id)===state.employeeId},
    Store:{_sessionEpoch:1,getEmployees:()=>employees,getOvertime:()=>overtime,getLeaveRequests:()=>leaves,
      isCompensatoryLeave:row=>row.type==='compensatory',getTimeBalance:()=>({remainingHours:state.remainingHours}),
      submitApproval:(...args)=>{state.calls.push(args);return state.submit(...args);},
      updateOvertime:(...args)=>state.mutations.push(['updateOvertime',...args]),
      updateLeaveRequest:(...args)=>state.mutations.push(['updateLeaveRequest',...args]),
      flushServerSync:async()=>true},
    App:{currentPage:'attendance',today:()=> '2026-11-23',toast:(...args)=>state.toasts.push(args),
      navigate:page=>state.navigations.push(page),closeModal:()=>{delete elements.leaveNotificationContent;},
      confirm:message=>{state.confirmations.push(message);return state.confirm;},
      openModal:(...args)=>{state.modals.push(args);if(args[1].includes('id="leaveNotificationContent"')) elements.leaveNotificationContent={innerHTML:'',textContent:''};}},
    Attendance:{_activeTab:''},document:{getElementById:id=>elements[id]},
    fetch:(url,options)=>{state.requests.push([url,options]);return state.fetch(url,options);}
  });
  for(const name of ['overtime','leave']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..','js',name+'.js'),'utf8'),context);
  vm.runInContext('globalThis.modules={Overtime,Leave};',context);
  return {...context.modules,state,employees,overtime,leaves,elements,context};
}

test('stage controls are role and scope specific while legacy pending means leader',()=>{
  for(const role of ['admin','leader','region_manager','user']) {
    const f=fixture(role);
    for(const [module,rows,leaderId,regionalId,otherRegionId,sameRegionId,ownOutsideId] of [
      [f.Overtime,f.overtime,11,12,15,16,17],[f.Leave,f.leaves,21,22,25,26,27]
    ]) {
      const html=module._renderTable(rows,f.employees), name=module===f.Leave?'Leave':'Overtime';
      const has=id=>html.includes(name+'.approve('+id+')');
      assert.equal(has(leaderId),role==='admin'||role==='leader');
      assert.equal(has(regionalId),role==='admin'||role==='region_manager');
      assert.equal(has(otherRegionId),role==='admin');
      assert.equal(has(sameRegionId),role==='admin'||role==='region_manager');
      assert.equal(has(ownOutsideId),role==='admin');
      if(role!=='user') assert.match(html,/待区域经理终审/);
      if(role==='leader'||role==='admin') assert.match(html,/待楼长审批/);
      if(role==='region_manager') {
        assert.match(html,/合成丙/); assert.match(html,/合成本人/); assert.doesNotMatch(html,/合成乙/);
        assert.doesNotMatch(html,/deleteRecord|Leave\.delete\(|showEditModal/);
      }
    }
  }
});

test('out of stage, out of region, ordinary and completed direct approvals make no requests',async()=>{
  for(const [role,ids] of [['leader',[12,15,16,17]],['region_manager',[11,15,17]],['user',[11,12,17]],['admin',[13,14]]]) {
    const f=fixture(role);
    for(const id of ids) {await f.Overtime.approve(id);await f.Leave.reject(id+10);}
    assert.equal(f.state.calls.length,0); assert.equal(f.state.mutations.length,0);
  }
});

test('both overtime types need leader then regional approval without locally forging status',async()=>{
  for(const type of ['fee','compensatory']) {
    const f=fixture();f.overtime[0].overtimeType=type;
    await f.Overtime.approve(11);
    assert.deepEqual(f.state.calls,[['overtime',11,'approved']]);
    assert.equal(f.overtime[0].status,'pending'); assert.equal(f.overtime[0].approvalStage,'regional');
    assert.match(f.state.toasts[0][0],/等待区域经理终审/); assert.doesNotMatch(f.state.toasts[0][0],/最终批准/);
    assert.equal(f.state.mutations.length,0);
    f.state.role='region_manager';await f.Overtime.approve(11);
    assert.equal(f.overtime[0].status,'approved');assert.equal(f.overtime[0].approvalStage,'complete');
    assert.match(f.state.toasts.at(-1)[0],/最终批准/);
  }
});

test('administrators advance one stage per action for overtime and the three legal leave types',async()=>{
  for(const type of ['statutoryAnnual','welfareAnnual','paidSick']) {
    const f=fixture('admin');f.leaves[0].type=type;
    for(const [module,id,row] of [[f.Leave,21,f.leaves[0]],[f.Overtime,11,f.overtime[0]]]) {
      await module.approve(id); assert.equal(row.status,'pending'); assert.equal(row.approvalStage,'regional');
      await module.approve(id); assert.equal(row.status,'approved');assert.equal(row.approvalStage,'complete');
    }
    assert.equal(f.state.mutations.length,0);
  }
});

test('compensatory and existing shift leave become effective after leader approval and show truthful SMS status',async()=>{
  for(const type of ['compensatory','shift']) for(const [status,reason,label] of [
    ['blocked','sms_not_configured',/待配置/],['blocked','manager_phone_missing',/未填写/],
    ['sent',null,/已提交短信平台/],['uncertain','delivery_unknown',/结果不确定/],['pending',null,/待处理/]
  ]) {
    const f=fixture();f.leaves[0].type=type;f.state.notification={id:'synthetic',status,reason};
    await f.Leave.approve(21);
    assert.equal(f.leaves[0].status,'approved'); assert.equal(f.leaves[0].approvalStage,'complete');
    assert.match(f.state.toasts[0][0],/最终批准/);assert.match(f.state.toasts[1][0],label);
    assert.doesNotMatch(f.state.toasts[1][0],/短信已送达|已通知到达/);
    assert.equal(f.state.toasts[1][1],status==='sent'?'info':'warning');
    assert.equal(f.Leave._types.shift,'替班请假');assert.equal(f.Leave._types.substitute,undefined);
  }
});

test('unchanged one-stage leave types keep a direct approval action rather than imply a second stage',async()=>{
  for(const type of ['annual','sick','personal','marriage','maternity','other','leave']) {
    const f=fixture();f.leaves[0].type=type;
    const html=f.Leave._renderTable([f.leaves[0]],f.employees);
    assert.match(html,/Leave\.approve\(21\)\">批准<\/button>/);
    assert.doesNotMatch(html,/初审通过|批准并通知/);
    await f.Leave.approve(21);assert.equal(f.leaves[0].status,'approved');assert.equal(f.state.toasts.length,1);
  }
});

test('approval waits for the server snapshot and repeat clicks do not submit twice',async()=>{
  for(const [name,id] of [['Overtime',11],['Leave',21]]) {
    const f=fixture();let acknowledge;
    const submit=f.state.submit;f.state.submit=(...args)=>new Promise(resolve=>{acknowledge=async()=>resolve(await submit(...args));});
    const waiting=f[name].approve(id);await f[name].approve(id);
    assert.equal(f.state.calls.length,1);assert.equal(f.state.mutations.length,0);
    assert.equal(f.state.toasts.length,0);assert.equal(f.state.navigations.length,0);
    await acknowledge();await waiting;
    assert.match(f.state.toasts[0][0],/等待区域经理终审/);assert.equal(f[name]._saving,false);
  }
});

test('server denial, uncertain commits and session changes never report a successful approval',async()=>{
  for(const [name,id] of [['Overtime',11],['Leave',21]]) for(const sessionChanged of [false,true]) {
    const f=fixture();f.state.submit=async()=>{throw Object.assign(new Error('审批可能已提交，请刷新核对，不要重复审批'),{sessionChanged,approvalMayBeCommitted:true});};
    await f[name].approve(id);
    assert.equal(f.state.mutations.length,0);assert.equal(f.state.navigations.length,0);
    assert.equal(f.state.toasts.length,sessionChanged?0:1);
    if(!sessionChanged) assert.equal(f.state.toasts[0][1],'error');
    assert.equal(f[name]._saving,false);
  }
});

test('regional managers can view regional applications but only create their own and never edit',()=>{
  const f=fixture('region_manager');
  for(const module of [f.Overtime,f.Leave]) {
    assert.equal(module._canApply(1),false);assert.equal(module._canApply(3),false);assert.equal(module._canApply(4),true);
  }
  f.Overtime.showAddModal();f.Leave.showApplyModal();
  for(const [,html] of f.state.modals) {assert.match(html,/合成本人/);assert.doesNotMatch(html,/合成甲|合成丙/);}
  f.Overtime.showEditModal(17);assert.equal(f.state.modals.length,2);
});

test('overtime edit is allowed at leader stage and locked after referral or completion',async()=>{
  const f=fixture('admin');
  f.Overtime.showEditModal(11);assert.equal(f.state.modals.length,1);
  for(const id of [12,13,14]) {
    f.Overtime.showEditModal(id);f.elements.otEditId={value:String(id)};await f.Overtime.saveEdit();
  }
  assert.equal(f.state.modals.length,1);assert.equal(f.state.mutations.length,0);
  assert.equal(f.Overtime._statusLabel(f.overtime[2]),'已批准');
  assert.equal(f.Overtime._statusLabel(f.overtime[3]),'最终批准');
});

test('compensatory balance and minute display remain enforced before submitting approvals',async()=>{
  const f=fixture();f.leaves[0].type='compensatory';f.leaves[0].hours=9;
  await f.Leave.approve(21);assert.equal(f.state.calls.length,0);assert.match(f.state.toasts[0][0],/调休时长不足/);
  const html=f.Leave._renderTable(f.leaves,f.employees);assert.match(html,/2026-11-23 09:15/);assert.match(html,/2026-11-23 10:45/);
  assert.match(html,/法定年假/);assert.equal(f.Leave._types.annual,'年假（外包人员）');assert.equal(f.Leave._types.sick,'病假（外包人员）');
});

test('notification status view uses scoped GET and only blocked notifications have an administrator retry',async()=>{
  const f=fixture('admin');f.leaves[0].type='shift';f.leaves[0].status='approved';f.leaves[0].approvalStage='complete';
  f.state.notifications=[
    {id:'blocked-event',kind:'leaveRequests',recordId:21,status:'blocked',reason:'sms_not_configured'},
    {id:'uncertain-event',kind:'leaveRequests',recordId:21,status:'uncertain',reason:'delivery_unknown'},
    {id:'sent-event',kind:'leaveRequests',recordId:21,status:'sent'},
    {id:'other-record',kind:'leaveRequests',recordId:22,status:'blocked'}
  ];
  await f.Leave.showNotifications(21);
  assert.equal(f.state.requests[0][0],'/api/approvals/notifications?kind=leaveRequests&id=21');
  const html=f.elements.leaveNotificationContent.innerHTML;
  assert.match(html,/待配置/);assert.match(html,/结果不确定/);assert.match(html,/已提交短信平台/);
  assert.match(html,/retryNotification\(21,0\)/);assert.doesNotMatch(html,/retryNotification\(21,[123]\)/);
  assert.equal(f.Leave._notificationEvents.length,3);
  await f.Leave.retryNotification(21,1);assert.equal(f.state.requests.length,1);
  await f.Leave.retryNotification(21,0);
  assert.equal(f.state.requests[1][0],'/api/approvals/notifications/blocked-event/retry');
  assert.equal(f.state.requests[1][1].body,'{}');assert.equal(f.state.requests[1][1].method,'POST');
  f.state.role='leader';await f.Leave.showNotifications(21);
  assert.doesNotMatch(f.elements.leaveNotificationContent.innerHTML,/retryNotification/);
  f.state.role='user';const requests=f.state.requests.length;await f.Leave.showNotifications(21);assert.equal(f.state.requests.length,requests);
});

test('closed dialogs and changed identities discard late notification responses',async()=>{
  for(const changeIdentity of [false,true]) {
    const f=fixture('admin');f.leaves[0].type='shift';f.leaves[0].status='approved';let release;
    f.state.fetch=()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ok:true,notifications:[{id:'late',kind:'leaveRequests',recordId:21,status:'sent'}]})});});
    const waiting=f.Leave.showNotifications(21), content=f.elements.leaveNotificationContent;
    if(changeIdentity) f.state.role='user';else delete f.elements.leaveNotificationContent;
    release();await waiting;
    assert.equal(content.innerHTML,'');assert.equal(content.textContent,'');assert.equal(f.Leave._notificationEvents.length,0);
  }
});
