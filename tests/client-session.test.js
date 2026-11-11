'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
let directory, server, base, admin, person;
const password = 'Client-Test-Password-2026';

function storage() {
  const values = {};
  Object.defineProperties(values, {
    getItem: { value: key => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null },
    setItem: { value: (key, value) => { values[key] = String(value); } },
    removeItem: { value: key => { delete values[key]; } }
  });
  return values;
}
function client() {
  let cookie = '';
  const context = vm.createContext({
    console, setTimeout, clearTimeout, localStorage: storage(), sessionStorage: storage(),
    App: { toast() {} }, window: { location: {} },
    fetch: async (url, options = {}) => {
      const response = await fetch(base + url, { ...options, headers: { ...(options.headers || {}), Cookie: cookie } });
      const nextCookie = response.headers.get('set-cookie');
      if (nextCookie) cookie = nextCookie.split(';')[0];
      return response;
    }
  });
  for (const name of ['store', 'auth']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + name + '.js'), 'utf8') + '\nglobalThis.' + (name === 'store' ? 'Store = Store;' : 'Auth = Auth;'), context);
  context.Auth._updateUI = () => {};
  return context;
}
async function load(context) {
  context.Store.clearSessionData();
  await context.Store.restoreFromServer();
  context.Store._serverHydrating = true;
  context.Store.init();
  context.Store._serverHydrating = false;
  context.Store._serverSyncReady = true;
}
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-client-tests-'));
  process.env.HR_DATA_DIR = directory; process.env.HR_NO_OPEN = '1';
  ({ server } = require('../server/server'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  admin = client();
  assert.equal((await admin.Auth.setupAdmin(password)).success, true);
  person = client();
  assert.equal((await person.Auth.register('13800000021', password, { name: '测试人员', company: '', personAttribute: '', workAttribute: '', department: '', status: '', building: '' })).success, true);
  await load(person); await load(admin);
});
after(async () => {
  for (const context of [admin, person]) if (context?.Store._serverSyncTimer) clearTimeout(context.Store._serverSyncTimer);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('真实客户端注册后选填项保持为空，个人资料可保存且公开身份同步改名', async () => {
  const employee = person.Store.getEmployees()[0];
  for (const field of ['company', 'personAttribute', 'workAttribute', 'department', 'status', 'building']) assert.equal(employee[field], '');
  person.Store.updateEmployee(employee.id, { name: '更新姓名', email: 'person@example.com' });
  await person.Store.flushServerSync();
  assert.equal(person.Auth.currentUser().name, '更新姓名');
  const anotherDevice = client();
  assert.equal((await anotherDevice.Auth.login('13800000021', password)).success, true);
  await load(anotherDevice);
  assert.equal(anotherDevice.Store.getEmployees()[0].email, 'person@example.com');
  assert.equal(anotherDevice.Store.getEmployees().length, 1);
});

test('无待保存内容的flush不会阻止下一次真正保存，批量新增编号不重复', async () => {
  await person.Store.flushServerSync();
  const employeeId = person.Auth.currentUser().employeeId;
  person.Store.addOvertime({ employeeId, date: '2026-11-11', hours: 2, reason: '第一次', status: 'pending', overtimeType: 'fee' });
  person.Store.addOvertime({ employeeId, date: '2026-11-11', hours: 1, reason: '第二次', status: 'pending', overtimeType: 'fee' });
  assert.equal(new Set(person.Store.getOvertime().map(row => row.id)).size, 2);
  await person.Store.flushServerSync();
  await person.Store.restoreFromServer();
  assert.equal(person.Store.getOvertime().length, 2);
});

test('版本冲突会撤回未获确认的本地申请，重试只提交一次', async () => {
  await admin.Store.restoreFromServer();
  const second = client();
  assert.equal((await second.Auth.register('13800000022', password, { name: '其他楼栋同事' })).success, true);
  const employeeId = person.Auth.currentUser().employeeId;
  person.Store.addLeaveRequest({ employeeId, type: 'personal', startDate: '2026-11-12', endDate: '2026-11-12', days: 1, reason: '冲突前申请', status: 'pending' });
  await assert.rejects(person.Store.flushServerSync(), /数据已更新/);
  assert.equal(person.Store.getLeaveRequests().length, 0);
  person.Store.addLeaveRequest({ employeeId, type: 'personal', startDate: '2026-11-12', endDate: '2026-11-12', days: 1, reason: '重试申请', status: 'pending' });
  await person.Store.flushServerSync();
  await person.Store.restoreFromServer();
  assert.equal(person.Store.getLeaveRequests().length, 1);
  assert.equal(person.Store.getEmployees().length, 1);
});

test('大附件以内存为当前数据源，不依赖浏览器localStorage配额', async () => {
  const employeeId = person.Auth.currentUser().employeeId;
  const data = 'data:text/plain;base64,' + 'YQ=='.repeat(1500000);
  person.Store.updateEmployee(employeeId, { resumeData: data, resumeName: 'large.txt' });
  assert.equal(person.Store.getEmployees()[0].resumeData.length, data.length);
  assert.equal(person.localStorage.getItem('personnel_management_employees'), null);
  await person.Store.flushServerSync();
  await person.Store.restoreFromServer();
  assert.equal(person.Store.getEmployees()[0].resumeData.length, data.length);
});

test('保存被拒绝仍可退出，清除个人缓存并使服务端会话失效', async () => {
  person.Store.flushServerSync = async () => { throw new Error('模拟保存冲突'); };
  await person.Auth.logout();
  assert.equal(person.Auth.isLoggedIn(), false);
  assert.equal(person.Store.getEmployees().length, 0);
  assert.equal(person.window.location.href, 'login.html');
  assert.equal((await person.Auth.request('session')).user, null);
});
