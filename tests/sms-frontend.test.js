'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../login.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const phone = '13800000001';
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function fixture(required = true, configured = true) {
  let clock = Date.parse('2026-11-12T04:00:00Z');
  const documentEvents = {}, windowEvents = {}, intervals = [], calls = [], elements = {};
  for (const id of [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).concat('empPhone')) {
    elements[id] = { value: '', hidden: false, disabled: false, required: false, checked: false, textContent: '', dataset: {}, attributes: {}, events: {}, innerHTML: '', addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; }, classList: { toggle() {} } };
  }
  Object.assign(elements.loginUsername, { value: phone });
  Object.assign(elements.empPhone, { value: phone });
  elements.loginPassword.value = elements.registerPassword.value = elements.registerConfirm.value = 'Fixture-password-2026';
  elements.loginBtn.textContent = '登录'; elements.registerBtn.textContent = '注册并登录';
  const auth = {
    smsVerificationRequired: required, smsConfigured: configured,
    async init() { return { smsVerificationRequired: required, smsConfigured: configured }; }, isLoggedIn: () => false,
    async sendSmsCode(number, purpose) { calls.push({ action: 'send', number, purpose }); return { challengeId: (purpose === 'login' ? 'a' : 'b').repeat(64), expiresIn: 300, retryAfter: 60 }; },
    async login(...args) { calls.push({ action: 'login', args }); return { success: false, message: '测试登录响应' }; },
    async register(...args) { calls.push({ action: 'register', args }); return { success: false, message: '测试注册响应' }; }
  };
  const localStorage = storage(), sessionStorage = storage();
  const context = vm.createContext({
    console, Map, Set, Auth: auth, localStorage, sessionStorage,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    window: { location: { hostname: 'localhost', href: '' }, addEventListener(name, fn) { windowEvents[name] = fn; } },
    document: { getElementById: id => elements[id] || null, addEventListener(name, fn) { documentEvents[name] = fn; } },
    Store: { async loadOrganizationSettings(value) { calls.push({ action: 'options', publicOnly: value }); } },
    Employees: { _formHtml: () => '<input id="empPhone">', readFormData: () => ({ name: '测试人员', phone: elements.empPhone.value, company: '', personAttribute: '', workAttribute: '', department: '', status: '', building: '' }) }
  });
  vm.runInContext(inline, context, { filename: 'login.html' });
  return { context, elements, auth, calls, localStorage, sessionStorage, documentEvents, windowEvents, intervals, advance(milliseconds) { clock += milliseconds; context.updateSmsControls(); } };
}

test('短信字段具备六位数字和系统自动填充语义，页面脚本语法有效', () => {
  new vm.Script(inline);
  for (const id of ['loginSmsCode', 'registerSmsCode']) {
    const input = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))[0];
    assert.match(input, /inputmode="numeric"/); assert.match(input, /autocomplete="one-time-code"/);
    assert.match(input, /maxlength="6"/); assert.match(input, /pattern="\[0-9\]\{6\}"/);
  }
});

test('Auth兼容旧密码调用，并传递验证码挑战及发送用途，不保存验证码', async () => {
  const calls = [], localStorage = storage();
  const context = vm.createContext({ console, localStorage, sessionStorage: storage(), fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => url.endsWith('status') ? { smsVerificationRequired: true, smsConfigured: true } : url.endsWith('session') ? { user: null } : { ok: true, user: { role: 'user' }, challengeId: 'a'.repeat(64), expiresIn: 300, retryAfter: 60 } };
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8') + '\nglobalThis.Auth=Auth;', context);
  const status = await context.Auth.init(); assert.equal(status.smsVerificationRequired, true); assert.equal(status.smsConfigured, true);
  await context.Auth.login(phone, 'password');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { username: phone, password: 'password' });
  const verification = { smsCode: '654321', smsChallengeId: 'a'.repeat(64) };
  await context.Auth.login(phone, 'password', verification);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { username: phone, password: 'password', ...verification });
  await context.Auth.register(phone, 'password', { name: '测试人员' }, verification);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { phone, password: 'password', employee: { name: '测试人员' }, ...verification });
  await context.Auth.sendSmsCode(phone, 'register');
  assert.equal(calls.at(-1).url, '/api/auth/sms-code');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { phone, purpose: 'register' });
  assert.equal(localStorage.values.size, 0);
});

test('发送限流的retryAfter从服务端错误保留供绝对倒计时使用', async () => {
  const context = vm.createContext({ fetch: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, message: '请稍后重试', retryAfter: 42 }) }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8') + '\nglobalThis.Auth=Auth;', context);
  await assert.rejects(context.Auth.sendSmsCode(phone, 'login'), error => error.status === 429 && error.retryAfter === 42);
});

test('短信未启用时保持旧流程，六个组织字段仍可留空', async () => {
  const f = fixture(false, false);
  f.context.updateSmsControls();
  assert.equal(f.elements.loginSmsGroup.hidden, true); assert.equal(f.elements.registerSmsGroup.hidden, true);
  await f.context.doLogin(); await f.context.doRegister({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.action === 'send').length, 0);
  assert.equal(f.calls.find(call => call.action === 'login').args[2], undefined);
  const registered = f.calls.find(call => call.action === 'register');
  assert.equal(registered.args[3], undefined);
  for (const key of ['company', 'personAttribute', 'workAttribute', 'department', 'status', 'building']) assert.equal(registered.args[2][key], '');
});

test('启用但未配置短信时不降级，手机号注册登录被阻止而管理账号路径保留', async () => {
  const f = fixture(true, false);
  f.context.updateSmsControls();
  assert.equal(f.elements.loginSmsSend.disabled, true); assert.equal(f.elements.registerSmsSend.disabled, true);
  assert.match(f.elements.loginSmsHelp.textContent, /短信服务尚未配置/);
  await f.context.sendAuthSms('login'); await f.context.doLogin(); await f.context.doRegister({ preventDefault() {} });
  assert.equal(f.calls.length, 0);
  f.elements.loginUsername.value = 'admin'; f.context.smsPhoneChanged('login');
  assert.equal(f.elements.loginSmsGroup.hidden, true); assert.equal(f.elements.managementLoginHint.hidden, false);
  await f.context.doLogin();
  assert.equal(f.calls.at(-1).action, 'login'); assert.equal(f.calls.at(-1).args[2], undefined);
});

test('同手机号发送中阻止重复和跨标签请求；切换标签不会重置60秒冷却', async () => {
  const f = fixture(), sent = deferred(); let sends = 0;
  f.auth.sendSmsCode = async () => { sends++; return sent.promise; };
  const pending = f.context.sendAuthSms('login');
  await f.context.sendAuthSms('login'); await f.context.sendAuthSms('register');
  assert.equal(sends, 1);
  sent.resolve({ challengeId: 'a'.repeat(64), expiresIn: 300, retryAfter: 60 }); await pending;
  await f.context.showAuthMode('register'); await f.context.showAuthMode('login');
  assert.equal(f.elements.loginSmsSend.textContent, '60秒后重发');
  assert.equal(f.elements.registerSmsSend.disabled, true);
  f.advance(59001); assert.equal(f.elements.loginSmsSend.textContent, '1秒后重发');
  await f.context.sendAuthSms('login'); assert.equal(sends, 1);
  f.advance(1000); assert.equal(f.elements.loginSmsSend.disabled, false);
});

test('修改手机号立即清空验证码，迟到响应不能为新号码安装旧challenge', async () => {
  const f = fixture(), sent = deferred();
  f.auth.sendSmsCode = () => sent.promise;
  const pending = f.context.sendAuthSms('login');
  f.elements.loginSmsCode.value = '654321'; f.elements.loginUsername.value = '13800000002';
  f.context.smsPhoneChanged('login');
  assert.equal(f.elements.loginSmsCode.value, '');
  sent.resolve({ challengeId: 'a'.repeat(64), expiresIn: 300, retryAfter: 60 }); await pending;
  f.elements.loginSmsCode.value = '654321';
  assert.throws(() => f.context.smsVerification('login'), /请先获取当前手机号/);
  f.elements.loginUsername.value = phone; f.context.smsPhoneChanged('login');
  assert.equal(f.elements.loginSmsSend.textContent, '60秒后重发');
});

test('两类提交均要求当前用途challenge与六位验证码，过期后不能提交', async () => {
  const f = fixture();
  await f.context.doLogin(); assert.equal(f.calls.filter(call => call.action === 'login').length, 0);
  await f.context.sendAuthSms('login');
  f.elements.loginSmsCode.value = '12345'; await f.context.doLogin();
  assert.equal(f.calls.filter(call => call.action === 'login').length, 0);
  f.elements.loginSmsCode.value = '654321'; await f.context.doLogin();
  const login = f.calls.find(call => call.action === 'login');
  assert.deepEqual(JSON.parse(JSON.stringify(login.args[2])), { smsCode: '654321', smsChallengeId: 'a'.repeat(64) });
  await f.context.doRegister({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.action === 'register').length, 0);
  f.advance(60000); await f.context.sendAuthSms('register');
  f.elements.registerSmsCode.value = '654321'; await f.context.doRegister({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.action === 'register').length, 1);
  f.advance(300001); f.elements.registerSmsCode.value = '654321';
  await f.context.doRegister({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.action === 'register').length, 1);
  assert.equal(f.localStorage.values.size, 0); assert.equal(f.sessionStorage.values.size, 0);
});

test('发送失败采用服务端冷却且不误报成功，也不会安装challenge', async () => {
  const f = fixture();
  f.auth.sendSmsCode = async () => { const error = new Error('短信发送失败，请稍后重试'); error.retryAfter = 45; throw error; };
  await f.context.sendAuthSms('register');
  assert.match(f.elements.loginError.textContent, /发送失败/); assert.doesNotMatch(f.elements.loginError.textContent, /已发送/);
  assert.equal(f.elements.registerSmsSend.textContent, '45秒后重发');
  f.elements.registerSmsCode.value = '654321';
  assert.throws(() => f.context.smsVerification('register'), /请先获取/);
});

test('页面离开清除验证码与challenge；重新显示按真实时间更新冷却', async () => {
  const f = fixture(); await f.documentEvents.DOMContentLoaded();
  await f.context.sendAuthSms('login'); f.elements.loginSmsCode.value = '654321';
  f.windowEvents.pagehide(); assert.equal(f.elements.loginSmsCode.value, '');
  f.advance(61000); f.windowEvents.pageshow();
  assert.equal(f.elements.loginSmsSend.disabled, false);
  assert.throws(() => f.context.smsVerification('login'), /请先获取/);
});
