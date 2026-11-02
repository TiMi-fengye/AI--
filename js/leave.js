/**
 * 请假管理模块
 */
const Leave = {
  render(container) {
    const leaves = Store.getLeaveRequests();
    const employees = Store.getEmployees();
    const pending = leaves.filter(l => l.status === 'pending').length;

    container.innerHTML = `
      <!-- 统计 -->
      <div class="stats-grid">
        <div class="stat-card info">
          <div class="stat-icon">📋</div>
          <div class="stat-label">总申请</div>
          <div class="stat-value">${leaves.length}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-icon">⏳</div>
          <div class="stat-label">待审批</div>
          <div class="stat-value">${pending}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-icon">✅</div>
          <div class="stat-label">已批准</div>
          <div class="stat-value">${leaves.filter(l => l.status === 'approved').length}</div>
        </div>
        <div class="stat-card danger">
          <div class="stat-icon">❌</div>
          <div class="stat-label">已拒绝</div>
          <div class="stat-value">${leaves.filter(l => l.status === 'rejected').length}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>📋 请假列表</h3>
          <button class="btn btn-primary" onclick="Leave.showApplyModal()">+ 申请请假</button>
        </div>
        <div class="card-body">
          <div class="filter-row">
            <select class="form-control" id="leaveStatusFilter" style="max-width:140px;" onchange="Leave.render(document.getElementById('pageContent'))">
              <option value="">全部状态</option>
              <option value="pending">待审批</option>
              <option value="approved">已批准</option>
              <option value="rejected">已拒绝</option>
            </select>
          </div>
          ${this._renderTable(leaves, employees)}
        </div>
      </div>
    `;
  },

  _renderTable(leaves, employees) {
    const statusFilter = document.getElementById('leaveStatusFilter')?.value;
    let filtered = [...leaves].sort((a, b) => b.id - a.id);
    if (statusFilter) filtered = filtered.filter(l => l.status === statusFilter);

    if (filtered.length === 0) {
      return `<div class="empty-state"><div class="empty-icon">📋</div><p>暂无请假记录</p></div>`;
    }

    const statusMap = {
      pending: '<span class="tag tag-warning">⏳ 待审批</span>',
      approved: '<span class="tag tag-success">✅ 已批准</span>',
      rejected: '<span class="tag tag-danger">❌ 已拒绝</span>'
    };
    const typeMap = { sick: '病假', personal: '事假', annual: '年假', marriage: '婚假', maternity: '产假', other: '其他' };

    return `
    <div class="table-responsive">
      <table>
        <thead><tr><th>申请编号</th><th>员工</th><th>部门</th><th>请假类型</th><th>起止日期</th><th>天数</th><th>预计扣费</th><th>原因</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${filtered.map(l => {
            const emp = employees.find(e => e.id === l.employeeId);
            return `<tr>
              <td>#${String(l.id).padStart(4, '0')}</td>
              <td><strong>${emp ? emp.name : '(已删除)'}</strong></td>
              <td>${emp ? (emp.department || '-') : '-'}</td>
              <td>${typeMap[l.type] || l.type}</td>
              <td>${App.formatDate(l.startDate)} ~ ${App.formatDate(l.endDate)}</td>
              <td>${l.days}天</td>
              <td style="font-size:12px;color:var(--text-light);">${(function(){
                var _e = employees.find(function(x){return x.id === l.employeeId;});
                if (!_e) return "-";
                var _cfg = Store._getLeaveDeductConfig(_e);
                var _d = parseInt(l.days) || 0;
                if (_cfg) {
                  var _amt = _d * _cfg.hoursPerDay * _cfg.rate;
                  return "¥" + _amt.toFixed(0) + " (" + _cfg.rate + "/h)";
                } else {
                  return "-";
                }
              })()}</td>
              <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${l.reason || ''}">${l.reason || '-'}</td>
              <td>${statusMap[l.status] || '-'}</td>
              <td>
                ${l.status === 'pending' ? `
                  <button class="btn btn-success btn-sm" onclick="Leave.approve(${l.id})">批准</button>
                  <button class="btn btn-danger btn-sm" onclick="Leave.reject(${l.id})">拒绝</button>
                ` : '-'}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  },

  showApplyModal() {
    var employees = Store.getEmployees();var _cu=Auth.currentUser();if(_cu&&_cu.role!='admin'){employees=employees.filter(function(e){return e.name===_cu.name;});}
    if (employees.length === 0) {
      App.toast('请先添加人员信息', 'warning');
      return;
    }
    App.openModal('申请请假', `
      <div class="form-group">
        <label>选择员工 *</label>
        <select class="form-control" id="leaveEmployee">
          ${employees.map(e => `<option value="${e.id}">${e.name} (${e.department || '未分配'})</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>请假类型 *</label>
        <select class="form-control" id="leaveType">
          <option value="sick">病假</option>
          <option value="personal">事假</option>
          <option value="annual">年假</option>
          <option value="marriage">婚假</option>
          <option value="maternity">产假</option>
          <option value="other">其他</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>开始日期 *</label>
          <input type="date" class="form-control" id="leaveStart" value="${App.today()}">
        </div>
        <div class="form-group">
          <label>结束日期 *</label>
          <input type="date" class="form-control" id="leaveEnd" value="${App.today()}">
        </div>
      </div>
      <div class="form-group">
        <label>请假原因</label>
        <textarea class="form-control" id="leaveReason" placeholder="请输入请假原因"></textarea>
      </div>
    `, '<button class="btn btn-primary" onclick="Leave.saveApply()">提交申请</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },

  saveApply() {
    const employeeId = parseInt(document.getElementById('leaveEmployee').value);
    const type = document.getElementById('leaveType').value;
    const startDate = document.getElementById('leaveStart').value;
    const endDate = document.getElementById('leaveEnd').value;
    const reason = document.getElementById('leaveReason').value.trim();

    if (!startDate || !endDate) {
      App.toast('请选择起止日期', 'error');
      return;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end < start) {
      App.toast('结束日期不能早于开始日期', 'error');
      return;
    }
    const days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;

    console.log("Leave saved:", { employeeId, type, startDate, endDate, days, reason }); Store.addLeaveRequest({ employeeId, type, startDate, endDate, days, reason });
    var _lvEmp = Store.getEmployees().find(function(e){return e.id===employeeId;}); if (_lvEmp) Feishu.notifyLeave(_lvEmp, {type:type,days:days,startDate:startDate,endDate:endDate});
    App.toast('请假申请已提交，等待审批', 'success');
    App.closeModal();
    App.navigate('leave');
  },

  approve(id) {
    Store.updateLeaveRequest(id, { status: 'approved' });
    App.toast('已批准该请假申请', 'success');
    App.navigate('leave');
  },

  reject(id) {
    Store.updateLeaveRequest(id, { status: 'rejected' });
    App.toast('已拒绝该请假申请', 'info');
    App.navigate('leave');
  },

  delete(id) {
    if (App.confirm('确定删除此请假记录？')) {
      Store.deleteLeaveRequest(id);
      App.toast('已删除', 'info');
      App.navigate('leave');
    }
  }
};
