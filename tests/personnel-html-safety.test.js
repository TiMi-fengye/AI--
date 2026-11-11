const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const payload = '<img src=x onerror="globalThis.pwned=1">\'&';
const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function fixture(role = 'admin', employeeId = 1, buildings = ['楼栋A']) {
  const employees = [
    { id: 1, name: payload, gender: payload, department: payload, position: payload, phone: payload, region: payload, room: payload, building: payload, company: payload, email: payload, aiProfile: payload, resumeName: payload, resumeData: 'data:application/pdf;base64,JVBERi0x', joinDate: '2026-11-01' },
    { id: 2, name: '其他人员', building: '楼栋B', department: '部门B', position: '工程师' }
  ];
  const scores = [{ id: '1);globalThis.pwned=1;//', employeeId: 1, name: payload, dept: payload, yearMonth: payload, total: payload, scores: { [payload]: payload } }];
  const settlements = [{ yearMonth: '2026-11', records: [{ employeeId: 1, name: payload, department: payload, building: payload, otRate: payload, lvRate: payload, otPay: 10, lvDeduct: 5, otHours: 1, lvDays: 1 }] }];
  const calls = { toasts: [], modals: [], sets: [], removals: [], links: [], fetches: 0 };
  const elements = { pfYm: { value: '2026-11' }, pfTable: { innerHTML: '' }, pfRank: { innerHTML: '' }, costYm: { value: '2026-11' }, costSettlementContent: { innerHTML: '' } };
  const tree = { id: '1" onfocus="globalThis.pwned=1', name: payload, type: 'company', children: [{ id: '2);globalThis.pwned=1;//', name: payload, type: 'department', children: [] }] };
  const sandbox = {
    Auth: {
      escape,
      currentUser: () => ({ role, employeeId, buildings }),
      isAdmin: () => role === 'admin',
      isLeader: () => role === 'leader',
      leaderBuildings: () => buildings,
      canAccessEmployee: (id) => role === 'admin' || employees.some((emp) => Number(emp.id) === Number(id) && (role === 'leader' ? buildings.includes(emp.building) : emp.id === employeeId)),
      canManageEmployee: (id) => sandbox.Auth.canAccessEmployee(id),
      canAccessPage: (page) => role === 'admin' || (role === 'leader' && ['dashboard', 'cost', 'performance'].includes(page))
    },
    Store: {
      getEmployees: () => JSON.parse(JSON.stringify(employees)),
      getStats: () => ({ totalEmployees: 2 }),
      getLeaveRequests: () => [{ employeeId: 1, status: 'approved', type: 'leave', startDate: '2026-11-01', endDate: payload, lvDeduct: 5, lvRate: payload, days: 1 }],
      getOvertime: () => [{ employeeId: 1, status: 'approved', date: '2026-11-01', hours: 1, otPay: 10, otRate: payload }],
      getSettlements: () => settlements,
      getOrCalcSettlement: () => settlements[0],
      getTimeBalance: () => ({ overtimeHours: 10, compensatoryHours: 2, remainingHours: 8 }),
      get: () => scores,
      set: (...args) => calls.sets.push(args),
      getOrgStructure: () => tree,
      getDepartments: () => [payload],
      getOrgEmployeeCounts: () => Object.create(null),
      refreshRates() {}, deleteSettlementByMonth() {},
      flushServerSync: async () => true
    },
    Employees: { _buildingLeaders: [{ building: payload, leaders: [payload] }], _buildingOptions: [payload] },
    App: {
      today: () => '2026-11-11', formatDate: (value) => value,
      toast: (...args) => calls.toasts.push(args), openModal: (...args) => calls.modals.push(args),
      closeModal() {}, navigate() {}, confirm: () => true
    },
    document: {
      getElementById: (id) => elements[id],
      createElement: (tag) => {
        const element = { tag, clicked: false, click() { this.clicked = true; } };
        calls.links.push(element); return element;
      }
    },
    localStorage: { removeItem: (key) => calls.removals.push(key) },
    navigator: { clipboard: { writeText: async () => true } },
    fetch: async () => { calls.fetches++; return { ok: true, json: async () => ({ choices: [{ message: { content: payload } }] }) }; },
    AI: { getConfig: () => ({ endpoint: '/api/ai/chat', model: 'test' }) },
    console: { log() {} }
  };
  vm.createContext(sandbox);
  for (const file of ['dashboard', 'employee-profile', 'performance', 'org', 'cost', 'importer']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), sandbox);
  vm.runInContext('this.modules = { Dashboard, EmpProfile, Performance, Org, Cost, ImportData };', sandbox);
  return { ...sandbox.modules, sandbox, calls, elements, employees, scores, settlements, tree };
}

function assertEscaped(html) {
  assert.doesNotMatch(html, /<img|<script|value="[^"<>]*"\s+onfocus=/i);
  assert.match(html, /&lt;img/);
}

test('dashboard personnel, fees, buildings, and log cards escape all personnel-controlled text', () => {
  const f = fixture();
  for (const html of [
    f.Dashboard._newEmployeesCard('2026-11'), f.Dashboard._leaveCard(), f.Dashboard._otCard(),
    f.Dashboard._buildingHeadcountCard(), f.Dashboard._buildingTimeBalanceCard(), f.Dashboard._monthChangesCard('2026-11'),
    f.Dashboard._updateLogCard([{ date: payload, operator: payload, employeeName: payload, building: payload, action: 'update' }], 0)
  ]) assertEscaped(html);
});

test('resume and AI profile dialog treats supplied strings as text', () => {
  const f = fixture();
  f.EmpProfile.showModal(1);
  const html = f.calls.modals[0][1];
  assertEscaped(html);
  assert.match(html, /邮箱/);
  assert.match(html, /EmpProfile\.uploadResume\(1\)/);
  assert.match(html, /white-space:pre-wrap/);
});

test('attachment download accepts approved base64 data and rejects executable URL schemes and formats', () => {
  const f = fixture();
  assert.equal(f.EmpProfile._safeResumeData('javascript:alert(1)'), false);
  assert.equal(f.EmpProfile._safeResumeData('data:text/html;base64,PHNjcmlwdD4='), false);
  assert.equal(f.EmpProfile._safeResumeData('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(f.EmpProfile._safeResumeData('https://example.com/private'), false);
  f.EmpProfile.downloadResume(1);
  assert.equal(f.calls.links.length, 1);
  assert.equal(f.calls.links[0].href, 'data:application/pdf;base64,JVBERi0x');
  assert.equal(f.calls.links[0].clicked, true);
  f.employees[0].resumeData = 'javascript:alert(1)';
  f.EmpProfile.downloadResume(1);
  assert.equal(f.calls.links.length, 1);
});

test('ordinary employee can read only their own resume and cannot invoke AI analysis', async () => {
  const f = fixture('user', 1);
  f.EmpProfile.showModal(2);
  f.EmpProfile.downloadResume(2);
  await f.EmpProfile.deleteResume(2);
  f.EmpProfile.uploadResume(2);
  f.EmpProfile.analyzeResume(1);
  await f.EmpProfile._doAutoAnalyze(1, 'test resume');
  assert.equal(f.calls.modals.length, 0);
  assert.equal(f.calls.links.length, 0);
  assert.equal(f.calls.sets.length, 0);
  assert.equal(f.calls.fetches, 0);
  f.EmpProfile.showModal(1);
  assert.equal(f.calls.modals.length, 1);
  assert.doesNotMatch(f.calls.modals[0][1], /AI 分析生成简介/);
});

test('performance tables, score dimensions, form labels and employee options are safe', () => {
  const f = fixture();
  f.Performance.renderScores();
  assertEscaped(f.elements.pfTable.innerHTML);
  assertEscaped(f.elements.pfRank.innerHTML);
  assert.doesNotMatch(f.elements.pfTable.innerHTML, /Performance\.showEdit\([^)]*;/);
  f.Performance.showEdit(f.scores[0].id);
  assertEscaped(f.calls.modals[0][1]);
  assert.doesNotMatch(f.calls.modals[0][1], /value="1" onfocus=/);
  f.Performance.showAddModal();
  assertEscaped(f.calls.modals[1][1]);
});

test('organization employee cards, initial, nested options, and numeric event arguments are safe', () => {
  const f = fixture();
  assertEscaped(f.Org._renderDeptSections(f.employees));
  assertEscaped(f.Org._getParentOptions());
  assert.doesNotMatch(f.Org._getParentOptions(), /value="1" onfocus=/);
  assert.equal(f.Org._getGroupInfo('__proto__').group, '其他');
  f.Org.showPersonDetail(1);
  assertEscaped(f.calls.modals[0][1]);
});

test('cost cards escape personnel and group names and reject invalid month input', () => {
  const f = fixture();
  f.Cost.renderSettlement();
  assertEscaped(f.elements.costSettlementContent.innerHTML);
  f.elements.costYm.value = payload;
  f.elements.costSettlementContent.innerHTML = '';
  f.Cost.renderSettlement();
  assert.equal(f.elements.costSettlementContent.innerHTML, '');
  assert.equal(f.elements.costSettlementContent.textContent, '请选择有效的月份');
});

test('non-manager direct calls cannot render or mutate organization, cost, performance, or reset data', () => {
  const f = fixture('user', 1);
  f.Performance.showAddModal(); f.Performance.showEdit(1); f.Performance.saveManual(); f.Performance.saveEdit(); f.Performance.del(1); f.Performance.clearMonth(); f.Performance.setScores([]);
  f.Org.showAddForm(); f.Org.showEditForm(1); f.Org.showEditCompanyForm(); f.Org.saveNode(); f.Org.saveEdit(); f.Org.saveCompanyName(); f.Org.deleteNode(1);
  f.Cost.forceRecalc(); f.Cost.renderSettlement();
  const result = f.ImportData.run();
  assert.equal(result.success, false);
  assert.equal(f.calls.sets.length, 0);
  assert.equal(f.calls.modals.length, 0);
  assert.equal(f.calls.removals.length, 0);
});

test('prototype-looking building and department values do not corrupt rendering groups', () => {
  const f = fixture();
  f.employees[0].building = '__proto__'; f.employees[0].department = '__proto__';
  f.settlements[0].records[0].building = '__proto__'; f.settlements[0].records[0].department = '__proto__';
  assert.doesNotThrow(() => f.Dashboard._buildingHeadcountCard());
  assert.doesNotThrow(() => f.Dashboard._buildingTimeBalanceCard());
  assert.doesNotThrow(() => f.Dashboard._monthChangesCard('2026-11'));
  assert.doesNotThrow(() => f.Org._renderDeptSections(f.employees));
  assert.doesNotThrow(() => f.Cost.renderSettlement());
});

test('floor leader cannot access foreign employees through resume or performance helpers', () => {
  const f = fixture('leader', 1, [payload]);
  f.EmpProfile.showModal(2);
  f.Performance.setScores([{ employeeId: 2, name: 'foreign' }]);
  assert.equal(f.calls.modals.length, 0);
  assert.equal(f.calls.sets.length, 0);
  const html = f.Dashboard._buildingHeadcountCard();
  assert.doesNotMatch(html, /楼栋B/);
});

test('resume deletion persists the modified array rather than a fresh unchanged snapshot', async () => {
  const f = fixture('user', 1);
  await f.EmpProfile.deleteResume(1);
  const stored = f.calls.sets[0][1];
  assert.equal(stored[0].resumeData, null);
  assert.equal(stored[0].resumeName, null);
});
