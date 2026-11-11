/**
 * 人力资源管理模块
 * 楼栋楼长只可维护本人负责楼栋人员；管理人员用特殊颜色标识
 */
const Employees = {
  /**
   * 公开源码不携带生产组织架构中的负责人姓名。
   * 部署方可在本地数据中按实际组织架构维护楼栋负责人。
   */
  _buildingLeaders: [],

  // Public package uses neutral demo options. Configure real organization values locally.
  _regionOptions: ["区域A", "区域B"],
  _roomOptions: ["机房A", "机房B"],
  _buildingOptions: ["楼栋A", "楼栋B", "楼栋C"],
  _companyOptions: ["公司A", "公司B", "外包单位"],
  _personAttributes: ["属性A", "属性B"],
  _workAttributes: ["标准班次", "轮班"],
  _workPositions: ["岗位A", "岗位B", "岗位C", "主管", "工程师"],
  _departments: ["部门A", "部门B"],

  /** 判断是否为管理岗 */
  _isManager(position) {
    if (!position) return false;
    return position.includes('主管') || position.includes('值班长') || position.includes('经理') || position.includes('总监') || position.includes('区域经理');
  },

  /** 获取管理岗的职位标记 */
  _getManagerTag(position) {
    if (!position) return null;
    if (position.includes('主管')) return { label: '主管', color: '#8b5cf6' };
    if (position.includes('值班长')) return { label: '值班长', color: '#f59e0b' };
    if (position.includes('经理')) return { label: '经理', color: '#ec4899' };
    if (position.includes('总监')) return { label: '总监', color: '#ef4444' };
    return null;
  },

  /** 当前登录用户名（用于楼长识别） */
  _currentUserName() {
    var u = typeof Auth !== "undefined" && Auth.currentUser ? Auth.currentUser() : null;
    return u ? (u.name || "") : "";
  },

  /** 当前用户负责的楼栋 */
  _leaderBuildings() {
    return Auth.leaderBuildings();
  },

  _isFloorLeader() { return Auth.isLeader(); },

  /** 当前用户可见的人员（楼长只看本楼栋） */
  _visibleEmployees() {
    var all = Store.getEmployees();
    return all.filter(function (e) { return Auth.canAccessEmployee(e.id); });
  },

  _escape(v) {
    return String(v === undefined || v === null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  },

  _options(list, selected) {
    var self = this;
    return list.map(function (item) {
      return '<option value="' + self._escape(item) + '"' + (item === selected ? ' selected' : '') + '>' + self._escape(item) + '</option>';
    }).join('');
  },

  /** 头像底色（按姓名散列，与新版一致） */
  _avatarColor(name) {
    var palette = ["#6366f1","#3b82f6","#10b981","#f59e0b","#ef4444","#14b8a6","#ec4899","#8b5cf6","#06b6d4","#d97706"];
    if (!name) return palette[0];
    var hash = 0;
    for (var i = 0; i < name.length; i++) { hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0; }
    return palette[Math.abs(hash) % palette.length];
  },

  render(container) {
    if (!Auth.isAdmin() && !Auth.isLeader()) { App.navigate('profile'); return; }
    container.classList.add('employees-page');
    var self = this;
    var employees = this._visibleEmployees();
    var isLeader = this._isFloorLeader();
    var leaderBuildings = this._leaderBuildings();
    var showReminder = new Date().getDate() <= 10;
    var monthLogs = Store.getMonthUpdateLogs ? Store.getMonthUpdateLogs() : [];
    var lateCount = Store.getLateUpdateCount ? Store.getLateUpdateCount() : 0;

    var positions = Array.from(new Set(employees.map(function (e) { return e.position; }).filter(Boolean)));
    var buildings = Array.from(new Set(employees.map(function (e) { return e.building; }).filter(Boolean)));
    var companies = Array.from(new Set(employees.map(function (e) { return e.company; }).filter(Boolean)));

    var rows = employees.slice().sort(function (a, b) {
      var aMgr = self._isManager(a.position) ? 0 : 1;
      var bMgr = self._isManager(b.position) ? 0 : 1;
      return aMgr - bMgr || a.id - b.id;
    }).map(function (e, idx) { return self._renderRow(e, idx); }).join('');

    container.innerHTML = [
      // 操作按钮
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">',
        '<button class="btn btn-primary" onclick="Employees.showAddModal()">+ 添加人员</button>',
        '<button class="btn btn-outline" onclick="Employees.showImportModal()">📥 批量导入</button>',
        '<button class="btn btn-outline" onclick="Employees.downloadTemplate()">📄 生成模板</button>',
        isLeader ? '' : '<button class="btn btn-outline" onclick="Employees.clearAll()" style="color:#ef4444;border-color:#fecaca;">🗑️ 清空人员</button>',
      '</div>',

      // 更新提醒
      showReminder ? '<div style="display:flex;gap:10px;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:12px 16px;margin-bottom:12px;">' +
        '<span style="font-size:18px;">⚠️</span><div>' +
        '<div style="font-size:13px;font-weight:600;color:#92400e;">每栋楼长人员信息更新提醒</div>' +
        '<div style="font-size:12px;color:#b45309;margin-top:2px;">请各楼栋楼长在每月 10 日前完成本月入职、离职及人员信息更新。</div>' +
        '</div></div>' : '',
      monthLogs.length > 0 ? '<div style="display:flex;gap:10px;align-items:flex-start;background:' + (lateCount > 0 ? '#fffbeb' : '#ecfdf5') + ';border:1px solid ' + (lateCount > 0 ? '#fde68a' : '#a7f3d0') + ';border-radius:12px;padding:12px 16px;margin-bottom:12px;">' +
        '<span style="font-size:18px;">' + (lateCount > 0 ? '⚠️' : '✅') + '</span><div>' +
        '<div style="font-size:13px;font-weight:600;color:' + (lateCount > 0 ? '#92400e' : '#065f46') + ';">本月人员更新：' + monthLogs.length + ' 次</div>' +
        '<div style="font-size:12px;color:' + (lateCount > 0 ? '#b45309' : '#047857') + ';margin-top:2px;">其中逾期更新 ' + lateCount + ' 次（每月 10 号后更新计为逾期）</div>' +
        '</div></div>' : '',

      // 摘要
      '<div class="emp-stats" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px;">',
        '<div style="display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><span style="color:#64748b;font-size:12px;">总人数</span><strong style="font-size:24px;line-height:1;">' + employees.length + '</strong></div>',
        '<div style="display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><span style="color:#64748b;font-size:12px;">在职</span><strong style="font-size:24px;line-height:1;color:#059669;">' + employees.filter(function (e) { return e.status === '在职'; }).length + '</strong></div>',
        '<div style="display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><span style="color:#64748b;font-size:12px;">管理岗</span><strong style="font-size:24px;line-height:1;color:#8b5cf6;">' + employees.filter(function (e) { return self._isManager(e.position); }).length + '</strong></div>',
        '<div style="display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);"><span style="color:#64748b;font-size:12px;">离职</span><strong style="font-size:24px;line-height:1;color:#dc2626;">' + employees.filter(function (e) { return e.status === '离职'; }).length + '</strong></div>',
      '</div>',

      // 筛选工具条
      '<div class="emp-filters" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff;color:#1e3a8a;font-size:13px;font-weight:600;margin-bottom:16px;">',
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">',
          '<input type="text" class="form-control" id="empSearch" placeholder="搜索姓名" style="width:150px;" oninput="Employees.filter()">',
          '<select class="form-control" id="empFilterPosition" style="width:140px;" onchange="Employees.filter()"><option value="">全部职位</option>' + this._options(positions, '') + '</select>',
          '<select class="form-control" id="empFilterGender" style="width:110px;" onchange="Employees.filter()"><option value="">全部性别</option><option value="男">男</option><option value="女">女</option></select>',
          '<select class="form-control" id="empFilterStatus" style="width:120px;" onchange="Employees.filter()"><option value="">全部状态</option><option value="在职">在职</option><option value="离职">离职</option></select>',
          '<select class="form-control" id="empFilterBuilding" style="width:120px;" onchange="Employees.filter()"><option value="">全部楼栋</option>' + this._options(buildings, '') + '</select>',
          '<select class="form-control" id="empFilterCompany" style="width:140px;" onchange="Employees.filter()"><option value="">全部人员性质</option>' + this._options(companies, '') + '</select>',
          '<label style="display:flex;align-items:center;gap:4px;white-space:nowrap;font-weight:600;"><input type="checkbox" id="empFilterManager" onchange="Employees.filter()"> 只看管理岗</label>',
        '</div>',
        '<span style="white-space:nowrap;">大区：' + (this._regionOptions[0] || '区域A') + ' · 机房：' + (this._roomOptions[0] || '机房A') + (leaderBuildings.length ? ' · 负责楼栋：' + leaderBuildings.join('、') : '') + '</span>',
      '</div>',

      // 人员表
      '<div class="card emp-table-card" style="overflow:hidden;">',
        '<div class="card-body" style="padding:0;">',
          '<div class="table-responsive"><table>',
            '<thead><tr>',
              '<th style="width:56px;">编号</th>',
              '<th style="min-width:130px;">姓名</th>',
              '<th style="min-width:120px;">工作岗位</th>',
              '<th style="width:90px;">人员性质</th>',
              '<th style="width:56px;">性别</th>',
              '<th style="min-width:110px;">手机</th>',
              '<th style="width:80px;">状态</th>',
              '<th style="width:110px;">操作</th>',
            '</tr></thead>',
            '<tbody id="empTableBody">' + (rows || '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">👤</div><p>暂无人员</p></div></td></tr>') + '</tbody>',
          '</table></div>',
        '</div>',
      '</div>'
    ].join('');
  },

  /** 渲染单行 */
  _renderRow(e, index) {
    var self = this;
    var mgrTag = this._getManagerTag(e.position);
    var rowStyle = mgrTag ? ' style="background:' + mgrTag.color + '14;border-left:3px solid ' + mgrTag.color + ';"' : '';
    var nameColor = mgrTag ? ' style="color:' + mgrTag.color + ';font-weight:700;"' : '';
    var tagChip = mgrTag
      ? '<span style="font-size:10px;padding:1px 8px;border-radius:10px;background:' + mgrTag.color + '22;color:' + mgrTag.color + ';font-weight:600;">' + mgrTag.label + '</span>'
      : '';
    var statusCell = !e.status ? '<span style="font-size:12px;color:var(--text-light);">未填写</span>' : e.status === '离职'
      ? '<span class="tag tag-danger" style="font-size:11px;">离职</span>'
      : '<span class="tag tag-success" style="font-size:11px;">在职</span>';

    return '<tr class="emp-row"' + rowStyle +
      ' data-name="' + self._escape(e.name) + '" data-pos="' + self._escape(e.position) +
      '" data-id="' + e.id + '" data-gender="' + self._escape(e.gender) + '" data-status="' + self._escape(e.status) +
      '" data-building="' + self._escape(e.building) + '" data-company="' + self._escape(e.company) + '">' +
      '<td style="font-size:12px;color:var(--text-light);">' + String(index + 1).padStart(3, '0') + '</td>' +
      '<td>' +
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
          '<span style="display:grid;flex:0 0 30px;width:30px;height:30px;place-items:center;border-radius:8px;color:#fff;font-size:13px;font-weight:700;background:' + self._avatarColor(e.name) + ';">' + self._escape((e.name || '?').charAt(0)) + '</span>' +
          '<div style="display:flex;align-items:center;gap:6px;min-width:0;">' +
            '<strong' + nameColor + ' style="overflow:hidden;max-width:90px;text-overflow:ellipsis;white-space:nowrap;">' + self._escape(e.name) + '</strong>' + tagChip +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td style="font-size:13px;">' + (self._escape(e.position) || '-') + '</td>' +
      '<td style="font-size:12px;">' + (self._escape(e.company) || '-') + '</td>' +
      '<td>' + (self._escape(e.gender) || '-') + '</td>' +
      '<td style="font-size:13px;">' + (self._escape(e.phone) || '-') + '</td>' +
      '<td>' + statusCell + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<a href="javascript:;" style="color:#2563eb;font-size:13px;margin-right:10px;" onclick="Employees.showEditModal(' + e.id + ')">编辑</a>' +
        '<a href="javascript:;" style="color:#dc2626;font-size:13px;" onclick="Employees.delete(' + e.id + ')">删除</a>' +
      '</td>' +
      '</tr>';
  },
  /** 搜索与筛选 */
  filter() {
    var el = function (id) { return document.getElementById(id); };
    var val = function (id) { return el(id) ? el(id).value : ''; };
    var keyword = (val('empSearch') || '').toLowerCase().trim();
    var position = val('empFilterPosition');
    var gender = val('empFilterGender');
    var status = val('empFilterStatus');
    var building = val('empFilterBuilding');
    var company = val('empFilterCompany');
    var managerOnly = !!(el('empFilterManager') && el('empFilterManager').checked);
    var self = this;

    document.querySelectorAll('.emp-row').forEach(function (row) {
      var name = (row.dataset.name || '').toLowerCase();
      var pos = (row.dataset.pos || '').toLowerCase();
      var match = (!keyword || name.indexOf(keyword) >= 0 || pos.indexOf(keyword) >= 0)
        && (!position || row.dataset.pos === position)
        && (!gender || row.dataset.gender === gender)
        && (!status || row.dataset.status === status)
        && (!building || row.dataset.building === building)
        && (!company || row.dataset.company === company)
        && (!managerOnly || self._isManager(row.dataset.pos));
      row.style.display = match ? '' : 'none';
    });

    // 单人表布局：无需再按部门卡片收敛显示
  },

  /** 表单 HTML（新增 / 编辑共用） */
  _formHtml(emp, options) {
    var s = this;
    var e = emp || {};
    var opts = options || {};
    var isEdit = !!emp;
    var personal = opts.registration || (!Auth.isAdmin() && !Auth.isLeader());
    var registeredPhone = !opts.registration && e.registrationSource === 'phone';
    var buildingOptions = Auth.isLeader() ? Auth.leaderBuildings() : s._buildingOptions;
    var optional = function (list, selected) {
      var values = list.slice();
      if (selected && values.indexOf(selected) < 0) values.push(selected);
      return '<option value=""' + (!selected ? ' selected' : '') + '>暂不填写</option>' + s._options(values, selected);
    };
    return `
      <div class="form-row">
        <div class="form-group"><label for="empName">姓名 *</label>
          <input type="text" class="form-control" id="empName" value="${s._escape(e.name)}" placeholder="请输入姓名" required maxlength="80" autocomplete="name"></div>
        <div class="form-group"><label for="empGender">性别</label>
          <select class="form-control" id="empGender">
            <option value="男"${e.gender !== '女' ? ' selected' : ''}>男</option>
            <option value="女"${e.gender === '女' ? ' selected' : ''}>女</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empPosition">工作岗位</label>
          <select class="form-control" id="empPosition">${s._options(s._workPositions, e.position)}</select></div>
        <div class="form-group"><label for="empCompany">人员性质（选填）</label>
          <select class="form-control" id="empCompany">${optional(s._companyOptions, e.company)}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empPersonAttribute">人员属性（选填）</label>
          <select class="form-control" id="empPersonAttribute">${optional(s._personAttributes, e.personAttribute)}</select></div>
        <div class="form-group"><label for="empWorkAttribute">工作属性（选填）</label>
          <select class="form-control" id="empWorkAttribute">${optional(s._workAttributes, e.workAttribute)}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empDepartment">部门（选填）</label>
          <select class="form-control" id="empDepartment">${optional(s._departments, e.department)}</select></div>
        <div class="form-group"><label for="empStatus">状态（选填）</label>
          <select class="form-control" id="empStatus">
            <option value=""${!e.status ? ' selected' : ''}>暂不填写</option>
            <option value="在职"${e.status === '在职' ? ' selected' : ''}>在职</option>
            <option value="离职"${e.status === '离职' ? ' selected' : ''}>离职</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empRegion">区域</label>
          <select class="form-control" id="empRegion">${s._options(s._regionOptions, e.region || '区域A')}</select></div>
        <div class="form-group"><label for="empRoom">机房</label>
          <select class="form-control" id="empRoom">${s._options(s._roomOptions, e.room || '机房A')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empBuilding">楼栋（选填）</label>
          <select class="form-control" id="empBuilding">${optional(buildingOptions, e.building)}</select></div>
        <div class="form-group"><label for="empPhone">手机号${opts.registration ? ' *（登录账号）' : ''}</label>
          <input type="tel" class="form-control" id="empPhone" value="${s._escape(e.phone)}" placeholder="请输入11位手机号" inputmode="tel" maxlength="11" autocomplete="tel" ${opts.registration ? 'required pattern="1[3-9][0-9]{9}"' : ''} ${!opts.registration && (personal || registeredPhone) ? 'readonly aria-readonly="true"' : ''}>
          ${registeredPhone ? '<small style="display:block;margin-top:6px;color:var(--text-light);font-size:12px;">登录号码请联系管理员在账号维护中处理。</small>' : ''}</div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empEmail">邮箱</label>
          <input type="email" class="form-control" id="empEmail" value="${s._escape(e.email)}" placeholder="请输入邮箱"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="empJoinDate">入职日期</label>
          <input type="date" class="form-control" id="empJoinDate" value="${s._escape(e.joinDate || new Date().toISOString().slice(0, 10))}"></div>
        <div class="form-group"><label for="empLeaveDate">离职日期</label>
          <input type="date" class="form-control" id="empLeaveDate" value="${s._escape(e.leaveDate)}"></div>
      </div>

      <hr style="margin:14px 0;">
      <div class="form-group"><label for="empResume">简历附件</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="file" id="empResume" style="display:none;" accept=".pdf,.doc,.docx,.txt" onchange="Employees.pickResume(event)">
          <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('empResume').click()">选择文件</button>
          <button type="button" class="btn btn-outline btn-sm" id="empResumeDownload" style="display:none;" onclick="Employees.downloadPendingResume()">下载</button>
          <button type="button" class="btn btn-danger btn-sm" id="empResumeClear" style="display:none;" onclick="Employees.clearPendingResume()">删除</button>
          <span style="font-size:12px;color:#64748b;" id="empResumeName">${e.resumeName ? '已上传: ' + s._escape(e.resumeName) : '未上传简历'}</span>
        </div></div>
      <div class="form-group"><label for="empCredential">证件上传</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="file" id="empCredential" style="display:none;" accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png" onchange="Employees.pickCredential(event)">
          <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('empCredential').click()">选择文件</button>
          <button type="button" class="btn btn-outline btn-sm" id="empCredentialDownload" style="display:none;" onclick="Employees.downloadPendingCredential()">下载</button>
          <button type="button" class="btn btn-danger btn-sm" id="empCredentialClear" style="display:none;" onclick="Employees.clearPendingCredential()">删除</button>
          <span style="font-size:12px;color:#64748b;" id="empCredentialName">${e.credentialName ? '已上传: ' + s._escape(e.credentialName) : '未上传证件'}</span>
        </div></div>
      <div class="form-group"><label for="empAiProfile">人员简介</label>
        ${Auth.isAdmin() && !opts.registration ? '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">' +
          '<button type="button" class="btn btn-info btn-sm" onclick="Employees.autoGenerateProfile()">🤖 AI 自动生成简介</button>' +
          '<span style="font-size:11px;color:#94a3b8;">上传简历后自动识别并生成重要技能简介</span></div>' : ''}
        <textarea class="form-control" id="empAiProfile" rows="3" placeholder="填写工作经历、技能或其他个人信息">${s._escape(e.aiProfile)}</textarea>
      </div>
      ${isEdit ? '<input type="hidden" id="empId" value="' + e.id + '">' : ''}
    `;
  },

  /* ===== 待上传附件缓存 ===== */
  _pendingResume: null,
  _pendingCredential: null,
  _resumeText: '',

  showAddModal() {
    if (!Auth.isAdmin() && !Auth.isLeader()) { App.toast('仅管理员或楼长可添加人员', 'warning'); return; }
    var self = this;
    this._editReturnPage = 'employees';
    this._pendingResume = { data: '', name: '' };
    this._pendingCredential = { data: '', name: '' };
    this._resumeText = '';
    App.openModal('添加人员', this._formHtml(null),
      '<button class="btn btn-primary" onclick="Employees.save()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
    setTimeout(function () { self._syncAttachmentButtons(); }, 50);
  },

  showEditModal(id, returnPage) {
    var self = this;
    var emp = Store.getEmployees().find(function (e) { return e.id === id; });
    if (!emp) return;
    if (!Auth.canManageEmployee(id)) { App.toast('无权维护此人员', 'warning'); return; }
    this._editReturnPage = returnPage || (App.currentPage === 'profile' ? 'profile' : 'employees');
    this._pendingResume = { data: emp.resumeData || '', name: emp.resumeName || '' };
    this._pendingCredential = { data: emp.credentialData || '', name: emp.credentialName || '' };
    this._resumeText = '';
    App.openModal(this._editReturnPage === 'profile' ? '维护我的资料' : '编辑人员', this._formHtml(emp),
      '<button class="btn btn-primary" onclick="Employees.save()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
    setTimeout(function () { self._syncAttachmentButtons(); }, 50);
  },

  _syncAttachmentButtons() {
    var r = this._pendingResume || { data: '', name: '' };
    var c = this._pendingCredential || { data: '', name: '' };
    var rd = document.getElementById('empResumeDownload');
    var rc = document.getElementById('empResumeClear');
    if (rd) rd.style.display = r.data ? '' : 'none';
    if (rc) rc.style.display = r.data ? '' : 'none';
    var cd = document.getElementById('empCredentialDownload');
    var cc = document.getElementById('empCredentialClear');
    if (cd) cd.style.display = c.data ? '' : 'none';
    if (cc) cc.style.display = c.data ? '' : 'none';
  },

  pickResume(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { App.toast('附件请控制在3MB以内', 'warning'); ev.target.value = ''; return; }
    var self = this;
    var reader = new FileReader();
    reader.onload = function (e2) {
      self._pendingResume = { data: String(e2.target.result || ''), name: file.name };
      var label = document.getElementById('empResumeName');
      if (label) label.textContent = '已上传: ' + file.name;
      self._syncAttachmentButtons();
      if (Auth.isAdmin()) self._extractResumeText(file);
    };
    reader.readAsDataURL(file);
    ev.target.value = '';
  },

  pickCredential(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { App.toast('附件请控制在3MB以内', 'warning'); ev.target.value = ''; return; }
    var self = this;
    var reader = new FileReader();
    reader.onload = function (e2) {
      self._pendingCredential = { data: String(e2.target.result || ''), name: file.name };
      var label = document.getElementById('empCredentialName');
      if (label) label.textContent = '已上传: ' + file.name;
      self._syncAttachmentButtons();
    };
    reader.readAsDataURL(file);
    ev.target.value = '';
  },

  /** 读取简历文本（txt / docx 提取，pdf、doc 兜底） */
  _extractResumeText(file) {
    var self = this;
    var name = (file.name || '').toLowerCase();
    var reader = new FileReader();
    reader.onload = function (e) {
      var buf = e.target.result;
      var done = function (text) {
        self._resumeText = (text || '').trim();
        if (self._resumeText.length >= 10) {
          App.toast('简历已读取，正在生成 AI 简介...', 'info');
          self.autoGenerateProfile();
        } else {
          App.toast('无法自动读取附件文本，可手动粘贴到 AI 简介', 'warning');
        }
      };
      try {
        if (name.indexOf('.docx') >= 0) {
          self._extractDocx(buf, done);
        } else {
          done(self._cleanText(new TextDecoder('utf-8').decode(new Uint8Array(buf))));
        }
      } catch (ex) { done(''); }
    };
    reader.readAsArrayBuffer(file);
  },

  _cleanText(t) {
    if (!t) return '';
    t = String(t).replace(/[^\x20-\x7E\u4e00-\u9FFF\u3000-\u303F\uFF00-\uFFEF\r\n\t]/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  },

  /** 解析 docx（zip → word/document.xml） */
  _extractDocx(buf, cb) {
    var self = this;
    var bytes = new Uint8Array(buf);
    var view = new DataView(buf);
    var i = 0, entries = [];
    while (i + 30 <= bytes.length) {
      if (view.getUint32(i, true) !== 0x04034b50) break;
      var method = view.getUint16(i + 8, true);
      var compSize = view.getUint32(i + 18, true);
      var nameLen = view.getUint16(i + 26, true);
      var extraLen = view.getUint16(i + 28, true);
      var entryName = new TextDecoder('utf-8').decode(bytes.subarray(i + 30, i + 30 + nameLen));
      var dataStart = i + 30 + nameLen + extraLen;
      entries.push({ name: entryName, method: method, start: dataStart, end: dataStart + compSize });
      i = dataStart + compSize;
    }
    var doc = null;
    for (var j = 0; j < entries.length; j++) {
      if (entries[j].name === 'word/document.xml') { doc = entries[j]; break; }
    }
    if (!doc) { cb(''); return; }
    var data = bytes.subarray(doc.start, doc.end);
    var stripXml = function (xml) {
      if (!xml) return '';
      xml = xml.replace(/<[^>]+>/g, ' ');
      xml = xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
      return self._cleanText(xml);
    };
    if (doc.method === 0) { cb(stripXml(new TextDecoder('utf-8').decode(data))); return; }
    if (typeof DecompressionStream === 'undefined') { cb(''); return; }
    try {
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      stream.arrayBuffer().then(function (ab) {
        cb(stripXml(new TextDecoder('utf-8').decode(new Uint8Array(ab))));
      }).catch(function () { cb(''); });
    } catch (ex) { cb(''); }
  },

  downloadPendingResume() {
    var r = this._pendingResume;
    if (!r || !r.data) return;
    var a = document.createElement('a');
    a.href = r.data; a.download = r.name || 'resume'; a.click();
  },

  clearPendingResume() {
    this._pendingResume = { data: '', name: '' };
    var label = document.getElementById('empResumeName');
    if (label) label.textContent = '未上传简历';
    this._syncAttachmentButtons();
  },

  downloadPendingCredential() {
    var c = this._pendingCredential;
    if (!c || !c.data) return;
    var a = document.createElement('a');
    a.href = c.data; a.download = c.name || 'credential'; a.click();
  },

  clearPendingCredential() {
    this._pendingCredential = { data: '', name: '' };
    var label = document.getElementById('empCredentialName');
    if (label) label.textContent = '未上传证件';
    this._syncAttachmentButtons();
  },

  /** AI 自动生成人员简介（上传简历后自动触发，也可手动点击） */
  autoGenerateProfile() {
    if (!Auth.isAdmin()) { App.toast('仅管理员可使用 AI 分析', 'warning'); return; }
    var text = this._resumeText;
    if (!text || text.trim().length < 10) {
      App.toast('请先上传可读取文本的简历', 'warning');
      return;
    }
    var cfg = (typeof AI !== 'undefined' && AI.getConfig) ? AI.getConfig() : null;
    var endpoint = (cfg && cfg.endpoint) ? cfg.endpoint : (window.location.protocol + '//' + window.location.hostname + ':11434/v1/chat/completions');
    var model = (cfg && cfg.model) ? cfg.model : 'mock-ai';
    var headers = { 'Content-Type': 'application/json' };
    if (cfg && cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
    App.toast('AI 正在分析简历...', 'info');
    var prompt = '你是专业HR分析师，请根据简历内容生成约100字的人员简介，重点提炼重要技能、技术栈和工作背景。\n\n简历：\n' + text.slice(0, 6000);
    fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], max_tokens: 512, temperature: 0.7, stream: false })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var reply = (d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '') || d.response || '';
        var ta = document.getElementById('empAiProfile');
        if (reply && ta) ta.value = reply;
        App.toast(reply ? 'AI 简介已自动生成' : 'AI 未返回内容，请检查 AI 配置', reply ? 'success' : 'warning');
      })
      .catch(function () { App.toast('AI 请求失败：请先在 AI 问答中配置可访问的 API 地址和模型', 'error'); });
  },

  readFormData() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var name = g('empName').trim();
    var building = g('empBuilding');
    var position = g('empPosition');
    var data = {
      name: name,
      gender: g('empGender'),
      position: position,
      company: g('empCompany'),
      personAttribute: g('empPersonAttribute'),
      workAttribute: g('empWorkAttribute'),
      department: g('empDepartment'),
      status: g('empStatus'),
      region: g('empRegion'),
      room: g('empRoom'),
      building: building,
      phone: g('empPhone').trim(),
      email: g('empEmail').trim(),
      joinDate: g('empJoinDate'),
      leaveDate: g('empLeaveDate'),
      aiProfile: g('empAiProfile').trim()
    };
    if (this._pendingResume && this._pendingResume.data) {
      data.resumeData = this._pendingResume.data;
      data.resumeName = this._pendingResume.name;
    } else {
      data.resumeData = '';
      data.resumeName = '';
    }
    if (this._pendingCredential && this._pendingCredential.data) {
      data.credentialData = this._pendingCredential.data;
      data.credentialName = this._pendingCredential.name;
    } else {
      data.credentialData = '';
      data.credentialName = '';
    }

    return data;
  },

  async save() {
    if (this._saving) return;
    var idEl = document.getElementById('empId');
    var id = idEl ? Number(idEl.value) : null;
    if (id ? !Auth.canManageEmployee(id) : (!Auth.isAdmin() && !Auth.isLeader())) {
      App.toast('无权维护此人员', 'error'); return;
    }
    var data = this.readFormData();
    if (!data.name) { App.toast('请输入姓名', 'error'); return; }
    if (data.phone && !/^1[3-9]\d{9}$/.test(data.phone)) { App.toast('请输入有效的11位手机号', 'error'); return; }
    var emailInput = document.getElementById('empEmail');
    if (emailInput && !emailInput.checkValidity()) { emailInput.reportValidity(); return; }
    if (data.joinDate && data.leaveDate && data.leaveDate < data.joinDate) { App.toast('离职日期不能早于入职日期', 'error'); return; }
    if (Auth.isLeader() && this._leaderBuildings().indexOf(data.building) < 0) {
      App.toast('请选择本人负责的楼栋', 'warning'); return;
    }
    if (!Auth.isAdmin() && !Auth.isLeader()) {
      var original = Store.getEmployees().find(function(e) { return e.id === id; });
      data.phone = original ? original.phone : Auth.currentUser().phone;
    }
    this._saving = true;
    var saveButton = document.querySelector('#modalFooter .btn-primary');
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = '保存中…'; }
    try {
      if (id) Store.updateEmployee(id, data);
      else Store.addEmployee(data);
      await Store.flushServerSync();
      App.toast(id ? '人员信息已更新' : '人员添加成功', 'success');
      App.closeModal();
      App.navigate(this._editReturnPage || 'employees');
    } catch (error) {
      App.toast(error.message || '保存失败，请重试', 'error');
    } finally {
      this._saving = false;
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = '保存'; }
    }
  },

  async delete(id) {
    if (!Auth.isAdmin() && !Auth.isLeader()) { App.toast('无权删除人员', 'warning'); return; }
    var emp = Store.getEmployees().find(function (e) { return e.id === id; });
    if (!emp) return;
    if (this._isFloorLeader() && this._leaderBuildings().indexOf(emp.building || '') < 0) {
      App.toast('只能维护本楼栋人员', 'warning');
      return;
    }
    if (App.confirm('确定要删除「' + emp.name + '」吗？\n相关考勤、请假和加班记录也会同步删除。')) {
      try {
        Store.deleteEmployee(id);
        await Store.flushServerSync();
        App.toast('已删除', 'info');
        App.navigate('employees');
      } catch (error) { App.toast(error.message || '删除失败，请重试', 'error'); }
    }
  },

  async clearAll() {
    if (!Auth.isAdmin()) { App.toast('仅管理员可清空全部人员', 'warning'); return; }
    if (!App.confirm('确定清空全部人员信息？关联的考勤、请假、加班和绩效记录也会一并清空。')) return;
    try {
      Store.clearEmployees();
      await Store.flushServerSync();
      App.toast('人员信息已清空', 'info');
      App.navigate('employees');
    } catch (error) { App.toast(error.message || '清空失败，请重试', 'error'); }
  },

  /** 生成批量导入模板 */
  downloadTemplate() {
    var text = '姓名,性别,工作岗位,人员性质,人员属性,工作属性,月薪,手机,邮箱,区域,机房,楼栋,状态,入职日期,离职日期\n' +
      '示例员工,男,岗位A,公司A,属性A,标准班次,,13800000000,example@example.com,区域A,机房A,楼栋A,在职,2026-01-01,\n';
    var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '人员批量导入模板.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  },

  /** 批量导入弹窗 */
  showImportModal() {
    if (!Auth.isAdmin() && !Auth.isLeader()) { App.toast('无权导入人员', 'warning'); return; }
    App.openModal('批量导入人员',
      '<div class="form-group"><label>选择文件（CSV / Excel）</label>' +
      '<input type="file" id="importFileInput" accept=".csv,.xlsx,.xls" onchange="Employees.importFile(event)" style="display:block;margin-bottom:12px;">' +
      '<p style="font-size:12px;color:var(--text-light);">列顺序：姓名,性别,工作岗位,人员性质,人员属性,工作属性,月薪,手机,邮箱,区域,机房,楼栋,状态,入职日期,离职日期</p></div>',
      '<button class="btn btn-outline" onclick="Employees.downloadTemplate()">下载模板</button>' +
      '<button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  /** 导入文件（CSV / Excel） */
  importFile(ev) {
    if (!Auth.isAdmin() && !Auth.isLeader()) { App.toast('无权导入人员', 'warning'); return; }
    var file = ev.target.files[0];
    if (!file) return;
    var name = file.name.toLowerCase();
    var self = this;
    if (name.indexOf('.xls') >= 0) {
      var r = new FileReader();
      r.onload = function (e) {
        try {
          var d = new Uint8Array(e.target.result);
          var wb = XLSX.read(d, { type: 'array' });
          var s = wb.Sheets[wb.SheetNames[0]];
          self._parseImportRows(XLSX.utils.sheet_to_json(s, { header: 1, defval: '' }));
        } catch (ex) { App.toast('文件解析失败', 'error'); }
      };
      r.readAsArrayBuffer(file);
    } else {
      var r2 = new FileReader();
      r2.onload = function (e) {
        var text = String(e.target.result || '').replace(/^\uFEFF/, '');
        var rows = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).map(function (l) { return self._csvLine(l); });
        self._parseImportRows(rows);
      };
      r2.readAsText(file);
    }
  },

  /** 解析导入数据 */
  async _parseImportRows(rows) {
    if (!Auth.isAdmin() && !Auth.isLeader()) { App.toast('无权导入人员', 'warning'); return; }
    if (!rows || rows.length < 2) { App.toast('数据不足，第一行为表头', 'error'); return; }
    var leaders = this._leaderBuildings();
    var emps = Store.getEmployees();
    var added = 0, skipped = 0;
    for (var i = 1; i < rows.length; i++) {
      var cols = (rows[i] || []).map(function (c) { return String(c === undefined || c === null ? '' : c).trim(); });
      var name = cols[0];
      if (!name) continue;
      var building = cols[11] || '';
      if (Auth.isLeader() && leaders.indexOf(building) < 0) { skipped++; continue; }
      if (emps.some(function (e) { return e.name === name; })) { skipped++; continue; }
      Store.addEmployee({
        name: name,
        gender: cols[1] || '男',
        position: cols[2] || '',
        company: cols[3] || '',
        personAttribute: cols[4] || '',
        workAttribute: cols[5] || '',
        phone: cols[7] || '',
        email: cols[8] || '',
        region: cols[9] || '区域A',
        room: cols[10] || '机房A',
        building: building,
        status: cols[12] || '',
        joinDate: cols[13] || App.today(),
        leaveDate: cols[14] || ''
      });
      added++;
    }
    try {
      await Store.flushServerSync();
      App.closeModal();
      App.toast('导入完成：新增 ' + added + ' 人' + (skipped > 0 ? '，跳过 ' + skipped + ' 人' : ''), 'success');
      App.navigate('employees');
    } catch (error) { App.toast(error.message || '导入失败，请重试', 'error'); }
  },

  _csvLine(l) {
    var r = [], c = '', q = false;
    for (var i = 0; i < l.length; i++) {
      var ch = l[i];
      if (ch === '"') { q = !q; }
      else if (ch === ',' && !q) { r.push(c); c = ''; }
      else { c += ch; }
    }
    r.push(c);
    return r;
  }
};
