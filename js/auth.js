/**
 * 登录验证模块 - Auth
 * 管理用户登录、退出、session 状态
 */
const Auth = {
  _sessionKey: 'personnel_auth_session',
  _userKey: 'personnel_users',
  _loginPage: 'login.html',

  /** 初始化：首次运行时由当前浏览器设置管理员密码。密码不会写入源码。 */
  init() {
    const users = this._getUsers();
    this._clearFeishuBindings(users);
    if (Object.keys(users).length === 0 || (users.admin && users.admin.needsSetup)) {
      var password = this._promptInitialPassword();
      users['admin'] = { password: password, needsSetup: !password, name: '管理员', role: 'admin', createdAt: new Date().toISOString() };
      this._saveUsers(users);
    }
  },

  _promptInitialPassword() {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return '';
    for (var i = 0; i < 3; i++) {
      var value = String(window.prompt('首次运行，请设置管理员密码（至少12位）：') || '').trim();
      if (value.length >= 12) return value;
      if (value) window.alert('管理员密码至少需要12位，请重新设置。');
    }
    return '';
  },

  /** 飞书登录已停用：清除浏览器中遗留的飞书身份字段，保留本地账号和权限。 */
  _clearFeishuBindings(users) {
    var changed = false;
    var session = this._getSession();
    var clearSession = false;
    Object.keys(users || {}).forEach(function (key) {
      var user = users[key] || {};
      ['feishu', 'feishuOpenId', 'feishuUnionId', 'feishuUserId'].forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(user, field)) { delete user[field]; changed = true; }
      });
      if (user.authType === 'feishu') {
        if (session && session.username === key) clearSession = true;
        delete user.authType;
        changed = true;
      }
    });
    if (changed) this._saveUsers(users);
    if (clearSession) this._clearSession();
  },

  /** 获取所有用户 */
  _getUsers() {
    try {
      return JSON.parse(localStorage.getItem(this._userKey)) || {};
    } catch (e) {
      return {};
    }
  },

  /** 保存用户列表 */
  _saveUsers(users) {
    localStorage.setItem(this._userKey, JSON.stringify(users));
  },

  /** 获取当前 session */
  _getSession() {
    try {
      return JSON.parse(sessionStorage.getItem(this._sessionKey));
    } catch (e) {
      return null;
    }
  },

  /** 保存 session */
  _setSession(user) {
    sessionStorage.setItem(this._sessionKey, JSON.stringify({
      username: user.username,
      name: user.name,
      role: user.role,
      authType: user.authType || 'password',
      loginAt: new Date().toISOString()
    }));
  },

  /** 清除 session */
  _clearSession() {
    sessionStorage.removeItem(this._sessionKey);
  },

  /** 检查是否已登录 */
  isLoggedIn() {
    return this._getSession() !== null;
  },

  /** 获取当前登录用户信息 */
  currentUser() {
    return this._getSession();
  },

  /** 登录 */
  login(username, password) {
    const users = this._getUsers();
    const user = users[username];
    if (!user) return { success: false, message: '用户不存在' };
    if (user.needsSetup || !user.password) return { success: false, message: '请刷新页面完成首次管理员密码设置' };
    if (user.password !== password) return { success: false, message: '密码错误' };
    this._setSession({ username, ...user });
    return { success: true, message: '登录成功', user: { username, name: user.name, role: user.role } };
  },

  /** 使用飞书 OAuth 返回的身份登录；系统不会接收或保存飞书密码。 */
  loginWithFeishuProfile(profile, cfg) {
    if (!cfg || cfg.enabled !== true) return { success: false, message: '飞书登录已停用' };
    if (!profile || !profile.open_id) return { success: false, message: '飞书未返回有效用户身份' };
    var users = this._getUsers();
    var username = null;
    var keys = Object.keys(users);
    for (var i = 0; i < keys.length; i++) {
      var u = users[keys[i]] || {};
      if (u.feishuOpenId === profile.open_id || u.feishu === profile.open_id || (profile.email && u.email === profile.email)) {
        username = keys[i];
        break;
      }
    }
    if (!username) {
      if (!cfg || cfg.autoProvision === false) return { success: false, message: '该飞书账号尚未绑定系统账号，请联系管理员' };
      var base = 'feishu_' + String(profile.open_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24);
      if (!base || base === 'feishu_') base = 'feishu_user';
      username = base;
      var n = 2;
      while (users[username]) username = base + '_' + (n++);
      var randomPassword = 'oauth_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      users[username] = {
        password: randomPassword,
        name: profile.name || profile.en_name || '飞书用户',
        role: 'user',
        authType: 'feishu',
        feishu: profile.open_id,
        feishuOpenId: profile.open_id,
        feishuUnionId: profile.union_id || '',
        feishuUserId: profile.user_id || '',
        email: profile.email || '',
        createdAt: new Date().toISOString()
      };
      this._saveUsers(users);
    }
    var user = users[username];
    this._setSession({ username: username, ...user });
    return { success: true, message: '飞书登录成功', user: { username: username, name: user.name, role: user.role, authType: 'feishu' } };
  },

  /** 使用微信 OAuth 返回的身份登录；系统不会接收或保存微信密码。 */
  loginWithWechatProfile(profile, cfg) {
    if (!cfg || cfg.enabled !== true) return { success: false, message: '微信登录已停用' };
    if (!profile || !profile.open_id) return { success: false, message: '微信未返回有效用户身份' };
    var users = this._getUsers();
    var username = null;
    var keys = Object.keys(users);
    for (var i = 0; i < keys.length; i++) {
      var u = users[keys[i]] || {};
      if (u.wechatOpenId === profile.open_id || (profile.union_id && u.wechatUnionId === profile.union_id)) {
        username = keys[i];
        break;
      }
    }
    if (!username) {
      if (cfg.autoProvision !== true) return { success: false, message: '该微信账号尚未绑定系统账号，请联系管理员' };
      var base = 'wechat_' + String(profile.open_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24);
      if (!base || base === 'wechat_') base = 'wechat_user';
      username = base;
      var n = 2;
      while (users[username]) username = base + '_' + (n++);
      var randomPassword = 'oauth_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      users[username] = {
        password: randomPassword,
        name: profile.name || profile.nickname || '微信用户',
        role: 'user',
        authType: 'wechat',
        wechatOpenId: profile.open_id,
        wechatUnionId: profile.union_id || '',
        createdAt: new Date().toISOString()
      };
      this._saveUsers(users);
    }
    var user = users[username];
    this._setSession({ username: username, ...user });
    return { success: true, message: '微信登录成功', user: { username: username, name: user.name, role: user.role, authType: 'wechat' } };
  },

  /** 退出登录 */
  logout() {
    this._clearSession();
    window.location.href = this._loginPage;
  },

  /** 修改密码 */
  changePassword(oldPwd, newPwd) {
    const session = this._getSession();
    if (!session) return { success: false, message: '未登录' };
    const users = this._getUsers();
    const user = users[session.username];
    if (!user) return { success: false, message: '用户不存在' };
    if (user.password !== oldPwd) return { success: false, message: '原密码错误' };
    user.password = newPwd;
    this._saveUsers(users);
    return { success: true, message: '密码已修改' };
  },

  /** 渲染登录页面（在 index.html 顶部显示） */
  renderLoginModal() {
    App.openModal('用户登录',
      '<div style="text-align:center;padding:8px;">' +
        '<div style="font-size:56px;margin-bottom:12px;">🔐</div>' +
        '<p style="font-size:14px;color:var(--text-light);margin-bottom:20px;">请输入账号密码登录系统</p>' +
        '<div class="form-group"><label>账号</label><input type="text" class="form-control" id="loginUsername" placeholder="请输入账号" value="admin"></div>' +
        '<div class="form-group"><label>密码</label><input type="password" class="form-control" id="loginPassword" placeholder="请输入密码"></div>' +
      '</div>',
      '<button class="btn btn-primary" onclick="Auth._doLogin()">登 ¼</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') Auth._doLogin();
    });
    setTimeout(() => document.getElementById('loginPassword').focus(), 100);
  },

  /** 执行登录 */
  _doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    if (!username || !password) {
      App.toast('请输入账号和密码', 'error');
      return;
    }
    const result = this.login(username, password);
    if (result.success) {
      App.toast('登录成功', 'success');
      App.closeModal();
      this._updateUI();
    } else {
      App.toast(result.message, 'error');
    }
  },

  /** 校验登录状态，未登录弹出登录框 */
  checkOrShowLogin() {
    if (this.isLoggedIn()) return true;
    // 延迟一点等页面渲染完成
    setTimeout(() => this.renderLoginModal(), 300);
    return false;
  },

  /** 更新 UI：顶部栏显示用户名和退出按钮 */
  _updateUI() {
    const session = this._getSession();
    const rightEl = document.querySelector('.header-right');
    if (!rightEl) return;

    // 移除旧的退出按钮
    const oldLogout = document.querySelector('.header-logout-btn');
    if (oldLogout) oldLogout.remove();

    if (session) {
      const btn = document.createElement('div');
      btn.className = 'header-logout-btn';
      btn.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:default;';
      btn.innerHTML = '<span style="font-size:13px;color:var(--text-light);">👤 ' + session.name + '</span>' +
        '<button onclick="Auth.logout()" style="padding:4px 12px;border:1px solid #e2e8f0;border-radius:6px;background:transparent;cursor:pointer;font-size:12px;color:#64748b;">退出</button>';
      rightEl.appendChild(btn);

      // 更新侧边栏底部
      const footerInfo = document.getElementById('onlineCount');
      if (footerInfo) {
        footerInfo.textContent = session.name + ' 已登录';
      }
    }
  },

  /** 用户管理 - 修改密码界面 */
  showChangePasswordModal() {
    if (!this.isLoggedIn()) {
      App.toast('请先登录', 'warning');
      return;
    }
    App.openModal('修改密码',
      '<div class="form-group"><label>原密码</label><input type="password" class="form-control" id="oldPwd" placeholder="请输入原密码"></div>' +
      '<div class="form-group"><label>新密码</label><input type="password" class="form-control" id="newPwd" placeholder="请输入新密码"></div>' +
      '<div class="form-group"><label>确认新密码</label><input type="password" class="form-control" id="confirmPwd" placeholder="请再次输入新密码"></div>',
      '<button class="btn btn-primary" onclick="Auth._doChangePwd()">修改</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  _doChangePwd() {
    const oldPwd = document.getElementById('oldPwd').value;
    const newPwd = document.getElementById('newPwd').value;
    const confirmPwd = document.getElementById('confirmPwd').value;
    if (!oldPwd || !newPwd) { App.toast('请填写完整', 'error'); return; }
    if (newPwd.length < 6) { App.toast('新密码至少6λ', 'error'); return; }
    if (newPwd !== confirmPwd) { App.toast('两次密码不一致', 'error'); return; }
    const result = this.changePassword(oldPwd, newPwd);
    if (result.success) {
      App.toast('密码已修改', 'success');
      App.closeModal();
    } else {
      App.toast(result.message, 'error');
    }
  },

  /** 用户管理 - 管理员添加/管理用户（仅 admin 角色可用） */
  showUserManageModal() {
    if (!this.isLoggedIn()) { App.toast('请先登录', 'warning'); return; }
    const session = this._getSession();
    if (session.role !== 'admin') { App.toast('仅管理员可管理用户', 'error'); return; }
    const users = this._getUsers();
    let html = '<div class="user-manage-modal"><div style="margin-bottom:12px;"><h4 style="margin-bottom:8px;">用户列表</h4>';
    Object.keys(users).forEach(u => {
      const user = users[u];
      const isSelf = u === session.username;
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#f8fafc;border-radius:6px;margin-bottom:4px;">' +
        '<span style="font-size:11px;color:var(--text-light);margin-right:4px;">' + (user.wechatOpenId ? "\u2705" : "") + '</span>' +
        '<span><strong>' + (user.name || u) + '</strong> (' + u + ') <span style="font-size:11px;color:var(--text-light);">' + user.role + '</span></span>' +
        (isSelf ? '<span style="font-size:11px;color:var(--text-light);">当前用户</span>' : '<button class="btn btn-danger btn-sm" onclick="Auth._deleteUser(\'' + u + '\')">删除</button>') +
      '</div>';
    });
    html += '</div><hr style="margin:12px 0;"><h4 style="margin-bottom:8px;">添加用户</h4>' +
      '<div class="form-group"><label>账号</label><input type="text" class="form-control" id="newUserName"></div>' +
      '<div class="form-group"><label>姓名</label><input type="text" class="form-control" id="newUserDisplayName"></div>' +
      '<div class="form-group"><label>密码</label><input type="password" class="form-control" id="newUserPwd" placeholder="请设置至少12位密码"></div>' +
      '<div class="form-group"><label>角色</label><select class="form-control" id="newUserRole"><option value="user">普通用户</option><option value="admin">管理员</option></select></div>' +
      '<div class="form-group"><label>微信 OpenID（可选）</label><input type="text" class="form-control" id="newUserWechat" placeholder="微信 OpenID"></div></div>';
    App.openModal('用户管理', html, '<button class="btn btn-primary" onclick="Auth._addUser()">添加用户</button><button class="btn btn-outline" onclick="App.closeModal()">关闭</button>');
  },

  _addUser() {
    const username = document.getElementById('newUserName').value.trim();
    const name = document.getElementById('newUserDisplayName').value.trim();
    const password = document.getElementById('newUserPwd').value.trim();
    const role = document.getElementById('newUserRole').value;
    if (!username || !password) { App.toast('账号和密码不能为空', 'error'); return; }
    const users = this._getUsers();
    if (users[username]) { App.toast('账号已存在', 'error'); return; }
    var wechatOpenId = document.getElementById('newUserWechat') ? document.getElementById('newUserWechat').value.trim() : '';
    users[username] = { password, name: name || username, role, wechatOpenId: wechatOpenId, createdAt: new Date().toISOString() };
    this._saveUsers(users);
    App.toast('用户 ' + username + ' 已添加', 'success');
    this.showUserManageModal();
  },

  _deleteUser(username) {
    if (username === 'admin') { App.toast('不能删除默认管理员', 'error'); return; }
    if (!App.confirm('确定删除用户「' + username + '」？')) return;
    const users = this._getUsers();
    delete users[username];
    this._saveUsers(users);
    App.toast('用户已删除', 'info');
    this.showUserManageModal();
  }
};
