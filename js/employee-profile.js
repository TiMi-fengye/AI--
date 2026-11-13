/** 人员简历与 AI 简介。所有资料按文本显示，并校验当前账号的数据范围。 */
const EmpProfile = {
  _initDone: false,
  _employee(id, edit) {
    var allowed=edit ? Auth.canManageEmployee(id) : Auth.canAccessEmployee(id);
    if (!allowed) { App.toast('无权访问该人员资料','error'); return null; }
    return Store.getEmployees().find(function(emp) { return Number(emp.id)===Number(id); }) || null;
  },
  _safeResumeData(value) {
    return typeof value==='string' && /^data:(?:application\/(?:pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream)|text\/(?:plain|csv)|image\/(?:png|jpeg|webp));base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
  },
  _canAnalyze(id) {
    if (!Auth.isAdmin() || !Auth.canManageEmployee(id)) { App.toast('仅管理员可使用 AI 分析简历','error'); return false; }
    return !!this._employee(id,true);
  },
  init() {
    if (this._initDone) return;
    this._initDone=true;
    var self=this;
    var observer=new MutationObserver(function() { self._addButtons(); });
    observer.observe(document.body,{childList:true,subtree:true});
    setTimeout(function() { self._addButtons(); },500);
  },
  _addButtons() {
    var self=this;
    document.querySelectorAll('.emp-row').forEach(function(row) {
      var id=Number(row.dataset.id);
      if (!Number.isSafeInteger(id)||id<=0||!Auth.canAccessEmployee(id)||row.querySelector('.btn-resume')||!row.lastElementChild) return;
      var button=document.createElement('button');
      button.className='btn btn-info btn-sm btn-resume';
      button.style.cssText='padding:3px 8px;font-size:11px;margin-left:4px;';
      button.textContent='简历'; button.onclick=function() { self.showModal(id); };
      row.lastElementChild.appendChild(button);
    });
  },
  showModal(id) {
    var emp=this._employee(id,false);
    if (!emp) return;
    id=Number(emp.id);
    var hasResume=this._safeResumeData(emp.resumeData), hasProfile=!!emp.aiProfile, canEdit=Auth.canManageEmployee(id), canAnalyze=Auth.isAdmin()&&canEdit;
    var fields={姓名:emp.name,工号:emp.employeeNo,性别:emp.gender,部门:emp.department,职位:emp.position,手机:emp.phone,区域:emp.region,机房:emp.room,楼栋:emp.building,邮箱:emp.email,入职日期:emp.joinDate};
    var html='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">'+Object.keys(fields).map(function(label) {
      return '<div class="form-group"><label>'+Auth.escape(label)+'</label><div style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;">'+Auth.escape(fields[label]||'-')+'</div></div>';
    }).join('')+'</div><hr><h4 style="margin:12px 0 8px;">简历附件</h4><div style="border:2px dashed var(--border);border-radius:12px;padding:16px;text-align:center;">'+
      (hasResume?'<p>已上传：'+Auth.escape(emp.resumeName||'简历附件')+'</p>':'<p>未上传可下载的简历附件</p>')+
      (canEdit?'<input type="file" id="resumeFileInput" style="display:none;" accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx,.png,.jpg,.jpeg,.webp" onchange="EmpProfile.uploadResume('+id+')"><button class="btn btn-primary btn-sm" onclick="document.getElementById(\'resumeFileInput\').click()">选择文件</button> ':'')+
      (hasResume?'<button class="btn btn-outline btn-sm" onclick="EmpProfile.downloadResume('+id+')">下载</button> ':'')+
      (canEdit&&hasResume?'<button class="btn btn-danger btn-sm" onclick="EmpProfile.deleteResume('+id+')">删除</button>':'')+'</div><hr><h4 style="margin:12px 0 8px;">AI 人员简介</h4>'+
      (hasProfile?'<div style="padding:12px 16px;border:1px solid var(--border);border-radius:10px;font-size:13px;line-height:1.8;white-space:pre-wrap;">'+Auth.escape(emp.aiProfile)+'</div>':'<p>暂无简介</p>')+
      (canAnalyze&&hasResume?'<div style="margin-top:8px;"><button class="btn btn-info btn-sm" onclick="EmpProfile.analyzeResume('+id+')">AI 分析生成简介</button></div>':'');
    App.openModal((emp.name||'人员')+' - 详细资料',html,(canEdit?'<button class="btn btn-primary" onclick="Employees.showEditModal('+id+')">编辑</button>':'')+'<button class="btn btn-outline" onclick="App.closeModal()">关闭</button>');
  },
  uploadResume(id) {
    if (!this._employee(id,true)) return;
    var input=document.getElementById('resumeFileInput');
    if (!input||!input.files||!input.files[0]) return;
    var file=input.files[0], self=this;
    if (file.size>10*1024*1024) { App.toast('简历附件不得超过10MB','error'); return; }
    var reader=new FileReader();
    reader.onload=async function(event) {
      if (!self._safeResumeData(event.target.result)) { App.toast('请上传 PDF、Word、表格、纯文本或常见图片文件','error'); return; }
      var emp=self._employee(id,true);
      if (!emp) return;
      var textReader=new FileReader();
      textReader.onload=async function(textEvent) {
        if (!self._employee(id,true)) return;
        var text=String(textEvent.target.result||'').substring(0,5000);
        var employees=Store.getEmployees();
        var current=employees.find(function(employee) { return Number(employee.id)===Number(id); });
        if (!current) return;
        current.resumeData=event.target.result; current.resumeName=file.name; current._resumeText=text;
        Store.set('employees',employees);
        try {
          await Store.flushServerSync();
          var ai=typeof AI!=='undefined'?AI:null, cfg=ai?ai.getConfig():null;
          if (Auth.isAdmin()&&cfg&&cfg.endpoint&&text.length>10) { App.toast('简历已上传，AI正在分析…','info'); await self._doAutoAnalyze(id,text); }
          else { App.toast('简历已上传','success'); App.closeModal(); }
        } catch(error) { App.toast(error.message||'简历保存失败','error'); }
      };
      textReader.onerror=function() { App.toast('附件读取失败，请重试','error'); };
      textReader.readAsText(file);
    };
    reader.onerror=function() { App.toast('附件读取失败，请重试','error'); };
    reader.readAsDataURL(file);
  },
  async _doAutoAnalyze(id,text) {
    if (!this._canAnalyze(id)) return;
    var ai=typeof AI!=='undefined'?AI:null, cfg=ai?ai.getConfig():null;
    if (!cfg||!cfg.endpoint) { App.toast('请先在AI问答中配置 API','warning'); return; }
    var prompt='你是专业的HR分析师。根据以下简历内容，分析该人员掌握的核心技能、技术栈和工作背景，生成约100字的人员简介。\n\n简历内容：\n'+String(text).slice(0,5000);
    try {
      var response=await fetch(cfg.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:cfg.model,messages:[{role:'user',content:prompt}],max_tokens:512,temperature:0.7,stream:false})});
      if (!response.ok) throw new Error('AI请求失败，请检查API配置');
      var data=await response.json();
      var reply=data.choices&&data.choices[0]&&data.choices[0].message?data.choices[0].message.content:'';
      if (!reply) { App.toast('AI分析无结果','error'); return; }
      if (!this._canAnalyze(id)) return;
      var employees=Store.getEmployees(), employee=employees.find(function(employee) { return Number(employee.id)===Number(id); });
      if (!employee) return;
      employee.aiProfile=String(reply); Store.set('employees',employees);
      await Store.flushServerSync();
      App.toast('AI简介已生成','success'); App.closeModal();
    } catch(error) { App.toast(error.message||'AI请求失败','error'); }
  },
  downloadResume(id) {
    var emp=this._employee(id,false);
    if (!emp) return;
    if (!this._safeResumeData(emp.resumeData)) { App.toast('附件格式无效，无法下载','error'); return; }
    var link=document.createElement('a');
    link.href=emp.resumeData; link.download=String(emp.resumeName||'resume').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');
    link.click();
  },
  async deleteResume(id) {
    if (!this._employee(id,true)||!App.confirm('确定删除简历？')) return;
    var employees=Store.getEmployees(), emp=employees.find(function(employee) { return Number(employee.id)===Number(id); });
    if (!emp) return;
    emp.resumeData=null; emp.resumeName=null; emp._resumeText='';
    Store.set('employees',employees);
    try { await Store.flushServerSync(); App.toast('已删除','info'); App.closeModal(); }
    catch(error) { App.toast(error.message||'保存失败','error'); }
  },
  analyzeResume(id) {
    if (!this._canAnalyze(id)) return;
    var emp=this._employee(id,false);
    if (emp._resumeText) return this._doAutoAnalyze(id,emp._resumeText);
    App.openModal('AI 分析简历','<p>粘贴简历内容，系统将分析并生成人员简介：</p><textarea class="form-control" id="resumeText" rows="10" placeholder="请粘贴简历内容"></textarea>',
      '<button class="btn btn-primary" onclick="EmpProfile._doAnalyze('+Number(id)+')">开始分析</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
  },
  _doAnalyze(id) {
    if (!this._canAnalyze(id)) return;
    var text=document.getElementById('resumeText').value.trim();
    if (!text) { App.toast('请粘贴简历内容','error'); return; }
    App.toast('AI正在分析简历，请稍候…','info');
    return this._doAutoAnalyze(id,text);
  }
};
