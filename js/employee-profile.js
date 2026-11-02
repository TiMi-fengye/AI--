/**
 * 人员简历与AI简介模块 — 独立加载，不依赖employees.js内部方法
 */
const EmpProfile = {
  _initDone: false,

  /** 初始化：给每行添加简历按钮 */
  init() {
    if (this._initDone) return;
    this._initDone = true;
    var self = this;
    // 监听DOM变化，给新增的行添加简历按钮
    var observer = new MutationObserver(function() {
      self._addButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 立即添加一次
    setTimeout(function(){ self._addButtons(); }, 500);
  },

  /** 给表格行添加简历按钮 */
  _addButtons() {
    var self = this;
    document.querySelectorAll('.emp-row').forEach(function(row) {
      if (row.querySelector('.btn-resume')) return;
      var id = row.dataset.id;
      if (!id) return;
      var cell = row.lastElementChild;
      if (!cell) return;
      var btn = document.createElement('button');
      btn.className = 'btn btn-info btn-sm btn-resume';
      btn.style.cssText = 'padding:3px 8px;font-size:11px;margin-left:4px;';
      btn.textContent = '简历';
      btn.onclick = function(){ self.showModal(parseInt(id)); };
      cell.appendChild(btn);
    });
  },

  /** 显示简历/AI简介弹窗 */
  showModal(id) {
    var emp = Store.getEmployees().find(function(e){return e.id === id;});
    if (!emp) return;
    var hasResume = emp.resumeData && emp.resumeData.length > 20;
    var hasProfile = emp.aiProfile && emp.aiProfile.length > 5;

    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
      '<div class="form-group"><label>姓名</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;font-weight:600;">' + emp.name + '</div></div>' +
      '<div class="form-group"><label>性别</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.gender||'-') + '</div></div>' +
      '<div class="form-group"><label>部门</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.department||'-') + '</div></div>' +
      '<div class="form-group"><label>职位</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.position||'-') + '</div></div>' +
      '<div class="form-group"><label>手机</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.phone||'-') + '</div></div>' +
      '<div class="form-group"><label>区域</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.region||'-') + '</div></div>' +
      '<div class="form-group"><label>机房</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.room||'-') + '</div></div>' +
      '<div class="form-group"><label>楼栋</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.building||'-') + '</div></div>' +
      '<div class="form-group"><label>邮箱</label>'
      '<div class="form-group"><label>邮箱</label><div style="padding:8px 12px;background:#f8fafc;border-radius:8px;">' + (emp.email||'-') + '</div></div>' +
    '</div><hr>' +
    '<h4 style="margin:12px 0 8px;">简历附件</h4>' +
    '<div style="border:2px dashed #e2e8f0;border-radius:12px;padding:16px;text-align:center;">' +
      '<div style="font-size:32px;margin-bottom:8px;">📎</div>' +
      (hasResume ? '<p>已上传: ' + (emp.resumeName||'') + '</p>' : '<p style="color:var(--text-light);">未上传简历附件</p>') +
      '<input type="file" id="resumeFileInput" style="display:none;" onchange="EmpProfile.uploadResume(' + id + ')">' +
      '<button class="btn btn-primary btn-sm" onclick="document.getElementById(\'resumeFileInput\').click()">选择文件</button>' +
      (hasResume ? ' <button class="btn btn-outline btn-sm" onclick="EmpProfile.downloadResume(' + id + ')">下载</button>' : '') +
      (hasResume ? ' <button class="btn btn-danger btn-sm" onclick="EmpProfile.deleteResume(' + id + ')">删除</button>' : '') +
    '</div><hr>' +
    '<h4 style="margin:12px 0 8px;">AI 人员简介</h4>' +
    (hasProfile ? '<div style="padding:12px 16px;background:#f0f4ff;border-radius:10px;font-size:13px;line-height:1.8;border-left:3px solid #6366f1;">' + emp.aiProfile + '</div>' : '<p style="color:var(--text-light);">暂无简介，上传简历后可使用AI分析生成</p>') +
    (hasResume ? '<div style="margin-top:8px;"><button class="btn btn-info btn-sm" onclick="EmpProfile.analyzeResume(' + id + ')">AI 分析生成简介</button></div>' : '');

    App.openModal(emp.name + ' - 详细资料', html,
      '<button class="btn btn-primary" onclick="Employees.showEditModal(' + id + ')">编辑</button>' +
      '<button class="btn btn-outline" onclick="App.closeModal()">关闭</button>'
    );
  },

  /** 上传简历 */
  uploadResume(id) {
    var fileInput = document.getElementById('resumeFileInput');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    var file = fileInput.files[0];
    var self = this;
    // Read as DataURL for storage
    var dr = new FileReader();
    dr.onload = function(e) {
      var data = e.target.result;
      var emps = Store.getEmployees();
      var emp = emps.find(function(x){return x.id === id;});
      if (!emp) return;
      emp.resumeData = data;
      emp.resumeName = file.name;
      Store.set('employees', emps);
      
      // Also try to read as text for AI analysis
      var tr = new FileReader();
      tr.onload = function(te) {
        var text = te.target.result;
        if (text && text.length > 10) {
          emp._resumeText = text.substring(0, 5000);
          Store.set('employees', emps);
          // Auto-analyze if AI is configured
          var ai = typeof AI !== "undefined" ? AI : null;
          var cfg = ai ? ai.getConfig() : null;
          if (cfg && cfg.endpoint) {
            App.toast("简历已上传，AI正在分析...", "info");
            self._doAutoAnalyze(id, text.substring(0, 5000));
          } else {
            App.toast("简历已上传", "success");
            App.closeModal();
          }
        } else {
          App.toast("简历已上传（无法提取文本，暂不支持AI分析）", "success");
          App.closeModal();
        }
      };
      // Read as text (works for .txt, .csv, can try for others)
      tr.readAsText(file);
    };
    dr.readAsDataURL(file);
  },

  /** AI 自动分析简历（无需手动粘贴） */
  _doAutoAnalyze(id, text) {
    var ai = typeof AI !== "undefined" ? AI : null;
    var cfg = ai ? ai.getConfig() : null;
    if (!cfg || !cfg.endpoint) { App.closeModal(); return; }
    var prompt = "你是一个专业的HR分析师。根据以下简历内容，分析该人员掌握的核心技能、技术栈和工作背景，生成一段约100字的人员简介，重点突出技能掌握情况。\n\n简历内容：\n" + text;
    fetch(cfg.endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model:cfg.model, messages:[{role:"user", content:prompt}], max_tokens:512, temperature:0.7, stream:false})
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var rp = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : "";
      if (rp) {
        var es = Store.getEmployees();
        var ep = es.find(function(x){return x.id === id;});
        if (ep) { ep.aiProfile = rp; Store.set("employees", es); }
        App.toast("AI简介已自动生成", "success");
      } else {
        App.toast("AI分析完成但无结果", "info");
      }
      App.closeModal();
    })
    .catch(function(){ App.toast("AI请求失败，请检查API配置", "error"); App.closeModal(); });
  },

  downloadResume(id) {
    var emp = Store.getEmployees().find(function(x){return x.id === id;});
    if (!emp || !emp.resumeData) return;
    var a = document.createElement('a');
    a.href = emp.resumeData;
    a.download = emp.resumeName || 'resume';
    a.click();
  },

  /** 删除简历 */
  deleteResume(id) {
    if (!App.confirm('确定删除简历？')) return;
    var emps = Store.getEmployees();
    var emp = emps.find(function(x){return x.id === id;});
    if (!emp) return;
    emp.resumeData = null;
    emp.resumeName = null;
    Store.set('employees', emps);
    App.toast('已删除', 'info');
    App.closeModal();
  },

  /** AI 分析简历生成简介 */
  analyzeResume(id) {
    var emp = Store.getEmployees().find(function(x){return x.id === id;});
    if (emp && emp._resumeText) {
      this._doAutoAnalyze(id, emp._resumeText);
      return;
    }
    App.openModal('AI 分析简历',
      '<p style="font-size:14px;margin-bottom:12px;">粘贴简历内容，系统将利用AI分析并生成人员简介，重点分析掌握技能：</p>' +
      '<textarea class="form-control" id="resumeText" rows="10" placeholder="请粘贴简历内容..." style="font-size:14px;"></textarea>',
      '<button class="btn btn-primary" onclick="EmpProfile._doAnalyze(' + id + ')">开始分析</button>' +
      '<button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  /** 执行AI分析 */
  _doAnalyze(id) {
    var text = document.getElementById('resumeText').value.trim();
    if (!text) { App.toast('请粘贴简历内容', 'error'); return; }
    App.closeModal();
    App.toast('AI正在分析简历，请稍候...', 'info');
    var ai = typeof AI !== 'undefined' ? AI : null;
    var cfg = ai ? ai.getConfig() : null;
    if (!cfg || !cfg.endpoint) { App.toast('请先在AI问答中配置 API', 'warning'); return; }
    var prompt = '你是专业的HR分析师。根据以下简历内容，分析该人员掌握的核心技能、技术栈和工作背景，生成一段约100字的人员简介，重点突出技能掌握情况。\n\n简历内容：\n' + text;
    fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.7,
        stream: false
      })
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var reply = d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
      if (reply) {
        var emps = Store.getEmployees();
        var emp = emps.find(function(x){return x.id === id;});
        if (emp) { emp.aiProfile = reply; Store.set('employees', emps); }
        App.toast('AI简介已生成', 'success');
      } else { App.toast('AI分析无结果', 'error'); }
    })
    .catch(function(){ App.toast('AI请求失败，请检查网络和API配置', 'error'); });
  }
};

// DOM加载完成后自动初始化
// EmpProfile.init() disabled - resume button removed