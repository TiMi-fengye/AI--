/** 考勤管理：管理员全量、楼长本楼栋，普通人员仅自己的申请与小时数。 */
const Attendance = {
  _activeTab: 'attendance',
  _dateFilter: '',
  _deptFilter: '',
  _saving: false,
  _escape(v) { return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  _getMyEmployeeId() { var u=Auth.currentUser(); return u && u.employeeId ? Number(u.employeeId) : null; },
  _isRegular() { return !Auth.isAdmin() && !Auth.isLeader(); },
  _isManagerUser() { return Auth.isAdmin() || Auth.isLeader(); },
  _employees() { return Store.getEmployees().filter(function(e) { return Auth.canAccessEmployee(e.id); }); },
  _records() {
    var ids=new Set(this._employees().map(function(e) { return Number(e.id); }));
    return Store.getAttendance().filter(function(r) { return ids.has(Number(r.employeeId)); });
  },
  _canManage(id) { return this._isManagerUser() && this._employees().some(function(e) { return Number(e.id)===Number(id); }) && Auth.canManageEmployee(id); },
  _deny() { App.toast('无权操作考勤记录','error'); },
  render(container) {
    if (!Auth.currentUser()) { container.innerHTML=''; return; }
    var regular=this._isRegular();
    var tabs=regular ? [['hours','我的小时数'],['overtime','加班申请'],['leave','请假申请']] : [['attendance','考勤'],['overtime','加班申请'],['leave','请假申请']];
    if (!tabs.some(function(tab) { return tab[0]===Attendance._activeTab; })) this._activeTab=tabs[0][0];
    container.innerHTML=(regular?'<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px;"><button class="btn btn-primary" onclick="Attendance.otShowAddModal()">+ 加班申请</button><button class="btn btn-outline" onclick="Attendance.lvShowApplyModal()">+ 请假申请</button></div>':'')+
      '<div role="tablist" aria-label="考勤管理" style="display:flex;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:20px;">'+
      tabs.map(function(tab) { return '<button type="button" role="tab" aria-selected="'+(tab[0]===Attendance._activeTab)+'" class="btn '+(tab[0]===Attendance._activeTab?'btn-primary':'btn-outline')+'" onclick="Attendance._switchTo(\''+tab[0]+'\')">'+tab[1]+'</button>'; }).join('')+'</div><div id="attSubContent"></div>';
    this._renderActiveTab();
  },
  _switchTo(tab) {
    var allowed=this._isRegular()?['hours','overtime','leave']:['attendance','overtime','leave'];
    if (!allowed.includes(tab)) { this._deny(); return; }
    this._activeTab=tab;
    var container=document.getElementById('pageContent');
    if (container) this.render(container);
  },
  _renderActiveTab() {
    var sub=document.getElementById('attSubContent');
    if (!sub) return;
    if (this._activeTab==='overtime') Overtime.render(sub);
    else if (this._activeTab==='leave') Leave.render(sub);
    else if (this._isRegular() || this._activeTab==='hours') MyHours.render(sub);
    else this._renderAttTab(sub);
  },
  setFilter(key,value) { if (key==='date') this._dateFilter=value; if (key==='department') this._deptFilter=value; this._refresh(); },
  _refresh() { this._activeTab='attendance'; App.navigate('attendance'); },
  _renderAttTab(sub) {
    if (!this._isManagerUser()) { MyHours.render(sub); return; }
    var self=this, records=this._records(), emps=this._employees(), today=App.today();
    var month=records.filter(function(r) { return r.date && r.date.slice(0,7)===today.slice(0,7); });
    var stats=[['本月考勤',month.length,'info'],['出勤',month.filter(function(r) { return r.status==='present'; }).length,'success'],['迟到',month.filter(function(r) { return r.status==='late'; }).length,'warning'],['缺勤',month.filter(function(r) { return r.status==='absent'; }).length,'danger']];
    var depts=Array.from(new Set(emps.map(function(e) { return e.department; }).filter(Boolean)));
    sub.innerHTML='<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">'+stats.map(function(s) { return '<div class="stat-card '+s[2]+'"><div class="stat-label">'+s[0]+'</div><div class="stat-value">'+s[1]+'</div></div>'; }).join('')+'</div>'+
      '<div class="card"><div class="card-header" style="flex-wrap:wrap;gap:10px;"><h3>今日考勤 ('+today+')</h3><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary" onclick="Attendance.showCheckinModal()">+ 签到/签退</button><button class="btn btn-success" onclick="Attendance.allPresent()">一键全部到岗</button></div></div><div class="card-body">'+this._todayTable(records.filter(function(r) { return r.date===today; }),emps)+'</div></div>'+
      '<div class="card"><div class="card-header" style="flex-wrap:wrap;gap:10px;"><h3>考勤记录</h3><div style="display:flex;gap:8px;flex-wrap:wrap;">'+
      '<input aria-label="按考勤日期筛选" type="date" class="form-control" style="max-width:170px;" value="'+this._escape(this._dateFilter)+'" onchange="Attendance.setFilter(\'date\',this.value)">'+
      '<select aria-label="按部门筛选考勤" class="form-control" style="max-width:150px;" onchange="Attendance.setFilter(\'department\',this.value)"><option value="">全部部门</option>'+depts.map(function(d) { return '<option value="'+self._escape(d)+'"'+(d===self._deptFilter?' selected':'')+'>'+self._escape(d)+'</option>'; }).join('')+'</select><button class="btn btn-info" onclick="Attendance.showMonthlyReport()">本月考勤统计</button></div></div><div class="card-body">'+this._attFilteredTable(records,emps)+'</div></div>';
  },
  _todayTable(records,employees) { return this._table(records,employees,true); },
  _attFilteredTable(records,employees) {
    var self=this;
    return this._table(records.filter(function(r) {
      var e=employees.find(function(e) { return Number(e.id)===Number(r.employeeId); });
      return e && (!self._dateFilter||r.date===self._dateFilter) && (!self._deptFilter||e.department===self._deptFilter);
    }),employees,false);
  },
  _table(records,employees,todayOnly) {
    if (!this._isManagerUser()) return '';
    var self=this, statuses={present:'出勤',late:'迟到',absent:'缺勤'};
    var filtered=records.filter(function(r) { return self._canManage(r.employeeId) && employees.some(function(e) { return Number(e.id)===Number(r.employeeId); }); }).slice().sort(function(a,b) { return b.id-a.id; });
    if (!filtered.length) return '<div class="empty-state"><div class="empty-icon">⏰</div><p>暂无考勤记录</p></div>';
    var rows=filtered.map(function(r) {
      var e=employees.find(function(e) { return Number(e.id)===Number(r.employeeId); });
      return '<tr>'+(todayOnly?'':'<td>'+self._escape(r.date)+'</td>')+'<td>'+self._escape(e.name)+'</td><td>'+self._escape(e.department||'-')+'</td><td>'+self._escape(r.checkIn||'-')+'</td><td>'+self._escape(r.checkOut||'-')+'</td><td>'+self._escape(statuses[r.status]||'-')+'</td><td>'+(!r.checkOut?'<button class="btn btn-info btn-sm" onclick="Attendance.showCheckoutModal('+Number(r.id)+')">签退</button> ':'')+'<button class="btn btn-danger btn-sm" onclick="Attendance.deleteRecord('+Number(r.id)+')">删除</button></td></tr>';
    }).join('');
    return '<div class="table-responsive"><table><thead><tr>'+(todayOnly?'':'<th>日期</th>')+'<th>人员</th><th>部门</th><th>签到</th><th>签退</th><th>状态</th><th>操作</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  },
  showCheckinModal() {
    if (!this._isManagerUser()) { this._deny(); return; }
    var self=this, emps=this._employees().filter(function(e) { return self._canManage(e.id); });
    if (!emps.length) { App.toast('当前范围暂无可管理人员','warning'); return; }
    App.openModal('签到','<div class="form-group"><label for="attEmployee">人员 *</label><select class="form-control" id="attEmployee">'+emps.map(function(e) { return '<option value="'+Number(e.id)+'">'+self._escape(e.name+' ('+(e.department||'未分配')+')')+'</option>'; }).join('')+'</select></div>'+
      '<div class="form-group"><label for="attDate">日期 *</label><input type="date" class="form-control" id="attDate" value="'+App.today()+'"></div><div class="form-group"><label for="attCheckIn">签到时间</label><input type="time" class="form-control" id="attCheckIn" value="'+new Date().toTimeString().slice(0,5)+'"></div><div class="form-group"><label for="attStatus">状态</label><select class="form-control" id="attStatus"><option value="present">出勤</option><option value="late">迟到</option><option value="absent">缺勤</option></select></div>',
      '<button class="btn btn-primary" onclick="Attendance.saveCheckin()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  showCheckoutModal(id) {
    var r=Store.getAttendance().find(function(r) { return Number(r.id)===Number(id); });
    if (!r || !this._canManage(r.employeeId)) { this._deny(); return; }
    App.openModal('签退','<div class="form-group"><label for="attCheckOut">签退时间</label><input type="time" class="form-control" id="attCheckOut" value="'+new Date().toTimeString().slice(0,5)+'"></div><input type="hidden" id="attRecordId" value="'+Number(id)+'">',
      '<button class="btn btn-primary" onclick="Attendance.saveCheckout()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  async saveCheckin() {
    if (!this._isManagerUser()) { this._deny(); return; }
    var id=Number(document.getElementById('attEmployee').value);
    if (!this._canManage(id)) { this._deny(); return; }
    var date=document.getElementById('attDate').value, time=document.getElementById('attCheckIn').value, status=document.getElementById('attStatus').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['present','late','absent'].includes(status)) { App.toast('请填写有效日期和状态','error'); return; }
    if (Store.getAttendance().some(function(r) { return Number(r.employeeId)===id&&r.date===date; })) { App.toast('该人员当天已有考勤记录','warning'); return; }
    await this._mutate(function() { Store.addAttendance({employeeId:id,date:date,checkIn:time,status:status}); },'考勤记录已添加');
  },
  async saveCheckout() {
    if (!this._isManagerUser()) { this._deny(); return; }
    var id=Number(document.getElementById('attRecordId').value), r=Store.getAttendance().find(function(r) { return Number(r.id)===id; });
    if (!r || !this._canManage(r.employeeId)) { this._deny(); return; }
    var time=document.getElementById('attCheckOut').value;
    if (!/^\d{2}:\d{2}$/.test(time)) { App.toast('请选择有效签退时间','error'); return; }
    await this._mutate(function() { Store.updateAttendance(r.id,{checkOut:time}); },'签退成功');
  },
  async deleteRecord(id) {
    var r=Store.getAttendance().find(function(r) { return Number(r.id)===Number(id); });
    if (!r || !this._canManage(r.employeeId)) { this._deny(); return; }
    if (App.confirm('确定删除此考勤记录？')) await this._mutate(function() { Store.deleteAttendance(r.id); },'已删除');
  },
  async allPresent() {
    if (!this._isManagerUser()) { this._deny(); return; }
    var self=this, today=App.today(), records=this._records();
    var missing=this._employees().filter(function(e) { return self._canManage(e.id)&&!records.some(function(r) { return Number(r.employeeId)===Number(e.id)&&r.date===today; }); });
    if (!missing.length) { App.toast('当前范围的人员今日均已有考勤记录','info'); return; }
    if (!App.confirm('将为当前范围 '+missing.length+' 名人员添加出勤记录，确认？')) return;
    var time=new Date().toTimeString().slice(0,5);
    await this._mutate(function() { missing.forEach(function(e) { Store.addAttendance({employeeId:e.id,date:today,checkIn:time,status:'present'}); }); },'已添加出勤记录');
  },
  async _mutate(action,message) {
    if (this._saving) return;
    this._saving=true;
    try { action(); await Store.flushServerSync(); App.toast(message,'success'); App.closeModal(); this._refresh(); }
    catch (error) { App.toast(error.message||'保存失败，请重试','error'); }
    finally { this._saving=false; }
  },
  showMonthlyReport() {
    if (!this._isManagerUser()) { this._deny(); return; }
    var self=this, month=App.today().slice(0,7), records=this._records().filter(function(r) { return r.date&&r.date.slice(0,7)===month; });
    var rows=this._employees().map(function(e) {
      var own=records.filter(function(r) { return Number(r.employeeId)===Number(e.id); });
      var present=own.filter(function(r) { return r.status==='present'; }).length, late=own.filter(function(r) { return r.status==='late'; }).length, absent=own.filter(function(r) { return r.status==='absent'; }).length;
      return '<tr><td>'+self._escape(e.name)+'</td><td>'+self._escape(e.department||'-')+'</td><td>'+self._escape(e.building||'-')+'</td><td>'+present+'</td><td>'+late+'</td><td>'+absent+'</td><td>'+(own.length?Math.round(present/own.length*100)+'%':'-')+'</td></tr>';
    }).join('');
    App.openModal(month+' 考勤统计','<div class="table-responsive"><table><thead><tr><th>人员</th><th>部门</th><th>楼栋</th><th>出勤</th><th>迟到</th><th>缺勤</th><th>出勤率</th></tr></thead><tbody>'+rows+'</tbody></table></div>',
      '<button class="btn btn-outline" onclick="App.closeModal()">关闭</button>');
  },
  // 兼容原考勤页面的调用入口；实际操作统一由共享申请模块校验权限。
  _renderOtTab(sub) { Overtime.render(sub); },
  _renderLeaveTab(sub) { Leave.render(sub); },
  _otRenderTable(list,emps) { return Overtime._renderTable(list,emps); },
  _lvRenderTable(list,emps) { return Leave._renderTable(list,emps); },
  otShowAddModal() { return Overtime.showAddModal(); },
  otSaveAdd() { return Overtime.saveAdd(); },
  otShowEditModal(id) { return Overtime.showEditModal(id); },
  otSaveEdit() { return Overtime.saveEdit(); },
  otApprove(id) { return Overtime.approve(id); },
  otReject(id) { return Overtime.reject(id); },
  otDeleteRecord(id) { return Overtime.deleteRecord(id); },
  lvShowApplyModal() { return Leave.showApplyModal(); },
  lvSaveApply() { return Leave.saveApply(); },
  lvApprove(id) { return Leave.approve(id); },
  lvReject(id) { return Leave.reject(id); }
};
