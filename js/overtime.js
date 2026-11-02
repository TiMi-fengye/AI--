/**
 * 加班管理模块
 */
const Overtime = {
  render(container) {
    var list = Store.getOvertime();
    var emps = Store.getEmployees();
    var today = App.today();
    var todayList = list.filter(function(o){return o.date === today;});
    var todayHours = todayList.reduce(function(s,o){return s + (parseFloat(o.hours)||0);}, 0);
    var month = today.substring(0,7);
    var monthList = list.filter(function(o){return o.date && o.date.indexOf(month) === 0;});
    var monthHours = monthList.reduce(function(s,o){return s + (parseFloat(o.hours)||0);}, 0);

    container.innerHTML =
      '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">' +
      '<span style="font-size:16px;font-weight:600;">⏰ 加班统计</span>' +
      '<button class="btn btn-primary" onclick="Overtime.showAddModal()">+ 申请加班</button>' +
      '<div style="flex:1;"></div>' +
      '<input type="date" class="form-control" id="otDateFilter" value="' + today + '" style="max-width:160px;" onchange="Overtime.render(document.getElementById(\u0027pageContent\u0027))">' +
      '</div>' +
      '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);">' +
        '<div class="stat-card primary"><div class="stat-icon">⏰</div><div class="stat-label">今日加班人次</div><div class="stat-value">' + todayList.length + '</div></div>' +
        '<div class="stat-card success"><div class="stat-icon">⏱️</div><div class="stat-label">今日加班时长</div><div class="stat-value">' + todayHours.toFixed(1) + 'h</div></div>' +
        '<div class="stat-card warning"><div class="stat-icon">📅</div><div class="stat-label">本月总加班</div><div class="stat-value">' + monthHours.toFixed(1) + 'h</div></div>' +
        '<div class="stat-card info"><div class="stat-icon">💼</div><div class="stat-label">待审核</div><div class="stat-value">' + list.filter(function(o){return o.status === 'pending';}).length + '</div></div>' +
      '</div>' +
      '<div class="card"><div class="card-header"><h3>📋 加班记录</h3></div><div class="card-body">' +
      this._renderTable(list, emps) +
      '</div></div>';
  },

  _renderTable(list, emps) {
    var dateFilterEl = document.getElementById('otDateFilter');
    var filterDate = dateFilterEl ? dateFilterEl.value : '';

    var filtered = list.slice().sort(function(a,b){return b.id - a.id;});
    if (filterDate) {
      filtered = filtered.filter(function(o){return o.date === filterDate;});
    }

    if (filtered.length === 0) {
      return '<div class="empty-state"><div class="empty-icon">⏰</div><p>暂无加班记录</p></div>';
    }

    var html = '<div class="table-responsive"><table><thead><tr>' +
      '<th>日期</th><th>员工</th><th>部门</th><th>时长</th><th>原因</th><th>状态</th><th>操作</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < filtered.length; i++) {
      var o = filtered[i];
      var emp = emps.find(function(e){return e.id === o.employeeId;});
      var statusLabel = '待审核';
      var statusClass = 'tag-warning';
      if (o.status === 'approved') { statusLabel = '已批准'; statusClass = 'tag-success'; }
      if (o.status === 'rejected') { statusLabel = '已拒绝'; statusClass = 'tag-danger'; }

      html += '<tr>' +
        '<td>' + o.date + '</td>' +
        '<td><strong>' + (emp ? emp.name : '(已删除)') + '</strong></td>' +
        '<td>' + (emp ? (emp.department || '-') : '-') + '</td>' +
        '<td>' + (parseFloat(o.hours) || 0).toFixed(1) + 'h</td>' +
        '<td>' + (o.reason || '-') + '</td>' +
        '<td><span class="tag ' + statusClass + '">' + statusLabel + '</span></td>' +
        '<td>';

      if (o.status === 'pending') {
        html += '<button class="btn btn-success btn-sm" onclick="Overtime.approve(' + o.id + ')">批准</button> ';
        html += '<button class="btn btn-danger btn-sm" onclick="Overtime.reject(' + o.id + ')">拒绝</button> ';
      }

      html += '<button class="btn btn-outline btn-sm" onclick="Overtime.showEditModal(' + o.id + ')">编辑</button> ';
      html += '<button class="btn btn-danger btn-sm" onclick="Overtime.deleteRecord(' + o.id + ')">删除</button>' +
        '</td></tr>';
    }

    html += '</tbody></table></div>';
    return html;
  },

  showAddModal() {
    var emps = Store.getEmployees();var _cu=Auth.currentUser();if(_cu&&_cu.role!='admin'){emps=emps.filter(function(e){return e.name===_cu.name;});}
    if (emps.length === 0) { App.toast('请先添加人员', 'warning'); return; }
    var options = '';
    for (var i = 0; i < emps.length; i++) {
      options += '<option value="' + emps[i].id + '">' + emps[i].name + ' (' + (emps[i].department||'') + ')</option>';
    }
    App.openModal('申请加班',
      '<div class="form-group"><label>选择员工 *</label><select class="form-control" id="otEmployee">' + options + '</select></div>' +
      '<div class="form-group"><label>加班日期 *</label><input type="date" class="form-control" id="otDate" value="' + App.today() + '"></div>' +
      '<div class="form-group"><label>加班时长（小时）*</label><input type="number" class="form-control" id="otHours" value="2" min="0.5" step="0.5"></div>' +
      '<div class="form-group"><label>加班原因</label><input type="text" class="form-control" id="otReason" placeholder="请输入加班原因"></div>',
      '<button class="btn btn-primary" onclick="Overtime.saveAdd()">提交</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  saveAdd() {
    var employeeId = parseInt(document.getElementById('otEmployee').value);
    var date = document.getElementById('otDate').value;
    var hours = parseFloat(document.getElementById('otHours').value) || 0;
    var reason = document.getElementById('otReason').value.trim();
    if (!date || hours <= 0) { App.toast('请填写完整信息', 'error'); return; }
    Store.addOvertime({ employeeId: employeeId, date: date, hours: hours, reason: reason, status: 'pending' });
    var _otEmp = Store.getEmployees().find(function(e){return e.id===employeeId;}); if (_otEmp) Feishu.notifyOvertime(_otEmp, {hours:hours,date:date});
    App.toast('加班申请已提交', 'success');
    App.closeModal();
    App.navigate('overtime');
  },

  showEditModal(id) {
    var o = Store.getOvertime().find(function(ot){return ot.id === id;});
    if (!o) return;
    var emp = Store.getEmployees().find(function(e){return e.id === o.employeeId;});
    App.openModal('编辑加班记录',
      '<div class="form-group"><label>员工</label><input type="text" class="form-control" value="' + (emp ? emp.name : '') + '" disabled></div>' +
      '<div class="form-group"><label>加班日期</label><input type="date" class="form-control" id="otEditDate" value="' + o.date + '"></div>' +
      '<div class="form-group"><label>加班时长（小时）</label><input type="number" class="form-control" id="otEditHours" value="' + (parseFloat(o.hours) || 0) + '" min="0.5" step="0.5"></div>' +
      '<div class="form-group"><label>加班原因</label><input type="text" class="form-control" id="otEditReason" value="' + (o.reason || '') + '"></div>' +
      '<input type="hidden" id="otEditId" value="' + id + '">',
      '<button class="btn btn-primary" onclick="Overtime.saveEdit()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  saveEdit() {
    var id = parseInt(document.getElementById('otEditId').value);
    var date = document.getElementById('otEditDate').value;
    var hours = parseFloat(document.getElementById('otEditHours').value) || 0;
    var reason = document.getElementById('otEditReason').value.trim();
    Store.updateOvertime(id, { date: date, hours: hours, reason: reason });
    App.toast('已更新', 'success');
    App.closeModal();
    App.navigate('overtime');
  },

  approve(id) {
    Store.updateOvertime(id, { status: 'approved' });
    App.toast('已批准', 'success');
    App.navigate('overtime');
  },

  reject(id) {
    Store.updateOvertime(id, { status: 'rejected' });
    App.toast('已拒绝', 'info');
    App.navigate('overtime');
  },

  deleteRecord(id) {
    if (App.confirm('确定删除此加班记录？')) {
      Store.deleteOvertime(id);
      App.toast('已删除', 'info');
      App.navigate('overtime');
    }
  }
};
