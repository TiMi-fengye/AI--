/** AI 查询与期间报表：权限、事实计算及模型配置均由服务端处理。 */
const AI = {
  // Store.clearSessionData 旧版会赋 messages=[]；同时清理本模块内存和迟到请求。
  get messages() { return []; },
  set messages(_) { this.clearSession(); },
  _epoch: 0, _settingsEpoch: 0, _busy: false, _settingsBusy: false, _result: null,
  clearSession() {
    this._epoch++; this._settingsEpoch++; this._result = null; this._settingsContext = null; this._busy = false; this._settingsBusy = false;
    const target = document.getElementById('aiResult'), key = document.getElementById('aiSettingApiKey');
    if (target) target.innerHTML = ''; if (key) key.value = '';
  },
  _allowed() { const u = Auth.currentUser(); return !!u && ['admin', 'leader'].includes(u.role); },
  _admin() { const u = Auth.currentUser(); return !!u && u.role === 'admin'; },
  _identity() {
    const u = Auth.currentUser();
    return JSON.stringify(u ? [Auth._sessionSequence, u.username, u.role, u.employeeId,
      (u.buildings || []).slice().sort(), (u.regions || []).slice().sort()] : null);
  },
  _escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  },
  _cleanLegacyStorage() {
    try { Object.keys(localStorage).filter(k => k === 'personnel_ai_config' || k.startsWith('personnel_ai_messages_')).forEach(k => localStorage.removeItem(k)); }
    catch (_) { /* 禁用存储时仍可使用服务端功能。 */ }
  },
  getConfig() {
    this._cleanLegacyStorage();
    // 管理员简历分析兼容接口：地址固定，已有密钥从不下发浏览器。
    return this._admin() ? { endpoint: '/api/ai/chat', model: '', maxTokens: 2048, temperature: 0.7 } : {};
  },
  render(container) {
    this._cleanLegacyStorage(); this._epoch++; this._busy = false; this._result = null;
    if (!this._allowed()) { container.textContent = '无权使用 AI 查询与报表'; return; }
    const now = new Date(), year = now.getFullYear(), month = now.getMonth() + 1;
    container.innerHTML = '<div class="card" id="aiWorkspace" style="padding:20px">'
      + '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center"><h3>🤖 AI 查询与报表</h3>'
      + (this._admin() ? '<button class="btn btn-outline btn-sm" onclick="AI.showSettings()">AI 服务配置</button>' : '') + '</div>'
      + '<p class="text-muted">管理员查询全部授权数据，楼长查询本楼栋数据。统计由服务器计算；AI 解读单独显示。未配置模型时仍可查询和导出事实报表。</p>'
      + '<div class="form-row"><div class="form-group"><label for="aiMode">功能</label><select class="form-control" id="aiMode" onchange="AI.changeMode()"><option value="query">智能查询</option><option value="report">期间报表</option></select></div>'
      + '<div class="form-group"><label for="aiPeriodType">统计期间</label><select class="form-control" id="aiPeriodType" onchange="AI.changePeriod()"><option value="monthly">月度</option><option value="quarterly">季度</option><option value="annual">年度</option></select></div>'
      + '<div class="form-group"><label for="aiYear">年份</label><input class="form-control" type="number" min="2000" max="2100" id="aiYear" value="' + year + '"></div>'
      + '<div class="form-group" id="aiMonthGroup"><label for="aiMonth">月份</label><select class="form-control" id="aiMonth">'
      + Array.from({ length: 12 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === month ? ' selected' : '') + '>' + (i + 1) + '月</option>').join('') + '</select></div>'
      + '<div class="form-group" id="aiQuarterGroup" style="display:none"><label for="aiQuarter">季度</label><select class="form-control" id="aiQuarter">'
      + Array.from({ length: 4 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === Math.ceil(month / 3) ? ' selected' : '') + '>第' + (i + 1) + '季度</option>').join('') + '</select></div></div>'
      + '<div class="form-row"><div class="form-group"><label for="aiBuilding">楼栋（可选）</label><input class="form-control" id="aiBuilding" maxlength="100" placeholder="留空查询全部授权楼栋"></div>'
      + '<div class="form-group"><label for="aiDepartment">部门（可选）</label><input class="form-control" id="aiDepartment" maxlength="100" placeholder="部门名称"></div>'
      + '<div class="form-group"><label for="aiEmployeeName">人员姓名（可选）</label><input class="form-control" id="aiEmployeeName" maxlength="100" placeholder="在授权范围内查询"></div></div>'
      + '<div class="form-group" id="aiQuestionGroup"><label for="aiQuestion">查询内容</label><textarea class="form-control" id="aiQuestion" rows="3" maxlength="500" placeholder="例如：本月已批准的费用加班和调休加班各多少小时？"></textarea>'
      + '<small>支持人员、考勤、加班、请假和汇总查询。查询文字中的明确年月优先，未指定时使用所选期间；期间报表按上方选择生成。</small></div>'
      + '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap"><label><input type="checkbox" id="aiIncludeAnalysis"> 同时生成 AI 解读（向管理员配置的模型服务发送本次授权统计）</label>'
      + '<button class="btn btn-primary" id="aiRun" onclick="AI.run()">开始查询</button></div><div id="aiStatus" role="status" style="margin-top:12px;white-space:pre-wrap"></div></div><div id="aiResult" style="margin-top:16px"></div>';
  },
  changeMode() {
    if (!this._allowed()) return;
    const report = document.getElementById('aiMode').value === 'report';
    document.getElementById('aiQuestionGroup').style.display = report ? 'none' : '';
    document.getElementById('aiRun').textContent = report ? '生成报表' : '开始查询'; this._invalidate();
  },
  changePeriod() {
    if (!this._allowed()) return;
    const type = document.getElementById('aiPeriodType').value;
    document.getElementById('aiMonthGroup').style.display = type === 'monthly' ? '' : 'none';
    document.getElementById('aiQuarterGroup').style.display = type === 'quarterly' ? '' : 'none'; this._invalidate();
  },
  _invalidate() { this._result = null; const target = document.getElementById('aiResult'); if (target) target.innerHTML = ''; },
  _requestBody() {
    const value = id => String(document.getElementById(id).value || '').trim();
    const periodType = value('aiPeriodType'), year = Number(value('aiYear'));
    if (!['monthly', 'quarterly', 'annual'].includes(periodType) || !Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('请选择有效的统计期间和年份（2000～2100）');
    const body = { periodType, year, filters: {}, includeAnalysis: !!document.getElementById('aiIncludeAnalysis').checked };
    if (periodType === 'monthly') { body.month = Number(value('aiMonth')); if (!Number.isInteger(body.month) || body.month < 1 || body.month > 12) throw new Error('请选择有效月份'); }
    if (periodType === 'quarterly') { body.quarter = Number(value('aiQuarter')); if (!Number.isInteger(body.quarter) || body.quarter < 1 || body.quarter > 4) throw new Error('请选择有效季度'); }
    for (const [name, id] of [['building', 'aiBuilding'], ['department', 'aiDepartment'], ['employeeName', 'aiEmployeeName']]) {
      const text = value(id); if (text.length > 100) throw new Error('筛选条件不能超过100个字符'); if (text) body.filters[name] = text;
    }
    if (value('aiMode') !== 'report') { body.question = value('aiQuestion'); if (!body.question || body.question.length > 500) throw new Error('请输入查询内容（最多500个字符）'); }
    return body;
  },
  _current(identity, epoch, target) {
    return this._allowed() && this._identity() === identity && this._epoch === epoch && App.currentPage === 'ai' && document.getElementById('aiResult') === target;
  },
  async _json(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data; try { data = await response.json(); } catch (_) { throw new Error('服务器响应无效，请稍后重试'); }
    if (!response.ok || !data || data.ok === false) {
      const message = data && (typeof data.error === 'string' ? data.error : data.error && data.error.message || data.message);
      throw new Error(message || (response.status === 401 ? '登录已过期，请重新登录' : response.status === 403 ? '无权查询该范围' : '请求失败（' + response.status + '）'));
    }
    return data;
  },
  async run() {
    if (!this._allowed() || this._busy || App.currentPage !== 'ai') return;
    let body; try { body = this._requestBody(); } catch (error) { App.toast(error.message, 'warning'); return; }
    const identity = this._identity(), epoch = this._epoch, target = document.getElementById('aiResult');
    const button = document.getElementById('aiRun'), status = document.getElementById('aiStatus');
    this._busy = true; this._invalidate(); button.disabled = true; status.textContent = body.question ? '正在查询授权数据…' : '正在生成授权范围报表…';
    try {
      if (typeof Store !== 'undefined' && typeof Store.flushServerSync === 'function') await Store.flushServerSync();
      if (!this._current(identity, epoch, target)) return;
      const data = await this._json(body.question ? '/api/ai/query' : '/api/ai/reports', body);
      if (!this._current(identity, epoch, target)) return;
      if (JSON.stringify(this._requestBody()) !== JSON.stringify(body)) { status.textContent = '查询条件已改变，请重新查询。'; return; }
      const report = data.report ? this._safeReport(data.report) : null; if (report) this._checkScope(report);
      const result = { report, answer: typeof data.answer === 'string' ? data.answer : '', analysis: typeof data.analysis === 'string' ? data.analysis : '',
        supported: data.supported !== false, ai: this._safeAI(data.ai), identity, epoch, target, request: JSON.stringify(body) };
      this._result = result; status.textContent = ''; this._renderResult(result);
    } catch (error) {
      if (this._current(identity, epoch, target)) { this._result = null; status.textContent = '查询失败：' + error.message; App.toast(error.message, 'error'); }
    } finally { if (this._epoch === epoch) this._busy = false; if (this._current(identity, epoch, target)) button.disabled = false; }
  },
  _safeAI(value) { const ai = value && typeof value === 'object' ? value : {}; return { configured: ai.configured === true, status: String(ai.status || ''), message: String(ai.message || '') }; },
  _safeReport(input) {
    if (!input || input.schemaVersion !== 1 || !input.scope || !input.period || !Array.isArray(input.exportRows)) throw new Error('报表结构无效，请刷新后重试');
    const text = v => String(v == null ? '' : v), number = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    const summary = item => {
      item = item || {}; const out = {};
      for (const [section, names] of Object.entries({ personnel: ['total', 'joined', 'left'], attendance: ['records', 'employees'],
        overtime: ['requests', 'approvedRequests', 'feeHours', 'compensatoryHours', 'pendingLeader', 'pendingRegional', 'pendingUnknown', 'otherStatus', 'rejected'],
        leave: ['requests', 'approvedRequests', 'hours', 'days', 'pendingLeader', 'pendingRegional', 'pendingUnknown', 'otherStatus', 'rejected', 'crossMonthRequests'] })) {
        out[section] = {}; for (const name of names) out[section][name] = number(item[section] && item[section][name]);
      }
      const statuses = item.attendance && item.attendance.statuses || {};
      out.attendance.statuses = {}; for (const key of ['present', 'late', 'absent', 'other']) out.attendance.statuses[key] = number(statuses[key]);
      return out;
    };
    const report = { schemaVersion: 1, mode: 'facts', generatedAt: text(input.generatedAt), revision: text(input.revision),
      scope: { role: text(input.scope.role), buildings: (Array.isArray(input.scope.buildings) ? input.scope.buildings : []).map(text), employeeCount: number(input.scope.employeeCount), filters: {} },
      period: { type: text(input.period.type), year: number(input.period.year), label: text(input.period.label), start: text(input.period.start), endExclusive: text(input.period.endExclusive) },
      summary: summary(input.summary), monthlyBreakdown: (Array.isArray(input.monthlyBreakdown) ? input.monthlyBreakdown : []).map(item => ({ month: text(item.month), label: text(item.label), summary: summary(item.summary) })),
      groupings: {}, dataQuality: (Array.isArray(input.dataQuality) ? input.dataQuality : []).map(item => ({ code: text(item.code), label: text(item.label), count: number(item.count) })),
      methodology: (Array.isArray(input.methodology) ? input.methodology : []).map(text),
      exportRows: input.exportRows.map(item => ({ section: text(item.section), label: text(item.label), value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : text(item.value), unit: text(item.unit), month: text(item.month) })), leaveOverlap: {}, details: { leaves: [] } };
    for (const key of ['month', 'quarter']) if (input.period[key] != null) report.period[key] = number(input.period[key]);
    for (const key of ['department', 'building', 'employeeName']) if (input.scope.filters && input.scope.filters[key]) report.scope.filters[key] = text(input.scope.filters[key]);
    for (const key of ['statuses', 'departments', 'buildings', 'leaveTypes']) report.groupings[key] = (Array.isArray(input.groupings && input.groupings[key]) ? input.groupings[key] : []).map(item => {
      const row = { label: text(item.label), count: number(item.count) }; if (key === 'leaveTypes') for (const f of ['approvedRequests', 'hours', 'days']) row[f] = number(item[f]); return row;
    });
    for (const key of ['overlappingFromPreviousPeriod', 'crossBoundaryRequests', 'approvedOverlappingFromPreviousPeriod']) report.leaveOverlap[key] = number(input.leaveOverlap && input.leaveOverlap[key]);
    report.leaveOverlap.allocation = text(input.leaveOverlap && input.leaveOverlap.allocation);
    report.details.leaves = (Array.isArray(input.details && input.details.leaves) ? input.details.leaves : []).map(item => ({
      employeeName: text(item.employeeName), department: text(item.department), building: text(item.building), typeLabel: text(item.typeLabel),
      startDate: text(item.startDate), endDate: text(item.endDate), hours: item.hours == null ? null : number(item.hours), days: item.days == null ? null : number(item.days),
      approval: text(item.approval), attributedToPeriod: item.attributedToPeriod === true, crossPeriod: item.crossPeriod === true
    }));
    return report;
  },
  _checkScope(report) {
    const user = Auth.currentUser(); if (!user || report.scope.role !== user.role) throw new Error('账号权限已变化，请重新查询');
    if (user.role === 'leader' && (report.scope.buildings.some(b => !(user.buildings || []).includes(b)) || report.groupings.buildings.some(row => !(user.buildings || []).includes(row.label))
      || report.details.leaves.some(row => !(user.buildings || []).includes(row.building)))) throw new Error('报表范围已变化，请重新查询');
  },
  _table(headers, rows) {
    return '<div class="table-responsive"><table class="data-table"><thead><tr>' + headers.map(v => '<th>' + this._escape(v) + '</th>').join('') + '</tr></thead><tbody>'
      + (rows.length ? rows.map(row => '<tr>' + row.map(v => '<td>' + this._escape(v) + '</td>').join('') + '</tr>').join('') : '<tr><td colspan="' + headers.length + '">暂无记录</td></tr>') + '</tbody></table></div>';
  },
  _reportMarkup(report) {
    const s = report.summary;
    let html = '<h3>' + this._escape(report.period.label) + ' · 服务端事实统计</h3><p>授权范围：' + this._escape(report.scope.role === 'admin' ? '全部授权人员' : report.scope.buildings.join('、') || '无授权楼栋')
      + '；筛选：' + this._escape(Object.entries(report.scope.filters).map(([k, v]) => ({ building: '楼栋', department: '部门', employeeName: '人员' })[k] + '=' + v).join('，') || '无')
      + '；生成时间：' + this._escape(report.generatedAt) + '；数据版本：' + this._escape(report.revision) + '</p>';
    html += this._table(['指标', '数值'], [['当前人员存量', s.personnel.total], ['期间入职', s.personnel.joined], ['期间离职', s.personnel.left], ['考勤记录 / 人数', s.attendance.records + ' / ' + s.attendance.employees],
      ['已批准费用加班（小时）', s.overtime.feeHours], ['已批准调休加班（小时）', s.overtime.compensatoryHours], ['加班待楼长 / 待区域经理', s.overtime.pendingLeader + ' / ' + s.overtime.pendingRegional],
      ['考勤出勤 / 迟到 / 缺勤 / 其他记录', [s.attendance.statuses.present, s.attendance.statuses.late, s.attendance.statuses.absent, s.attendance.statuses.other].join(' / ')],
      ['加班申请 / 最终批准 / 已拒绝', [s.overtime.requests, s.overtime.approvedRequests, s.overtime.rejected].join(' / ')],
      ['加班待批阶段不明 / 其他异常状态', s.overtime.pendingUnknown + ' / ' + s.overtime.otherStatus],
      ['已批准请假（小时 / 天，分别统计）', s.leave.hours + ' / ' + s.leave.days], ['请假申请 / 最终批准 / 已拒绝', [s.leave.requests, s.leave.approvedRequests, s.leave.rejected].join(' / ')],
      ['请假待楼长 / 待区域经理', s.leave.pendingLeader + ' / ' + s.leave.pendingRegional], ['请假待批阶段不明 / 其他异常状态', s.leave.pendingUnknown + ' / ' + s.leave.otherStatus]]);
    if (report.monthlyBreakdown.length) html += '<h4>分月统计</h4>' + this._table(['月份', '人员存量', '入职', '离职', '考勤记录', '考勤人数', '费用加班小时', '调休加班小时', '请假小时', '请假天数'],
      report.monthlyBreakdown.map(r => [r.label || r.month, r.summary.personnel.total, r.summary.personnel.joined, r.summary.personnel.left, r.summary.attendance.records, r.summary.attendance.employees, r.summary.overtime.feeHours, r.summary.overtime.compensatoryHours, r.summary.leave.hours, r.summary.leave.days]));
    for (const [key, title] of [['statuses', '人员状态'], ['departments', '部门分布'], ['buildings', '楼栋分布']]) html += '<h4>' + title + '</h4>' + this._table(['类别', '人数'], report.groupings[key].map(r => [r.label, r.count]));
    html += '<h4>请假类型</h4>' + this._table(['类型', '申请数', '已批准数', '已批准小时', '已批准天数'], report.groupings.leaveTypes.map(r => [r.label, r.count, r.approvedRequests, r.hours, r.days]));
    html += '<h4>与本期重叠的请假原始日期</h4>' + this._table(['人员', '楼栋', '请假类型', '开始日期 / 时分', '结束日期 / 时分', '记录小时', '记录天数', '审批状态', '归属说明'],
      report.details.leaves.map(r => [r.employeeName, r.building, r.typeLabel, r.startDate, r.endDate, r.hours == null ? '未记录' : r.hours, r.days == null ? '未记录' : r.days,
        ({ approved: '最终批准', pendingLeader: '待楼长', pendingRegional: '待区域经理', pendingUnknown: '待审批阶段待核对', rejected: '已拒绝', otherStatus: '其他状态待核对' })[r.approval] || r.approval,
        (r.attributedToPeriod ? '开始归属本期' : '上期开始，不计本期开始口径') + (r.crossPeriod ? '；跨期未摊分' : '')]));
    html += '<h4>数据质量提示</h4>' + this._table(['检查项', '记录数'], report.dataQuality.map(r => [r.label, r.count]));
    return html + '<h4>统计口径与跨期说明</h4><ul>' + report.methodology.map(line => '<li>' + this._escape(line) + '</li>').join('') + '</ul><p>从上期延续的请假：'
      + report.leaveOverlap.overlappingFromPreviousPeriod + '；跨本期边界的请假：' + report.leaveOverlap.crossBoundaryRequests
      + '。跨期时长未按天数自动摊分，请假小时与天数分别展示；人员存量和去重考勤人数不可直接累加分月值。</p>';
  },
  _renderResult(result) {
    let html = result.answer ? '<div class="card" style="padding:20px"><h3>' + (result.supported ? '查询结果' : '当前问题暂不支持') + '</h3><div style="white-space:pre-wrap">' + this._escape(result.answer) + '</div>'
      + (!result.supported ? '<p>下方仅展示所选期间和筛选范围的事实报表，不表示已经回答该问题。</p>' : '') + '</div>' : '';
    if (result.report) html += '<div class="card" style="margin-top:12px;padding:20px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><label for="aiExportFormat">导出格式</label>'
      + '<select class="form-control" id="aiExportFormat" style="width:auto"><option value="xlsx">Excel（XLSX）</option><option value="csv">CSV</option><option value="json">JSON</option><option value="html">独立 HTML</option><option value="pdf">打印 / 另存为 PDF</option></select><button class="btn btn-outline" onclick="AI.exportReport()">导出当前报表</button></div>' + this._reportMarkup(result.report) + '</div>';
    const ai = result.ai, failed = ['error', 'failed', 'unavailable'].includes(ai.status);
    html += '<div class="card" style="margin-top:12px;padding:20px"><h3>AI 解读（独立于事实统计）</h3><div style="white-space:pre-wrap">' + this._escape(result.analysis || (failed ? 'AI 解读失败：' + (ai.message || '模型服务暂不可用，请重试。')
      : !ai.configured ? '事实查询和报表可用；AI 解读待管理员配置。' : ai.message || '本次未请求 AI 解读。')) + '</div><p class="text-muted">AI 解读可能有误，人员、考勤、加班及请假数值请以服务端事实统计为准。</p></div>';
    result.target.innerHTML = html;
  },
  _spreadsheetText(value) { const text = String(value == null ? '' : value); return /^[\s\uFEFF]*[=+@-]|^[\s\uFEFF]*[\t\r\n]/.test(text) ? "'" + text : text; },
  makeFile(format, input) {
    const report = this._safeReport(input), stem = '人力资源-' + (report.period.label || String(report.period.year)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    if (format === 'json') return { filename: stem + '.json', mime: 'application/json;charset=utf-8', content: JSON.stringify(report, null, 2) };
    if (format === 'html' || format === 'pdf') return { filename: stem + '.html', mime: 'text/html;charset=utf-8', content: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
      + this._escape(stem) + '</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#172033;line-height:1.6}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ccd4df;padding:7px;text-align:left}h4{margin-bottom:8px}.table-responsive{overflow:auto}@media print{button{display:none}body{margin:0;font-size:10pt}}</style></head><body>'
      + (format === 'pdf' ? '<button id="aiPrint">打印 / 另存为 PDF</button>' : '') + this._reportMarkup(report) + '</body></html>' };
    const rows = [['期间', report.period.label], ['生成时间', report.generatedAt], ['数据版本', report.revision], ['授权范围', report.scope.role === 'admin' ? '全部授权人员' : report.scope.buildings.join('、')], [], ['分组', '指标', '数值', '单位', '月份'],
      ...report.exportRows.map(r => [r.section, r.label, r.value, r.unit, r.month]), [], ['统计口径'], ...report.methodology.map(line => [line]), [], ['质量检查', '记录数'], ...report.dataQuality.map(r => [r.label, r.count])];
    if (format === 'csv') return { filename: stem + '.csv', mime: 'text/csv;charset=utf-8', content: '\uFEFF' + rows.map(row => row.map(v => '"' + this._spreadsheetText(v).replace(/"/g, '""') + '"').join(',')).join('\r\n') };
    if (format === 'xlsx') {
      if (typeof XLSX === 'undefined' || !XLSX.utils) throw new Error('Excel 导出组件未加载，请刷新后重试');
      const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows.map(row => row.map(v => typeof v === 'number' ? v : this._spreadsheetText(v)))), '期间统计');
      return { filename: stem + '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) };
    }
    throw new Error('不支持的导出格式');
  },
  exportReport() {
    const result = this._result; if (!result || !result.report || !this._current(result.identity, result.epoch, result.target)) return;
    try {
      if (JSON.stringify(this._requestBody()) !== result.request) { this._invalidate(); throw new Error('期间或筛选已改变，请重新查询后导出'); }
      this._checkScope(result.report); const format = document.getElementById('aiExportFormat').value, file = this.makeFile(format, result.report);
      if (format !== 'pdf') return this._download(file);
      const popup = window.open('', '_blank'); if (!popup) throw new Error('浏览器阻止了打印窗口，请允许弹窗后重试');
      popup.opener = null; popup.document.open(); popup.document.write(file.content); popup.document.close();
      const button = popup.document.getElementById('aiPrint'); if (button) button.onclick = () => { popup.focus(); popup.print(); };
      Promise.resolve(popup.document.fonts && popup.document.fonts.ready).then(() => { if (!popup.closed) { popup.focus(); popup.print(); } });
    } catch (error) { App.toast(error.message, 'error'); }
  },
  _download(file) {
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mime })), link = document.createElement('a');
    link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  },
  async showSettings() {
    if (!this._admin()) return;
    const identity = this._identity(), sequence = ++this._settingsEpoch;
    try {
      const data = await this._json('/api/ai/settings');
      if (!this._admin() || this._identity() !== identity || this._settingsEpoch !== sequence || App.currentPage !== 'ai') return;
      const s = data.settings || data, flags = s.envOverride; this._settingsBusy = false;
      App.openModal('AI 服务配置（仅管理员）', '<p>配置保存在服务器，浏览器不会保存或读取已有密钥。先保存，再测试当前有效连接；测试不发送人员数据。</p><p>状态：'
        + (s.configured ? '已配置' : '待配置') + '；密钥：' + (s.apiKeyConfigured ? '已设置' : '未设置') + (flags && (flags === true || Object.values(flags).some(Boolean)) ? '。部分有效配置由服务器环境变量覆盖，请在服务器调整对应值。' : '') + '</p>'
        + '<div class="form-group"><label><input type="checkbox" id="aiSettingEnabled"' + (s.enabled ? ' checked' : '') + '> 启用 AI 解读</label></div>'
        + '<div class="form-group"><label for="aiSettingEndpoint">OpenAI 兼容 API 地址（由服务器访问）</label><input class="form-control" id="aiSettingEndpoint" maxlength="2048" value="' + this._escape(s.endpoint) + '" placeholder="https://服务地址/v1/chat/completions"></div>'
        + '<div class="form-group"><label for="aiSettingModel">模型名称</label><input class="form-control" id="aiSettingModel" maxlength="200" value="' + this._escape(s.model) + '"></div>'
        + '<div class="form-group"><label for="aiSettingApiKey">新 API Key（留空保留已有密钥）</label><input class="form-control" type="password" autocomplete="new-password" id="aiSettingApiKey" value="" placeholder="仅更换密钥时填写"></div>'
        + '<label><input type="checkbox" id="aiSettingClearKey"> 清除服务器已保存的密钥</label><div role="status" id="aiSettingStatus" style="margin-top:12px;white-space:pre-wrap"></div>',
        '<button class="btn btn-primary" id="aiSettingSave" onclick="AI.saveSettings()">保存配置</button><button class="btn btn-outline" id="aiSettingTest" onclick="AI.testConnection()">测试已保存连接</button><button class="btn btn-outline" onclick="App.closeModal()">关闭</button>');
      this._settingsContext = { identity, sequence, target: document.getElementById('aiSettingStatus') };
    } catch (error) { if (this._admin() && this._identity() === identity && sequence === this._settingsEpoch) App.toast(error.message, 'error'); }
  },
  _settingsCurrent(context) {
    const overlay = document.getElementById('modalOverlay');
    return context && this._admin() && context.identity === this._identity() && context.sequence === this._settingsEpoch && document.getElementById('aiSettingStatus') === context.target
      && App.currentPage === 'ai' && (!overlay || overlay.classList.contains('show'));
  },
  async _settingsAction(test) {
    const context = this._settingsContext; if (this._settingsBusy || !this._settingsCurrent(context)) return;
    let body = {};
    if (!test) {
      body = { enabled: !!document.getElementById('aiSettingEnabled').checked, endpoint: document.getElementById('aiSettingEndpoint').value.trim(), model: document.getElementById('aiSettingModel').value.trim(),
        apiKey: document.getElementById('aiSettingApiKey').value.trim(), clearApiKey: !!document.getElementById('aiSettingClearKey').checked };
      if (body.apiKey && body.clearApiKey) { App.toast('更换密钥和清除密钥不能同时选择', 'warning'); return; }
    }
    this._settingsBusy = true; const buttons = ['aiSettingSave', 'aiSettingTest'].map(id => document.getElementById(id));
    buttons.forEach(b => { if (b) b.disabled = true; }); context.target.textContent = test ? '正在测试已保存的连接…' : '正在保存配置…';
    try {
      const data = await this._json(test ? '/api/ai/test' : '/api/ai/settings', body); if (!this._settingsCurrent(context)) return;
      context.target.textContent = test ? '连接测试成功' : '配置已保存。可测试连接或开始查询。';
      if (!test) { document.getElementById('aiSettingApiKey').value = ''; document.getElementById('aiSettingClearKey').checked = false; }
      if (test && data.message) context.target.textContent += '：' + String(data.message);
    } catch (error) { if (this._settingsCurrent(context)) context.target.textContent = (test ? '连接测试失败：' : '保存失败：') + error.message; }
    finally { if (context.sequence === this._settingsEpoch) this._settingsBusy = false; if (this._settingsCurrent(context)) buttons.forEach(b => { if (b) b.disabled = false; }); }
  },
  saveSettings() { return this._settingsAction(false); },
  testConnection() { return this._settingsAction(true); }
};
AI._cleanLegacyStorage();
