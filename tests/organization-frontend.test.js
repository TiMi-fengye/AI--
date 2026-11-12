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

test('管理员下拉使用已保存配置，空楼栋和楼长也恢复到看板', async () => {
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
