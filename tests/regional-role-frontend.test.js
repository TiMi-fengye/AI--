'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function storage() {
  const values = {};
  Object.defineProperties(values, {
    getItem: {value: key => values[key] || null},
    setItem: {value: (key, value) => { values[key] = String(value); }},
    removeItem: {value: key => { delete values[key]; }}
  });
  return values;
}
function response(payload, status = 200) { return {ok: status >= 200 && status < 300, status, json: async () => payload}; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
const snapshot = () => ({revision: 7, employees: [
  {id: 1, name: '合成区域人员', region: '北区', building: 'A'},
  {id: 2, name: '合成其他区域', region: '南区', building: 'B'},
  {id: 3, name: '合成本人', region: '南区', building: 'C'}
], overtime: [{id: 11, employeeId: 1, status: 'pending', approvalStage: 'regional'}]});

function fixture() {
  const elements = {pageContent: {innerHTML: ''}, attSubContent: {innerHTML: ''}}, notices = [];
  const context = vm.createContext({console, setTimeout, clearTimeout, localStorage: storage(), sessionStorage: storage(),
    document: {getElementById: id => elements[id], querySelector: () => null}, window: {location: {}},
    fetch: async () => { throw Error('Unexpected request'); },
    App: {toast: (...args) => notices.push(args), openModal() {}, closeModal() {}},
    Overtime: {render: sub => {sub.innerHTML = '区域申请列表';}}, Leave: {render: sub => {sub.innerHTML = '请假列表';}},
    MyHours: {render: sub => {sub.innerHTML = '本人小时数';}}
  });
  for (const [file, name] of [['store', 'Store'], ['auth', 'Auth'], ['permission', 'Permission'], ['attendance', 'Attendance']]) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/' + file + '.js'), 'utf8') + '\nglobalThis.' + name + '=' + name + ';', context);
  }
  const {Store, Auth} = context;
  Auth._user = {username: 'synthetic-manager', role: 'region_manager', regions: ['北区'], buildings: [], employeeId: 3};
  Store.clearSessionData(); Store._hydrate(snapshot()); Store._revision = 7; Store._serverSyncReady = true;
  return {context, Store, Auth, Permission: context.Permission, Attendance: context.Attendance, elements, notices};
}

test('regional role has region visibility and own profile without personnel-management or cross-region approval', () => {
  const f = fixture();
  let reads = 0; const get = f.Store.getEmployees; f.Store.getEmployees = function() {reads++; return get.call(this);};
  assert.equal(f.Auth.canAccessEmployee(1), true);
  assert.equal(f.Auth.canAccessEmployee(2), false);
  assert.equal(f.Auth.canAccessEmployee(3), true);
  assert.equal(f.Auth.canAccessEmployee(999), false);
  assert.equal(f.Auth.canApproveEmployee(1), true);
  assert.equal(f.Auth.canApproveEmployee(3), false);
  assert.equal(f.Auth.canManageEmployee(1), false);
  assert.equal(f.Auth.canManageEmployee(3), true);
  assert.equal(reads, 0);
  for (const page of ['profile', 'attendance', 'overtime', 'leave', 'hours']) assert.equal(f.Auth.canAccessPage(page), true);
  for (const page of ['employees', 'dashboard', 'cost', 'performance', 'org', 'ai', 'admin']) assert.equal(f.Auth.canAccessPage(page), false);
  assert.equal(f.Auth.roleLabel('region_manager'), '区域经理');
  const regions = f.Auth.regionalRegions(); regions.push('南区'); assert.equal(f.Auth.canAccessEmployee(2), false);
  const identity = f.Store._organizationIdentity(); f.Auth._user.regions = ['南区'];
  assert.notEqual(f.Store._organizationIdentity(), identity);
  assert.equal(f.Auth.canApproveEmployee(1), false);
  assert.equal(f.Auth.canApproveEmployee(2), true);
});

test('regional attendance exposes approvals and own hours, never sign-in, attendance or administrator deletes', async () => {
  const f = fixture();
  f.Attendance.render(f.elements.pageContent);
  assert.match(f.elements.pageContent.innerHTML, /加班审批|请假审批/);
  assert.match(f.elements.pageContent.innerHTML, /我的小时数/);
  assert.equal(f.Attendance._activeTab, 'overtime');
  f.Attendance._switchTo('attendance');
  assert.equal(f.Attendance._activeTab, 'overtime');
  f.Attendance.showCheckinModal(); await f.Attendance.allPresent();
  assert.ok(f.notices.every(row => row[1] === 'error'));
  assert.doesNotMatch(f.elements.pageContent.innerHTML, /签到|签退|考勤统计|全部到岗/);
  f.Auth._user.employeeId = null; f.Attendance.render(f.elements.pageContent);
  assert.doesNotMatch(f.elements.pageContent.innerHTML, /我的小时数|申请加班|\+ 加班申请/);
});

test('approval flushes first, carries revision, then reloads authoritative state without optimistic approval', async () => {
  const f = fixture(), calls = [], pending = deferred();
  f.Store.flushServerSync = async () => calls.push('flush');
  f.context.fetch = async (url, options) => {
    calls.push(url);
    if (url.startsWith('/api/approvals/')) {
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
      assert.deepEqual(JSON.parse(options.body), {decision: 'approved', expectedRevision: 7});
      return pending.promise;
    }
    return response({...snapshot(), revision: 8, overtime: [{id: 11, employeeId: 1, status: 'approved', approvalStage: 'complete'}]});
  };
  const saving = f.Store.submitApproval('overtime', 11, 'approved');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.Store.getOvertime()[0].status, 'pending');
  await assert.rejects(f.Store.submitApproval('leaveRequests', 12, 'rejected'), /另一项审批/);
  pending.resolve(response({ok: true, record: {status: 'approved'}}));
  assert.equal((await saving).record.status, 'approved');
  assert.deepEqual(calls, ['flush', '/api/approvals/overtime/11', '/api/data/snapshot.json']);
  assert.equal(f.Store.getOvertime()[0].status, 'approved'); assert.equal(f.Store._revision, 8);
});

test('stale or unauthorized approval reloads server state and reports failure without local approval', async () => {
  const f = fixture(), calls = [];
  f.Store.flushServerSync = async () => {};
  f.context.fetch = async url => {
    calls.push(url);
    return url.startsWith('/api/approvals/') ? response({ok: false, message: '数据已更新，请刷新'}, 409) : response(snapshot());
  };
  await assert.rejects(f.Store.submitApproval('overtime', 11, 'approved'), error => error.status === 409 && /数据已更新/.test(error.message));
  assert.equal(f.Store.getOvertime()[0].status, 'pending');
  assert.deepEqual(calls, ['/api/approvals/overtime/11', '/api/data/snapshot.json']);
});

test('approval never posts after failed flush and validates parameters before network activity', async () => {
  const f = fixture(); let posted = 0;
  f.context.fetch = async () => {posted++; return response({ok: true});};
  f.Store.flushServerSync = async () => {throw Error('原保存失败');};
  await assert.rejects(f.Store.submitApproval('overtime', 11, 'approved'), /原保存失败/);
  for (const args of [['attendance', 11, 'approved'], ['overtime', 0, 'approved'], ['leaveRequests', 11, 'pending']]) await assert.rejects(f.Store.submitApproval(...args), /参数无效/);
  assert.equal(posted, 0);
});

test('late approval responses cannot hydrate a different account or changed regional scope', async () => {
  for (const change of ['logout', 'scope']) {
    const f = fixture(), pending = deferred(); let reads = 0;
    f.Store.flushServerSync = async () => {};
    f.context.fetch = async url => {if (!url.startsWith('/api/approvals/')) reads++; return pending.promise;};
    const saving = f.Store.submitApproval('overtime', 11, 'approved');
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'logout') {f.Store.clearSessionData(); f.Auth._user = {username: 'another', role: 'user', employeeId: 2};}
    else f.Auth._user.regions = ['南区'];
    pending.resolve(response({ok: true, record: {status: 'approved'}}));
    await assert.rejects(saving, error => error.sessionChanged === true);
    assert.equal(reads, 0);
    assert.equal(f.Store._approvalPromise, null);
  }
});

test('unknown POST or failed reload tells operator to verify instead of repeating an approval', async () => {
  for (const unknown of [true, false]) {
    const f = fixture(); f.Store.flushServerSync = async () => {};
    f.context.fetch = async url => {
      if (url.startsWith('/api/approvals/')) { if (unknown) throw Error('network'); return response({ok: true}); }
      throw Error('refresh failed');
    };
    await assert.rejects(f.Store.submitApproval('overtime', 11, 'approved'), error => error.approvalMayBeCommitted && /刷新核对|刷新核对后/.test(error.message));
    assert.equal(f.Store.getOvertime()[0].status, 'pending');
  }
});

test('administrator assigns regions and phone; invalid or missing scope never submits an account', async () => {
  const f = fixture(), saved = [];
  f.Auth._user = {username: 'admin', role: 'admin'};
  const values = {permUsername: 'test-manager', permName: '合成区域经理', permPassword: 'syntheticpass', permRole: 'region_manager', permEmployee: '', permBuildings: '', permRegions: '北区，南区，北区', permPhone: '13800000000'};
  for (const [id, value] of Object.entries(values)) f.elements[id] = {value};
  f.elements.permSave = {disabled: false};
  f.Store.flushServerSync = async () => {}; f.Auth.saveUser = async body => saved.push(JSON.parse(JSON.stringify(body)));
  f.Permission._refreshBuildingLeaders = async () => {}; f.Permission.render = () => {};
  await f.Permission.saveAccount(false);
  assert.deepEqual(saved[0], {username: 'test-manager', name: '合成区域经理', role: 'region_manager', employeeId: null, buildings: [], regions: ['北区', '南区'], password: 'syntheticpass', phone: '13800000000'});
  f.elements.permRegions.value = ''; await f.Permission.saveAccount(false);
  f.elements.permRegions.value = '北区'; f.elements.permPhone.value = 'bad'; await f.Permission.saveAccount(false);
  assert.equal(saved.length, 1); assert.equal(f.elements.permSave.disabled, false);
});

test('regional permission form escapes configured regions and retains administrator-only role control', () => {
  const f = fixture(); let modal;
  f.Auth._user = {username: 'admin', role: 'admin'};
  f.Auth._users = {test: {name: '合成', role: 'region_manager', regions: ['北区<script>'], phone: '13800000000'}};
  f.Store.getPersonnelOptions = key => key === 'regions' ? ['北区<script>'] : ['A'];
  Object.assign(f.elements, {permRole: {value: 'region_manager'}, permBuildingsGroup: {}, permRegionsGroup: {}, permSave: {}});
  f.context.App.openModal = (title, body) => {modal = body;};
  f.Permission.showEditModal('test');
  assert.match(modal, /value="region_manager" selected/);
  assert.match(modal, /北区&lt;script&gt;/); assert.doesNotMatch(modal, /<script>/);
  assert.equal(f.elements.permRegionsGroup.hidden, false); assert.equal(f.elements.permBuildingsGroup.hidden, true);
  modal = null; f.Auth._user.role = 'region_manager'; f.Permission.showEditModal('test'); assert.equal(modal, null);
});
