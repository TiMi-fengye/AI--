const Dashboard = {
  _employees() { return Store.getEmployees().filter(function (employee) { return Auth.canAccessEmployee(employee.id); }); },
  render(container) {
    if (!Auth.canAccessPage('dashboard')) { container.textContent = '无权查看数据看板'; return; }
    var stats = Store.getStats();
    var employees = this._employees();
    var leaves = Store.getLeaveRequests();
    var monthYm = App.today().substring(0, 7);
    var otList = Store.getOvertime();
    var monthOt = otList.filter(function(o){return o.date && o.date.indexOf(monthYm) === 0;});
    var monthOtHours = monthOt.reduce(function(s,o){return s + (parseFloat(o.hours)||0);}, 0);
    var settlement = Store.getOrCalcSettlement(monthYm);
    var totalOtPay = 0, totalLvDeduct = 0;
    if (settlement && settlement.records) { for (var i = 0; i < settlement.records.length; i++) { totalOtPay += settlement.records[i].otPay || 0; totalLvDeduct += settlement.records[i].lvDeduct || 0; } }
    var totalFee = totalOtPay - totalLvDeduct;
    var pendingLeaves = leaves.filter(function(l){return l.status === "pending";}).length;
    var pendingOt = otList.filter(function(o){return o.status === "pending";}).length;
    var monthLogs = Store.getMonthUpdateLogs ? Store.getMonthUpdateLogs() : [];
    var lateCount = Store.getLateUpdateCount ? Store.getLateUpdateCount() : 0;
    var showReminder = new Date().getDate() <= 10;
    var reminder = showReminder
      ? "<div style=\"display:flex;gap:10px;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin-bottom:16px;\">" +
        "<span style=\"font-size:18px;\">⚠️</span><div>" +
        "<div style=\"font-size:13px;font-weight:600;color:#92400e;\">每栋楼长人员信息更新提醒</div>" +
        "<div style=\"font-size:12px;color:#b45309;margin-top:2px;\">请各楼栋楼长在每月 10 日前完成本月入职、离职及人员信息更新。</div>" +
        "</div></div>"
      : "";
    container.innerHTML = '<div class="dashboard-view">' + [
      reminder,
      "<div style=\"display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px;\">",
        "<div style=\"background:linear-gradient(135deg,#3b82f6,#2563eb);border-radius:14px;padding:18px 16px;color:#fff;box-shadow:0 4px 12px rgba(59,130,246,0.25);\">" + "<div style=\"font-size:12px;opacity:0.85;margin-bottom:8px;\">👥 总人数</div>" + "<div style=\"font-size:26px;font-weight:700;\">" + employees.length + "</div>" + "</div>",
        "<div style=\"background:linear-gradient(135deg,#10b981,#059669);border-radius:14px;padding:18px 16px;color:#fff;box-shadow:0 4px 12px rgba(16,185,129,0.25);\">" + "<div style=\"font-size:12px;opacity:0.85;margin-bottom:8px;\">💰 本月费用合计</div>" + "<div style=\"font-size:26px;font-weight:700;\">¥" + totalFee.toFixed(0) + "</div>" + "</div>",
        "<div style=\"background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:14px;padding:18px 16px;color:#fff;box-shadow:0 4px 12px rgba(245,158,11,0.25);\">" + "<div style=\"font-size:12px;opacity:0.85;margin-bottom:8px;\">⏰ 本月加班</div>" + "<div style=\"font-size:26px;font-weight:700;\">" + monthOtHours.toFixed(1) + "h</div>" + "<div style=\"margin-top:8px;font-size:11px;opacity:0.8;\">" + monthOt.length + " 人次</div>" + "</div>",
        "<div style=\"background:linear-gradient(135deg,#8b5cf6,#7c3aed);border-radius:14px;padding:18px 16px;color:#fff;box-shadow:0 4px 12px rgba(139,92,246,0.25);\">" + "<div style=\"font-size:12px;opacity:0.85;margin-bottom:8px;\">💵 加班费</div>" + "<div style=\"font-size:26px;font-weight:700;\">¥" + totalOtPay.toFixed(0) + "</div>" + "<div style=\"margin-top:8px;font-size:11px;opacity:0.8;\">待审批 " + pendingOt + " 条</div>" + "</div>",
        "<div style=\"background:linear-gradient(135deg,#ef4444,#dc2626);border-radius:14px;padding:18px 16px;color:#fff;box-shadow:0 4px 12px rgba(239,68,68,0.25);\">" + "<div style=\"font-size:12px;opacity:0.85;margin-bottom:8px;\">📉 扣除费</div>" + "<div style=\"font-size:26px;font-weight:700;\">¥" + totalLvDeduct.toFixed(0) + "</div>" + "<div style=\"margin-top:8px;font-size:11px;opacity:0.8;\">请假扣款</div>" + "</div>",
        "<div style=\"background:linear-gradient(135deg,#06b6d4,#0891b2);border-radius:14px;padding:18px 16px;color:#fff;box-shadow:0 4px 12px rgba(6,182,212,0.25);\">" + "<div style=\"font-size:12px;opacity:0.85;margin-bottom:8px;\">⏳ 待审批</div>" + "<div style=\"font-size:26px;font-weight:700;\">" + (pendingLeaves + pendingOt) + "</div>" + "<div style=\"margin-top:8px;font-size:11px;opacity:0.8;\">请假 " + pendingLeaves + " · 加班 " + pendingOt + "</div>" + "</div>",
      "</div>",
      "<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;\">",
        this._deductionCard(),
        this._increaseCard(),
      "</div>",
      "<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:16px;\">",
        this._leaveCard(),
        this._otCard(),
      "</div>",
      this._buildingHeadcountCard(),
      this._buildingTimeBalanceCard(),
      this._monthChangesCard(monthYm),
      this._newEmployeesCard(monthYm),
      this._updateLogCard(monthLogs, lateCount)
    ].join("") + '</div>';
  },

  _deductionCard() {
    var monthYm = App.today().substring(0, 7);
    Store.getOrCalcSettlement(monthYm);
    var settlements = Store.getSettlements();
    if (!settlements || settlements.length === 0) return "";
    settlements.sort(function(a,b){ return b.yearMonth.localeCompare(a.yearMonth); });
    var recent = settlements.slice(0, 6).reverse();
    var maxVal = 0, data = [];
    for (var i = 0; i < recent.length; i++) {
      var s = recent[i]; var v = 0;
      if (s.records) { for (var j = 0; j < s.records.length; j++) v += s.records[j].lvDeduct || 0; }
      if (v > maxVal) maxVal = v;
      data.push({ym:s.yearMonth, total:v});
    }
    if (maxVal === 0) return "";
    var bars = "";
    for (var i = 0; i < data.length; i++) {
      var d = data[i]; var p = maxVal > 0 ? (d.total/maxVal*100) : 0;
      bars += '<div style="display:flex;align-items:center;margin-bottom:10px;gap:10px;">' +
        '<div style="width:38px;font-size:12px;font-weight:600;color:#64748b;text-align:right;">' + Auth.escape(String(d.ym).substring(5)) + "\u6708</div>" +
        '<div style="flex:1;height:26px;background:#fef2f2;border-radius:8px;overflow:hidden;">' +
          '<div style="height:100%;width:' + p.toFixed(1) + '%;background:linear-gradient(90deg,#fca5a5,#ef4444);border-radius:8px;"></div>' +
        "</div>" +
        '<div style="width:76px;text-align:right;font-size:13px;font-weight:700;color:#dc2626;">¥' + d.total.toFixed(0) + "</div>" +
      "</div>";
    }
    return '<div class="card" style="height:100%;"><div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">📉 每月扣除费用概览</h3></div><div class="card-body" style="padding:16px 18px;">' + bars + "</div></div>";
  },

  _increaseCard() {
    var monthYm = App.today().substring(0, 7);
    Store.getOrCalcSettlement(monthYm);
    var settlements = Store.getSettlements();
    if (!settlements || settlements.length === 0) return "";
    settlements.sort(function(a,b){ return b.yearMonth.localeCompare(a.yearMonth); });
    var recent = settlements.slice(0, 6).reverse();
    var maxVal = 0, data = [];
    for (var i = 0; i < recent.length; i++) {
      var s = recent[i]; var v = 0;
      if (s.records) { for (var j = 0; j < s.records.length; j++) v += s.records[j].otPay || 0; }
      if (v > maxVal) maxVal = v;
      data.push({ym:s.yearMonth, total:v});
    }
    if (maxVal === 0) return "";
    var bars = "";
    for (var i = 0; i < data.length; i++) {
      var d = data[i]; var p = maxVal > 0 ? (d.total/maxVal*100) : 0;
      bars += '<div style="display:flex;align-items:center;margin-bottom:10px;gap:10px;">' +
        '<div style="width:38px;font-size:12px;font-weight:600;color:#64748b;text-align:right;">' + Auth.escape(String(d.ym).substring(5)) + "\u6708</div>" +
        '<div style="flex:1;height:26px;background:#ecfdf5;border-radius:8px;overflow:hidden;">' +
          '<div style="height:100%;width:' + p.toFixed(1) + '%;background:linear-gradient(90deg,#6ee7b7,#10b981);border-radius:8px;"></div>' +
        "</div>" +
        '<div style="width:76px;text-align:right;font-size:13px;font-weight:700;color:#059669;">+¥' + d.total.toFixed(0) + "</div>" +
      "</div>";
    }
    return '<div class="card" style="height:100%;"><div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">📈 每月加班费数据概览</h3></div><div class="card-body" style="padding:16px 18px;">' + bars + "</div></div>";
  },

  _leaveCard() {
    var monthYm = App.today().substring(0, 7);
    var leaves = Store.getLeaveRequests().filter(function(l){return l.startDate && l.startDate.indexOf(monthYm) === 0 && l.status === "approved";});
    if (!leaves || leaves.length === 0) return "";
    var emps = this._employees();
    var totalDeduct = 0, rows = "";
    for (var i = 0; i < leaves.length; i++) {
      var l = leaves[i];
      var emp = emps.find(function(e){return e.id === l.employeeId;});
      if (!emp) continue;
      var ds = l.startDate === l.endDate ? l.startDate : l.startDate + "~" + l.endDate;
      var ded = l.lvDeduct;
      var rateStr = l.lvRate;
      if (ded === undefined || ded === null || !rateStr) {
        var cfg = Store._getLeaveDeductConfig(emp);
        var days = parseInt(l.days) || 0;
        if (cfg) {
          ded = days * cfg.hoursPerDay * cfg.rate;
          rateStr = cfg.rate.toFixed(2) + "Ԫ/h×" + cfg.hoursPerDay + "h/天";
        } else {
          ded = 0;
          rateStr = "未配置请假费率";
        }
      }
      ded = Number(ded) || 0;
      totalDeduct += ded;
      rows += '<tr><td><strong>' + Auth.escape(emp.name) + '</strong></td><td>' + Auth.escape(emp.department||"") + "</td><td>" + Auth.escape(ds) + '</td><td>' + (Number(l.days)||0) + "天</td><td>" + Auth.escape(rateStr) + '</td><td style="color:#dc2626;font-weight:700;">-¥' + ded.toFixed(0) + "</td></tr>";
    }
    if (!rows) return "";
    return '<div class="card"><div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">📉 请假扣款数据概览</h3><span style="font-size:12px;color:#94a3b8;">本月合计 ¥' + totalDeduct.toFixed(0) + '</span></div><div class="card-body" style="padding:6px 18px;"><div class="table-responsive"><table style="font-size:12px;"><thead><tr><th>姓名</th><th>部门</th><th>日期</th><th>天数</th><th>标准</th><th>金额</th></tr></thead><tbody>' + rows + "</tbody></table></div></div></div>";
  },

  _otCard() {
    var monthYm = App.today().substring(0, 7);
    var otList = Store.getOvertime().filter(function(o){return o.date && o.date.indexOf(monthYm) === 0 && o.status === "approved" && String(o.overtimeType || "fee") !== "compensatory";});
    if (!otList || otList.length === 0) return "";
    var emps = this._employees();
    var totalPay = 0, rows = "";
    for (var i = 0; i < otList.length; i++) {
      var o = otList[i];
      var emp = emps.find(function(e){return e.id === o.employeeId;});
      if (!emp) continue;
      var pay = o.otPay;
      var rateStr = o.otRate;
      if (pay === undefined || pay === null || !rateStr) {
        var fixedRate = Store._getFixedOtRate(emp);
        var hrs = parseFloat(o.hours) || 0;
        if (fixedRate > 0) {
          pay = hrs * fixedRate;
          rateStr = fixedRate.toFixed(2) + "Ԫ/h";
        } else {
          pay = 0;
          rateStr = "未配置加班费率";
        }
      }
      pay = Number(pay) || 0;
      totalPay += pay;
      rows += '<tr><td><strong>' + Auth.escape(emp.name) + '</strong></td><td>' + Auth.escape(emp.department||"") + "</td><td>" + Auth.escape(o.date) + '</td><td>' + (parseFloat(o.hours)||0) + 'h</td><td>' + Auth.escape(rateStr) + '</td><td style="color:#059669;font-weight:700;">+¥' + pay.toFixed(0) + "</td></tr>";
    }
    if (!rows) return "";
    return '<div class="card"><div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">📈 加班费用数据概览</h3><span style="font-size:12px;color:#94a3b8;">本月合计 +¥' + totalPay.toFixed(0) + '</span></div><div class="card-body" style="padding:6px 18px;"><div class="table-responsive"><table style="font-size:12px;"><thead><tr><th>姓名</th><th>部门</th><th>日期</th><th>时长</th><th>单价</th><th>金额</th></tr></thead><tbody>' + rows + "</tbody></table></div></div></div>";
  },

  _newEmployeesCard(monthYm) {
    var employees = this._employees();
    var newEmps = employees.filter(function(e){
      var jd = e.joinDate || (e.createdAt ? e.createdAt.substring(0, 10) : "");
      return jd && jd.indexOf(monthYm) === 0;
    });
    if (newEmps.length === 0) return "";
    var rows = "";
    for (var i = 0; i < newEmps.length; i++) {
      var e = newEmps[i];
      var dateStr = e.joinDate || (e.createdAt ? e.createdAt.substring(0, 10) : "");
      rows += '<tr>' +
        '<td><strong>' + Auth.escape(e.name||"") + '</strong></td>' +
        '<td>' + Auth.escape(e.position||"") + '</td>' +
        '<td>' + Auth.escape(e.gender||"") + '</td>' +
        '<td>' + Auth.escape(e.phone||"") + '</td>' +
        '<td>' + Auth.escape(e.building||"") + '</td>' +
        '<td style="color:#2563eb;font-weight:600;">' + Auth.escape(dateStr) + '</td>' +
      '</tr>';
    }
    return '<div class="card" style="margin-top:16px;"><div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">👤 本月新增人员</h3><span style="font-size:12px;color:#3b82f6;font-weight:600;">+' + newEmps.length + ' 人</span></div><div class="card-body" style="padding:6px 18px;"><div class="table-responsive"><table style="font-size:12px;"><thead><tr><th>姓名</th><th>职位</th><th>性别</th><th>手机</th><th>楼栋</th><th>入职日期</th></tr></thead><tbody>' + rows + "</tbody></table></div></div></div>";
  },

  /** 本月人员更新记录 */
  _updateLogCard(monthLogs, lateCount) {
    monthLogs = monthLogs || [];
    var label = function (a) { return a === 'add' ? '新增' : a === 'remove' ? '减少' : '修改'; };
    var rows = monthLogs.slice(0, 20).map(function (log) {
      return '<tr>' +
        '<td style="font-size:12px;">' + Auth.escape(log.date || '-') + '</td>' +
        '<td style="font-size:12px;">' + Auth.escape(log.operator || '-') + '</td>' +
        '<td style="font-size:12px;">' + label(log.action) + '</td>' +
        '<td style="font-size:12px;"><strong>' + Auth.escape(log.employeeName || '-') + '</strong></td>' +
        '<td style="font-size:12px;">' + Auth.escape(log.building || '-') + '</td>' +
        '<td>' + (log.late
          ? '<span class="tag tag-danger" style="font-size:10px;">逾期更新</span>'
          : '<span class="tag tag-success" style="font-size:10px;">按时更新</span>') + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">📝 本月人员更新</h3>' +
      '<span style="font-size:12px;color:#94a3b8;">按时 ' + (monthLogs.length - (Number(lateCount)||0)) + ' 次 · 逾期 ' + (Number(lateCount)||0) + ' 次（每月 10 号后更新计为逾期）</span></div>' +
      '<div class="card-body" style="padding:6px 18px;">' +
      (rows
        ? '<div class="table-responsive"><table style="font-size:12px;"><thead><tr><th>日期</th><th>操作人</th><th>操作</th><th>人员</th><th>楼栋</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty-state"><div class="empty-icon">📝</div><p>本月暂无人员更新记录</p></div>') +
      '</div></div>';
  },

  /** 楼栋总人数概览（含楼长） */
  _buildingHeadcountCard() {
    var leaderMap = Object.create(null);
    (Employees._buildingLeaders || []).forEach(function (item) { leaderMap[item.building] = item.leaders; });
    var map = Object.create(null);
    (Auth.isLeader() ? Auth.leaderBuildings() : (Employees._buildingOptions || [])).forEach(function (b) { map[b] = { building: b, leader: leaderMap[b] || '', count: 0 }; });
    this._employees().forEach(function (emp) {
      var b = emp.building || '未分配';
      if (!map[b]) map[b] = { building: b, leader: leaderMap[b] || '', count: 0 };
      map[b].count += 1;
    });
    var items = Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.building.localeCompare(b.building); });
    var total = this._employees().length;
    var cards = items.map(function (item) {
      return '<div style="display:flex;flex-direction:column;gap:6px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">' +
        '<span style="font-size:14px;font-weight:700;color:#0f172a;">' + Auth.escape(item.building) + '</span>' +
        '<span style="font-size:12px;color:#3b82f6;font-weight:600;">' + Auth.escape(item.leader || '未配置楼长') + '</span>' +
        '<strong style="font-size:24px;line-height:1;color:#2563eb;">' + item.count + '</strong>' +
        '</div>';
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">🏢 楼栋总人数概览</h3>' +
      '<span style="font-size:12px;color:#94a3b8;">共 ' + total + ' 人</span></div>' +
      '<div class="card-body" style="padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;">' + cards + '</div></div>';
  },

  /** 楼栋人员调休时长概览（仅统计已批准的调休加班和调休请假） */
  _buildingTimeBalanceCard() {
    var map = Object.create(null);
    (Auth.isLeader() ? Auth.leaderBuildings() : (Employees._buildingOptions || [])).forEach(function (b) {
      map[b] = { building: b, people: 0, overtimeHours: 0, usedHours: 0, remainingHours: 0 };
    });
    this._employees().forEach(function (emp) {
      var b = emp.building || '未分配';
      if (!map[b]) map[b] = { building: b, people: 0, overtimeHours: 0, usedHours: 0, remainingHours: 0 };
      var balance = Store.getTimeBalance ? Store.getTimeBalance(emp.id) : { overtimeHours: 0, compensatoryHours: 0, remainingHours: 0 };
      map[b].people += 1;
      map[b].overtimeHours += Number(balance.overtimeHours) || 0;
      map[b].usedHours += Number(balance.compensatoryHours) || 0;
      map[b].remainingHours += Number(balance.remainingHours) || 0;
    });
    var items = Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.building.localeCompare(b.building); });
    var total = items.reduce(function (sum, item) { return sum + item.remainingHours; }, 0);
    var cards = items.map(function (item) {
      return '<div style="display:flex;flex-direction:column;gap:8px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<span style="font-size:14px;font-weight:700;color:#0f172a;">' + Auth.escape(item.building) + '</span>' +
          '<span style="font-size:11px;color:#64748b;">' + item.people + '人</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b;"><span>调休加班总时长</span><strong style="color:#2563eb;">' + item.overtimeHours.toFixed(1) + 'h</strong></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b;"><span>已使用调休时长</span><strong style="color:#d97706;">' + item.usedHours.toFixed(1) + 'h</strong></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b;"><span>剩余调休时长</span><strong style="color:#059669;">' + item.remainingHours.toFixed(1) + 'h</strong></div>' +
        '</div>';
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">🔄 楼栋人员调休时长概览</h3>' +
      '<span style="font-size:12px;color:#94a3b8;">全员剩余 ' + total.toFixed(1) + 'h</span></div>' +
      '<div class="card-body" style="padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;">' + cards + '</div></div>';
  },

  /** 本月人员变化（按楼栋统计入职 / 离职） */
  _monthChangesCard(monthYm) {
    var rows = [];
    this._employees().forEach(function (emp) {
      if ((emp.joinDate || '').indexOf(monthYm) === 0) rows.push({ building: emp.building || '-', type: '入职' });
      if ((emp.leaveDate || '').indexOf(monthYm) === 0) rows.push({ building: emp.building || '-', type: '离职' });
    });
    var joins = rows.filter(function (r) { return r.type === '入职'; }).length;
    var leaves = rows.filter(function (r) { return r.type === '离职'; }).length;
    var map = Object.create(null);
    rows.forEach(function (r) {
      if (!map[r.building]) map[r.building] = { building: r.building, added: 0, removed: 0 };
      if (r.type === '入职') map[r.building].added += 1; else map[r.building].removed += 1;
    });
    var cards = Object.keys(map).map(function (k) { return map[k]; }).map(function (item) {
      return '<div style="display:flex;flex-direction:column;gap:6px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">' +
        '<strong style="font-size:15px;">' + Auth.escape(item.building) + '</strong>' +
        '<span style="font-size:13px;color:#64748b;">新增 <b style="color:#10b981;">+' + item.added + '</b></span>' +
        '<span style="font-size:13px;color:#64748b;">减少 <b style="color:#ef4444;">-' + item.removed + '</b></span>' +
        '</div>';
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div class="card-header" style="padding:14px 18px;"><h3 style="font-size:15px;">👥 本月人员变化</h3>' +
      '<span style="font-size:12px;color:#94a3b8;">入职 ' + joins + ' · 离职 ' + leaves + '</span></div>' +
      '<div class="card-body" style="padding:14px 16px;">' +
      (cards
        ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;">' + cards + '</div>'
        : '<div class="empty-state"><div class="empty-icon">👥</div><p>本月暂无人员变化</p></div>') +
      '</div></div>';
  }
};
