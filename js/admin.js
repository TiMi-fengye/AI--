/**
 * 系统管理模块
 */
const Admin = {
  render(container) {
    var employees = Store.getEmployees();
    var departments = Store.getDepartments();
    var attendance = Store.getAttendance();
    var leaves = Store.getLeaveRequests();
    container.innerHTML = [
      '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:center;"><span style="font-size:16px;font-weight:600;">⚙️ 系统管理</span></div>',
      '<div class="card"><div class="card-header"><h3>📊 数据概览</h3></div><div class="card-body"><div style="font-size:14px;line-height:2;"><div>👥 人员总数：<strong>' + employees.length + '</strong></div><div>🏢 部门：<strong>' + departments.length + '</strong></div><div>🕘 考勤记录：<strong>' + attendance.length + '</strong></div><div>📋 请假记录：<strong>' + leaves.length + '</strong></div><div>⏰ 加班记录：<strong>' + Store.getOvertime().length + '</strong></div></div></div></div>',
      '<div class="card"><div class="card-header"><h3>🏢 部门管理</h3></div><div class="card-body"><div style="display:flex;gap:8px;"><input type="text" class="form-control" id="adminNewDept" placeholder="新部门名称" style="flex:1;"><button class="btn btn-primary" onclick="Admin.addDept()">添加</button></div></div></div>',
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:20px;">',
      '<div class="card" style="cursor:pointer;text-align:center;padding:24px;border-color:var(--primary);" onclick="Permission.render(document.getElementById(\'pageContent\'))"><div style="font-size:36px;margin-bottom:8px;">🔑</div><div style="font-weight:600;color:var(--primary);">权限管理</div></div>',
      '<div class="card" style="cursor:pointer;text-align:center;padding:24px;" onclick="Admin.exportData()"><div style="font-size:36px;margin-bottom:8px;">📤</div><div style="font-weight:600;">导出数据</div></div>',
      '<div class="card" style="cursor:pointer;text-align:center;padding:24px;" onclick="document.getElementById(\'importFile\').click()"><div style="font-size:36px;margin-bottom:8px;">📥</div><div style="font-weight:600;">导入数据</div><input type="file" id="importFile" accept=".json" style="display:none;" onchange="Admin.importData(this)"></div>',
      '<div class="card" style="cursor:pointer;text-align:center;padding:24px;border-color:#ef4444;" onclick="Admin.resetData()"><div style="font-size:36px;margin-bottom:8px;">🗑️</div><div style="font-weight:600;color:#ef4444;">重置数据</div></div>',
      '</div>',
      '<div class="card" style="margin-top:20px;"><div class="card-header"><h3>🔧 本地存储</h3></div><div class="card-body" style="font-size:12px;color:var(--text-light);font-family:monospace;max-height:200px;overflow-y:auto;white-space:pre-wrap;">' + this._getStorageDetail() + '</div></div>',
      '<div class="card" style="margin-top:20px;"><div class="card-header"><h3>飞书应用接入</h3></div><div class="card-body"><p style="font-size:12px;color:var(--text-light);margin-bottom:12px;">App Secret 只保存在本地服务端。请在飞书开放平台为应用开通“以应用身份发送消息”权限。</p><div class="form-group"><label>App ID</label><input type="text" class="form-control" id="feishuAppId" placeholder="cli_xxx"></div><div class="form-group"><label>App Secret</label><input type="password" class="form-control" id="feishuAppSecret" placeholder="留空表示保留已保存的 Secret"></div><div class="form-group"><label>接收对象 ID</label><input type="text" class="form-control" id="feishuReceiveId" placeholder="群聊填 oc_xxx，用户填 ou_xxx"></div><div class="form-group"><label>接收对象类型</label><select class="form-control" id="feishuReceiveIdType"><option value="chat_id">群聊 chat_id</option><option value="open_id">用户 open_id</option><option value="user_id">用户 user_id</option><option value="union_id">用户 union_id</option><option value="email">邮箱 email</option></select></div><button class="btn btn-primary" onclick="Admin.saveFeishuApp()">保存应用配置</button> <button class="btn btn-info btn-sm" onclick="Admin.testFeishuApp()">发送测试</button></div></div>',
      '<div class="card" style="margin-top:20px;"><div class="card-header"><h3>🔐 微信登录（网站扫码 OAuth）</h3></div><div class="card-body"><p style="font-size:12px;color:var(--text-light);margin-bottom:12px;">飞书账号绑定和登录已停用。配置微信开放平台网站应用后，用户可扫码授权登录；系统只保存微信 OpenID/UnionID，不读取或保存微信密码。</p><div class="form-group"><label>微信 AppID</label><input type="text" class="form-control" id="wechatAppId" placeholder="wx_xxx"></div><div class="form-group"><label>微信 AppSecret</label><input type="password" class="form-control" id="wechatAppSecret" placeholder="留空表示保留已保存的 Secret"></div><div class="form-group"><label><input type="checkbox" id="wechatLoginEnabled"> 启用微信登录</label></div><div class="form-group"><label>OAuth 回调地址</label><input type="url" class="form-control" id="wechatOAuthRedirect" placeholder="https://你的域名/api/wechat/callback"></div><div class="form-group"><label><input type="checkbox" id="wechatAutoProvision"> 首次授权自动创建系统账号</label></div><button class="btn btn-primary" onclick="Admin.saveWechatLoginConfig()">保存微信登录设置</button><p style="font-size:12px;color:var(--text-light);margin-top:10px;">请在微信开放平台将回调地址加入授权回调域名。未配置 AppID/AppSecret 时，登录按钮不会显示。</p></div></div>',
      '<div class="card" style="margin-top:20px;"><div class="card-header"><h3>飞书群机器人（兼容）</h3></div><div class="card-body"><div class="form-group"><label>Webhook</label><input type="text" class="form-control" id="feishuWebhook" value="' + (typeof Feishu !== 'undefined' ? Feishu.getWebhook() : '') + '"></div><button class="btn btn-outline" onclick="Admin.saveFeishu()">保存 Webhook</button> <button class="btn btn-info btn-sm" onclick="Admin.testFeishu()">发送测试</button></div></div>'
    ].join('');
    this.loadFeishuAppConfig();
    this.loadWechatLoginConfig();
  },

  recalcRates() {
    var r = Store.refreshRates ? Store.refreshRates() : { overtime: false, leave: false };
    App.toast('加班费与请假扣款已按最新费率重算', 'success');
    App.navigate('admin');
  },

  addDept() {
    var name = document.getElementById('adminNewDept').value.trim();
    if (!name) { App.toast('请输入部门名称', 'error'); return; }
    Store.addDepartment(name);
    App.toast('已添加', 'success');
    App.navigate('admin');
  },

  exportData() {
    var d = Store.exportSnapshot ? Store.exportSnapshot() : { employees: Store.getEmployees(), attendance: Store.getAttendance(), leaveRequests: Store.getLeaveRequests(), departments: Store.getDepartments(), exportedAt: new Date().toISOString() };
    var b = new Blob([JSON.stringify(d, null, 2)], {type:'application/json'});
    var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'backup_' + App.today() + '.json'; a.click();
    App.toast('已导出', 'success');
  },

  importData(input) {
    var file = input.files[0]; if (!file) return;
    var r = new FileReader();
    r.onload = function(e) {
      try {
        var d = JSON.parse(e.target.result);
        var ok = Store.importSnapshot ? Store.importSnapshot(d) : false;
        if (!ok && d.employees) { Store.set('employees', d.employees); Store.set('attendance', d.attendance || []); Store.set('leave_requests', d.leaveRequests || []); Store.set('departments', d.departments || []); ok = true; }
        App.toast(ok ? '已导入' : '格式错误', ok ? 'success' : 'error');
      } catch(ex) { App.toast('导入失败', 'error'); }
    };
    r.readAsText(file); input.value = '';
  },

  resetData() {
    if (!App.confirm('确定重置所有数据？')) return;
    ImportData.run(); Store.init();
    App.toast('已重置', 'info'); App.navigate('admin');
  },

  _getStorageDetail() {
    var prefix = 'personnel_management_', lines = [];
    Object.keys(localStorage).sort().forEach(function(k) { if (k.startsWith(prefix)) { var v = localStorage.getItem(k); lines.push(k.replace(prefix, '') + ' = ' + (v.length > 100 ? v.substring(0, 100) + '...' : v)); } });
    return lines.join('\n') || '(空)';
  },

  loadFeishuLoginConfig() {
    if (typeof Feishu === 'undefined') return;
    Feishu.loadLoginConfig().then(function(c) {
      var enabled = document.getElementById('feishuLoginEnabled');
      var redirect = document.getElementById('feishuOAuthRedirect');
      var auto = document.getElementById('feishuAutoProvision');
      if (enabled) enabled.checked = c.enabled === true;
      if (redirect) redirect.value = c.redirectUri || '';
      if (auto) auto.checked = c.autoProvision !== false;
    });
  },

  saveFeishuLoginConfig() {
    var enabled = document.getElementById('feishuLoginEnabled');
    var redirect = document.getElementById('feishuOAuthRedirect');
    var auto = document.getElementById('feishuAutoProvision');
    var payload = {
      loginEnabled: !!(enabled && enabled.checked),
      oauthRedirectUri: redirect ? redirect.value.trim() : '',
      autoProvision: !!(auto && auto.checked)
    };
    Feishu.saveLoginConfig(payload).then(function(c) {
      App.toast(c.enabled ? '飞书登录已启用' : '飞书登录设置已保存', 'success');
    }).catch(function(e) { App.toast(e.message || '保存失败', 'error'); });
  },

  loadWechatLoginConfig() {
    if (typeof Wechat === 'undefined') return;
    Wechat.loadLoginConfig().then(function(c) {
      var appId = document.getElementById('wechatAppId');
      var enabled = document.getElementById('wechatLoginEnabled');
      var redirect = document.getElementById('wechatOAuthRedirect');
      var auto = document.getElementById('wechatAutoProvision');
      if (appId) appId.value = c.appId || '';
      if (enabled) enabled.checked = c.enabled === true;
      if (redirect) redirect.value = c.redirectUri || '';
      if (auto) auto.checked = c.autoProvision === true;
    });
  },

  saveWechatLoginConfig() {
    var payload = {
      appId: (document.getElementById('wechatAppId').value || '').trim(),
      appSecret: (document.getElementById('wechatAppSecret').value || '').trim(),
      loginEnabled: !!document.getElementById('wechatLoginEnabled').checked,
      oauthRedirectUri: (document.getElementById('wechatOAuthRedirect').value || '').trim(),
      autoProvision: !!document.getElementById('wechatAutoProvision').checked
    };
    if (!payload.appId && payload.loginEnabled) { App.toast('启用微信登录前请填写 AppID', 'warning'); return; }
    Wechat.saveLoginConfig(payload).then(function(c) {
      App.toast(c.enabled ? '微信登录已启用' : '微信登录设置已保存', 'success');
      document.getElementById('wechatAppSecret').value = '';
    }).catch(function(e) { App.toast(e.message || '保存失败', 'error'); });
  },

  testFeishu() {
    var url = document.getElementById('feishuWebhook').value.trim();
    if (!url) { App.toast('请先配置 Webhook', 'warning'); return; }
    Feishu.saveConfig({ webhook: url });
    Feishu.test('测试消息：华北一部酒仙桥人力资源管理平台已接入飞书！').then(function() { App.toast('测试消息已发送', 'success'); }).catch(function() { App.toast('测试消息发送失败', 'error'); });
  },

  saveFeishu() {
    var url = document.getElementById('feishuWebhook').value.trim();
    Feishu.saveConfig({ webhook: url });
    App.toast('飞书 Webhook 已保存', 'success');
  },

  loadFeishuAppConfig() {
    if (typeof Feishu === 'undefined') return;
    Feishu.loadAppConfig().then(function(c) {
      var id = document.getElementById('feishuAppId');
      var rid = document.getElementById('feishuReceiveId');
      var typ = document.getElementById('feishuReceiveIdType');
      if (id) id.value = c.appId || '';
      if (rid) rid.value = c.receiveId || '';
      if (typ) typ.value = c.receiveIdType || 'chat_id';
    });
  },

  saveFeishuApp() {
    var payload = {
      appId: (document.getElementById('feishuAppId').value || '').trim(),
      appSecret: (document.getElementById('feishuAppSecret').value || '').trim(),
      receiveId: (document.getElementById('feishuReceiveId').value || '').trim(),
      receiveIdType: document.getElementById('feishuReceiveIdType').value
    };
    if (!payload.appId || !payload.receiveId) { App.toast('请填写 App ID 和接收对象 ID', 'warning'); return; }
    Feishu.saveAppConfig(payload).then(function() {
      App.toast('飞书应用配置已保存', 'success');
      document.getElementById('feishuAppSecret').value = '';
    }).catch(function(e) { App.toast(e.message || '保存失败', 'error'); });
  },

  testFeishuApp() {
    Feishu.test('测试消息：人员管理系统已接入飞书应用！').then(function() { App.toast('测试消息已发送', 'success'); }).catch(function(e) { App.toast(e.message || '发送失败', 'error'); });
  }
};
