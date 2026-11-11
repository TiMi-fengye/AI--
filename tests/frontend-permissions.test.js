const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(role = 'user', employeeId = 1, buildings = []) {
  const employees = [
    { id: 1, name: '同名人员', position: '总监', building: '楼栋A', department: '部门A' },
    { id: 2, name: '同名人员', building: '楼栋B', department: '部门B' },
    { id: 3, name: '本栋人员', building: '楼栋A', department: '部门A' }
  ];
  const overtime = [
    { id: 11, employeeId: 1, date: '2026-11-11', hours: 3, overtimeType: 'fee', status: 'approved', reason: '自己的费用加班' },
    { id: 12, employeeId: 1, date: '2026-11-11', hours: 10, overtimeType: 'compensatory', status: 'approved', reason: '自己的调休加班' },
    { id: 13, employeeId: 1, date: '2026-11-11', hours: 4, overtimeType: 'fee', status: 'pending', reason: '自己的待审批申请' },
    { id: 21, employeeId: 2, date: '2026-11-11', hours: 24, overtimeType: 'compensatory', status: 'approved', reason: '楼栋B加班' },
    { id: 31, employeeId: 3, date: '2026-11-11', hours: 8, overtimeType: 'fee', status: 'pending', reason: '同栋他人加班' },
    { id: 99, employeeId: 99, date: '2026-11-11', hours: 90, status: 'pending', reason: '已删除人员加班' }
  ];
  const leaves = [
    { id: 41, employeeId: 1, type: 'compensatory', startDate: '2026-11-11', endDate: '2026-11-11', hours: 2, status: 'approved', reason: '自己的调休' },
    { id: 42, employeeId: 1, type: 'leave', startDate: '2026-11-11', endDate: '2026-11-11', days: 1, status: 'pending', reason: '自己的待审批请假' },
    { id: 51, employeeId: 2, type: 'compensatory', startDate: '2026-11-11', endDate: '2026-11-11', hours: 20, status: 'pending', reason: '楼栋B请假' },
    { id: 61, employeeId: 3, type: 'leave', startDate: '2026-11-11', endDate: '2026-11-11', days: 1, status: 'pending', reason: '同栋他人请假' }
  ];
  const attendance = employees.map((emp) => ({ id: 100 + emp.id, employeeId: emp.id, date: '2026-11-11', status: 'present' }));
  const user = { username: '13800000000', name: '同名人员', role, employeeId, buildings };
  const calls = { mutations: [], toasts: [], modals: [], closes: 0, navigations: [] };
  const elements = { pageContent: { innerHTML: '' }, attSubContent: { innerHTML: '' } };
  const sandbox = {
    Auth: {
      currentUser: () => user,
      isAdmin: () => role === 'admin',
      isLeader: () => role === 'leader',
      canAccessEmployee: (id) => employees.some((emp) => emp.id === Number(id) && (role === 'admin' || (role === 'leader' ? buildings.includes(emp.building) : emp.id === employeeId))),
      canManageEmployee: (id) => role !== 'user' && sandbox.Auth.canAccessEmployee(id)
    },
    Store: {
      getEmployees: () => employees,
      getOvertime: () => overtime,
      getLeaveRequests: () => leaves,
      getAttendance: () => attendance,
      isCompensatoryOvertime: (record) => record.overtimeType === 'compensatory',
      isCompensatoryLeave: (record) => record.type === 'compensatory',
      _isOutsourced: () => false,
      getTimeBalance: (id) => {
        const overtimeHours = overtime.filter((record) => record.employeeId === Number(id) && record.status === 'approved' && record.overtimeType === 'compensatory').reduce((sum, record) => sum + record.hours, 0);
        const compensatoryHours = leaves.filter((record) => record.employeeId === Number(id) && record.status === 'approved' && record.type === 'compensatory').reduce((sum, record) => sum + record.hours, 0);
        return { overtimeHours, compensatoryHours, remainingHours: Math.max(0, overtimeHours - compensatoryHours) };
      },
      addOvertime: (record) => calls.mutations.push(['addOvertime', record]),
      updateOvertime: (...args) => calls.mutations.push(['updateOvertime', ...args]),
      deleteOvertime: (...args) => calls.mutations.push(['deleteOvertime', ...args]),
      addLeaveRequest: (record) => calls.mutations.push(['addLeaveRequest', record]),
      updateLeaveRequest: (...args) => calls.mutations.push(['updateLeaveRequest', ...args]),
      deleteLeaveRequest: (...args) => calls.mutations.push(['deleteLeaveRequest', ...args]),
      addAttendance: (record) => calls.mutations.push(['addAttendance', record]),
      updateAttendance: (...args) => calls.mutations.push(['updateAttendance', ...args]),
      deleteAttendance: (...args) => calls.mutations.push(['deleteAttendance', ...args]),
      flushServerSync: async () => true
    },
    App: {
      currentPage: 'attendance',
      today: () => '2026-11-11',
      formatDate: (date) => date,
      toast: (...args) => calls.toasts.push(args),
      openModal: (...args) => calls.modals.push(args),
      closeModal: () => { calls.closes++; },
      navigate: (page) => calls.navigations.push(page),
      confirm: () => true
    },
    document: { getElementById: (id) => elements[id] }
  };
  vm.createContext(sandbox);
  for (const name of ['my-hours', 'overtime', 'leave', 'attendance']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8'), sandbox);
  }
  vm.runInContext('this.modules = { MyHours, Overtime, Leave, Attendance };', sandbox);
  return { ...sandbox.modules, sandbox, calls, elements, employees, overtime, leaves, attendance };
}

test('ordinary employee sees only their own records despite duplicate names and manager job title', () => {
  const f = fixture();
  assert.deepEqual(Array.from(f.Overtime._records(), (record) => record.id), [11, 12, 13]);
  assert.deepEqual(Array.from(f.Leave._records(), (record) => record.id), [41, 42]);
  const overtimeHtml = f.Overtime._renderTable(f.overtime, f.employees);
  const leaveHtml = f.Leave._renderTable(f.leaves, f.employees);
  assert.match(overtimeHtml, /自己的费用加班/);
  assert.match(leaveHtml, /自己的待审批请假/);
  assert.doesNotMatch(overtimeHtml + leaveHtml, /楼栋B|同栋他人|已删除|批准<\/button>|拒绝<\/button>|编辑<\/button>|删除<\/button>/);
});

test('ordinary attendance page exposes only application entries and own hours', () => {
  const f = fixture();
  f.Attendance.render(f.elements.pageContent);
  const html = f.elements.pageContent.innerHTML + f.elements.attSubContent.innerHTML;
  assert.match(html, /我的小时数/);
  assert.match(html, /加班申请/);
  assert.match(html, /请假申请/);
  assert.doesNotMatch(html, /签到|签退|考勤记录|本月考勤统计|全部到岗/);
  f.Attendance._switchTo('attendance');
  assert.equal(f.Attendance._activeTab, 'hours');
});

test('direct regular-user calls cannot approve, edit, delete, or create attendance', async () => {
  const f = fixture();
  await f.Overtime.approve(13);
  await f.Overtime.reject(31);
  f.Overtime.showEditModal(13);
  await f.Overtime.deleteRecord(13);
  await f.Leave.approve(42);
  await f.Leave.reject(61);
  await f.Leave.delete(42);
  f.Attendance.showCheckinModal();
  f.Attendance.showCheckoutModal(101);
  await f.Attendance.saveCheckin();
  await f.Attendance.saveCheckout();
  await f.Attendance.deleteRecord(101);
  await f.Attendance.allPresent();
  f.Attendance.showMonthlyReport();
  assert.equal(f.calls.mutations.length, 0);
  assert.equal(f.calls.modals.length, 0);
  assert.ok(f.calls.toasts.every(([, type]) => type === 'error'));
});

test('floor leader sees and manages only their own building including direct calls', async () => {
  const f = fixture('leader', 1, ['楼栋A']);
  assert.deepEqual(Array.from(f.Overtime._records(), (record) => record.id), [11, 12, 13, 31]);
  assert.deepEqual(Array.from(f.Leave._records(), (record) => record.id), [41, 42, 61]);
  const html = f.Overtime._renderTable(f.overtime, f.employees) + f.Leave._renderTable(f.leaves, f.employees);
  assert.match(html, /同栋他人加班/);
  assert.match(html, /批准<\/button>/);
  assert.doesNotMatch(html, /楼栋B|已删除人员/);
  await f.Overtime.reject(21);
  await f.Leave.approve(51);
  await f.Attendance.deleteRecord(102);
  assert.equal(f.calls.mutations.length, 0);
  await f.Overtime.approve(31);
  assert.equal(f.calls.mutations.length, 1);
  assert.equal(f.calls.mutations[0][1], 31);
});

test('administrator retains all existing employees and management operations', async () => {
  const f = fixture('admin', null);
  assert.equal(f.Overtime._employees().length, 3);
  assert.equal(f.Overtime._records().length, 5);
  await f.Leave.approve(51);
  assert.equal(f.calls.mutations[0][0], 'updateLeaveRequest');
  f.Attendance._activeTab = 'attendance';
  f.Attendance.render(f.elements.pageContent);
  assert.match(f.elements.attSubContent.innerHTML, /签到\/签退/);
});

test('hour summary counts only own approved records with fees and compensatory time separated', () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(f.MyHours.summary())), {
    totalHours: 13, feeHours: 3, overtimeHours: 10, usedHours: 2, remainingHours: 8
  });
  const unbound = fixture('user', null);
  assert.equal(unbound.MyHours.summary(), null);
  assert.equal(unbound.Overtime._canApply(1), false);
  assert.equal(unbound.Overtime._records().length, 0);
});

test('application success waits for server acknowledgement and repeated clicks do not duplicate', async () => {
  const f = fixture();
  Object.assign(f.elements, {
    otEmployee: { value: '1' }, otDate: { value: '2026-11-11' }, otHours: { value: '2' },
    otType: { value: 'fee' }, otReason: { value: '加班原因' }
  });
  let acknowledge;
  f.sandbox.Store.flushServerSync = () => new Promise((resolve) => { acknowledge = resolve; });
  const pending = f.Overtime.saveAdd();
  await f.Overtime.saveAdd();
  assert.equal(f.calls.mutations.length, 1);
  assert.equal(f.calls.toasts.length, 0);
  assert.equal(f.calls.closes, 0);
  acknowledge(true);
  await pending;
  assert.equal(f.calls.toasts[0][1], 'success');
  assert.equal(f.calls.closes, 1);
});

test('server rejection remains an error without success toast or closing the form', async () => {
  const f = fixture();
  Object.assign(f.elements, {
    leaveEmployee: { value: '1' }, leaveType: { value: 'leave' }, leaveStart: { value: '2026-11-11' },
    leaveEnd: { value: '2026-11-12' }, leaveHours: { value: '0' }, leaveReason: { value: '请假原因' }
  });
  f.sandbox.Store.flushServerSync = async () => { throw new Error('服务端拒绝越权操作'); };
  await f.Leave.saveApply();
  assert.deepEqual(f.calls.toasts, [['服务端拒绝越权操作', 'error']]);
  assert.equal(f.calls.closes, 0);
  assert.equal(f.calls.navigations.length, 0);
});

test('request descriptions render as text', () => {
  const f = fixture();
  f.overtime[0].reason = '<img src=x onerror=alert(1)>';
  const html = f.Overtime._renderTable(f.overtime, f.employees);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('forged application employee IDs cannot create another persons requests', async () => {
  const f = fixture();
  f.elements.otEmployee = { value: '2' };
  f.elements.leaveEmployee = { value: '3' };
  await f.Overtime.saveAdd();
  await f.Leave.saveApply();
  assert.equal(f.calls.mutations.length, 0);
  assert.equal(f.calls.toasts.length, 2);
  assert.ok(f.calls.toasts.every(([, type]) => type === 'error'));
});
