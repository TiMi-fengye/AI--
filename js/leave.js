/** 请假申请与审批，普通人员只查看和提交自己的申请。 */
const Leave = {
  _statusFilter: '',
  _saving: false,
  _guidanceKey: '',
  _types: {leave:'请假',compensatory:'调休请假',shift:'替班请假',statutoryAnnual:'法定年假',welfareAnnual:'福利年假',paidSick:'带薪病假',annual:'年假（外包人员）',sick:'病假（外包人员）',personal:'事假',marriage:'婚假',maternity:'产假',other:'其他'},
  _escape(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  _minuteValue(value) {
    var match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value||'');
    if (!match || Number(match[1])<1) return NaN;
    var parts=match.slice(1).map(Number), date=new Date(0);
    // Compare wall-clock components without converting the selected time zone.
    date.setUTCFullYear(parts[0],parts[1]-1,parts[2]);
    date.setUTCHours(parts[3],parts[4],0,0);
    if (date.getUTCFullYear()!==parts[0] || date.getUTCMonth()+1!==parts[1] || date.getUTCDate()!==parts[2] || date.getUTCHours()!==parts[3] || date.getUTCMinutes()!==parts[4]) return NaN;
    return date.getTime();
  },
  _currentMinute() {
    var now=new Date(), pad=function(value) { return String(value).padStart(2,'0'); };
    return now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())+'T'+pad(now.getHours())+':'+pad(now.getMinutes());
  },
  _formatDateTime(value) {
    // Historical date-only requests have no recorded time to reconstruct.
    return String(value||'-').replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/,'$1 $2');
  },
  _isManager() { return Auth.isAdmin() || Auth.isLeader(); },
  _employees() { return Store.getEmployees().filter(function(e) { return Auth.canAccessEmployee(e.id); }); },
  _records() {
    var ids=new Set(this._employees().map(function(e) { return Number(e.id); }));
    return Store.getLeaveRequests().filter(function(r) { return ids.has(Number(r.employeeId)); });
  },
  _canApply(id) {
    var u=Auth.currentUser();
    return !!u && this._employees().some(function(e) { return Number(e.id)===Number(id); }) && (this._isManager() || Number(u.employeeId)===Number(id));
  },
  _canManage(r) { return !!r && this._isManager() && this._canApply(r.employeeId) && Auth.canManageEmployee(r.employeeId); },
  _deny() { App.toast('无权操作该人员的请假记录','error'); },
  _refresh() {
    if (App.currentPage==='attendance') { Attendance._activeTab='leave'; App.navigate('attendance'); }
    else App.navigate('leave');
  },
  setStatusFilter(value) { this._statusFilter=value; this._refresh(); },
  render(container) {
    var records=this._records(), employees=this._employees();
    container.innerHTML='<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center;"><h3>'+(this._isManager()?'请假申请':'我的请假申请')+'</h3><button class="btn btn-primary" onclick="Leave.showApplyModal()">+ 申请请假</button></div>'+
      '<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">'+
      '<div class="stat-card info"><div class="stat-label">申请数量</div><div class="stat-value">'+records.length+'</div></div>'+
      '<div class="stat-card warning"><div class="stat-label">待审批</div><div class="stat-value">'+records.filter(function(r) { return r.status==='pending'; }).length+'</div></div>'+
      '<div class="stat-card success"><div class="stat-label">已批准</div><div class="stat-value">'+records.filter(function(r) { return r.status==='approved'; }).length+'</div></div></div>'+
      '<div class="card"><div class="card-header"><h3>请假记录</h3><select aria-label="按请假状态筛选" class="form-control" style="max-width:150px;" onchange="Leave.setStatusFilter(this.value)">'+
      [['','全部状态'],['pending','待审批'],['approved','已批准'],['rejected','已拒绝']].map(function(pair) { return '<option value="'+pair[0]+'"'+(pair[0]===Leave._statusFilter?' selected':'')+'>'+pair[1]+'</option>'; }).join('')+'</select></div><div class="card-body">'+this._renderTable(records,employees)+'</div></div>';
  },
  _renderTable(records,employees) {
    var self=this, manager=this._isManager();
    var filtered=records.filter(function(r) { return self._canApply(r.employeeId) && employees.some(function(e) { return Number(e.id)===Number(r.employeeId); }) && (!self._statusFilter||r.status===self._statusFilter); }).slice().sort(function(a,b) { return b.id-a.id; });
    if (!filtered.length) return '<div class="empty-state"><div class="empty-icon">📋</div><p>暂无请假记录</p></div>';
    var statuses={pending:'待审批',approved:'已批准',rejected:'已拒绝'};
    var types=this._types;
    var rows=filtered.map(function(r) {
      var e=employees.find(function(e) { return Number(e.id)===Number(r.employeeId); }), controls='-';
      if (self._canManage(r) && r.status==='pending') controls='<button class="btn btn-success btn-sm" onclick="Leave.approve('+Number(r.id)+')">批准</button> <button class="btn btn-danger btn-sm" onclick="Leave.reject('+Number(r.id)+')">拒绝</button>';
      var duration=Store.isCompensatoryLeave(r)?(Number(r.hours)||0).toFixed(1)+'h':(Number(r.days)||0)+'天';
      return '<tr><td>#'+self._escape(r.id)+'</td><td>'+self._escape(e.name)+'</td>'+(manager?'<td>'+self._escape(e.department||'-')+'</td>':'')+'<td>'+self._escape(types[r.type]||r.type)+'</td><td>'+self._escape(self._formatDateTime(r.startDate))+' ~ '+self._escape(self._formatDateTime(r.endDate))+'</td><td>'+duration+'</td><td>'+self._escape(r.reason||'-')+'</td><td>'+self._escape(statuses[r.status]||'-')+'</td>'+(manager?'<td>'+controls+'</td>':'')+'</tr>';
    }).join('');
    return '<div class="table-responsive"><table><thead><tr><th>编号</th><th>人员</th>'+(manager?'<th>部门</th>':'')+'<th>类型</th><th>起止时间</th><th>时长</th><th>原因</th><th>状态</th>'+(manager?'<th>操作</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  },
  showApplyModal() {
    var self=this, employees=this._employees().filter(function(e) { return self._canApply(e.id); });
    if (!employees.length) { App.toast('请先完善并关联自己的人员信息','warning'); return; }
    this._guidanceKey='';
    var options=employees.map(function(e) { return '<option value="'+Number(e.id)+'">'+self._escape(e.name+' ('+(e.department||'未分配')+')')+'</option>'; }).join('');
    var typeOptions=Object.keys(this._types).map(function(type) { return '<option value="'+type+'">'+self._escape(self._types[type])+'</option>'; }).join('');
    App.openModal('申请请假','<div class="form-group"><label for="leaveEmployee">人员 *</label><select class="form-control" id="leaveEmployee" onchange="Leave.updateHoursField()">'+options+'</select></div>'+
      '<div class="form-group"><label for="leaveType">请假类型 *</label><select class="form-control" id="leaveType" onchange="Leave.updateHoursField()">'+typeOptions+'</select></div>'+
      '<div class="form-row"><div class="form-group"><label for="leaveStart">开始时间 *</label><input type="datetime-local" step="60" class="form-control" id="leaveStart" value="'+this._currentMinute()+'" required></div><div class="form-group"><label for="leaveEnd">结束时间 *</label><input type="datetime-local" step="60" class="form-control" id="leaveEnd" required></div></div>'+
      '<p style="margin-bottom:16px;color:var(--text-light);">请假天数按起止日期（含首尾日）计算；调休按填写小时数计算。</p>'+
      '<div class="form-group" id="leaveHoursGroup" hidden><label for="leaveHours">调休时长（小时）*</label><input type="number" class="form-control" id="leaveHours" min="0.5" step="0.5" value="1"><p id="leaveGuidance" role="status" style="margin-top:8px;line-height:1.8;color:var(--text-light);"></p></div>'+
      '<div class="form-group"><label for="leaveReason">请假原因</label><textarea class="form-control" id="leaveReason" maxlength="2000"></textarea></div>',
      '<button class="btn btn-primary" onclick="Leave.saveApply()">提交申请</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  _compensatoryGuidance(id) {
    if (!this._canApply(id)) return null;
    var employee=this._employees().find(function(e) { return Number(e.id)===Number(id); });
    if (!employee) return null;
    var balance=Store.getTimeBalance(id)||{}, value=Number(balance.remainingHours);
    if (!Number.isFinite(value)) return {remainingHours:0,message:'调休余额读取异常，请重新加载或联系楼长核对后再申请。',key:'invalid:'+Number(id)};
    var remaining=Number.isFinite(value)&&value>0?value:0;
    var is420=String(employee.company==null?'':employee.company).trim()==='420';
    var message=remaining>0
      ? '当前可用调休时长 '+remaining.toFixed(1)+' 小时。请发送调休申请邮件，走邮件审批流程；本系统申请仍需提交并等待审批。'
      : is420
        ? '当前无可用调休时长。420人员请前往 ERP 提交法定年假、福利年假或带薪病假申请。'
        : '当前无可用调休时长。请联系楼长，在自己所属平台提交请假申请。';
    return {remainingHours:remaining,message:message,key:JSON.stringify([Number(id),remaining,is420])};
  },
  _showCompensatoryGuidance(guidance, force) {
    if (!guidance || (!force && this._guidanceKey===guidance.key)) return;
    this._guidanceKey=guidance.key;
    // Native alerts preserve the open application form and all entered values.
    if (typeof window!=='undefined' && typeof window.alert==='function') window.alert(guidance.message);
    else App.toast(guidance.message,guidance.remainingHours>0?'info':'warning');
  },
  updateHoursField() {
    var type=document.getElementById('leaveType'), group=document.getElementById('leaveHoursGroup');
    if (!type || !group) return;
    group.hidden=type.value!=='compensatory';
    if (group.hidden) { this._guidanceKey=''; return; }
    var person=document.getElementById('leaveEmployee');
    var guidance=person&&this._compensatoryGuidance(Number(person.value));
    var hint=document.getElementById('leaveGuidance');
    if (hint) hint.textContent=guidance?guidance.message:'';
    this._showCompensatoryGuidance(guidance,false);
  },
  async saveApply() {
    if (this._saving) return;
    var id=Number(document.getElementById('leaveEmployee').value);
    if (!this._canApply(id)) { this._deny(); return; }
    var type=document.getElementById('leaveType').value, start=document.getElementById('leaveStart').value, end=document.getElementById('leaveEnd').value, hours=Number(document.getElementById('leaveHours').value), reason=document.getElementById('leaveReason').value.trim();
    var startTime=this._minuteValue(start), endTime=this._minuteValue(end);
    if (!Number.isFinite(startTime)||!Number.isFinite(endTime)||endTime<=startTime) { App.toast('请选择精确到分钟的有效起止时间，结束时间必须晚于开始时间','error'); return; }
    if (!Object.prototype.hasOwnProperty.call(this._types,type)) { App.toast('请选择有效请假类型','error'); return; }
    var emp=this._employees().find(function(e) { return Number(e.id)===id; });
    if (type==='shift' && !Store._isOutsourced(emp)) { App.toast('替班请假仅限外包单位外派人员使用','error'); return; }
    if (type==='compensatory') {
      var guidance=this._compensatoryGuidance(id);
      if (!guidance) { this._deny(); return; }
      if (guidance.remainingHours<=0) { this._showCompensatoryGuidance(guidance,true); return; }
      if (!Number.isFinite(hours)||hours<=0) { App.toast('请填写有效的调休小时数','error'); return; }
      if (hours>guidance.remainingHours) { App.toast('调休时长不足，当前剩余 '+guidance.remainingHours.toFixed(1)+' 小时','error'); return; }
      this._showCompensatoryGuidance(guidance,false);
    }
    var days=Math.floor((Date.parse(end.slice(0,10))-Date.parse(start.slice(0,10)))/86400000)+1;
    var saved=await this._mutate(function() { Store.addLeaveRequest({employeeId:id,type:type,startDate:start,endDate:end,days:days,hours:type==='compensatory'?hours:0,reason:reason,status:'pending'}); },'请假申请已提交，等待审批');
    if (saved && typeof Feishu!=='undefined') {
      // 通知沿用现有集成；服务端未允许通知时仍保留已提交的申请。
      try { Promise.resolve(Feishu.notifyLeave(emp,{type:this._types[type],days:days,startDate:start,endDate:end})).catch(function() {}); } catch (_) {}
    }
  },
  async _mutate(action,message) {
    if (this._saving) return;
    this._saving=true;
    try { action(); await Store.flushServerSync(); App.toast(message,'success'); App.closeModal(); this._refresh(); return true; }
    catch (error) { App.toast(error.message||'保存失败，请重试','error'); return false; }
    finally { this._saving=false; }
  },
  async _setStatus(id,status) {
    var r=Store.getLeaveRequests().find(function(r) { return Number(r.id)===Number(id); });
    if (!this._canManage(r)||r.status!=='pending') { this._deny(); return; }
    if (status==='approved' && Store.isCompensatoryLeave(r) && Number(r.hours)>Store.getTimeBalance(r.employeeId).remainingHours) { App.toast('调休时长不足，无法批准该申请','error'); return; }
    await this._mutate(function() { Store.updateLeaveRequest(r.id,{status:status}); },status==='approved'?'已批准该请假申请':'已拒绝该请假申请');
  },
  approve(id) { return this._setStatus(id,'approved'); },
  reject(id) { return this._setStatus(id,'rejected'); },
  async delete(id) {
    var r=Store.getLeaveRequests().find(function(r) { return Number(r.id)===Number(id); });
    if (!this._canManage(r)) { this._deny(); return; }
    if (App.confirm('确定删除此请假记录？')) await this._mutate(function() { Store.deleteLeaveRequest(r.id); },'已删除');
  }
};
