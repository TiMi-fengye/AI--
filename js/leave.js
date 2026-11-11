/** 请假申请与审批，普通人员只查看和提交自己的申请。 */
const Leave = {
  _statusFilter: '',
  _saving: false,
  _escape(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
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
    var types={compensatory:'调休请假',leave:'请假',shift:'替班请假',sick:'病假',personal:'事假',annual:'年假',marriage:'婚假',maternity:'产假',other:'其他'};
    var rows=filtered.map(function(r) {
      var e=employees.find(function(e) { return Number(e.id)===Number(r.employeeId); }), controls='-';
      if (self._canManage(r) && r.status==='pending') controls='<button class="btn btn-success btn-sm" onclick="Leave.approve('+Number(r.id)+')">批准</button> <button class="btn btn-danger btn-sm" onclick="Leave.reject('+Number(r.id)+')">拒绝</button>';
      var duration=Store.isCompensatoryLeave(r)?(Number(r.hours)||0).toFixed(1)+'h':(Number(r.days)||0)+'天';
      return '<tr><td>#'+self._escape(r.id)+'</td><td>'+self._escape(e.name)+'</td>'+(manager?'<td>'+self._escape(e.department||'-')+'</td>':'')+'<td>'+self._escape(types[r.type]||r.type)+'</td><td>'+self._escape(App.formatDate(r.startDate))+' ~ '+self._escape(App.formatDate(r.endDate))+'</td><td>'+duration+'</td><td>'+self._escape(r.reason||'-')+'</td><td>'+self._escape(statuses[r.status]||'-')+'</td>'+(manager?'<td>'+controls+'</td>':'')+'</tr>';
    }).join('');
    return '<div class="table-responsive"><table><thead><tr><th>编号</th><th>人员</th>'+(manager?'<th>部门</th>':'')+'<th>类型</th><th>起止日期</th><th>时长</th><th>原因</th><th>状态</th>'+(manager?'<th>操作</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  },
  showApplyModal() {
    var self=this, employees=this._employees().filter(function(e) { return self._canApply(e.id); });
    if (!employees.length) { App.toast('请先完善并关联自己的人员信息','warning'); return; }
    var options=employees.map(function(e) { return '<option value="'+Number(e.id)+'">'+self._escape(e.name+' ('+(e.department||'未分配')+')')+'</option>'; }).join('');
    App.openModal('申请请假','<div class="form-group"><label for="leaveEmployee">人员 *</label><select class="form-control" id="leaveEmployee">'+options+'</select></div>'+
      '<div class="form-group"><label for="leaveType">请假类型 *</label><select class="form-control" id="leaveType" onchange="Leave.updateHoursField()"><option value="leave">请假</option><option value="compensatory">调休请假</option><option value="shift">替班请假</option><option value="sick">病假</option><option value="personal">事假</option><option value="annual">年假</option><option value="marriage">婚假</option><option value="maternity">产假</option><option value="other">其他</option></select></div>'+
      '<div class="form-row"><div class="form-group"><label for="leaveStart">开始日期 *</label><input type="date" class="form-control" id="leaveStart" value="'+App.today()+'"></div><div class="form-group"><label for="leaveEnd">结束日期 *</label><input type="date" class="form-control" id="leaveEnd" value="'+App.today()+'"></div></div>'+
      '<div class="form-group" id="leaveHoursGroup" hidden><label for="leaveHours">调休时长（小时）*</label><input type="number" class="form-control" id="leaveHours" min="0.5" step="0.5" value="1"></div>'+
      '<div class="form-group"><label for="leaveReason">请假原因</label><textarea class="form-control" id="leaveReason" maxlength="2000"></textarea></div>',
      '<button class="btn btn-primary" onclick="Leave.saveApply()">提交申请</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  updateHoursField() { document.getElementById('leaveHoursGroup').hidden=document.getElementById('leaveType').value!=='compensatory'; },
  async saveApply() {
    if (this._saving) return;
    var id=Number(document.getElementById('leaveEmployee').value);
    if (!this._canApply(id)) { this._deny(); return; }
    var type=document.getElementById('leaveType').value, start=document.getElementById('leaveStart').value, end=document.getElementById('leaveEnd').value, hours=Number(document.getElementById('leaveHours').value), reason=document.getElementById('leaveReason').value.trim();
    var startTime=Date.parse(start), endTime=Date.parse(end);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||!Number.isFinite(startTime)||!Number.isFinite(endTime)||endTime<startTime) { App.toast('请选择有效的起止日期，结束日期不能早于开始日期','error'); return; }
    if (!['leave','compensatory','shift','sick','personal','annual','marriage','maternity','other'].includes(type)) { App.toast('请选择有效请假类型','error'); return; }
    var emp=this._employees().find(function(e) { return Number(e.id)===id; });
    if (type==='shift' && !Store._isOutsourced(emp)) { App.toast('替班请假仅限外包单位外派人员使用','error'); return; }
    if (type==='compensatory') {
      var balance=Store.getTimeBalance(id);
      if (!Number.isFinite(hours)||hours<=0) { App.toast('请填写有效的调休小时数','error'); return; }
      if (hours>balance.remainingHours) { App.toast('调休时长不足，当前剩余 '+balance.remainingHours.toFixed(1)+' 小时','error'); return; }
    }
    var days=Math.floor((endTime-startTime)/86400000)+1;
    var saved=await this._mutate(function() { Store.addLeaveRequest({employeeId:id,type:type,startDate:start,endDate:end,days:days,hours:type==='compensatory'?hours:0,reason:reason,status:'pending'}); },'请假申请已提交，等待审批');
    if (saved && typeof Feishu!=='undefined') {
      // 通知沿用现有集成；服务端未允许通知时仍保留已提交的申请。
      try { Promise.resolve(Feishu.notifyLeave(emp,{type:type,days:days,startDate:start,endDate:end})).catch(function() {}); } catch (_) {}
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
