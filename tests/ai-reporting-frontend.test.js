'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/ai.js'), 'utf8');

function facts(role = 'admin', type = 'monthly') {
  const summary = { personnel: { total: 4, joined: 1, left: 0 }, attendance: { records: 18, employees: 4 },
    overtime: { requests: 5, approvedRequests: 3, feeHours: 6, compensatoryHours: 7, pendingLeader: 1, pendingRegional: 1, rejected: 0 },
    leave: { requests: 3, approvedRequests: 2, hours: 4, days: 1, pendingLeader: 1, pendingRegional: 0, rejected: 0, crossMonthRequests: 1 } };
  return { schemaVersion: 1, mode: 'facts', generatedAt: '2026-11-24T08:00:00.000Z', revision: 'test-1',
    scope: { role, buildings: role === 'leader' ? ['楼栋A'] : [], employeeCount: 4, filters: {} },
    period: { type, year: 2026, month: type === 'monthly' ? 11 : undefined, quarter: type === 'quarterly' ? 4 : undefined,
      label: type === 'annual' ? '2026年' : type === 'quarterly' ? '2026年第4季度' : '2026年11月', start: '2026-11-01', endExclusive: '2026-12-01' },
    summary, monthlyBreakdown: Array.from({ length: type === 'annual' ? 12 : type === 'quarterly' ? 3 : 1 }, (_, i) => ({ month: String(i + 1), label: (i + 1) + '月', summary })),
    groupings: { statuses: [{ label: '在职', count: 4 }], departments: [{ label: '演示部门', count: 4 }], buildings: [{ label: '楼栋A', count: 4 }],
      leaveTypes: [{ label: '调休请假', count: 2, approvedRequests: 1, hours: 4, days: 0 }] },
    dataQuality: [{ code: 'legacyDates', label: '历史日期待核对', count: 1 }], methodology: ['请假以开始日期归属，不自动按日摊分。'],
    exportRows: [{ section: '总体', label: '已批准费用加班', value: 6, unit: '小时' }, { section: '分月', label: '已批准费用加班', value: 2, unit: '小时', month: '2026-11' }],
    leaveOverlap: { overlappingFromPreviousPeriod: 1, crossBoundaryRequests: 1, approvedOverlappingFromPreviousPeriod: 1, allocation: 'unallocated' },
    details: { leaves: [{ employeeName: '测试人员', building: '楼栋A', typeLabel: '调休请假', startDate: '2026-10-31T09:30', endDate: '2026-11-01T10:40', hours: 2, days: null, approval: 'approved', attributedToPeriod: false, crossPeriod: true }] } };
}
function fixture(role = 'admin') {
  const user = { username: 'test', role, employeeId: 1, buildings: role === 'leader' ? ['楼栋A'] : [] };
  const state = { requests: [], toasts: [], downloads: [], modals: [], flushes: 0, cleaned: [] };
  const elements = {};
  const element = (value = '') => ({ value, checked: false, disabled: false, textContent: '', innerHTML: '', style: {}, classList: { contains: () => true } });
  for (const [id, value] of Object.entries({ aiMode: 'query', aiPeriodType: 'monthly', aiYear: '2026', aiMonth: '11', aiQuarter: '4',
    aiBuilding: '', aiDepartment: '', aiEmployeeName: '', aiQuestion: '本月加班多少小时？', aiExportFormat: 'json', aiIncludeAnalysis: '',
    aiRun: '', aiStatus: '', aiResult: '', aiQuestionGroup: '', aiMonthGroup: '', aiQuarterGroup: '', modalOverlay: '',
    aiSettingEnabled: '', aiSettingEndpoint: 'https://provider.example/v1/chat/completions', aiSettingModel: 'test-model', aiSettingApiKey: '',
    aiSettingClearKey: '', aiSettingStatus: '', aiSettingSave: '', aiSettingTest: '' })) elements[id] = element(value);
  const storage = { personnel_ai_config: '{"apiKey":"OLD_SECRET"}', personnel_ai_messages_test: 'OLD_PERSONNEL', personnel_employees: 'KEEP_BUSINESS',
    unrelated_setting: 'KEEP_OTHER', removeItem(key) { state.cleaned.push(key); delete this[key]; } };
  const sandbox = { console, Date, JSON, Number, String, Object, Array, Promise, Blob, setTimeout,
    Auth: { _sessionSequence: 1, currentUser: () => user, isAdmin: () => user.role === 'admin', isLeader: () => user.role === 'leader' },
    Store: { flushServerSync: async () => { state.flushes++; }, getEmployees() { throw new Error('never read cached personnel'); } },
    App: { currentPage: 'ai', toast: (...args) => state.toasts.push(args), openModal: (...args) => state.modals.push(args), closeModal() {} },
    document: { getElementById: id => elements[id] }, localStorage: storage,
    fetch: async (url, options) => { state.requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true, report: facts(user.role), answer: '已批准费用加班6小时。', ai: { configured: false, status: 'unconfigured' } }) }; }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.api = AI;', context);
  const api = context.api; api._download = file => state.downloads.push(file);
  return { api, context, user, state, elements, storage };
}

test('browser removes only its obsolete AI settings/history and fixes legacy administrator proxy endpoint', () => {
  const f = fixture();
  assert.deepEqual(f.state.cleaned.sort(), ['personnel_ai_config', 'personnel_ai_messages_test']);
  assert.equal(f.storage.personnel_employees, 'KEEP_BUSINESS'); assert.equal(f.storage.unrelated_setting, 'KEEP_OTHER');
  const cfg = f.api.getConfig(); assert.equal(cfg.endpoint, '/api/ai/chat'); assert.equal(cfg.apiKey, undefined);
  f.user.role = 'leader'; assert.equal(f.api.getConfig().endpoint, undefined);
  assert.doesNotMatch(source, /localStorage\.setItem|Authorization|_buildSystemPrompt|getEmployees\(/);
});

test('only administrator and building leader receive AI navigation, with configuration restricted to administrator', async () => {
  const auth = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8') + ';this.api=Auth;', auth);
  for (const role of ['admin', 'leader', 'region_manager', 'user']) {
    auth.api._user = { role }; assert.equal(auth.api.canAccessPage('ai'), ['admin', 'leader'].includes(role));
    const f = fixture(role), container = { textContent: '', innerHTML: '' }; f.api.render(container);
    if (['admin', 'leader'].includes(role)) {
      assert.match(container.innerHTML, /月度.*季度.*年度/s); assert.match(container.innerHTML, /AI 解读/);
      assert.equal(container.innerHTML.includes('AI 服务配置'), role === 'admin');
    } else { assert.match(container.textContent, /无权/); await f.api.run(); assert.equal(f.state.requests.length, 0); }
    if (role !== 'admin') { await f.api.showSettings(); assert.equal(f.state.requests.length, 0); }
  }
});

test('query sends only selected period/filters to same-origin API after successful save, and shows deterministic facts without AI key', async () => {
  const f = fixture('leader'); f.elements.aiBuilding.value = '楼栋A'; f.elements.aiDepartment.value = '演示部门';
  await f.api.run(); assert.equal(f.state.flushes, 1); assert.equal(f.state.requests.length, 1);
  const { url, options } = f.state.requests[0]; assert.equal(url, '/api/ai/query'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(JSON.parse(options.body), { periodType: 'monthly', year: 2026, month: 11, filters: { building: '楼栋A', department: '演示部门' }, includeAnalysis: false, question: '本月加班多少小时？' });
  const html = f.elements.aiResult.innerHTML;
  assert.match(html, /服务端事实统计/); assert.match(html, /已批准费用加班/); assert.match(html, /AI 解读待管理员配置/); assert.match(html, /分月统计|跨期说明/);
  assert.equal(f.elements.aiRun.disabled, false); assert.equal(f.api._busy, false);
  assert.match(html, /2026-10-31T09:30/); assert.match(html, /上期开始，不计本期开始口径/);
});

test('monthly, quarterly, annual requests validate their period; report endpoint omits question and preserves visible monthly breakdown', async () => {
  for (const [type, count] of [['monthly', 1], ['quarterly', 3], ['annual', 12]]) {
    const f = fixture(); f.elements.aiMode.value = 'report'; f.elements.aiPeriodType.value = type;
    f.context.fetch = async (url, options) => { f.state.requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, report: facts('admin', type), ai: {} }) }; };
    await f.api.run(); const body = JSON.parse(f.state.requests[0].options.body);
    assert.equal(f.state.requests[0].url, '/api/ai/reports'); assert.equal(body.question, undefined); assert.equal(body.periodType, type);
    assert.equal(f.api._result.report.monthlyBreakdown.length, count); assert.match(f.elements.aiResult.innerHTML, /分月统计/);
  }
  for (const [id, value] of [['aiYear', '0'], ['aiYear', '2026.1'], ['aiMonth', '13'], ['aiPeriodType', 'all'], ['aiQuestion', ''], ['aiQuestion', '问'.repeat(501)]]) {
    const f = fixture(); f.elements[id].value = value; await f.api.run(); assert.equal(f.state.requests.length, 0, id); assert.equal(f.state.toasts.length, 1);
  }
  const q = fixture(); q.elements.aiPeriodType.value = 'quarterly'; q.elements.aiQuarter.value = '5'; await q.api.run(); assert.equal(q.state.requests.length, 0);
});

test('unsupported queries explicitly distinguish a fallback period report from answering the question', async () => {
  const f = fixture(); f.context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, supported: false, report: facts(), answer: '当前不支持该问题。', ai: { configured: true, status: 'skipped' } }) });
  await f.api.run(); assert.match(f.elements.aiResult.innerHTML, /当前问题暂不支持/); assert.match(f.elements.aiResult.innerHTML, /不表示已经回答该问题/);
});

test('AI analysis is escaped text and cannot override facts or execute returned HTML', async () => {
  const f = fixture(); f.elements.aiIncludeAnalysis.checked = true;
  const report = facts(); report.groupings.departments[0].label = '<img src=x onerror=alert(1)>';
  f.context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, report, answer: '<script>bad()</script>', analysis: '<img src=x> 模型认为999999小时', ai: { configured: true, status: 'success' } }) });
  await f.api.run(); const html = f.elements.aiResult.innerHTML;
  assert.doesNotMatch(html, /<script|<img/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/);
  assert.equal(f.api._result.report.summary.overtime.feeHours, 6); assert.match(html, /独立于事实统计/);
});

test('upstream/network/authorization/invalid payload failures are explicit and produce no success export', async () => {
  for (const failure of ['network', 'bad-json', 401, 403, 502, 'scope']) {
    const f = fixture('leader');
    f.context.fetch = async () => {
      if (failure === 'network') throw new Error('连接失败');
      if (failure === 'bad-json') return { ok: true, json: async () => { throw Error('bad'); } };
      if (failure === 'scope') { const report = facts('leader'); report.scope.buildings = ['楼栋B']; return { ok: true, json: async () => ({ ok: true, report }) }; }
      return { ok: false, status: failure, json: async () => ({ ok: false, error: '上游服务错误' }) };
    };
    await f.api.run(); assert.equal(f.api._result, null, String(failure)); assert.match(f.elements.aiStatus.textContent, /查询失败/); assert.equal(f.elements.aiRun.disabled, false);
    f.api.exportReport(); assert.equal(f.state.downloads.length, 0);
  }
  const f = fixture(); f.context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, report: facts(), ai: { configured: true, status: 'error', message: '模型超时' } }) });
  await f.api.run(); assert.match(f.elements.aiResult.innerHTML, /AI 解读失败：模型超时/); assert.doesNotMatch(f.elements.aiResult.innerHTML, /连接测试成功/);
});

test('duplicate clicks and late results after identity/scope/session/navigation/container changes never produce downloadable reports', async () => {
  for (const reason of ['logout', 'role', 'building', 'session', 'navigation', 'container', 'period']) {
    const f = fixture('leader'); let release;
    f.context.fetch = () => new Promise(resolve => { release = resolve; });
    const first = f.api.run(); await new Promise(resolve => setImmediate(resolve)); await f.api.run(); assert.equal(f.state.flushes, 1);
    if (reason === 'logout') f.context.Auth.currentUser = () => null;
    if (reason === 'role') f.user.role = 'user';
    if (reason === 'building') f.user.buildings = ['楼栋B'];
    if (reason === 'session') f.context.Auth._sessionSequence++;
    if (reason === 'navigation') f.context.App.currentPage = 'profile';
    if (reason === 'container') f.elements.aiResult = { innerHTML: '' };
    if (reason === 'period') f.elements.aiMonth.value = '12';
    release({ ok: true, json: async () => ({ ok: true, report: facts('leader') }) }); await first;
    assert.equal(f.api._result, null, reason); f.api.exportReport(); assert.equal(f.state.downloads.length, 0, reason);
  }
});

test('changing filters or access scope after generation blocks exporting the old range', async () => {
  for (const reason of ['filter', 'building', 'role', 'session', 'navigation']) {
    const f = fixture('leader'); await f.api.run();
    if (reason === 'filter') f.elements.aiDepartment.value = '新部门';
    if (reason === 'building') f.user.buildings = ['楼栋B'];
    if (reason === 'role') f.user.role = 'user';
    if (reason === 'session') f.context.Auth._sessionSequence++;
    if (reason === 'navigation') f.context.App.currentPage = 'profile';
    f.api.exportReport(); assert.equal(f.state.downloads.length, 0, reason);
  }
});

test('existing Store session cleanup also discards report memory, visible results, entered key and pending settings context', async () => {
  const f = fixture(); await f.api.run(); assert.ok(f.api._result);
  f.elements.aiSettingApiKey.value = 'UNSAVED_SECRET'; f.api._settingsContext = { identity: f.api._identity() };
  f.api.messages = [];
  assert.equal(f.api._result, null); assert.equal(f.api._settingsContext, null); assert.equal(f.elements.aiResult.innerHTML, ''); assert.equal(f.elements.aiSettingApiKey.value, '');
  assert.equal(f.api.messages.length, 0); f.api.exportReport(); assert.equal(f.state.downloads.length, 0);
});

test('frontend requests interoperate with actual deterministic reporting schema for quarterly and annual reports', async () => {
  const { buildReport, queryFacts } = require('../server/ai-reporting');
  for (const periodType of ['monthly', 'quarterly', 'annual']) {
    const f = fixture('leader'); f.elements.aiMode.value = 'report'; f.elements.aiPeriodType.value = periodType;
    f.context.fetch = async (url, options) => {
      const body = JSON.parse(options.body), bundle = { revision: 7, employees: [{ id: 1, name: '测试人员', building: '楼栋A', department: '测试部门', status: 'active' }], attendance: [], overtime: [], leaveRequests: [] };
      const result = url === '/api/ai/query' ? queryFacts(bundle, f.user, body, '2026-11-24T08:00:00Z') : { report: buildReport(bundle, f.user, body, '2026-11-24T08:00:00Z') };
      return { ok: true, json: async () => ({ ok: true, ...result, ai: { configured: false, status: 'unconfigured' } }) };
    };
    await f.api.run(); assert.ok(f.api._result, periodType); assert.equal(f.api._result.report.period.type, periodType);
    assert.equal(f.api._result.report.monthlyBreakdown.length, periodType === 'annual' ? 12 : periodType === 'quarterly' ? 3 : 1);
    assert.match(f.elements.aiResult.innerHTML, /当前档案|当前人员存量/);
    f.elements.aiMode.value = 'query'; await f.api.run(); assert.ok(f.api._result); assert.match(f.api._result.answer, /加班/);
  }
});

test('JSON/CSV/XLSX/HTML export only reviewed facts; quotes, formula-like labels and model HTML stay inert', () => {
  const f = fixture(), report = facts('admin', 'annual'); report.secret = 'SERVER_SECRET'; report.details = { resumeData: 'REAL_ATTACHMENT' };
  report.details.leaves = [{ ...facts().details.leaves[0], resumeData: 'REAL_ATTACHMENT', phone: 'PRIVATE_PHONE' }];
  report.scope.passwordHash = 'CREDENTIAL'; report.groupings.departments[0].label = '<script>malicious()</script>';
  report.exportRows[0].label = ' \t=HYPERLINK("https://example.com")'; report.exportRows[0].resumeData = 'EXTRA_ATTACHMENT';
  const json = f.api.makeFile('json', report).content; assert.doesNotMatch(json, /SERVER_SECRET|REAL_ATTACHMENT|CREDENTIAL|EXTRA_ATTACHMENT|resumeData|PRIVATE_PHONE/);
  assert.equal(JSON.parse(json).monthlyBreakdown.length, 12);
  const csv = f.api.makeFile('csv', report).content; assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /"' \t=HYPERLINK\(""https/); assert.match(csv, /分月/);
  const html = f.api.makeFile('html', report).content; assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|<iframe|<img|<link|SERVER_SECRET/); assert.match(html, /分月统计/);
  f.context.XLSX = require('../js/xlsx.full.min.js');
  const workbook = f.context.XLSX.read(f.api.makeFile('xlsx', report).content, { type: 'array' }), rows = f.context.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
  assert.equal(rows[6][1], "' \t=HYPERLINK(\"https://example.com\")"); assert.equal(workbook.Sheets[workbook.SheetNames[0]].B7.f, undefined);
  assert.throws(() => f.api.makeFile('exe', report), /不支持/);
});

test('PDF uses escaped standalone printable HTML, no raw model data, and handles popup denial', async () => {
  const f = fixture(); await f.api.run(); f.elements.aiExportFormat.value = 'pdf';
  let content = '', printed = 0; const button = {};
  const popup = { opener: {}, closed: false, focus() {}, print() { printed++; }, document: { fonts: { ready: Promise.resolve() }, open() {}, close() {}, write(html) { content = html; }, getElementById() { return button; } } };
  f.context.window = { open: () => popup }; f.api.exportReport(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.opener, null); assert.match(content, /打印 \/ 另存为 PDF/); assert.equal(typeof button.onclick, 'function'); assert.equal(printed, 1); assert.equal(f.state.downloads.length, 0);
  f.context.window.open = () => null; f.api.exportReport(); assert.match(f.state.toasts.at(-1)[0], /阻止了打印窗口/);
});

test('server settings never fill or cache existing key; blank preserves key and connection test sends no personnel', async () => {
  const f = fixture(); f.context.fetch = async (url, options) => {
    f.state.requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, settings: { enabled: true, configured: true, endpoint: 'https://provider.example/v1/chat/completions', model: 'safe-model', apiKeyConfigured: true, apiKey: 'MUST_NOT_RENDER', envOverride: true }, message: '模型连接测试成功' }) };
  };
  await f.api.showSettings(); assert.equal(f.state.requests[0].url, '/api/ai/settings');
  assert.doesNotMatch(f.state.modals[0][1], /MUST_NOT_RENDER/); assert.match(f.state.modals[0][1], /环境变量覆盖/); assert.match(f.state.modals[0][1], /id="aiSettingApiKey" value=""/);
  await f.api.saveSettings(); let request = f.state.requests[1]; assert.equal(request.url, '/api/ai/settings'); assert.equal(JSON.parse(request.options.body).apiKey, '');
  f.elements.aiSettingApiKey.value = 'NEW_SECRET'; await f.api.saveSettings(); assert.equal(f.elements.aiSettingApiKey.value, '');
  f.elements.aiSettingClearKey.checked = true; await f.api.saveSettings(); assert.equal(JSON.parse(f.state.requests.at(-1).options.body).clearApiKey, true);
  await f.api.testConnection(); request = f.state.requests.at(-1); assert.equal(request.url, '/api/ai/test'); assert.deepEqual(JSON.parse(request.options.body), {}); assert.match(f.elements.aiSettingStatus.textContent, /连接测试成功/);
  assert.equal(f.storage.personnel_ai_config, undefined); assert.doesNotMatch(JSON.stringify(f.storage), /NEW_SECRET/);
});

test('settings duplicate actions, closed modal, lost administrator access and failed connection cannot claim success', async () => {
  const f = fixture(); f.context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, settings: {} }) }); await f.api.showSettings();
  let release, calls = 0; f.context.fetch = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = f.api.testConnection(); await f.api.testConnection(); assert.equal(calls, 1); assert.equal(f.elements.aiSettingTest.disabled, true);
  release({ ok: false, status: 502, json: async () => ({ ok: false, error: '连接超时' }) }); await pending;
  assert.match(f.elements.aiSettingStatus.textContent, /连接测试失败：连接超时/); assert.equal(f.elements.aiSettingTest.disabled, false);
  const oldStatus = f.elements.aiSettingStatus; const late = f.api.testConnection(); f.user.role = 'leader';
  release({ ok: true, json: async () => ({ ok: true }) }); await late; assert.doesNotMatch(oldStatus.textContent, /成功/);
});
