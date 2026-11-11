/** 管理员为账号绑定人员档案，分配角色和楼栋范围。 */
const Permission = {
  async render(container) {
    if (!Auth.isAdmin()) { App.toast('仅管理员可管理权限', 'error'); return; }
    App.currentPage = 'admin';
    document.getElementById('pageTitle').textContent = '🔐 账号与人员权限';
    container.textContent = '正在读取账号…';
    try {
      const users = await Auth.loadUsers();
      const employees = Store.getEmployees();
      const e = Auth.escape;
      container.innerHTML =
        '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px;"><button class="btn btn-primary" id="permAdd">添加账号</button><button class="btn btn-outline" onclick="App.navigate(\'admin\')">返回设置</button></div>' +
        '<div class="card"><div class="card-header"><h3>账号与人员权限</h3></div><div class="card-body"><div class="table-responsive"><table><thead><tr><th>姓名</th><th>登录账号</th><th>角色</th><th>关联人员</th><th>负责楼栋</th><th>操作</th></tr></thead><tbody>' +
        Object.keys(users).map(username => {
          const user = users[username];
          const employee = employees.find(emp => String(emp.id) === String(user.employeeId));
          return '<tr><td>' + e(user.name) + '</td><td>' + e(username) + '</td><td>' + Auth.roleLabel(user.role) + '</td><td>' + (employee ? e(employee.name) + '（' + e(employee.phone || '') + '）' : '未绑定') + '</td><td>' + e((user.buildings || []).join('、') || '—') + '</td><td><button class="btn btn-outline btn-sm" data-edit="' + e(username) + '">编辑权限</button> ' + (username !== 'admin' && username !== Auth.currentUser().username ? '<button class="btn btn-danger btn-sm" data-delete="' + e(username) + '">删除账号</button>' : '') + '</td></tr>';
        }).join('') +
        '</tbody></table></div></div></div>' +
        '<p style="margin-top:16px;color:var(--text-light);line-height:1.9;">管理员可查看全部信息。楼长只可查看和维护指定楼栋的信息。普通人员只可维护自己绑定的档案、提交自己的加班和请假申请、查看自己的小时数。手机号注册的账号自动绑定个人档案；楼长身份由管理员分配。</p>';
      container.querySelector('#permAdd').onclick = () => this.showEditModal();
      container.querySelectorAll('[data-edit]').forEach(button => { button.onclick = () => this.showEditModal(button.dataset.edit); });
      container.querySelectorAll('[data-delete]').forEach(button => { button.onclick = () => this.deleteAccount(button.dataset.delete); });
    } catch (error) { container.textContent = '读取失败：' + error.message; }
  },

  showEditModal(username) {
    if (!Auth.isAdmin()) return;
    const user = (username && Auth._getUsers()[username]) || { role: 'user', buildings: [] };
    const e = Auth.escape;
    const employees = Store.getEmployees();
    const buildings = [...new Set(employees.map(emp => emp.building).filter(Boolean).concat(typeof Employees === 'undefined' ? [] : Employees._buildingOptions))];
    App.openModal(username ? '编辑账号权限' : '添加账号',
      '<div class="form-group"><label>手机号 / 管理账号 *</label><input class="form-control" id="permUsername" value="' + e(username || '') + '"' + (username ? ' readonly' : '') + ' autocomplete="off"></div>' +
      '<div class="form-group"><label>姓名 *</label><input class="form-control" id="permName" value="' + e(user.name || '') + '"></div>' +
      '<div class="form-group"><label>密码' + (username ? '（留空保留）' : ' *') + '</label><input type="password" class="form-control" id="permPassword" autocomplete="new-password" placeholder="普通人员/楼长至少8位，管理员至少12位"' + (username === Auth.currentUser().username ? ' disabled' : '') + '>' + (username === Auth.currentUser().username ? '<p>修改本人密码请使用右上角“账号 → 修改密码”。</p>' : '') + '</div>' +
      '<div class="form-group"><label>关联人员档案</label><select class="form-control" id="permEmployee"><option value="">未绑定</option>' +
      employees.map(emp => '<option value="' + e(emp.id) + '"' + (String(emp.id) === String(user.employeeId) ? ' selected' : '') + '>' + e(emp.name + ' · ' + (emp.phone || '') + ' · ' + (emp.building || '楼栋未填写')) + '</option>').join('') + '</select></div>' +
      '<div class="form-group"><label>角色</label><select class="form-control" id="permRole">' +
      ['user', 'leader', 'admin'].map(role => '<option value="' + role + '"' + (role === user.role ? ' selected' : '') + '>' + Auth.roleLabel(role) + '</option>').join('') + '</select></div>' +
      '<div class="form-group" id="permBuildingsGroup"><label>负责楼栋（楼长必填，多个用逗号分隔）</label><input class="form-control" id="permBuildings" list="permBuildingOptions" value="' + e((user.buildings || []).join('，')) + '"><datalist id="permBuildingOptions">' + buildings.map(building => '<option value="' + e(building) + '"></option>').join('') + '</datalist><p style="font-size:12px;color:var(--text-light);margin-top:6px;">按此处明确分配的楼栋授权，人员表单中的岗位名称不会授予楼长权限。</p></div>',
      '<button class="btn btn-primary" id="permSave">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
    const roleSelect = document.getElementById('permRole');
    const toggle = () => { document.getElementById('permBuildingsGroup').hidden = roleSelect.value !== 'leader'; };
    roleSelect.onchange = toggle; toggle();
    document.getElementById('permSave').onclick = () => this.saveAccount(!!username);
  },

  async saveAccount(isEdit) {
    if (!Auth.isAdmin()) return;
    const username = document.getElementById('permUsername').value.trim();
    const name = document.getElementById('permName').value.trim();
    const password = document.getElementById('permPassword').value;
    const role = document.getElementById('permRole').value;
    const employeeId = Number(document.getElementById('permEmployee').value) || null;
    const buildings = role === 'leader' ? [...new Set(document.getElementById('permBuildings').value.split(/[,，、;\n]/).map(item => item.trim()).filter(Boolean))] : [];
    if (!username || !name) return App.toast('请填写账号和姓名', 'error');
    const minimum = role === 'admin' ? 12 : 8;
    if ((!isEdit || password) && password.length < minimum) return App.toast('密码至少' + minimum + '位', 'error');
    if (role === 'leader' && !buildings.length) return App.toast('请填写楼长负责的楼栋', 'error');
    const body = { username, name, role, employeeId, buildings };
    if (password) body.password = password;
    if (/^1[3-9]\d{9}$/.test(username)) body.phone = username;
    const button = document.getElementById('permSave'); button.disabled = true;
    try {
      await Store.flushServerSync();
      await Auth.saveUser(body);
      App.closeModal();
      App.toast('账号权限已保存', 'success');
      this.render(document.getElementById('pageContent'));
    } catch (error) { App.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  },

  async deleteAccount(username) {
    if (!Auth.isAdmin() || !App.confirm('确定删除账号“' + username + '”？人员档案会保留。')) return;
    try {
      await Auth.deleteUser(username);
      App.toast('账号已删除', 'success');
      this.render(document.getElementById('pageContent'));
    } catch (error) { App.toast(error.message, 'error'); }
  }
};
