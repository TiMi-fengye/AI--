/**
 * 绩效管理模块
 */
const Performance = {
  _key: "personnel_performance",
  _allowed() { return Auth.isAdmin() || Auth.isLeader(); },
  _guard() { if (this._allowed()) return true; App.toast('无权管理绩效数据', 'error'); return false; },
  _employees() { return Store.getEmployees().filter(function (employee) { return Auth.canAccessEmployee(employee.id); }); },
  getScores() {
    if (!this._allowed()) return [];
    var scores = Store.get(this._key);
    return Array.isArray(scores) ? scores.filter(function (score) { return Auth.isAdmin() || Auth.canAccessEmployee(score.employeeId); }) : [];
  },
  setScores(d) {
    if (!this._guard()) return;
    if (!Array.isArray(d) || d.some(function (score) { return !Auth.isAdmin() && !Auth.canAccessEmployee(score.employeeId); })) { App.toast('不能修改其他楼栋的绩效数据', 'error'); return; }
    Store.set(this._key, d);
  },

  render(container) {
    if (!this._guard()) { container.textContent = '无权查看绩效数据'; return; }
    var n = new Date();
    var ym = "";
    var h = [
      '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">',
        '<span style="font-size:16px;font-weight:600;">绩效管理</span>',
        '<span style="font-size:13px;color:var(--text-light);">上传考核表</span>',
      '</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">',
        '<div class="card"><div class="card-header"><h3>上传考核表</h3></div><div class="card-body">',
          '<p style="font-size:13px;color:var(--text-light);margin-bottom:12px;">支持批量上传多个 CSV / Excel 文件，自动识别。共上传 ' + this.getScores().length + ' 条记录。</p>',
          '<div style="border:2px dashed #e2e8f0;border-radius:12px;padding:24px;text-align:center;background:#f8fafc;">',
            '<div style="font-size:48px;margin-bottom:8px;">📄</div>',
            '<p style="font-size:13px;color:var(--text-light);margin-bottom:12px;">选择文件</p>',
            '<input type="file" id="pfFile" accept="*" style="display:none;" onchange="Performance.parseFiles(event)" multiple>',
            '<button class="btn btn-primary" onclick="Performance._pickFile()">选择文件</button> <button class="btn btn-outline" onclick="Performance.downloadTemplate()">📥 下载模板</button>',
          '</div>',
          '<div style="margin-top:12px;padding:10px 14px;background:#f8fafc;border-radius:8px;">',
            '<strong>格式：</strong>第一列姓名，第二列部门。支持季度考核表模板。</div>',
        '</div></div>',
        '<div class="card"><div class="card-header"><h3>考核月份</h3></div><div class="card-body">',
          '<div class="form-group"><label>选择月份</label>',
          '<input type="month" class="form-control" id="pfYm" value="' + ym + '" onchange="Performance.renderScores()"></div><span style="font-size:12px;color:var(--text-light);margin-left:8px;cursor:pointer;" onclick="Performance.clearMonthFilter()">显示全部</span>',
          '<button class="btn btn-outline" onclick="Performance.showAddModal()">手动评分</button>',
          '<button class="btn btn-danger btn-sm" style="margin-left:8px;" onclick="Performance.clearMonth()">清空</button>',
        '</div></div>',
      '</div>',
      '<div class="card" style="margin-top:16px;">',
        '<div class="card-header"><h3>评分表<span style="font-size:13px;color:var(--text-light);margin-left:8px;">' + ym + '</span><span style="font-size:12px;color:var(--text-light);margin-left:12px;">共 ' + this.getScores().length + ' 条记录</span></h3></div>',
        '<div class="card-body" id="pfTable"><div class="empty-state"><div class="empty-icon">📊</div><p>暂无数据</p></div></div>',
      '</div>',
      '<div class="card" style="margin-top:16px;">',
        '<div class="card-header"><h3>排名</h3><span style="font-size:13px;color:var(--text-light);">按总分降序</span></div>',
        '<div class="card-body" id="pfRank"><div class="empty-state"><div class="empty-icon">🏆</div><p>暂无数据</p></div></div>',
      '</div>',
    ].join("");
    container.innerHTML = h;
    this.renderScores();
  },
  _pickFile() { if (this._guard()) document.getElementById("pfFile").click(); },
    parseFiles(ev) {
    if (!this._guard()) return;
    var files = ev.target.files;
    if (!files || files.length === 0) return;
    var self = this;
    var pending = files.length;
    var success = 0;
    var errors = [];

    function processFile(f) {
      var name = f.name.toLowerCase();
      var isExcel = name.indexOf(".xls") >= 0;

      if (isExcel) {
        var r = new FileReader();
        r.onload = function(e) {
          try {
            var d = new Uint8Array(e.target.result);
            var wb = XLSX.read(d, {type:"array"});
            var s = wb.Sheets[wb.SheetNames[0]];
            if (!s) { errors.push(f.name + ": 无数据"); checkDone(); return; }
            var j = XLSX.utils.sheet_to_json(s, {header:1});
            if (self._parseTmpl(j, ev, self, f.name)) { success++; checkDone(); return; }
            var rows = [];
            for (var i = 0; i < j.length; i++) { var row = j[i].filter(function(c){return c != null;}); if (row.length > 0 && String(row[0]).trim()) rows.push(row.join(",")); }
            if (rows.length > 0) { self._parseRows2(rows, self, f.name); success++; checkDone(); return; }
            errors.push(f.name + ": 未找到数据"); checkDone();
          } catch(ex) { errors.push(f.name + ": " + ex.message); checkDone(); }
        };
        r.readAsArrayBuffer(f);
      } else {
        var r = new FileReader();
        r.onload = function(e) {
          try {
            var t = e.target.result;
            var lines = t.split("\n").filter(function(l){return l.trim();});
            if (lines.length >= 2 && lines[0].split(",").length >= 2) { self._parseRows2(lines, self, f.name); success++; checkDone(); return; }
            errors.push(f.name + ": 格式无效"); checkDone();
          } catch(ex) { errors.push(f.name + ": 读取失败"); checkDone(); }
        };
        r.readAsText(f);
      }
    }

    function checkDone() {
      pending--;
      if (pending <= 0) {
        var msg = "导入完成: " + success + " 个文件成功";
        if (errors.length > 0) msg += ", " + errors.length + " 个失败";
        App.toast(msg, success > 0 ? "success" : "error");
        self.renderScores();
      }
    }

    for (var i = 0; i < files.length; i++) processFile(files[i]);
    ev.target.value = "";
  },

  _parseRows2(lines, self, fname) {
    if (!this._guard()) return;
    if (lines.length < 2) return;
    var h = Performance._csvLine(lines[0]);
    if (h.length < 2) return;
    var dims = h.slice(2);
    var emps = this._employees();
    // Build name lookup map (case-insensitive)
    var nameMap = Object.create(null);
    for (var ei = 0; ei < emps.length; ei++) {
      nameMap[emps[ei].name] = emps[ei];
    }
    var recs = [];
    var unmatched = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = Performance._csvLine(lines[i]);
      if (cols.length < 2) continue;
      var name = String(cols[0]).trim(); if (!name) continue;
      var emp = nameMap[name];
      if (!emp) {
        unmatched.push(name);
        recs.push({employeeId:0, name:name, dept:cols[1]?String(cols[1]).trim():"", pos:"", scores:{}, total:0});
        continue;
      }
      var scores = Object.create(null); var total = 0;
      for (var j = 0; j < dims.length && j+2 < cols.length; j++) {
        var v = parseFloat(cols[j+2]) || 0;
        scores[dims[j].trim()] = v; total += v;
      }
      recs.push({employeeId:emp.id,name:name,dept:cols[1]?String(cols[1]).trim():"",pos:emp.position||"",scores:scores,total:total});
    }
    if (unmatched.length > 0) {
      App.toast("未匹配的姓名: " + unmatched.join(", "), "warning");
    }
    if (recs.length === 0) return;
    console.log("Parsed " + recs.length + "/" + (lines.length-1) + " records from " + fname + ". Names:", recs.map(function(r){return r.name;})); if (unmatched.length > 0) console.log("Unmatched:", unmatched);
    var ym = document.getElementById("pfYm").value;
    if (!ym) { ym = new Date().toISOString().substring(0, 7); }
    var all = self.getScores();
    for (var i = 0; i < recs.length; i++) {
      recs[i].yearMonth = ym;
      recs[i].id = Date.now()+i;
      recs[i].createdAt = new Date().toISOString();
      all.push(recs[i]);
    }
    self.setScores(all);
  },

  _parseTmpl(json, ev, self, fname) {
    if (!this._guard()) return false;
    var title = json[0] ? String(json[0][0] || "") : "";
    if (title.indexOf("考核表") < 0) return false;
    var nc = json[1] ? String(json[1][0] || "") : "";
    var en = nc.replace(/考核人姓名[\:\uFF1A]/, "").trim();
    if (!en) { App.toast("未找到姓名", "error"); ev.target.value = ""; return true; }
    var emp = this._employees().find(function(e){return e.name === en;});
    if (!emp) { App.toast("未找到: " + en, "error"); ev.target.value = ""; return true; }
    var ym = document.getElementById("pfYm").value;
    if (!ym) { ym = new Date().toISOString().substring(0, 7); }
    var ts = json[4] ? parseFloat(json[4][4]) || 0 : 0;
    var ss = json[5] ? parseFloat(json[5][4]) || 0 : 0;
    var hs = json[13] ? parseFloat(json[13][4]) || 0 : 0;
    var ns = json[38] ? parseFloat(json[38][4]) || 0 : 0;
    var ps = json[44] ? parseFloat(json[44][4]) || 0 : 0;
    var sc = {软性: ss, 硬性: hs, 负激励: ns, 亮点: ps, 总分: ts};
    var all = self.getScores();
    all.push({id:Date.now(),employeeId:emp.id,name:emp.name,dept:emp.department||"",pos:emp.position||"",yearMonth:ym,scores:sc,total:ts,createdAt:new Date().toISOString()});
    self.setScores(all);
    App.toast("导入 1 条", "success");
    self.renderScores(); ev.target.value = ""; return true;
  },
  _csvLine(l) {
    var r = [], c = "", q = false;
    for (var i = 0; i < l.length; i++) {
      var ch = l[i];
      if (ch === '"') { q = !q; }
      else if (ch === "," && !q) { r.push(c); c = ""; }
      else { c += ch; }
    }
    r.push(c); return r;
  },
  _parseRows(lines, ev, self) {
    if (!this._guard()) return;
    if (lines.length < 2) { App.toast("数据不足", "error"); ev.target.value = ""; return; }
    var h = this._csvLine(lines[0]);
    if (h.length < 2) { App.toast("格式错误", "error"); ev.target.value = ""; return; }
    var dims = h.slice(2);
    var emps = this._employees(); var recs = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = this._csvLine(lines[i]);
      if (cols.length < 2) continue;
      var name = String(cols[0]).trim(); if (!name) continue;
      var emp = emps.find(function(e){return e.name === name;});
      if (!emp) { App.toast("未匹配: " + name, "warning"); continue; }
      var scores = Object.create(null); var total = 0;
      for (var j = 0; j < dims.length && j+2 < cols.length; j++) {
        var v = parseFloat(cols[j+2]) || 0; scores[dims[j].trim()] = v; total += v;
      }
      recs.push({employeeId:emp.id,name:name,dept:cols[1]?String(cols[1]).trim():"",pos:emp.position||"",scores:scores,total:total});
    }
    if (recs.length === 0) { App.toast("未识别", "error"); ev.target.value = ""; return; }
    var ym = document.getElementById("pfYm").value;
    if (!ym) { App.toast("请选月份", "error"); ev.target.value = ""; return; }
    var all = this.getScores();
    all = all.filter(function(s){return s.yearMonth !== ym;});
    for (var i = 0; i < recs.length; i++) {
      recs[i].yearMonth = ym; recs[i].id = Date.now()+i; recs[i].createdAt = new Date().toISOString(); all.push(recs[i]);
    }
    this.setScores(all);
    App.toast("导入 " + recs.length + " 条", "success");
    this.renderScores(); ev.target.value = "";
  },
  renderScores() {
    if (!this._guard()) return;
    var el = document.getElementById("pfYm"); if (!el) return;
    var ym = el.value;
    var allScores = this.getScores();
    var ms = allScores;
    var tb = document.getElementById("pfTable");
    var rb = document.getElementById("pfRank");
    if (!tb || !rb) return;
    if (ms.length === 0) {
      tb.innerHTML = "<div class='empty-state'><div class='empty-icon'>📊</div><p>暂无数据</p></div>";
      rb.innerHTML = "<div class='empty-state'><div class='empty-icon'>🏆</div><p>暂无数据</p></div>";
      return;
    }
    var dims = [];
    for (var i = 0; i < ms.length; i++) { for (var k in ms[i].scores) { if (dims.indexOf(k) < 0) dims.push(k); } }
    var h = '<div class="table-responsive"><table><thead><tr><th>姓名</th><th>部门</th>';
    for (var d = 0; d < dims.length; d++) h += '<th>' + Auth.escape(dims[d]) + '</th>';
    h += '<th>总分</th><th>操作</th></tr></thead><tbody>';
    for (var i = 0; i < ms.length; i++) {
      var s = ms[i];
      h += '<tr><td><strong>' + Auth.escape(s.name) + '</strong></td><td>' + Auth.escape(s.dept||'') + '</td>';
      for (var d = 0; d < dims.length; d++) {
        var sv = Number(s.scores[dims[d]]) || 0;
        var sc = sv >= 90 ? 'var(--success)' : (sv >= 70 ? 'var(--warning)' : 'var(--danger)');
        h += '<td style="font-weight:600;color:' + sc + ';">' + sv + '</td>';
      }
      h += '<td style="font-weight:700;color:var(--primary);">' + (Number(s.total)||0) + '</td>';
      h += '<td><button class="btn btn-info btn-sm" onclick="Performance.showEdit(' + Number(s.id) + ')">编辑</button> <button class="btn btn-danger btn-sm" onclick="Performance.del(' + Number(s.id) + ')">删除</button></td></tr>';
    }
    h += '</tbody></table></div>'; tb.innerHTML = h;
    var sorted = ms.slice().sort(function(a,b){return (b.total||0)-(a.total||0);});
    var medals = ["🥇","🥈","🥉","4","5"];
    var rh = "";
    for (var i = 0; i < sorted.length && i < 5; i++) {
      var sv = sorted[i];
      var rankColors = ["#059669","#d97706","#92400e","#64748b","#64748b"];
      var rankBgs = ["#ecfdf5","#fffbeb","#fef3c7","#f8fafc","#f8fafc"];
      var c = rankColors[i] || "#64748b";
      var bg = rankBgs[i] || "#f8fafc";
      var isTop3 = i < 3;
      rh +=
        '<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;background:' + bg + ';border-radius:10px;border:1px solid ' + (isTop3 ? "transparent" : "#f1f5f9") + ';">' +
          '<div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:' + c + ';color:#fff;border-radius:8px;font-size:16px;flex-shrink:0;">' + medals[i] + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:15px;font-weight:600;color:#0f172a;">' + Auth.escape(sv.name) + '</div>' +
            '<div style="font-size:12px;color:#64748b;margin-top:2px;">' + Auth.escape(sv.dept||"") + '</div>' +
          '</div>' +
          '<div style="text-align:right;flex-shrink:0;">' +
            '<div style="font-size:18px;font-weight:700;color:' + c + ';">' + (Number(sv.total)||0) + '<span style="font-size:12px;font-weight:400;">分</span></div>' +
            '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">' + dims.length + '项考核</div>' +
          '</div>' +
        '</div>';
    }
    rb.innerHTML = rh || '<div class="empty-state"><div class="empty-icon">🏆</div><p>暂无数据</p></div>';
    console.log("renderScores: total=" + allScores.length + ", showing=" + ms.length);
  },

  clearMonthFilter() {
    if (!this._guard()) return;
    var el = document.getElementById("pfYm");
    if (el) { el.value = ""; this.renderScores(); }
  },

  showAddModal() {
    if (!this._guard()) return;
    var emps = this._employees();
    if (!emps.length) { App.toast("请先添加人员", "warning"); return; }
    App.openModal("手动评分",
      '<div class="form-group"><label>员工</label><select class="form-control" id="pfEmp">' +
        emps.map(function(e){return '<option value="'+Number(e.id)+'">'+Auth.escape(e.name)+' ('+Auth.escape(e.department||'')+')</option>';}).join('') +
      '</select></div>' +
      '<div class="form-row"><div class="form-group"><label>效率</label><input type="number" class="form-control" id="pfD1" value="85" min="0" max="100"></div>' +
      '<div class="form-group"><label>质量</label><input type="number" class="form-control" id="pfD2" value="85" min="0" max="100"></div></div>' +
      '<div class="form-row"><div class="form-group"><label>出勤</label><input type="number" class="form-control" id="pfD3" value="90" min="0" max="100"></div>' +
      '<div class="form-group"><label>协作</label><input type="number" class="form-control" id="pfD4" value="80" min="0" max="100"></div></div>',
      '<button class="btn btn-primary" onclick="Performance.saveManual()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },
  saveManual() {
    if (!this._guard()) return;
    var eid = parseInt(document.getElementById("pfEmp").value);
    var emp = this._employees().find(function(e){return e.id===eid;});
    if (!emp) { App.toast("请选员工", "error"); return; }
    var ym = document.getElementById("pfYm").value;
    if (!ym) { App.toast("请选月份", "error"); return; }
    var s = {效率:parseInt(document.getElementById('pfD1').value)||0,质量:parseInt(document.getElementById('pfD2').value)||0,出勤:parseInt(document.getElementById('pfD3').value)||0,协作:parseInt(document.getElementById('pfD4').value)||0};
    var t = s['效率']+s['质量']+s['出勤']+s['协作'];
    var all = this.getScores();
    all = all.filter(function(x){return !(x.employeeId===eid&&x.yearMonth===ym);});
    all.push({id:Date.now(),employeeId:eid,name:emp.name,dept:emp.department,pos:emp.position,yearMonth:ym,scores:s,total:t,createdAt:new Date().toISOString()});
    this.setScores(all); App.toast('已添加','success'); App.closeModal(); this.renderScores();
  },
  showEdit(id) {
    if (!this._guard()) return;
    var all = this.getScores(); var sc = all.find(function(x){return x.id===id;}); if (!sc) return;
    var dims = sc.scores || {}; var h = ''; var i = 0;
    for (var k in dims) {
      h += '<div class="form-group"><label>' + Auth.escape(k) + '</label><input type="number" class="form-control" id="pfE' + i + '" value="' + (Number(dims[k])||0) + '" min="0" max="100"></div>'; i++;
    }
    App.openModal('编辑', '<div style="font-size:13px;color:var(--text-light);margin-bottom:12px;">' + Auth.escape(sc.dept||'') + ' · ' + Auth.escape(sc.yearMonth) + '</div>' + h + '<input type="hidden" id="pfId" value="' + Number(id) + '"><input type="hidden" id="pfCnt" value="' + i + '">', '<button class="btn btn-primary" onclick="Performance.saveEdit()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  saveEdit() {
    if (!this._guard()) return;
    var id = parseInt(document.getElementById("pfId").value);
    var cnt = parseInt(document.getElementById("pfCnt").value);
    var all = this.getScores(); var sc = all.find(function(x){return x.id===id;}); if (!sc) return;
    var dims = sc.scores || {}; var keys = Object.keys(dims); var total = 0;
    for (var i = 0; i < cnt && i < keys.length; i++) {
      var v = parseInt(document.getElementById("pfE" + i).value) || 0;
      dims[keys[i]] = v; total += v;
    }
    sc.scores = dims; sc.total = total; this.setScores(all);
    App.toast('已更新','success'); App.closeModal(); this.renderScores();
  },
  del(id) {
    if (!this._guard()) return;
    if (!App.confirm('确定删除？')) return;
    var all = this.getScores(); this.setScores(all.filter(function(s){return s.id!==id;}));
    App.toast('已删除','info'); this.renderScores();
  },
  clearMonth() {
    if (!this._guard()) return;
    if (!App.confirm('确定清空？')) return;
    var ym = document.getElementById("pfYm").value; if (!ym) return;
    var all = this.getScores(); this.setScores(all.filter(function(s){return s.yearMonth!==ym;}));
    App.toast('已清空','info'); this.renderScores();
  }
};
