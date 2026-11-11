const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function environment(role = 'user') {
  const state = { role, toasts: [], modals: [], navigation: [], mutations: [], closed: false };
  const user = { username: '13800000001', phone: '13800000001', employeeId: 11, name: '同名人员', role, buildings: role === 'leader' ? ['A栋'] : [] };
  const employees = [
    { id: 11, name: '同名人员', phone: '13800000001', building: 'A栋', email: 'my@example.com' },
    { id: 12, name: '同名人员', phone: '13800000002', building: 'B栋', email: 'private@example.com' }
  ];
  const values = {
    empId: '11', empName: '更新姓名', empPhone: '13900000003', empGender: '男', empPosition: '', empCompany: '',
    empPersonAttribute: '', empWorkAttribute: '', empDepartment: '', empStatus: '', empRegion: '区域A', empRoom: '机房A',
    empBuilding: '', empEmail: '', empJoinDate: '2026-11-11', empLeaveDate: '', empAiProfile: ''
  };
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, checkValidity: () => true }]));
  const button = { disabled: false, textContent: '保存' };
  const context = vm.createContext({
    console, setTimeout: callback => { callback(); }, clearTimeout() {},
    Auth: {
      currentUser: () => user, isAdmin: () => role === 'admin', isLeader: () => role === 'leader', leaderBuildings: () => user.buildings,
      canAccessEmployee: id => role === 'admin' || (role === 'leader' ? employees.some(e => e.id === id && user.buildings.includes(e.building)) : id === user.employeeId),
      canManageEmployee: id => role === 'admin' || (role === 'leader' ? employees.some(e => e.id === id && user.buildings.includes(e.building)) : id === user.employeeId)
    },
    Store: {
      getEmployees: () => employees,
      updateEmployee(id, data) { state.mutations.push({ action: 'update', id, data }); },
      addEmployee(data) { state.mutations.push({ action: 'add', data }); },
      deleteEmployee(id) { state.mutations.push({ action: 'delete', id }); },
      clearEmployees() { state.mutations.push({ action: 'clear' }); },
      flushServerSync: async () => true
    },
    App: {
      currentPage: 'profile', today: () => '2026-11-11',
      toast: (message, type) => state.toasts.push({ message, type }),
      openModal: (...args) => state.modals.push(args),
      navigate: page => state.navigation.push(page),
      closeModal: () => { state.closed = true; }, confirm: () => true
    },
    document: { getElementById: id => elements[id] || null, querySelector: () => button },
    window: {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/employees.js'), 'utf8') + '\nglobalThis.Employees = Employees;', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/self-profile.js'), 'utf8') + '\nglobalThis.SelfProfile = SelfProfile;', context);
  return { context, state, elements, button };
}

test('注册表单的六项组织资料默认留空，姓名和手机号必填', () => {
  const { context } = environment();
  const html = context.Employees._formHtml(null, { registration: true });
  for (const field of ['Company', 'PersonAttribute', 'WorkAttribute', 'Department', 'Status', 'Building']) {
    const select = html.match(new RegExp('<select[^>]*id="emp' + field + '"[^>]*>([\\s\\S]*?)</select>'));
    assert.ok(select, field);
    assert.match(select[1], /<option value="" selected>暂不填写<\/option>/);
    assert.doesNotMatch(select[1], /<option value="[^"]+" selected>/);
  }
  assert.match(html, /id="empName"[^>]*required/);
  assert.match(html, /id="empPhone"[^>]*required/);
  assert.doesNotMatch(html, /AI 自动生成简介/);
});

test('个人资料使用employeeId关联，姓名相同也不会显示另一人的信息', () => {
  const { context } = environment();
  const container = { innerHTML: '' };
  context.SelfProfile.render(container);
  assert.match(container.innerHTML, /my@example.com/);
  assert.doesNotMatch(container.innerHTML, /private@example.com|13800000002/);
  const visible = context.Employees._visibleEmployees();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 11);
});

test('普通人不能通过隐藏按钮的方法新增、删除、导入或编辑他人', async () => {
  const { context, state } = environment();
  context.Employees.showAddModal();
  context.Employees.showEditModal(12);
  await context.Employees.delete(11);
  await context.Employees.clearAll();
  context.Employees.showImportModal();
  context.Employees.importFile({});
  await context.Employees._parseImportRows([['姓名'], ['新人员']]);
  assert.equal(state.modals.length, 0);
  assert.equal(state.mutations.length, 0);
});

test('保存自己资料锁定登录手机号，等待服务器确认后再显示成功', async () => {
  const { context, state, button } = environment();
  let resolve;
  context.Store.flushServerSync = () => new Promise(done => { resolve = done; });
  context.Employees._editReturnPage = 'profile';
  const saving = context.Employees.save();
  assert.equal(state.mutations.length, 1);
  assert.equal(state.mutations[0].data.phone, '13800000001');
  assert.equal(state.mutations[0].data.building, '');
  assert.equal(state.mutations[0].data.company, '');
  assert.equal(button.disabled, true);
  assert.equal(state.toasts.some(item => item.type === 'success'), false);
  assert.equal(state.closed, false);
  resolve(true);
  await saving;
  assert.equal(state.toasts.some(item => item.type === 'success'), true);
  assert.deepEqual(state.navigation, ['profile']);
  assert.equal(button.disabled, false);
});

test('服务器拒绝资料更新时保留编辑窗口并提示失败', async () => {
  const { context, state, button } = environment();
  context.Store.flushServerSync = async () => { throw new Error('数据已更新，请重新读取'); };
  await context.Employees.save();
  assert.equal(state.closed, false);
  assert.equal(state.toasts.some(item => item.type === 'success'), false);
  assert.equal(state.toasts.at(-1).message, '数据已更新，请重新读取');
  assert.equal(button.disabled, false);
});

test('楼长表单只提供负责楼栋，跨楼栋保存被拒绝', async () => {
  const { context, state, elements } = environment('leader');
  const html = context.Employees._formHtml(null);
  const select = html.match(/<select[^>]*id="empBuilding"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(select, /A栋/);
  assert.doesNotMatch(select, /B栋|楼栋A/);
  elements.empBuilding.value = 'B栋';
  await context.Employees.save();
  assert.equal(state.mutations.length, 0);
});
