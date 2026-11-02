/**
 * 组织架构管理模块
 */
const Org = {
  _positionGroups: {
    "交付运维主管": { group: "主管",    icon: "⭐",  order: 0 },
    "设施运维主管": { group: "主管",    icon: "⭐",  order: 0 },
    "设施运维值班长": { group: "值班长",  icon: "⭐",  order: 1 },
    "高级交付运维工程师": { group: "高级工程师", icon: "🔬", order: 2 },
    "交付运维工程师":     { group: "工程师",   icon: "🔧", order: 3 },
    "设施运维工程师":     { group: "工程师",   icon: "🔧", order: 3 },
    "交付运维值班工程师":  { group: "值班工程师",icon: "🛠️", order: 4 },
    "设施运维值班工程师":  { group: "值班工程师",icon: "🛠️", order: 4 },
    "交付运维工程师-网银专职": { group: "网银专职", icon: "💳", order: 5 },
    "ǰ̨":             { group: "ǰ̨",    icon: "💁", order: 6 },
    "区域经理": { group: "区域经理", icon: "⭐", order: -2 },
    "区域总监": { group: "区域总监", icon: "⭐", order: -3 },
  },

  _getGroupInfo(position) {
    return this._positionGroups[position] || { group: "其他", icon: "👤", order: 99 };
  },

  render(container) {
    var tree = Store.getOrgStructure();
    var allEmps = Store.getEmployees();
    var total = allEmps.length;
    var mgrHtml = this._renderManagementChain(tree);
    var deptSections = this._renderDeptSections(allEmps);
    container.innerHTML =
      '<!-- org-chart -->' +
      '<div class="org-wrap">' +
        '<div class="org-topbar">' +
          '<div class="org-title">🏗️ 组织架构<span class="org-subtitle">共 ' + total + ' 人</span></div>' +
          '<div class="org-actions">' +
            '<button class="btn btn-outline btn-sm" onclick="Org.showEditCompanyForm()">✏️ 名称</button>' +
            '<button class="btn btn-primary btn-sm" onclick="Org.showAddForm()">+ 部门</button>' +
            '<button class="btn btn-outline btn-sm" onclick="Org.exportOrg()">📋 导出</button>' +
          '</div>' +
        '</div>' +
        (mgrHtml ? '<div class="org-mgr-wrap"><div class="org-mgr-label">管理层</div><div class="org-mgr-row">' + mgrHtml + '</div></div>' : '') +
        '<div class="org-dept-row">' + deptSections + '</div>' +
      '</div>';
  },

  _renderManagementChain(tree) {
    var mgrNodes = [];
    var walk = function(node) {
      if (node.type === "position") mgrNodes.push(node);
      if (node.children) { for (var i = 0; i < node.children.length; i++) walk(node.children[i]); }
    };
    walk(tree);
    if (mgrNodes.length === 0) return "";
    var allEmps = Store.getEmployees();
    var html = "";
    for (var i = 0; i < mgrNodes.length; i++) {
      var node = mgrNodes[i];
      var posEmp = allEmps.find(function(e){ return node.name.indexOf(e.name) >= 0; });
      var posName = posEmp ? posEmp.position : "";
      var icon = node.name.indexOf("总监") >= 0 ? "👑" : "⭐";
      html +=
        '<div class="mgr-card">' +
          '<div class="mgr-icon">' + icon + '</div>' +
          '<div class="mgr-body">' +
            '<div class="mgr-name">' + this._escapeHtml(node.name) + '</div>' +
            '<div class="mgr-role">' + this._escapeHtml(posName) + '</div>' +
          '</div>' +
        '</div>';
      if (i < mgrNodes.length - 1) { html += '<div class="mgr-arr">▸</div>'; }
    }
    return html;
  },

  _renderDeptSections(allEmps) {
    if (!allEmps || allEmps.length === 0) return "";
    var deptNames = Store.getDepartments();
    var empDepts = {};
    for (var i = 0; i < allEmps.length; i++) { var d = allEmps[i].department; if (d) empDepts[d] = 1; }
    var allDepts = [];
    for (var j = 0; j < deptNames.length; j++) { if (allDepts.indexOf(deptNames[j]) < 0) allDepts.push(deptNames[j]); }
    for (var dk in empDepts) { if (allDepts.indexOf(dk) < 0) allDepts.push(dk); }
    if (allDepts.length === 0) return "";
    var nonMgrs = allEmps.filter(function(e){ return e.position !== "区域经理" && e.position !== "区域总监"; });
    if (nonMgrs.length === 0) return "";
    var colors = ["#7c3aed","#2563eb","#059669","#d97706","#dc2626","#0d9488","#db2777","#4338ca","#0891b2","#b45309"];
    var deptAccents = {"交付运维部": "#3b82f6", "设施运维部": "#10b981"};
    var deptIcons = {"交付运维部": "🔧", "设施运维部": "⚡"};
    var html = "";
    for (var d = 0; d < allDepts.length; d++) {
      var deptName = allDepts[d];
      var deptEmps = nonMgrs.filter(function(e){ return e.department === deptName; });
      if (deptEmps.length === 0) continue;
      var groups = {};
      for (var e = 0; e < deptEmps.length; e++) {
        var emp = deptEmps[e];
        var info = this._getGroupInfo(emp.position);
        var key = info.group;
        if (!groups[key]) groups[key] = { group: key, icon: info.icon, order: info.order, members: [] };
        groups[key].members.push(emp);
      }
      var sorted = [];
      for (var k in groups) sorted.push(groups[k]);
      sorted.sort(function(a,b){ return a.order - b.order; });
      var accent = deptAccents[deptName] || "#6366f1";
      var icon = deptIcons[deptName] || "📁";
      html += '<div class="dept-card">' +
        '<div class="dept-hd" style="border-left:3px solid ' + accent + ';">' +
          '<span class="dept-hd-icon">' + icon + '</span>' +
          '<span class="dept-hd-name">' + this._escapeHtml(deptName) + '</span>' +
          '<span class="dept-hd-count">' + deptEmps.length + '人</span>' +
        '</div>' +
        '<div class="dept-bd">';
      for (var g = 0; g < sorted.length; g++) {
        var group = sorted[g];
        group.members.sort(function(a,b){ return a.name.localeCompare(b.name); });
        var ci = Math.abs(this._hashCode(group.group)) % colors.length;
        var empHtml = "";
        for (var m = 0; m < group.members.length; m++) {
          var emp = group.members[m];
          var ec = this._getAvatarColor(emp.name);
          var init = emp.name ? emp.name.charAt(0) : "?";
          empHtml +=
            '<div class="org-emp" onclick="Org.showPersonDetail(' + emp.id + ')">' +
              '<div class="org-av" style="background:' + ec + ';">' + init + '</div>' +
              '<div class="org-ei">' +
                '<div class="org-en">' + this._escapeHtml(emp.name) + '</div>' +
                '<div class="org-ep">' + this._escapeHtml(emp.position || "") + '</div>' +
              '</div>' +
              (emp.company ? '<span class="org-co">' + this._escapeHtml(emp.company) + '</span>' : "") +
            '</div>';
        }
        html += '<div class="pos-card">' +
          '<div class="pos-hd" style="background:' + colors[ci] + ';">' +
            '<span class="pos-ic">' + group.icon + '</span>' +
            '<span class="pos-tl">' + this._escapeHtml(group.group) + '</span>' +
            '<span class="pos-cn">' + group.members.length + '</span>' +
          '</div>' +
          '<div class="pos-bd">' + empHtml + '</div>' +
        '</div>';
      }
      html += '</div></div>';
    }
    return html;
  },

  _hashCode(str) {
    if (!str) return 0;
    var hash = 0;
    for (var i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
    return hash;
  },

  _getAvatarColor(name) {
    if (!name) return "#6366f1";
    var pals = ["#6366f1","#3b82f6","#10b981","#f59e0b","#ef4444","#14b8a6","#ec4899","#8b5cf6","#06b6d4","#d97706"];
    var hash = 0;
    for (var i = 0; i < name.length; i++) { hash = ((hash << 5) - hash) + name.charCodeAt(i); hash |= 0; }
    return pals[Math.abs(hash) % pals.length];
  },

  showPersonDetail(id) {
    var emp = Store.getEmployees().find(function(e){ return e.id === id; });
    if (!emp) return;
    var info = this._getGroupInfo(emp.position);
    var isMgr = info.order <= 1;
    var color = this._getAvatarColor(emp.name);
    var initial = emp.name ? emp.name.charAt(0) : "?";
    var rows = "";
    var fields = {"部门": emp.department, "职位": emp.position, "公司": emp.company, "手机": emp.phone, "性别": emp.gender, "入职": App.formatDate(emp.joinDate)};
    for (var key in fields) {
      var val = fields[key] || "-";
      rows += '<div class="org-dr"><span class="org-dl">' + key + '</span><span class="org-dv">' + this._escapeHtml(String(val)) + '</span></div>';
    }
    App.openModal("人员详情",
      '<div style="text-align:center;padding:16px 0;">' +
        '<div class="org-av" style="width:56px;height:56px;font-size:22px;margin:0 auto 12px;background:' + color + ';">' + initial + '</div>' +
        '<h2 style="font-size:20px;font-weight:700;margin:0 0 4px;">' + this._escapeHtml(emp.name) + '</h2>' +
        '<span class="tag ' + (isMgr ? "tag-warning" : "tag-primary") + '">' + this._escapeHtml(emp.position || "员工") + '</span>' +
      '</div>' +
      '<div class="org-dt">' + rows + '</div>',
      '<button class="btn btn-outline" onclick="App.closeModal()">关闭</button>'
    );
  },

  /* ===== 以下保持原有功能不变 ===== */
  showAddChildFormByName(deptName) {
    var tree = Store.getOrgStructure();
    var find = function(node) {
      if (node.name === deptName && node.type === "department") return node;
      if (node.children) { for (var i=0;i<node.children.length;i++) { var f=find(node.children[i]); if(f) return f; } }
      return null;
    };
    var deptNode = find(tree);
    if (deptNode) Org.showAddChildForm(deptNode.id);
    else App.toast("未找到部门节点", "error");
  },

  showAddChildForm(parentId) {
    var tree = Store.getOrgStructure();
    var parent = Store._findNodeById(tree, parentId);
    if (!parent) return;
    App.openModal("添加子部门",
      '<p style="margin-bottom:12px;font-size:14px;color:var(--text-light);">上级：<strong>' + this._escapeHtml(parent.name) + '</strong></p>' +
      '<div class="form-group"><label>名称 *</label><input type="text" class="form-control" id="orgNodeName" placeholder="请输入名称"></div>' +
      '<div class="form-group"><label>类型</label><select class="form-control" id="orgNodeType"><option value="team">团队/小组</option><option value="department">部门</option></select></div>' +
      '<input type="hidden" id="orgParentId" value="' + parentId + '">',
      '<button class="btn btn-primary" onclick="Org.saveNode()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  showAddForm() {
    App.openModal("添加部门",
      '<div class="form-group"><label>部门名称 *</label><input type="text" class="form-control" id="orgNodeName" placeholder="请输入部门名称"></div>' +
      '<div class="form-group"><label>上级部门</label><select class="form-control" id="orgParentId">' + this._getParentOptions() + '</select></div>',
      '<button class="btn btn-primary" onclick="Org.saveNode()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  _getParentOptions() {
    var tree = Store.getOrgStructure();
    var opts = ['<option value="' + tree.id + '">' + this._escapeHtml(tree.name) + '（顶级）</option>'];
    var flatten = function(node) {
      if (node.children) { node.children.forEach(function(c){opts.push('<option value="'+c.id+'">　'+c.name+'</option>');flatten(c);}); }
    };
    flatten(tree);
    return opts.join("");
  },

  saveNode() {
    var name = document.getElementById("orgNodeName").value.trim();
    if (!name) { App.toast("请输入名称", "error"); return; }
    var parentId = parseInt(document.getElementById("orgParentId").value);
    var type = (document.getElementById("orgNodeType") && document.getElementById("orgNodeType").value) || "department";
    var result = Store.addOrgNode(parentId, { name: name, type: type, children: [] });
    if (result) { App.toast('"' + name + '" 已添加', "success"); App.closeModal(); App.navigate("org"); }
    else { App.toast("添加失败", "error"); }
  },

  showEditForm(id) {
    var node = Store._findNodeById(Store.getOrgStructure(), id);
    if (!node) return;
    App.openModal("编辑部门",
      '<div class="form-group"><label>部门名称 *</label><input type="text" class="form-control" id="orgEditName" value="' + this._escapeHtml(node.name) + '"></div><input type="hidden" id="orgEditId" value="' + id + '">',
      '<button class="btn btn-primary" onclick="Org.saveEdit()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  saveEdit() {
    var id = parseInt(document.getElementById("orgEditId").value);
    var name = document.getElementById("orgEditName").value.trim();
    if (!name) { App.toast("请输入名称", "error"); return; }
    Store.updateOrgNode(id, { name: name });
    App.toast("已更新", "success"); App.closeModal(); App.navigate("org");
  },

  showEditCompanyForm() {
    var tree = Store.getOrgStructure();
    App.openModal("编辑公司名称",
      '<div class="form-group"><label>公司名称 *</label><input type="text" class="form-control" id="orgCompanyName" value="' + this._escapeHtml(tree.name) + '"></div>',
      '<button class="btn btn-outline" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="Org.saveCompanyName()">保存</button>'
    );
  },

  saveCompanyName() {
    var name = document.getElementById("orgCompanyName").value.trim();
    if (!name) { App.toast("请输入名称", "error"); return; }
    Store.updateOrgNode(1, { name: name });
    App.toast("公司名称已更新", "success"); App.closeModal(); App.navigate("org");
  },

  deleteNode(id) {
    if (App.confirm("确定删除此部门？所有子部门也将被删除。")) {
      var node = Store._findNodeById(Store.getOrgStructure(), id);
      if (node && Store.deleteOrgNode(id)) { App.toast('"' + node.name + '" 已删除', "info"); App.navigate("org"); }
    }
  },

  exportOrg() {
    var tree = Store.getOrgStructure();
    var counts = Store.getOrgEmployeeCounts();
    var lines = [];
    var walk = function(node, depth) {
      var indent = "  ".repeat(depth);
      var cnt = counts[node.name] || 0;
      lines.push(indent + (node.type === "company" ? "🏢" : "📁") + " " + node.name + " (" + cnt + "人)");
      if (node.children) node.children.forEach(function(c){walk(c, depth + 1);});
    };
    walk(tree, 0);
    var text = lines.join("\n");
    navigator.clipboard.writeText(text).then(function(){App.toast("组织结构已复制到剪贴板","success");}).catch(function(){
      var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      App.toast("组织结构已复制到剪贴板","success");
    });
  },

  _escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },
};