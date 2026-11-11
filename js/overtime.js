/** 加班申请与审批；使用 employeeId 校验身份和数据范围。 */
const Overtime = {
  _dateFilter: '',
  _saving: false,
  _escape(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  _isManager() { return Auth.isAdmin() || Auth.isLeader(); },
  _employees() { return Store.getEmployees().filter(function(e) { return Auth.canAccessEmployee(e.id); }); },
  _records() {
    var ids = new Set(this._employees().map(function(e) { return Number(e.id); }));
    return Store.getOvertime().filter(function(r) { return ids.has(Number(r.employeeId)); });
  },
  _canApply(id) {
    var u = Auth.currentUser();
    return !!u && this._employees().some(function(e) { return Number(e.id) === Number(id); }) && (this._isManager() || Number(u.employeeId) === Number(id));
  },
  _canManage(r) { return !!r && this._isManager() && this._canApply(r.employeeId) && Auth.canManageEmployee(r.employeeId); },
  _deny() { App.toast('无权操作该人员的加班记录','error'); },
  _refresh() {
    if (App.currentPage === 'attendance') { Attendance._activeTab = 'overtime'; App.navigate('attendance'); }
    else App.navigate('overtime');
  },
  setDateFilter(value) { this._dateFilter = value; this._refresh(); },
  render(container) {
    var records = this._records(), employees = this._employees(), today = App.today();
    var monthHours = records.filter(function(r) { return r.status === 'approved' && r.date && r.date.slice(0,7) === today.slice(0,7); }).reduce(function(s,r) { return s + (Number(r.hours)||0); },0);
    container.innerHTML = '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center;"><h3>' + (this._isManager() ? '加班申请' : '我的加班申请') + '</h3><button class="btn btn-primary" onclick="Overtime.showAddModal()">+ 申请加班</button></div>' +
      '<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">' +
      '<div class="stat-card info"><div class="stat-label">申请数量</div><div class="stat-value">'+records.length+'</div></div>' +
      '<div class="stat-card warning"><div class="stat-label">待审批</div><div class="stat-value">'+records.filter(function(r) { return r.status==='pending'; }).length+'</div></div>' +
      '<div class="stat-card success"><div class="stat-label">本月已批准加班</div><div class="stat-value">'+monthHours.toFixed(1)+'h</div></div></div>' +
      '<div class="card"><div class="card-header"><h3>加班记录</h3><input aria-label="按加班日期筛选" type="date" class="form-control" style="max-width:180px;" value="'+this._escape(this._dateFilter)+'" onchange="Overtime.setDateFilter(this.value)"></div><div class="card-body">'+this._renderTable(records,employees)+'</div></div>';
  },
  _renderTable(records,employees) {
    var self=this, manager=this._isManager();
    var filtered=records.filter(function(r) { return self._canApply(r.employeeId) && employees.some(function(e) { return Number(e.id)===Number(r.employeeId); }) && (!self._dateFilter || r.date===self._dateFilter); }).slice().sort(function(a,b) { return b.id-a.id; });
    if (!filtered.length) return '<div class="empty-state"><div class="empty-icon">⏰</div><p>暂无加班记录</p></div>';
    var statuses={pending:'待审批',approved:'已批准',rejected:'已拒绝'};
    var rows=filtered.map(function(r) {
      var e=employees.find(function(e) { return Number(e.id)===Number(r.employeeId); }), controls='';
      if (self._canManage(r)) {
        if (r.status==='pending') controls+='<button class="btn btn-success btn-sm" onclick="Overtime.approve('+Number(r.id)+')">批准</button> <button class="btn btn-danger btn-sm" onclick="Overtime.reject('+Number(r.id)+')">拒绝</button> ';
        controls+='<button class="btn btn-outline btn-sm" onclick="Overtime.showEditModal('+Number(r.id)+')">编辑</button> <button class="btn btn-danger btn-sm" onclick="Overtime.deleteRecord('+Number(r.id)+')">删除</button>';
      }
      return '<tr><td>'+self._escape(r.date)+'</td><td>'+self._escape(e.name)+'</td>'+(manager?'<td>'+self._escape(e.department||'-')+'</td>':'')+'<td>'+(r.overtimeType==='compensatory'?'调休加班':'费用加班')+'</td><td>'+(Number(r.hours)||0).toFixed(1)+'h</td><td>'+self._escape(r.reason||'-')+'</td><td>'+self._escape(statuses[r.status]||'-')+'</td>'+(manager?'<td>'+controls+'</td>':'')+'</tr>';
    }).join('');
    return '<div class="table-responsive"><table><thead><tr><th>日期</th><th>人员</th>'+(manager?'<th>部门</th>':'')+'<th>加班类型</th><th>时长</th><th>原因</th><th>状态</th>'+(manager?'<th>操作</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  },
  showAddModal() {
    var self=this, emps=this._employees().filter(function(e) { return self._canApply(e.id); });
    if (!emps.length) { App.toast('请先完善并关联自己的人员信息','warning'); return; }
    var options=emps.map(function(e) { return '<option value="'+Number(e.id)+'">'+self._escape(e.name+' ('+(e.department||'未分配')+')')+'</option>'; }).join('');
    App.openModal('申请加班','<div class="form-group"><label for="otEmployee">人员 *</label><select class="form-control" id="otEmployee">'+options+'</select></div>'+
      '<div class="form-group"><label for="otType">加班类型 *</label><select class="form-control" id="otType"><option value="fee">费用加班</option><option value="compensatory">调休加班</option></select></div>'+
      '<div class="form-group"><label for="otDate">加班日期 *</label><input type="date" class="form-control" id="otDate" value="'+App.today()+'"></div>'+
      '<div class="form-group"><label for="otHours">加班时长（小时）*</label><input type="number" class="form-control" id="otHours" value="2" min="0.5" max="24" step="0.5"></div>'+
      '<div class="form-group"><label for="otReason">加班原因</label><textarea class="form-control" id="otReason" maxlength="2000"></textarea></div>',
      '<button class="btn btn-primary" onclick="Overtime.saveAdd()">提交申请</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  async saveAdd() {
    if (this._saving) return;
    var id=Number(document.getElementById('otEmployee').value);
    if (!this._canApply(id)) { this._deny(); return; }
    var date=document.getElementById('otDate').value, hours=Number(document.getElementById('otHours').value), type=document.getElementById('otType').value, reason=document.getElementById('otReason').value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(hours) || hours<=0 || hours>24 || !['fee','compensatory'].includes(type)) { App.toast('请填写有效日期和不超过24小时的加班时长','error'); return; }
    var saved=await this._mutate(function() { Store.addOvertime({employeeId:id,overtimeType:type,date:date,hours:hours,reason:reason,status:'pending'}); },'加班申请已提交，等待审批');
    if (saved && typeof Feishu!=='undefined') {
      var employee=this._employees().find(function(e) { return Number(e.id)===id; });
      // 沿用既有通知，消息权限或配置失败不能影响已保存的申请。
      try { Promise.resolve(Feishu.notifyOvertime(employee,{hours:hours,date:date})).catch(function() {}); } catch (_) {}
    }
  },
  showEditModal(id) {
    var r=Store.getOvertime().find(function(r) { return Number(r.id)===Number(id); });
    if (!this._canManage(r)) { this._deny(); return; }
    App.openModal('编辑加班记录','<div class="form-group"><label for="otEditType">加班类型</label><select class="form-control" id="otEditType"><option value="fee"'+(r.overtimeType!=='compensatory'?' selected':'')+'>费用加班</option><option value="compensatory"'+(r.overtimeType==='compensatory'?' selected':'')+'>调休加班</option></select></div>'+
      '<div class="form-group"><label for="otEditDate">日期</label><input type="date" class="form-control" id="otEditDate" value="'+this._escape(r.date)+'"></div>'+
      '<div class="form-group"><label for="otEditHours">小时数</label><input type="number" class="form-control" id="otEditHours" min="0.5" max="24" step="0.5" value="'+Number(r.hours)+'"></div>'+
      '<div class="form-group"><label for="otEditReason">原因</label><textarea class="form-control" id="otEditReason" maxlength="2000">'+this._escape(r.reason)+'</textarea></div><input type="hidden" id="otEditId" value="'+Number(id)+'">',
      '<button class="btn btn-primary" onclick="Overtime.saveEdit()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  async saveEdit() {
    var id=Number(document.getElementById('otEditId').value), r=Store.getOvertime().find(function(r) { return Number(r.id)===id; });
    if (!this._canManage(r)) { this._deny(); return; }
    var date=document.getElementById('otEditDate').value, hours=Number(document.getElementById('otEditHours').value), type=document.getElementById('otEditType').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(hours) || hours<=0 || hours>24 || !['fee','compensatory'].includes(type)) { App.toast('请填写有效日期和小时数','error'); return; }
    var reason=document.getElementById('otEditReason').value.trim();
    await this._mutate(function() { Store.updateOvertime(id,{date:date,hours:hours,overtimeType:type,reason:reason}); },'加班记录已更新');
  },
  async _mutate(action,message) {
    if (this._saving) return;
    this._saving=true;
    try { action(); await Store.flushServerSync(); App.toast(message,'success'); App.closeModal(); this._refresh(); return true; }
    catch (error) { App.toast(error.message||'保存失败，请重试','error'); return false; }
    finally { this._saving=false; }
  },
  async _setStatus(id,status) {
    var r=Store.getOvertime().find(function(r) { return Number(r.id)===Number(id); });
    if (!this._canManage(r) || r.status!=='pending') { this._deny(); return; }
    await this._mutate(function() { Store.updateOvertime(r.id,{status:status}); },status==='approved'?'已批准':'已拒绝');
  },
  approve(id) { return this._setStatus(id,'approved'); },
  reject(id) { return this._setStatus(id,'rejected'); },
  async deleteRecord(id) {
    var r=Store.getOvertime().find(function(r) { return Number(r.id)===Number(id); });
    if (!this._canManage(r)) { this._deny(); return; }
    if (App.confirm('确定删除此加班记录？')) await this._mutate(function() { Store.deleteOvertime(r.id); },'已删除');
  }
};
