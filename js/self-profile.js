/** 当前账号关联的人员资料，只使用服务端返回的个人范围数据。 */
const SelfProfile = {
  _employee() {
    var user = Auth.currentUser();
    if (!user || !user.employeeId) return null;
    return Store.getEmployees().find(function(e) { return String(e.id) === String(user.employeeId); }) || null;
  },

  render(container) {
    var employee = this._employee();
    var escape = Employees._escape;
    if (!employee) {
      container.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">👤</div><h3>尚未关联人员档案</h3><p>请联系管理员将当前账号与人员信息关联。</p></div></div></div>';
      return;
    }
    var fields = [
      ['姓名', 'name'], ['工号', 'employeeNo'], ['手机号（登录账号）', 'phone'], ['性别', 'gender'], ['工作岗位', 'position'],
      ['人员性质', 'company'], ['人员属性', 'personAttribute'], ['工作属性', 'workAttribute'], ['部门', 'department'],
      ['状态', 'status'], ['区域', 'region'], ['机房', 'room'], ['楼栋', 'building'],
      ['邮箱', 'email'], ['入职日期', 'joinDate'], ['离职日期', 'leaveDate']
    ];
    container.innerHTML = '<div class="card"><div class="card-header" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;">' +
      '<div><h3>👤 我的资料</h3><p style="font-size:13px;color:var(--text-light);margin-top:6px;">核对并补充自己的人员信息。</p></div>' +
      '<button class="btn btn-primary" onclick="SelfProfile.showEditModal()">维护我的资料</button></div>' +
      '<div class="card-body"><dl style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px 24px;">' +
      fields.map(function(field) {
        var value = field[1] === 'phone' ? (Auth.currentUser().phone || employee.phone) : employee[field[1]];
        return '<div style="min-width:0;"><dt style="font-size:12px;color:var(--text-light);margin-bottom:6px;">' + field[0] +
          '</dt><dd style="margin:0;overflow-wrap:anywhere;">' + escape(value || '未填写') + '</dd></div>';
      }).join('') + '</dl>' +
      '<div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--border);"><h4 style="margin-bottom:8px;">人员简介</h4>' +
      '<p style="line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;">' + escape(employee.aiProfile || '未填写，可在维护资料时补充工作经历、技能等信息。') + '</p></div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:20px;">' + this._attachmentHtml(employee, 'resume', '简历附件') + this._attachmentHtml(employee, 'credential', '证件附件') +
      '</div></div></div>';
  },

  _attachmentHtml(employee, kind, label) {
    return '<div style="flex:1;min-width:200px;padding:14px;border:1px solid var(--border);border-radius:10px;"><div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">' + label + '</div>' +
      (employee[kind + 'Data'] ? '<span style="overflow-wrap:anywhere;">' + Employees._escape(employee[kind + 'Name'] || '已上传') + '</span> <button class="btn btn-outline btn-sm" onclick="SelfProfile.downloadAttachment(\'' + kind + '\')">下载</button>' : '未上传') + '</div>';
  },

  showEditModal() {
    var employee = this._employee();
    if (employee && Auth.canManageEmployee(employee.id)) Employees.showEditModal(employee.id, 'profile');
  },

  save() { return Employees.save(); },

  downloadAttachment(kind) {
    if (kind !== 'resume' && kind !== 'credential') return;
    var employee = this._employee();
    if (!employee || !Auth.canAccessEmployee(employee.id)) return;
    var data = employee[kind + 'Data'];
    if (!data || !/^data:[\w.+/-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(data)) return;
    var link = document.createElement('a');
    link.href = data;
    link.download = employee[kind + 'Name'] || kind;
    link.click();
  }
};
