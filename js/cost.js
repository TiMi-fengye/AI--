/**
 * 费用结算模块：仅统计加班费和请假扣款，不再进行基础薪资结算。
 */
const Cost = {
  _fmt(value) {
    var n = Number(value) || 0;
    return (n < 0 ? '-¥' : '¥') + Math.abs(n).toFixed(2);
  },
  _esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  _month() {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  },
  render(container) {
    Store.refreshRates();
    var ym = this._month();
    container.innerHTML =
      '<div style="display:flex;gap:12px;margin-bottom:20px;align-items:center;flex-wrap:wrap;">' +
        '<span style="font-size:16px;font-weight:600;">💰 费用结算</span>' +
        '<span style="font-size:13px;color:var(--text-light);">仅统计加班费与请假扣款</span>' +
      '</div>' +
      '<div class="card" style="margin-top:16px;">' +
        '<div class="card-header"><h3>📅 月度费用结算</h3><div style="display:flex;gap:8px;align-items:center;">' +
          '<input type="month" class="form-control" id="costYm" value="' + ym + '" style="max-width:180px;display:inline-block;" onchange="Cost.renderSettlement()">' +
          '<button class="btn btn-outline btn-sm" onclick="Cost.forceRecalc();Cost.renderSettlement()">🔄 重算</button>' +
        '</div></div>' +
        '<div class="card-body" id="costSettlementContent"><div class="empty-state"><div class="empty-icon">💰</div><p>加载费用数据...</p></div></div>' +
      '</div>';
    this.renderSettlement();
  },
  renderSettlement() {
    var ymEl = document.getElementById('costYm');
    var container = document.getElementById('costSettlementContent');
    if (!ymEl || !container) return;
    var yearMonth = ymEl.value;
    var settlement = Store.getOrCalcSettlement(yearMonth);
    var records = settlement && settlement.records ? settlement.records : [];
    var totalOt = records.reduce(function(sum, r) { return sum + (Number(r.otPay) || 0); }, 0);
    var totalLv = records.reduce(function(sum, r) { return sum + (Number(r.lvDeduct) || 0); }, 0);
    var balance = totalOt - totalLv;
    var dept = {}, buildings = {};
    records.forEach(function(r) {
      var d = r.department || '未分配';
      var b = r.building || '未分配';
      if (!dept[d]) dept[d] = { name: d, count: 0, ot: 0, lv: 0 };
      if (!buildings[b]) buildings[b] = { name: b, count: 0, ot: 0, lv: 0 };
      [dept[d], buildings[b]].forEach(function(item) {
        item.count++;
        item.ot += Number(r.otPay) || 0;
        item.lv += Number(r.lvDeduct) || 0;
      });
    });
    var groupRows = function(groups) {
      var keys = Object.keys(groups).sort();
      if (!keys.length) return '<tr><td colspan="5" style="text-align:center;color:var(--text-light);">暂无费用数据</td></tr>';
      return keys.map(function(k) {
        var g = groups[k], net = g.ot - g.lv;
        return '<tr><td><strong>' + Cost._esc(g.name) + '</strong></td><td>' + g.count + '</td><td style="color:var(--success);">+' + Cost._fmt(g.ot) + '</td><td style="color:var(--danger);">-' + Cost._fmt(g.lv) + '</td><td style="font-weight:700;color:var(--primary);">' + Cost._fmt(net) + '</td></tr>';
      }).join('');
    };
    var detailRows = records.map(function(r) {
      var net = (Number(r.otPay) || 0) - (Number(r.lvDeduct) || 0);
      return '<tr><td><strong>' + Cost._esc(r.name) + '</strong></td><td>' + Cost._esc(r.department || '-') + '</td><td>' + (Number(r.otHours) || 0) + 'h</td><td style="color:var(--success);">+' + Cost._fmt(r.otPay) + (r.otRate ? '<small style="display:block;color:var(--text-light);">' + Cost._esc(r.otRate) + '</small>' : '') + '</td><td>' + (Number(r.lvDays) || 0) + '天</td><td style="color:var(--danger);">-' + Cost._fmt(r.lvDeduct) + (r.lvRate ? '<small style="display:block;color:var(--text-light);">' + Cost._esc(r.lvRate) + '</small>' : '') + '</td><td style="font-weight:700;color:var(--primary);">' + Cost._fmt(net) + '</td></tr>';
    }).join('');
    container.innerHTML =
      '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);">' +
        '<div class="stat-card primary"><div class="stat-icon">👥</div><div class="stat-label">人员数</div><div class="stat-value">' + (settlement.totalEmployees || 0) + '</div></div>' +
        '<div class="stat-card success"><div class="stat-icon">⏰</div><div class="stat-label">加班费</div><div class="stat-value">+' + this._fmt(totalOt) + '</div></div>' +
        '<div class="stat-card danger"><div class="stat-icon">📉</div><div class="stat-label">请假扣款</div><div class="stat-value">-' + this._fmt(totalLv) + '</div></div>' +
        '<div class="stat-card info"><div class="stat-icon">💰</div><div class="stat-label">费用合计</div><div class="stat-value">' + this._fmt(balance) + '</div></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;">' +
        '<div class="card"><div class="card-header"><h3>🏢 部门费用</h3></div><div class="card-body"><div class="table-responsive"><table><thead><tr><th>部门</th><th>人数</th><th>加班费</th><th>请假扣款</th><th>合计</th></tr></thead><tbody>' + groupRows(dept) + '</tbody></table></div></div></div>' +
        '<div class="card"><div class="card-header"><h3>🏢 楼栋费用</h3></div><div class="card-body"><div class="table-responsive"><table><thead><tr><th>楼栋</th><th>人数</th><th>加班费</th><th>请假扣款</th><th>合计</th></tr></thead><tbody>' + groupRows(buildings) + '</tbody></table></div></div></div>' +
      '</div>' +
      '<div class="card" style="margin-top:16px;"><div class="card-header"><h3>📋 ' + yearMonth + ' 费用明细</h3></div><div class="card-body"><div class="table-responsive"><table><thead><tr><th>姓名</th><th>部门</th><th>加班时长</th><th>加班费</th><th>请假天数</th><th>请假扣款</th><th>费用合计</th></tr></thead><tbody>' + (detailRows || '<tr><td colspan="7" style="text-align:center;color:var(--text-light);">暂无记录</td></tr>') + '</tbody></table></div></div></div>';
  },
  forceRecalc() {
    var ymEl = document.getElementById('costYm');
    if (ymEl && ymEl.value) Store.deleteSettlementByMonth(ymEl.value);
    Store.refreshRates();
  }
};