'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(role = 'admin') {
  const employees = [
    {id: 1, name: '合成人员甲', department: '测试部门', building: 'A'},
    {id: 2, name: '合成人员乙', department: '测试部门', building: 'A'},
    {id: 3, name: '合成人员丙', department: '测试部门', building: 'B'}
  ];
  const attendance = [
    {id: 11, employeeId: 1, date: '2026-11-18', checkIn: '09:00', status: 'present'},
    {id: 12, employeeId: 3, date: '2026-11-18', checkIn: '09:00', checkOut: '18:00', status: 'present'},
    {id: 19, employeeId: 99, date: '2026-11-18', status: 'present'}
  ];
  const overtime = [
    {id: 21, employeeId: 1, date: '2026-11-18', overtimeType: 'compensatory', hours: 8, status: 'approved'},
    {id: 22, employeeId: 2, date: '2026-11-18', overtimeType: 'fee', hours: 2, status: 'pending'},
    {id: 23, employeeId: 3, date: '2026-11-18', overtimeType: 'fee', hours: 2, status: 'rejected'},
    {id: 29, employeeId: 99, date: '2026-11-18', overtimeType: 'fee', hours: 2, status: 'pending'}
  ];
  const leaves = [
    {id: 31, employeeId: 1, type: 'statutoryAnnual', startDate: '2026-11-18T09:00', endDate: '2026-11-18T18:00', days: 1, status: 'pending'},
    {id: 32, employeeId: 2, type: 'compensatory', startDate: '2026-11-18T09:00', endDate: '2026-11-18T10:00', days: 1, hours: 1, status: 'approved'},
    {id: 33, employeeId: 3, type: 'sick', startDate: '2026-11-18', endDate: '2026-11-18', days: 1, status: 'rejected'},
    {id: 39, employeeId: 99, type: 'annual', startDate: '2026-11-18', endDate: '2026-11-18', days: 1, status: 'pending'}
  ];
  const state = {role, confirm: true, confirmations: [], mutations: [], toasts: [], modals: [], closes: 0, navigations: [], flushes: 0, blockedIds: new Set(), flush: async () => true};
  const access = id => !state.blockedIds.has(Number(id)) && employees.some(e => e.id === Number(id) &&
    (state.role === 'admin' || (state.role === 'leader' ? e.building === 'A' : e.id === 1)));
  const elements = {attRecordId: {value: '11'}, attCheckOut: {value: '18:00'}};
  const context = vm.createContext({
    Auth: {
      isAdmin: () => state.role === 'admin', isLeader: () => state.role === 'leader',
      isRegionalManager: () => state.role === 'region_manager',
      currentUser: () => ({role: state.role, employeeId: 1}),
      canAccessEmployee: access,
      canManageEmployee: id => state.role !== 'user' && access(id)
    },
    Store: {
      getEmployees: () => employees, getAttendance: () => attendance,
      getOvertime: () => overtime, getLeaveRequests: () => leaves,
      isCompensatoryLeave: row => row.type === 'compensatory',
      getTimeBalance: () => ({remainingHours: 7}),
      deleteAttendance: id => state.mutations.push(['deleteAttendance', id]),
      deleteOvertime: id => state.mutations.push(['deleteOvertime', id]),
      deleteLeaveRequest: id => state.mutations.push(['deleteLeaveRequest', id]),
      updateAttendance: (...args) => state.mutations.push(['updateAttendance', ...args]),
      updateOvertime: (...args) => state.mutations.push(['updateOvertime', ...args]),
      updateLeaveRequest: (...args) => state.mutations.push(['updateLeaveRequest', ...args]),
      flushServerSync: () => { state.flushes++; return state.flush(); },
      submitApproval: async (kind, id, decision) => {
        state.mutations.push(['submitApproval', kind, id, decision]);
        const record = (kind === 'overtime' ? overtime : leaves).find(row => row.id === id);
        const regional = decision === 'approved' && (kind === 'overtime' || ['statutoryAnnual', 'welfareAnnual', 'paidSick'].includes(record.type));
        Object.assign(record, {status: regional ? 'pending' : decision, approvalStage: regional ? 'regional' : 'complete'});
        return {ok: true, record};
      }
    },
    App: {
      currentPage: 'attendance', today: () => '2026-11-18',
      confirm: message => {state.confirmations.push(message); return state.confirm;},
      toast: (...args) => state.toasts.push(args),
      openModal: (...args) => state.modals.push(args), closeModal: () => state.closes++,
      navigate: page => state.navigations.push(page)
    },
    document: {getElementById: id => elements[id]}
  });
  for (const file of ['attendance', 'overtime', 'leave']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), context);
  }
  vm.runInContext('globalThis.modules = {Attendance, Overtime, Leave};', context);
  return {...context.modules, state, context, employees, attendance, overtime, leaves};
}

const deletionCases = [
  {module: 'Attendance', method: 'deleteRecord', id: 11, mutation: 'deleteAttendance', missingEmployeeId: 19},
  {module: 'Overtime', method: 'deleteRecord', id: 21, mutation: 'deleteOvertime', missingEmployeeId: 29},
  {module: 'Leave', method: 'delete', id: 31, mutation: 'deleteLeaveRequest', missingEmployeeId: 39}
];

test('only administrators see delete controls for attendance, overtime and every leave status', () => {
  for (const role of ['admin', 'leader', 'user']) {
    const f = fixture(role);
    const tables = [f.Attendance._table(f.attendance, f.employees, false),
      f.Overtime._renderTable(f.overtime, f.employees), f.Leave._renderTable(f.leaves, f.employees)];
    if (role === 'admin') {
      assert.match(tables[0], /Attendance\.deleteRecord\(11\)/);
      assert.match(tables[1], /Overtime\.deleteRecord\(21\)/);
      for (const id of [31, 32, 33]) assert.match(tables[2], new RegExp('Leave\\.delete\\(' + id + '\\)'));
    } else {
      assert.doesNotMatch(tables.join(''), /删除<\/button>|(?:Attendance|Overtime)\.deleteRecord|Leave\.delete\(/);
    }
    assert.doesNotMatch(tables.join(''), /deleteRecord\((?:19|29)\)|Leave\.delete\(39\)/);
  }
});

test('leaders and regular users cannot delete by direct calls or the attendance overtime wrapper', async () => {
  for (const role of ['leader', 'user']) {
    const f = fixture(role);
    for (const action of deletionCases) await f[action.module][action.method](action.id);
    await f.Attendance.otDeleteRecord(22);
    assert.equal(f.state.confirmations.length, 0);
    assert.equal(f.state.mutations.length, 0);
    assert.equal(f.state.flushes, 0);
    assert.ok(f.state.toasts.length >= 4);
    assert.ok(f.state.toasts.every(([, type]) => type === 'error'));
  }
});

test('administrator deletion still requires an existing accessible employee and record', async () => {
  for (const action of deletionCases) {
    const f = fixture();
    f.state.blockedIds.add(1);
    await f[action.module][action.method](action.id);
    await f[action.module][action.method](action.missingEmployeeId);
    await f[action.module][action.method](999);
    assert.equal(f.state.confirmations.length, 0);
    assert.equal(f.state.mutations.length, 0);
  }
});

test('cancelling administrator confirmation does not delete, save or refresh any record', async () => {
  for (const action of deletionCases) {
    const f = fixture(); f.state.confirm = false;
    await f[action.module][action.method](action.id);
    assert.equal(f.state.confirmations.length, 1);
    assert.match(f.state.confirmations[0], /确定删除/);
    assert.equal(f.state.mutations.length, 0);
    assert.equal(f.state.flushes, 0);
    assert.equal(f.state.toasts.length, 0);
    assert.equal(f.state.navigations.length, 0);
  }
});

test('administrator deletion waits for persistence and repeated clicks do not repeat confirmation or mutation', async () => {
  for (const action of deletionCases) {
    const f = fixture(); let acknowledge;
    f.state.flush = () => new Promise(resolve => {acknowledge = resolve;});
    const pending = f[action.module][action.method](action.id);
    assert.deepEqual(f.state.mutations, [[action.mutation, action.id]]);
    assert.equal(f.state.confirmations.length, 1);
    assert.equal(f.state.toasts.length, 0);
    assert.equal(f.state.closes, 0);
    assert.equal(f.state.navigations.length, 0);
    await f[action.module][action.method](action.id);
    assert.equal(f.state.confirmations.length, 1);
    assert.equal(f.state.mutations.length, 1);
    acknowledge(); await pending;
    assert.deepEqual(f.state.toasts, [['已删除', 'success']]);
    assert.equal(f.state.closes, 1);
    assert.deepEqual(f.state.navigations, ['attendance']);
    assert.equal(f[action.module]._saving, false);
  }
});

test('server rejection including spent compensatory hours never reports a successful deletion', async () => {
  for (const action of deletionCases) {
    const f = fixture();
    f.state.flush = async () => {throw new Error('已批准的调休小时数超过可用余额');};
    await f[action.module][action.method](action.id);
    assert.equal(f.state.mutations.length, 1);
    assert.deepEqual(f.state.toasts, [['已批准的调休小时数超过可用余额', 'error']]);
    assert.equal(f.state.closes, 0);
    assert.equal(f.state.navigations.length, 0);
    assert.equal(f[action.module]._saving, false);
  }
});

test('leaders retain own-building approvals, overtime editing and checkout while delete controls stay absent', async () => {
  const f = fixture('leader');
  const html = f.Attendance._table(f.attendance, f.employees, false) +
    f.Overtime._renderTable(f.overtime, f.employees) + f.Leave._renderTable(f.leaves, f.employees);
  assert.match(html, /Attendance\.showCheckoutModal\(11\)/);
  assert.match(html, /Overtime\.approve\(22\)/);
  assert.match(html, /Overtime\.showEditModal\(22\)/);
  assert.match(html, /Leave\.approve\(31\)/);
  assert.doesNotMatch(html, /删除<\/button>/);
  f.Overtime.showEditModal(22);
  assert.equal(f.state.modals.length, 1);
  await f.Overtime.approve(22);
  await f.Leave.approve(31);
  await f.Attendance.saveCheckout();
  assert.deepEqual(f.state.mutations.map(row => row[0]), ['submitApproval', 'submitApproval', 'updateAttendance']);
  assert.equal(f.state.confirmations.length, 0);
});
