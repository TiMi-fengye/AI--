/** 本人的小时数；仅按服务端绑定的 employeeId 汇总已批准记录。 */
const MyHours = {
  summary() {
    var user = Auth.currentUser();
    var id = user && Number(user.employeeId);
    var employee = id && Store.getEmployees().find(function (emp) { return Number(emp.id) === id && Auth.canAccessEmployee(emp.id); });
    if (!employee) return null;
    var overtime = Store.getOvertime().filter(function (record) { return Number(record.employeeId) === id && record.status === 'approved'; });
    var feeHours = overtime.filter(function (record) { return !Store.isCompensatoryOvertime(record); }).reduce(function (sum, record) { return sum + (Number(record.hours) || 0); }, 0);
    var balance = Store.getTimeBalance(employee.id);
    return {
      totalHours: feeHours + (Number(balance.overtimeHours) || 0),
      feeHours: feeHours,
      overtimeHours: Number(balance.overtimeHours) || 0,
      usedHours: Number(balance.compensatoryHours) || 0,
      remainingHours: Number(balance.remainingHours) || 0
    };
  },

  render(container) {
    var summary = this.summary();
    if (!summary) {
      container.innerHTML = '<div class="card"><div class="card-header"><h3>我的小时数</h3></div><div class="card-body"><p>当前账号尚未关联人员信息，请联系管理员核对。</p></div></div>';
      return;
    }
    var cards = [
      ['总加班时长', summary.totalHours, 'primary'],
      ['费用加班时长', summary.feeHours, 'info'],
      ['调休加班时长', summary.overtimeHours, 'primary'],
      ['已使用调休时长', summary.usedHours, 'warning'],
      ['剩余调休时长', summary.remainingHours, 'success']
    ];
    container.innerHTML = '<div class="card"><div class="card-header"><h3>我的小时数</h3><span style="font-size:12px;color:var(--text-light);">仅统计已批准记录</span></div><div class="card-body">' +
      '<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:0;">' +
      cards.map(function (card) { return '<div class="stat-card ' + card[2] + '"><div class="stat-label">' + card[0] + '</div><div class="stat-value">' + card[1].toFixed(1) + 'h</div></div>'; }).join('') + '</div></div></div>';
  }
};
