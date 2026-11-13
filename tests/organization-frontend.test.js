'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function storage() {
  const values = {};
  Object.defineProperties(values, {
    getItem: { value: key => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null },
    setItem: { value: (key, value) => { values[key] = String(value); } },
    removeItem: { value: key => { delete values[key]; } }
  });
  return values;
}

function fixture(role = 'admin') {
  const user = role ? { role, employeeId: 1, buildings: ['本栋'] } : null;
  const options = { companies: ['已配置性质'], personAttributes: ['已配置属性'], workAttributes: ['已配置班次'], positions: ['已配置岗位'], departments: ['已配置部门'], statuses: ['在职', '待岗'], buildings: ['本栋', '其他栋', '空楼栋'], regions: ['已配置大区'], rooms: ['已配置机房'] };
  const response = { ok: true, schemaVersion: 1, revision: 3, options, buildingLeaders: [{ building: '本栋', leaders: '本栋负责人' }, { building: '其他栋', leaders: '其他栋负责人' }] };
  const requests = [];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, localStorage: storage(), sessionStorage: storage(),
    Auth: {
      currentUser: () => user, isAdmin: () => role === 'admin', isLeader: () => role === 'leader', leaderBuildings: () => user && user.buildings || [],
      canAccessEmployee: id => role === 'admin' || (role === 'leader' ? [1].includes(id) : id === 1),
      escape: value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
    },
    App: { today: () => '2026-11-12', toast() {} },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => response }; }
  });
  for (const name of ['store', 'employees', 'dashboard']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + name + '.js'), 'utf8') + '\nglobalThis.' + ({ store: 'Store', employees: 'Employees', dashboard: 'Dashboard' })[name] + ' = ' + ({ store: 'Store', employees: 'Employees', dashboard: 'Dashboard' })[name] + ';', context);
  context.Store._memoryOnly = true;
  context.Store.importSnapshot({ employees: [{ id: 1, name: '当前范围人员', building: '本栋', company: '已移除性质', region: '', room: '', gender: '未说明' }, { id: 2, name: '其他范围人员', building: '其他栋' }], departments: ['旧部门'] });
  return { context, response, requests };
}

function select(html, field) {
  return html.match(new RegExp('<select[^>]*id="emp' + field + '"[^>]*>([\\s\\S]*?)</select>'))[1];
}

test('管理员下拉使用已保存选项，看板展示服务端同步的楼长和空楼栋', async () => {
  const { context, requests } = fixture();
  await context.Store.loadOrganizationSettings();
  assert.deepEqual(requests, ['/api/organization/settings']);
  const html = context.Employees._formHtml(null);
  assert.match(select(html, 'Company'), /已配置性质/);
  assert.doesNotMatch(select(html, 'Company'), /已移除性质|公司A/);
  assert.match(select(html, 'Building'), /空楼栋/);
  assert.match(select(html, 'Status'), /待岗/);
  assert.doesNotMatch(html, /区域A|机房A|部门A|岗位A|楼栋A/);
  const card = context.Dashboard._buildingHeadcountCard();
  assert.match(card, /空楼栋/);
  assert.match(card, /本栋负责人/);
  assert.match(card, /其他栋负责人/);
});

test('所有下拉保留未在配置列表中的旧档案值，并转义文本', async () => {
  const { context } = fixture();
  await context.Store.loadOrganizationSettings();
  const old = { name: '人员', gender: '未说明', position: '旧岗位', company: '旧性质', personAttribute: '旧属性', workAttribute: '旧班次', department: '旧部门', status: '旧状态', region: '旧大区', room: '旧机房', building: '<旧楼栋" &>' };
  const html = context.Employees._formHtml(old);
  for (const [field, value] of Object.entries({ Gender: old.gender, Position: old.position, Company: old.company, PersonAttribute: old.personAttribute, WorkAttribute: old.workAttribute, Department: old.department, Status: old.status, Region: old.region, Room: old.room })) {
    assert.ok(select(html, field).includes('value="' + value + '" selected'), field);
  }
  assert.match(select(html, 'Building'), /value="&lt;旧楼栋&quot; &amp;&gt;" selected/);
  assert.doesNotMatch(html, /<旧楼栋/);
});

test('楼长配置与楼长名单始终限制在负责楼栋', async () => {
  const { context } = fixture('leader');
  await context.Store.loadOrganizationSettings();
  const html = context.Employees._formHtml(null);
  assert.match(select(html, 'Building'), /本栋/);
  assert.doesNotMatch(select(html, 'Building'), /其他栋|空楼栋/);
  const card = context.Dashboard._buildingHeadcountCard();
  assert.match(card, /本栋负责人/);
  assert.doesNotMatch(card, /其他栋负责人|其他范围人员|空楼栋/);
});

test('公开注册仅读取公开选项，不能从旧浏览器缓存推导人员或楼长', async () => {
  const { context, requests } = fixture(null);
  context.Store.getEmployees = () => { throw new Error('公开注册不应读取旧人员缓存'); };
  await context.Store.loadOrganizationSettings(true);
  assert.deepEqual(requests, ['/api/organization/options']);
  const html = context.Employees._formHtml(null, { registration: true });
  assert.match(html, /已配置性质/);
  assert.doesNotMatch(html, /负责人|旧部门|已移除性质/);
  assert.deepEqual(Array.from(context.Employees._buildingLeaders), []);
  assert.deepEqual(Array.from(context.Store.getOrganizationSettings().buildingLeaders), []);
});

test('普通人员不能读到楼长名单；退出清理独立配置缓存', async () => {
  const { context } = fixture('user');
  await context.Store.loadOrganizationSettings();
  assert.deepEqual(Array.from(context.Employees._buildingLeaders), []);
  context.Store.clearSessionData();
  assert.equal(context.Store._organizationSettings, null);
  assert.deepEqual(Array.from(context.Employees._buildingLeaders), []);
});

test('显式空配置不会被已有档案值补回；读取失败保留当前配置', async () => {
  const { context, response } = fixture();
  response.options.companies = [];
  await context.Store.loadOrganizationSettings();
  assert.deepEqual(Array.from(context.Employees._companyOptions), []);
  context.fetch = async () => ({ ok: false, json: async () => ({ ok: false, message: '连接失败' }) });
  await assert.rejects(context.Store.loadOrganizationSettings(), /连接失败/);
  assert.deepEqual(Array.from(context.Employees._companyOptions), []);
  assert.match(context.Employees._formHtml({ company: '已移除性质' }), /value="已移除性质" selected/);
});

test('初始化与新增人员不再写入示例区域、机房、部门或覆盖性别', () => {
  const { context } = fixture();
  context.Store.init();
  const current = context.Store.getEmployees()[0];
  assert.equal(current.region, '');
  assert.equal(current.room, '');
  assert.equal(current.gender, '未说明');
  const added = context.Store.addEmployee({ name: '新增人员', region: '', room: '', gender: '' });
  assert.equal(added.region, '');
  assert.equal(added.room, '');
  assert.equal(added.gender, '');
  assert.doesNotMatch(JSON.stringify(context.Store.exportSnapshot()), /区域A|机房A|部门A/);
  assert.equal('organizationSettings' in context.Store.exportSnapshot(), false);
});

test('退出后迟到的组织配置响应不会恢复管理员名单', async () => {
  const { context, response } = fixture();
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  const loading = context.Store.loadOrganizationSettings();
  context.Store.clearSessionData();
  resolve({ ok: true, json: async () => response });
  assert.equal(await loading, null);
  assert.equal(context.Store._organizationSettings, null);
});

test('较早配置请求不能覆盖后发请求结果', async () => {
  const { context, response } = fixture();
  const pending = [];
  context.fetch = () => new Promise(done => { pending.push(done); });
  const first = context.Store.loadOrganizationSettings();
  const second = context.Store.loadOrganizationSettings();
  pending[1]({ ok: true, json: async () => ({ ...response, options: { ...response.options, companies: ['最新配置'] } }) });
  await second;
  pending[0]({ ok: true, json: async () => response });
  assert.equal(await first, null);
  assert.deepEqual(Array.from(context.Employees._companyOptions), ['最新配置']);
});

test('角色变化后配置getter立即按当前楼栋过滤楼长名单', async () => {
  const { context } = fixture();
  await context.Store.loadOrganizationSettings();
  context.Auth.currentUser = () => ({ role: 'leader', employeeId: 1, buildings: ['本栋'] });
  context.Auth.isAdmin = () => false;
  context.Auth.isLeader = () => true;
  const settings = context.Store.getOrganizationSettings();
  assert.deepEqual(Array.from(settings.options.buildings), ['本栋']);
  assert.deepEqual(Array.from(settings.buildingLeaders, item => item.leaders), ['本栋负责人']);
  context.Auth.currentUser = () => ({ role: 'user', employeeId: 1 });
  context.Auth.isLeader = () => false;
  assert.deepEqual(Array.from(context.Store.getOrganizationSettings().buildingLeaders), []);
});

test('格式异常的成功响应不会清空已保存选项', async () => {
  const { context } = fixture();
  await context.Store.loadOrganizationSettings();
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, options: { companies: '错误格式' } }) });
  await assert.rejects(context.Store.loadOrganizationSettings(), /格式无效/);
  assert.deepEqual(Array.from(context.Employees._companyOptions), ['已配置性质']);
});

function dashboardRefreshFixture() {
  const f = fixture();
  const target = { innerHTML: '' };
  const elements = { dashboardBuildingHeadcount: target };
  const events = { focus: [], visibilitychange: [] };
  f.context.document = {
    visibilityState: 'visible',
    getElementById: id => elements[id] || null,
    addEventListener: (event, handler) => events[event].push(handler)
  };
  f.context.window = { addEventListener: (event, handler) => events[event].push(handler) };
  f.context.App.currentPage = 'dashboard';
  f.context.Auth.canAccessPage = page => page === 'dashboard';
  return { ...f, target, elements, events };
}

test('楼长同步中和失败时隐藏旧姓名且不影响已保存下拉，成功空名单移除前任', async () => {
  const { context, response, target } = dashboardRefreshFixture();
  await context.Store.loadOrganizationSettings();
  let finish;
  context.fetch = () => new Promise(done => { finish = done; });
  const pending = context.Dashboard.refreshBuildingLeaders();
  assert.match(target.innerHTML, /正在同步楼长/);
  assert.doesNotMatch(target.innerHTML, /本栋负责人|其他栋负责人/);
  finish({ ok: false, json: async () => ({ ok: false, message: '暂时不可用' }) });
  await pending;
  assert.match(target.innerHTML, /楼长同步失败/);
  assert.doesNotMatch(target.innerHTML, /本栋负责人|其他栋负责人/);
  assert.deepEqual(Array.from(context.Store.getPersonnelOptions('companies')), ['已配置性质']);
  context.fetch = async () => ({ ok: true, json: async () => ({ ...response, buildingLeaders: [] }) });
  await context.Dashboard.refreshBuildingLeaders();
  assert.match(target.innerHTML, /待分配楼长/);
  assert.doesNotMatch(target.innerHTML, /本栋负责人|其他栋负责人/);
});

test('看板纳入仅有授权楼长的楼栋并转义姓名，不读取旧的固定名单回退', async () => {
  const { context, response } = fixture();
  response.buildingLeaders = [{ building: '仅楼长的楼栋', leaders: '<img src=x onerror=alert(1)>' }];
  await context.Store.loadOrganizationSettings();
  const html = context.Dashboard._buildingHeadcountCard();
  assert.match(html, /仅楼长的楼栋/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  context.Store.getBuildingLeaders = undefined;
  Object.defineProperty(context.Employees, '_buildingLeaders', { value: [{ building: '本栋', leaders: '历史固定负责人' }], configurable: true });
  assert.doesNotMatch(context.Dashboard._buildingHeadcountCard(), /历史固定负责人/);
});

test('看板刷新按最新请求与当前页面生效，离开页面后不改动后续界面', async () => {
  const { context, response, target, elements } = dashboardRefreshFixture();
  const pending = [];
  context.fetch = () => new Promise(done => { pending.push(done); });
  const first = context.Dashboard.refreshBuildingLeaders();
  const second = context.Dashboard.refreshBuildingLeaders();
  pending[1]({ ok: true, json: async () => ({ ...response, buildingLeaders: [{ building: '本栋', leaders: '新楼长' }] }) });
  await second;
  assert.match(target.innerHTML, /新楼长/);
  pending[0]({ ok: true, json: async () => response });
  await first;
  assert.match(target.innerHTML, /新楼长/);
  assert.doesNotMatch(target.innerHTML, /本栋负责人/);
  const third = context.Dashboard.refreshBuildingLeaders();
  const nextTarget = { innerHTML: '其他页面的内容' };
  elements.dashboardBuildingHeadcount = nextTarget;
  context.App.currentPage = 'employees';
  pending[2]({ ok: true, json: async () => response });
  await third;
  assert.equal(nextTarget.innerHTML, '其他页面的内容');
});

test('返回看板和重新可见会只读同步楼长，隐藏页面与普通人员不触发请求', async () => {
  const { context, response, target, events, requests } = dashboardRefreshFixture();
  // 隔离其他费用卡片，使真实 render 仍可验证进入看板触发自动同步。
  for (const name of ['_deductionCard', '_increaseCard', '_leaveCard', '_otCard', '_buildingTimeBalanceCard', '_monthChangesCard', '_newEmployeesCard', '_updateLogCard']) context.Dashboard[name] = () => '';
  context.Store.getOrCalcSettlement = () => null;
  context.Store.getStats = () => ({});
  const container = { innerHTML: '' };
  context.Dashboard.render(container);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.match(target.innerHTML, /本栋负责人/);
  assert.match(container.innerHTML, /id="dashboardBuildingHeadcount"/);
  assert.equal(events.focus.length, 1);
  context.Dashboard._bindLeaderRefresh();
  assert.equal(events.focus.length, 1);
  response.buildingLeaders = [{ building: '本栋', leaders: '替任楼长' }];
  await events.focus[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(target.innerHTML, /替任楼长/);
  context.document.visibilityState = 'hidden';
  const before = requests.length;
  events.focus[0](); events.visibilitychange[0]();
  assert.equal(requests.length, before);
  context.document.visibilityState = 'visible';
  events.visibilitychange[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, before + 1);
  context.Auth.canAccessPage = () => false;
  events.focus[0]();
  assert.equal(requests.length, before + 1);
});

test('权限保存和删除成功后刷新楼长名单，刷新失败不误报账号操作失败', async () => {
  const { context, response, requests } = fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/permission.js'), 'utf8') + '\nglobalThis.Permission = Permission;', context);
  const elements = Object.fromEntries(Object.entries({ permUsername: 'test-leader', permName: '新楼长', permPassword: '', permRole: 'leader', permEmployee: '1', permBuildings: '本栋' }).map(([key, value]) => [key, { value }]));
  elements.permSave = { disabled: false };
  elements.pageContent = {};
  context.document = { getElementById: id => elements[id] };
  const operations = [], toasts = [];
  context.App.confirm = () => true;
  context.App.closeModal = () => operations.push('closed');
  context.App.toast = (message, type) => toasts.push({ message, type });
  context.Permission.render = () => operations.push('render');
  context.Store.flushServerSync = async () => operations.push('flushed');
  context.Auth.saveUser = async () => {
    operations.push('saved');
    response.buildingLeaders = [{ building: '本栋', leaders: '新楼长' }];
  };
  context.Auth.deleteUser = async () => { operations.push('deleted'); response.buildingLeaders = []; };
  await context.Permission.saveAccount(true);
  assert.deepEqual(operations, ['flushed', 'saved', 'closed', 'render']);
  assert.equal(requests.length, 1);
  assert.deepEqual(Array.from(context.Store.getBuildingLeaders(), row => row.leaders), ['新楼长']);
  await context.Permission.deleteAccount('test-leader');
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(context.Store.getBuildingLeaders()), []);
  context.fetch = async () => { throw new Error('网络异常'); };
  await context.Permission.saveAccount(true);
  assert.ok(toasts.some(row => row.type === 'warning' && row.message.includes('账号已更新')));
  assert.equal(toasts.at(-1).type, 'success');
  assert.equal(elements.permSave.disabled, false);
});
