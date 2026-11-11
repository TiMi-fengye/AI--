/** 服务端账号与会话；浏览器不保存新账号密码。 */
const Auth = {
  _user: null,
  _users: {},
  setupRequired: false,

  async request(path, options = {}) {
    const response = await fetch('/api/auth/' + path, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.message || '请求失败，请重试');
    return data;
  },
  async init() {
    const [session, status] = await Promise.all([this.request('session'), this.request('status')]);
    this._user = session.user || null;
    this.setupRequired = status.setupRequired === true;
    sessionStorage.removeItem('personnel_auth_session');
    return { setupRequired: this.setupRequired, setupAllowed: status.setupAllowed === true, user: this._user };
  },
  async _authenticate(path, body) {
    try {
      const data = await this.request(path, { method: 'POST', body: JSON.stringify(body) });
      this._user = data.user;
      this._users = {};
      return { success: true, user: data.user, message: '操作成功' };
    } catch (error) { return { success: false, message: error.message }; }
  },
  login(username, password) { return this._authenticate('login', { username, password }); },
  register(phone, password, employee) { return this._authenticate('register', { phone, password, employee }); },
  setupAdmin(password) { return this._authenticate('setup', { password }); },
  isLoggedIn() { return !!this._user; },
  currentUser() { return this._user; },
  isAdmin() { return !!this._user && this._user.role === 'admin'; },
  isLeader() { return !!this._user && this._user.role === 'leader'; },
  leaderBuildings() { return this.isLeader() ? (this._user.buildings || []).slice() : []; },
  canAccessEmployee(id) {
    if (!this._user) return false;
    if (this.isAdmin()) return true;
    if (this.isLeader()) {
      const employee = Store.getEmployees().find(e => String(e.id) === String(id));
      return !!employee && this.leaderBuildings().includes(employee.building || '');
    }
    return this._user.employeeId != null && String(this._user.employeeId) === String(id);
  },
  canManageEmployee(id) { return this.canAccessEmployee(id); },
  canAccessPage(page) {
    if (!this._user) return false;
    if (this.isAdmin()) return true;
    if (this.isLeader()) return ['dashboard', 'employees', 'attendance', 'leave', 'overtime', 'profile', 'hours', 'cost', 'performance'].includes(page);
    return ['profile', 'attendance', 'leave', 'overtime', 'hours'].includes(page);
  },
  roleLabel(role) { return ({ admin: '管理员', leader: '楼长', user: '普通人员' })[role] || '普通人员'; },
  escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  },
  async logout() {
    if (typeof Store !== 'undefined' && Store._serverSyncReady) {
      try { await Store.flushServerSync(); } catch (_) { /* 保存失败已撤回，退出仍需清除服务端会话。 */ }
    }
    try {
      await this.request('logout', { method: 'POST', body: '{}' });
      this._user = null;
      this._users = {};
      if (typeof Store !== 'undefined') Store.clearSessionData();
      window.location.href = 'login.html';
    } catch (error) { App.toast(error.message, 'error'); }
  },
  renderLoginModal() { window.location.href = 'login.html'; },
  checkOrShowLogin() { if (this.isLoggedIn()) return true; this.renderLoginModal(); return false; },
  _getUsers() { return this._users; },
  async loadUsers() {
    if (!this.isAdmin()) throw new Error('仅管理员可管理账号');
    const data = await this.request('users');
    this._users = data.users || {};
    return this._users;
  },
  async saveUser(user) {
    if (!this.isAdmin()) throw new Error('仅管理员可管理账号');
    await this.request('users', { method: 'POST', body: JSON.stringify(user) });
    await this.loadUsers();
  },
  async deleteUser(username) {
    if (!this.isAdmin()) throw new Error('仅管理员可管理账号');
    await this.request('users/' + encodeURIComponent(username), { method: 'DELETE' });
    await this.loadUsers();
  },
  _updateUI() {
    const right = document.querySelector('.header-right');
    const old = document.querySelector('.header-logout-btn');
    if (old) old.remove();
    if (!right || !this._user) return;
    const group = document.createElement('div');
    group.className = 'header-logout-btn';
    group.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const name = document.createElement('span');
    name.textContent = this._user.name + ' · ' + this.roleLabel(this._user.role);
    name.style.fontSize = '13px';
    const button = document.createElement('button');
    button.className = 'btn btn-outline btn-sm';
    button.textContent = '退出';
    button.onclick = () => this.logout();
    group.append(name, button);
    right.appendChild(group);
    const footer = document.getElementById('onlineCount');
    if (footer) footer.textContent = this._user.name + ' 已登录';
  },
  showChangePasswordModal() {
    if (!this.isLoggedIn()) return;
    const minimum = this.isAdmin() ? 12 : 8;
    App.openModal('修改密码',
      '<div class="form-group"><label>原密码</label><input type="password" class="form-control" id="oldPwd" autocomplete="current-password"></div>' +
      '<div class="form-group"><label>新密码（至少' + minimum + '位）</label><input type="password" class="form-control" id="newPwd" autocomplete="new-password"></div>' +
      '<div class="form-group"><label>确认新密码</label><input type="password" class="form-control" id="confirmPwd" autocomplete="new-password"></div>',
      '<button class="btn btn-primary" onclick="Auth._doChangePwd()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  async _doChangePwd() {
    const oldPassword = document.getElementById('oldPwd').value;
    const newPassword = document.getElementById('newPwd').value;
    const minimum = this.isAdmin() ? 12 : 8;
    if (newPassword.length < minimum) return App.toast('新密码至少' + minimum + '位', 'error');
    if (newPassword !== document.getElementById('confirmPwd').value) return App.toast('两次密码不一致', 'error');
    try {
      await this.request('password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
      App.closeModal();
      App.toast('密码已修改', 'success');
    } catch (error) { App.toast(error.message, 'error'); }
  },
  showUserManageModal() { if (this.isAdmin()) Permission.render(document.getElementById('pageContent')); }
};
