/**
 * 人员权限分配模块
 * 管理员工与系统账号的绑定、角色分配
 * 每个 Auth 用户可绑定到一名员工（通过 employeeId）
 */
const Permission = {
  /** 渲染权限管理页面 */
  render(container) {
    if (!Auth.isLoggedIn()) { Auth.renderLoginModal(); return; }
    var session = Auth.currentUser();
    if (session.role !== 'admin') { App.toast('仅管理员可管理权限', 'error'); return; }

    var employees = Store.getEmployees();
    var users = Auth._getUsers();
    var stats = this._getStats(employees, users);

    container.innerHTML = [
      '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:center;">',
        '<span style="font-size:16px;font-weight:600;">🔐 人员权限分配</span>',
        '<button class="btn btn-outline" onclick="Admin.render(document.getElementById(\'pageContent\'))">← 返回设置</button>',
      '</div>',
      // 统计卡片
      '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">',
        '<div class="stat-card info"><div class="stat-icon">👤</div><div class="stat-label">总员工</div><div class="stat-value">' + stats.total + '</div></div>',
        '<div class="stat-card success"><div class="stat-icon">✅</div><div class="stat-label">已开通账号</div><div class="stat-value">' + stats.hasAccount + '</div></div>',
        '<div class="stat-card primary"><div class="stat-icon">🔑</div><div class="stat-label">管理员</div><div class="stat-value">' + stats.adminCount + '</div></div>',
        '<div class="stat-card warning"><div class="stat-icon">👥</div><div class="stat-label">普通用户</div><div class="stat-value">' + stats.userCount + '</div></div>',
      '</div>',
      // 未绑定账号的 Auth 用户提醒
      this._renderOrphanUsers(users, employees),
      // 权限表格
      '<div class="card"><div class="card-header"><h3>📋 员工权限列表</h3></div><div class="card-body">',
        employees.length > 0 ? this._renderTable(employees, users) : '<div class="empty-state"><div class="empty-icon">👤</div><p>暂无员工数据，请先添加人员</p></div>',
      '</div></div>',
      // 说明
      this._renderHelp(),
    ].join('');
  },

  /** 渲染未绑定员工的 Auth 用户提醒 */
  _renderOrphanUsers(users, employees) {
    var boundIds = {};
    Object.keys(users).forEach(function(u) {
      if (users[u].employeeId) boundIds[users[u].employeeId] = true;
    });
    var orphanUsers = Object.keys(users).filter(function(u) {
      return !users[u].employeeId && u !== 'admin';
    });
    if (orphanUsers.length === 0) return '';

    return [
      '<div class="card" style="border-left:4px solid var(--warning);margin-bottom:16px;">',
        '<div class="card-body" style="padding:12px 16px;">',
          '<div style="font-size:13px;color:var(--warning);font-weight:600;margin-bottom:6px;">⚠️ 以下系统账号未绑定到员工</div>',
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">',
            orphanUsers.map(function(u) {
              var roleLabel = users[u].role === 'admin' ? '管理员' : '普通用户';
              return '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#fef3c7;border-radius:6px;font-size:12px;">' +
                u + ' (' + (users[u].name || u) + ') <span class="tag tag-info" style="font-size:10px;">' + roleLabel + '</span>' +
                ' <span style="cursor:pointer;color:var(--primary);margin-left:4px;" onclick="Permission.showBindModal(\'' + u + '\')">📎 绑定</span>' +
                '</span>';
            }).join(''),
          '</div>',
        '</div>',
      '</div>'
    ].join('');
  },

  /** 统计 */
  _getStats(employees, users) {
    var boundIds = {};
    Object.keys(users).forEach(function(u) {
      if (users[u].employeeId) boundIds[users[u].employeeId] = true;
    });
    var total = employees.length;
    var hasAccount = 0, adminCount = 0, userCount = 0;
    Object.keys(users).forEach(function(u) {
      if (u === 'admin') { adminCount++; return; }
      if (users[u].role === 'admin') adminCount++;
      else userCount++;
      if (users[u].employeeId) hasAccount++;
    });
    return { total: total, hasAccount: hasAccount, adminCount: adminCount, userCount: userCount };
  },

  /** 渲染权限表格 */
  _renderTable(employees, users) {
    // 构建 employeeId -> auth user 的映射
    var userMap = {};
    Object.keys(users).forEach(function(u) {
      var empId = users[u].employeeId;
      if (empId) userMap[empId] = { username: u, name: users[u].name, role: users[u].role };
    });

    var html = '<div class="table-responsive"><table><thead><tr>' +
      '<th>员工姓名</th><th>部门</th><th>职位</th><th>系统账号</th><th>角色</th><th>操作</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < employees.length; i++) {
      var emp = employees[i];
      var auth = userMap[emp.id];
      var username = auth ? auth.username : '';
      var role = auth ? auth.role : '';
      var roleLabel = role === 'admin' ? '管理员' : (role === 'user' ? '普通用户' : '未开通');
      var roleClass = role === 'admin' ? 'tag-primary' : (role === 'user' ? 'tag-info' : 'tag-warning');

      html += '<tr>' +
        '<td><strong>' + emp.name + '</strong></td>' +
        '<td>' + (emp.department || '-') + '</td>' +
        '<td>' + (emp.position || '-') + '</td>' +
        '<td>' + (auth ? '<code style="font-size:12px;">' + username + '</code>' : '<span style="color:var(--text-light);font-size:12px;">未分配</span>') + '</td>' +
        '<td><span class="tag ' + roleClass + '" style="font-size:11px;">' + roleLabel + '</span></td>' +
        '<td style="white-space:nowrap;">' +
          (auth ? [
            '<button class="btn btn-info btn-sm" onclick="Permission.showEditRoleModal(' + emp.id + ')" title="修改角色">🔑 角色</button> ',
            '<button class="btn btn-outline btn-sm" onclick="Permission.showBindModal(\'' + username + '\')" title="重新绑定">📎 绑定</button> ',
            '<button class="btn btn-danger btn-sm" onclick="Permission.unbindAccount(' + emp.id + ',\'' + username + '\')" title="解除绑定">解除</button>'
          ].join('') : [
            '<button class="btn btn-success btn-sm" onclick="Permission.showCreateModal(' + emp.id + ')">+ 创建账号</button> ',
            '<button class="btn btn-outline btn-sm" onclick="Permission.showBindToExistingModal(' + emp.id + ')">📎 绑定已有</button>'
          ].join('')) +
        '</td></tr>';
    }

    html += '</tbody></table></div>';
    return html;
  },

  /** 显示帮助信息 */
  _renderHelp() {
    return [
      '<div class="card" style="background:#f8fafc;border:1px dashed var(--border);">',
        '<div class="card-body" style="padding:12px 16px;font-size:12px;color:var(--text-light);">',
          '💡 <strong>说明：</strong>',
          '系统账号与员工是分开管理的。在此页面可以将员工与系统账号绑定，从而控制员工登录系统后的权限。',
          '普通用户只能查看考勤、请假、加班页面并提交申请；管理员可以管理所有功能。',
        '</div>',
      '</div>'
    ].join('');
  },

  /** 打开创建账号弹窗 */
  showCreateModal(employeeId) {
    var emp = Store.getEmployees().find(function(e) { return e.id === employeeId; });
    if (!emp) return;

    App.openModal('创建系统账号 - ' + emp.name,
      '<div class="form-group"><label>登录账号 *</label><input type="text" class="form-control" id="permNewUsername" placeholder="请输入登录账号" value="' + (emp.name||'').toLowerCase() + '"></div>' +
      '<div class="form-group"><label>显示名称</label><input type="text" class="form-control" id="permNewDisplayName" value="' + emp.name + '" disabled style="background:#f1f5f9;"></div>' +
      '<div class="form-group"><label>密码 *</label><input type="password" class="form-control" id="permNewPassword" placeholder="请设置至少12位密码"></div>' +
      '<div class="form-group"><label>角色</label><select class="form-control" id="permNewRole"><option value="user">普通用户</option><option value="admin">管理员</option></select></div>' +
      '<input type="hidden" id="permEmployeeId" value="' + employeeId + '">' +
      '<p style="font-size:12px;color:var(--text-light);margin-top:8px;">将为此员工创建系统登录账号，绑定后该员工可使用账号登录系统。</p>',
      '<button class="btn btn-primary" onclick="Permission.saveCreateAccount()">创建账号</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  /** 保存创建账号 */
  saveCreateAccount() {
    var username = document.getElementById('permNewUsername').value.trim();
    var password = document.getElementById('permNewPassword').value.trim();
    var role = document.getElementById('permNewRole').value;
    var employeeId = parseInt(document.getElementById('permEmployeeId').value);
    var emp = Store.getEmployees().find(function(e) { return e.id === employeeId; });
    if (!emp) { App.toast('员工不存在', 'error'); return; }
    if (!username) { App.toast('请输入登录账号', 'error'); return; }
    if (!password || password.length < 6) { App.toast('密码至少6λ', 'error'); return; }

    var users = Auth._getUsers();
    if (users[username]) { App.toast('账号 ' + username + ' 已存在', 'error'); return; }

    users[username] = {
      password: password,
      name: emp.name,
      role: role,
      employeeId: employeeId,
      createdAt: new Date().toISOString()
    };
    Auth._saveUsers(users);
    App.toast('账号 ' + username + ' 已创建并绑定到 ' + emp.name, 'success');
    App.closeModal();
    App.navigate('admin');
    // 切换到权限管理
    Permission.render(document.getElementById('pageContent'));
  },

  /** 打开绑定已有账号弹窗 */
  showBindToExistingModal(employeeId) {
    var emp = Store.getEmployees().find(function(e) { return e.id === employeeId; });
    if (!emp) return;
    var users = Auth._getUsers();

    // 过滤出未绑定的账号（排除已绑定到其他员工的）
    var unboundUsers = Object.keys(users).filter(function(u) {
      return !users[u].employeeId || u === 'admin';
    });

    if (unboundUsers.length === 0) {
      App.toast('没有可绑定的未关联账号，请先创建', 'warning');
      return;
    }

    App.openModal('绑定已有账号 - ' + emp.name,
      '<div class="form-group"><label>选择系统账号</label><select class="form-control" id="permBindUsername">' +
        unboundUsers.map(function(u) {
          var roleLabel = users[u].role === 'admin' ? '管理员' : '普通用户';
          return '<option value="' + u + '">' + u + ' (' + (users[u].name || u) + ') - ' + roleLabel + '</option>';
        }).join('') +
      '</select></div>' +
      '<p style="font-size:12px;color:var(--text-light);margin-top:8px;">将员工 <strong>' + emp.name + '</strong> 绑定到选中的系统账号。</p>',
      '<button class="btn btn-primary" onclick="Permission.saveBindExisting(' + employeeId + ')">确认绑定</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  /** 保存绑定已有账号 */
  saveBindExisting(employeeId) {
    var username = document.getElementById('permBindUsername').value;
    var users = Auth._getUsers();
    if (!users[username]) { App.toast('账号不存在', 'error'); return; }

    // 检查是否已被其他员工绑定
    for (var u in users) {
      if (users[u].employeeId === employeeId && u !== username) {
        App.toast('该员工已绑定到其他账号：' + u, 'error');
        return;
      }
    }

    users[username].employeeId = employeeId;
    Auth._saveUsers(users);
    App.toast('账号 ' + username + ' 已绑定到员工', 'success');
    App.closeModal();
    Permission.render(document.getElementById('pageContent'));
  },

  /** 显示修改角色弹窗 */
  showEditRoleModal(employeeId) {
    var emp = Store.getEmployees().find(function(e) { return e.id === employeeId; });
    if (!emp) return;
    var users = Auth._getUsers();
    var targetUser = null, targetUsername = '';
    for (var u in users) {
      if (users[u].employeeId === employeeId) {
        targetUser = users[u];
        targetUsername = u;
        break;
      }
    }
    if (!targetUser) { App.toast('该员工未绑定账号', 'error'); return; }

    App.openModal('修改权限 - ' + emp.name,
      '<div style="margin-bottom:16px;">' +
        '<div style="font-size:13px;color:var(--text-light);margin-bottom:8px;">系统账号：<code>' + targetUsername + '</code></div>' +
        '<div class="form-group"><label>角色</label>' +
          '<select class="form-control" id="permEditRole">' +
            '<option value="user"' + (targetUser.role === 'user' ? ' selected' : '') + '>普通用户</option>' +
            '<option value="admin"' + (targetUser.role === 'admin' ? ' selected' : '') + '>管理员</option>' +
          '</select></div>' +
        '<div class="form-group"><label>新密码（留空不修改）</label>' +
          '<input type="password" class="form-control" id="permEditPassword" placeholder="留空则保留原密码"></div>' +
      '</div>',
      '<button class="btn btn-primary" onclick="Permission.saveEditRole(' + employeeId + ')">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  /** 保存角色修改 */
  saveEditRole(employeeId) {
    var role = document.getElementById('permEditRole').value;
    var newPassword = document.getElementById('permEditPassword').value.trim();
    var users = Auth._getUsers();
    var targetUsername = null;
    for (var u in users) {
      if (users[u].employeeId === employeeId) {
        targetUsername = u;
        break;
      }
    }
    if (!targetUsername) { App.toast('未找到关联账号', 'error'); return; }
    if (targetUsername === 'admin') { App.toast('不能修改默认管理员', 'error'); return; }

    users[targetUsername].role = role;
    if (newPassword) {
      if (newPassword.length < 6) { App.toast('密码至少6λ', 'error'); return; }
      users[targetUsername].password = newPassword;
    }
    Auth._saveUsers(users);
    App.toast('权限已更新', 'success');
    App.closeModal();
    Permission.render(document.getElementById('pageContent'));
  },

  /** 显示绑定弹窗（给未绑定员工的账号绑定到员工） */
  showBindModal(username) {
    var users = Auth._getUsers();
    var user = users[username];
    if (!user) return;
    var employees = Store.getEmployees();

    App.openModal('绑定员工 - ' + username,
      '<div class="form-group"><label>选择员工</label>' +
        '<select class="form-control" id="permBindEmployee">' +
          '<option value="">-- 请选择 --</option>' +
          employees.map(function(e) {
            return '<option value="' + e.id + '">' + e.name + ' (' + (e.department || '-') + ')</option>';
          }).join('') +
        '</select></div>' +
        '<p style="font-size:12px;color:var(--text-light);margin-top:8px;">将账号 <code>' + username + '</code> 绑定到选中的员工。</p>',
      '<button class="btn btn-primary" onclick="Permission.saveBindToEmployee(\'' + username + '\')">确认绑定</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  /** 保存账号绑定到员工 */
  saveBindToEmployee(username) {
    var employeeId = parseInt(document.getElementById('permBindEmployee').value);
    if (!employeeId) { App.toast('请选择员工', 'error'); return; }
    var users = Auth._getUsers();
    if (!users[username]) { App.toast('账号不存在', 'error'); return; }
    users[username].employeeId = employeeId;
    Auth._saveUsers(users);
    App.toast('已绑定', 'success');
    App.closeModal();
    Permission.render(document.getElementById('pageContent'));
  },

  /** 解除绑定 */
  unbindAccount(employeeId, username) {
    if (!App.confirm('确定解除 ' + username + ' 与员工的绑定？\n\n解除后该账号仍可登录，但不再关联到具体员工。')) return;
    var users = Auth._getUsers();
    if (!users[username]) { App.toast('账号不存在', 'error'); return; }
    if (username === 'admin') { App.toast('不能解绑默认管理员', 'error'); return; }
    delete users[username].employeeId;
    Auth._saveUsers(users);
    App.toast('已解除绑定', 'info');
    Permission.render(document.getElementById('pageContent'));
  },
};
