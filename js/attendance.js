/**
 * 考勤管理模块（考勤 + 加班 + 请假合并）
 */
const Attendance = {
  _activeTab: 'attendance',

  _getMyEmployeeId() {
    var _cu = Auth.currentUser();
    if (!_cu) return null;
    var users = Auth._getUsers();
    var user = users[_cu.username];
    if (user && user.employeeId) return user.employeeId;
    var emp = Store.getEmployees().find(function(e){return e.name===_cu.name;});
    return emp ? emp.id : null;
  },

  _isRegular() {
    var _cu = Auth.currentUser();
    return _cu && _cu.role !== 'admin';
  },
  _isManagerUser() {
    var eid = this._getMyEmployeeId();
    if (!eid) return false;
    var emp = Store.getEmployees().find(function(e){return e.id===eid;});
    if (!emp || !emp.position) return false;
    return emp.position.includes('主管') || emp.position.includes('值班长') || 
           emp.position.includes('经理') || emp.position.includes('总监') || 
           emp.position.includes('区域经理');
  },

  _durationSummary(balance, title) {
    balance = balance || {overtimeHours:0, compensatoryHours:0, remainingHours:0};
    return '<div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px;">' +
      '<div class="stat-card primary"><div class="stat-icon">⏱️</div><div class="stat-label">'+(title||'')+'调休加班总时长</div><div class="stat-value">'+Number(balance.overtimeHours||0).toFixed(1)+'h</div></div>' +
      '<div class="stat-card warning"><div class="stat-icon">🔄</div><div class="stat-label">已使用调休时长</div><div class="stat-value">'+Number(balance.compensatoryHours||0).toFixed(1)+'h</div></div>' +
      '<div class="stat-card success"><div class="stat-icon">✅</div><div class="stat-label">剩余调休时长</div><div class="stat-value">'+Number(balance.remainingHours||0).toFixed(1)+'h</div></div>' +
      '</div>';
  },


  render(container) {
    var tab = this._activeTab;
    var tabBar = [
      '<style>',
      '.att-tab{display:inline-flex;align-items:center;gap:6px;padding:10px 22px;font-size:14px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.2s;color:var(--text-light);user-select:none;}',
      '.att-tab:hover{color:var(--text);background:rgba(79,70,229,0.04);}',
      '.att-tab.active{color:var(--primary);border-bottom-color:var(--primary);font-weight:600;}',
      '</style>',
      '<div style="display:flex;border-bottom:2px solid var(--border);margin-bottom:20px;">',
        '<div class="att-tab', tab==='attendance'?' active':'', '" onclick="Attendance._switchTo(\'attendance\')">⏰ 考勤</div>',
        '<div class="att-tab', tab==='overtime'?' active':'', '" onclick="Attendance._switchTo(\'overtime\')">⏰ 加班</div>',
        '<div class="att-tab', tab==='leave'?' active':'', '" onclick="Attendance._switchTo(\'leave\')">📋 请假</div>',
      '</div>',
      '<div id="attSubContent"></div>'
    ].join('');

    container.innerHTML = tabBar;
    this._renderActiveTab();
  },

  _switchTo(tab) {
    this._activeTab = tab;
    var container = document.getElementById('pageContent');
    if (container) this.render(container);
  },

  _renderActiveTab() {
    var sub = document.getElementById('attSubContent');
    if (!sub) return;
    if (this._activeTab === 'attendance') this._renderAttTab(sub);
    else if (this._activeTab === 'overtime') this._renderOtTab(sub);
    else if (this._activeTab === 'leave') this._renderLeaveTab(sub);
  },

  // ===== Tab 1: 考勤 =====
  _renderAttTab(sub) {
    var records = Store.getAttendance();
    var employees = Store.getEmployees();
    var today = App.today();
    if (this._isRegular() && !this._isManagerUser()) {
      var myEid = this._getMyEmployeeId();
      var myRecords = myEid ? records.filter(function(r){return r.employeeId===myEid;}) : [];
      var myToday = myRecords.filter(function(r){return r.date === today;});
      sub.innerHTML = [
        '<div class="mobile-quick-actions">',
          '<button class="btn btn-primary" onclick="Attendance.showCheckinModal()">✅ 签到</button>',
          '<button class="btn btn-warning" onclick="Attendance.lvShowApplyModal()">📋 请假</button>',
          '<button class="btn btn-success" onclick="Attendance.otShowAddModal()">⏰ 加班</button>',
        '</div>',
        '<div class="card"><div class="card-header"><h3>⏰ 今日考勤 ('+today+')</h3>',
          '<button class="btn btn-primary" onclick="Attendance.showCheckinModal()">+ 签到/签退</button>',
        '</div><div class="card-body">',
          myToday.length>0
            ? this._todayTable(myToday, employees)
            : '<div class="empty-state"><div class="empty-icon">⏰</div><p>今日暂无考勤记录，请点击签到</p></div>',
        '</div></div>'
      ].join('');
      return;
    }
    var todayRecords = records.filter(function(r){return r.date === today;});
    var monthYm = today.substring(0, 7);
    var monthRecords = records.filter(function(r){return r.date && r.date.indexOf(monthYm) === 0;});
    var stat = {total:0,present:0,late:0,absent:0}, empSet={};
    for (var i=0;i<monthRecords.length;i++) {
      var r=monthRecords[i]; stat.total++; empSet[r.employeeId]=true;
      if(r.status==='present')stat.present++;else if(r.status==='late')stat.late++;else if(r.status==='absent')stat.absent++;
    }
    var empCount=Object.keys(empSet).length, rate=stat.total>0?Math.round(stat.present/stat.total*100):0;

    sub.innerHTML = [
      '<div class="stats-grid" style="grid-template-columns:repeat(6,1fr);margin-bottom:20px;">',
        '<div class="stat-card info"><div class="stat-icon">📊</div><div class="stat-label">\u672c\u6708\u8003\u52e4</div><div class="stat-value">',stat.total,'</div></div>',
        '<div class="stat-card success"><div class="stat-icon">✅</div><div class="stat-label">\u51fa\u52e4</div><div class="stat-value">',stat.present,'</div></div>',
        '<div class="stat-card warning"><div class="stat-icon">⚠️</div><div class="stat-label">\u8fdf\u5230</div><div class="stat-value">',stat.late,'</div></div>',
        '<div class="stat-card danger"><div class="stat-icon">❌</div><div class="stat-label">\u7f3a\u52e4</div><div class="stat-value">',stat.absent,'</div></div>',
        '<div class="stat-card primary"><div class="stat-icon">📈</div><div class="stat-label">\u51fa\u52e4\u7387</div><div class="stat-value">',rate,'%</div></div>',
        '<div class="stat-card primary" style="background:rgba(99,102,241,0.06);"><div class="stat-icon">👥</div><div class="stat-label">\u6d89\u53ca\u4eba\u6570</div><div class="stat-value">',empCount,'</div></div>',
      '</div>',
      '<div class="card"><div class="card-header"><h3>⏰ \u4eca\u65e5\u8003\u52e4 (',today,')</h3><div style="display:flex;gap:8px;align-items:center;">',
        '<button class="btn btn-primary" onclick="Attendance.showCheckinModal()">+ \u7b7e\u5230/\u7b7e\u9000</button>',
        '<button class="btn btn-success" onclick="Attendance.allPresent()">✅ \u4e00\u952e\u5168\u90e8\u5230\u5c97</button>',
      '</div></div><div class="card-body">',
        todayRecords.length>0?this._todayTable(todayRecords,employees):'<div class="empty-state"><div class="empty-icon">⏰</div><p>\u4eca\u65e5\u6682\u65e0\u8003\u52e4\u8bb0\u5f55</p></div>',
      '</div></div>',
      '<div class="card"><div class="card-header"><h3>📋 \u5168\u90e8\u8003\u52e4\u8bb0\u5f55</h3><div style="display:flex;gap:8px;align-items:center;">',
        '<input type="date" class="form-control" id="attDateFilter" style="max-width:160px;" value="',today,'" onchange="Attendance.render(document.getElementById(\'pageContent\'))">',
        '<select class="form-control" id="attDeptFilter" style="max-width:130px;" onchange="Attendance.render(document.getElementById(\'pageContent\'))">',
          '<option value="">\u5168\u90e8</option>',
          this._attDeptOptions(),
        '</select>',
        '<button class="btn btn-info btn-sm" onclick="Attendance.showMonthlyReport()">\u672c\u6708\u8003\u52e4\u7edf\u8ba1</button>',
      '</div></div><div class="card-body">',this._attFilteredTable(records,employees),'</div></div>'
    ].join('');
  },

  _todayTable(todayRecords, employees) {
    var rows='';
    for(var i=0;i<todayRecords.length;i++){
      var r=todayRecords[i],emp=employees.find(function(e){return e.id===r.employeeId;});
      var sm={present:'<span class="tag tag-success">\u51fa\u52e4</span>',late:'<span class="tag tag-warning">\u8fdf\u5230</span>',absent:'<span class="tag tag-danger">\u7f3a\u52e4</span>'};
      rows+='<tr><td><strong>'+(emp?emp.name:'(\u5df2\u5220\u9664)')+'</strong></td><td>'+(emp?(emp.department||'-'):'-')+'</td><td>'+(r.checkIn||'-')+'</td><td>'+(r.checkOut||'-')+'</td><td>'+(sm[r.status]||'-')+'</td><td>';
      if(!r.checkOut)rows+='<button class="btn btn-info btn-sm" onclick="Attendance.showCheckoutModal('+r.id+')">\u7b7e\u9000</button> ';
      rows+='<button class="btn btn-danger btn-sm" onclick="Attendance.deleteRecord('+r.id+')">\u5220\u9664</button></td></tr>';
    }
    return '<div class="table-responsive"><table><thead><tr><th>\u5458\u5de5</th><th>\u90e8\u95e8</th><th>\u7b7e\u5230</th><th>\u7b7e\u9000</th><th>\u72b6\u6001</th><th>\u64cd\u4f5c</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  },

  _attDeptOptions() {
    var depts=[],emps=Store.getEmployees();
    emps.forEach(function(e){if(e.department&&depts.indexOf(e.department)<0)depts.push(e.department);});
    return depts.map(function(d){return '<option value="'+d+'">'+d+'</option>';}).join('');
  },

  _attFilteredTable(records, employees) {
    var dateFilter=document.getElementById('attDateFilter')?.value,
        deptFilter=document.getElementById('attDeptFilter')?.value;
    var filtered=[...records].sort(function(a,b){return b.id-a.id;});
    if(dateFilter)filtered=filtered.filter(function(r){return r.date===dateFilter;});
    if(deptFilter)filtered=filtered.filter(function(r){var emp=employees.find(function(e){return e.id===r.employeeId;});return emp&&emp.department===deptFilter;});
    if(filtered.length===0)return '<div class="empty-state"><div class="empty-icon">📋</div><p>\u6682\u65e0\u8003\u52e4\u8bb0\u5f55</p></div>';
    var rows='',sm={present:'<span class="tag tag-success">\u51fa\u52e4</span>',late:'<span class="tag tag-warning">\u8fdf\u5230</span>',absent:'<span class="tag tag-danger">\u7f3a\u52e4</span>'};
    for(var i=0;i<filtered.length;i++){var r=filtered[i],emp=employees.find(function(e){return e.id===r.employeeId;});
      rows+='<tr><td>'+r.date+'</td><td><strong>'+(emp?emp.name:'(\u5df2\u5220\u9664)')+'</strong></td><td>'+(emp?(emp.department||'-'):'-')+'</td><td>'+(r.checkIn||'-')+'</td><td>'+(r.checkOut||'-')+'</td><td>'+(sm[r.status]||'-')+'</td><td><button class="btn btn-danger btn-sm" onclick="Attendance.deleteRecord('+r.id+')">🗑️</button></td></tr>';
    }
    return '<div class="table-responsive"><table><thead><tr><th>\u65e5\u671f</th><th>\u5458\u5de5</th><th>\u90e8\u95e8</th><th>\u7b7e\u5230</th><th>\u7b7e\u9000</th><th>\u72b6\u6001</th><th>\u64cd\u4f5c</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  },

  showCheckinModal() {
    var emps=Store.getEmployees();
    if(emps.length===0){App.toast('\u8bf7\u5148\u6dfb\u52a0\u4eba\u5458\u4fe1\u606f','warning');return;}
    if (this._isRegular() && !this._isManagerUser()) {
      var eid = this._getMyEmployeeId();
      if (eid) emps = emps.filter(function(e){return e.id===eid;});
    }
    if (this._isRegular()) {
      var eid = this._getMyEmployeeId();
      if (eid) emps = emps.filter(function(e){return e.id===eid;});
    }
    var t=new Date(),ts=t.toTimeString().slice(0,5);
    App.openModal('\u7b7e\u5230','<div class="form-group"><label>\u9009\u62e9\u5458\u5de5 *</label><select class="form-control" id="attEmployee">'+emps.map(function(e){return '<option value="'+e.id+'">'+e.name+' ('+(e.department||'\u672a\u5206\u914d')+')</option>';}).join('')+'</select></div><div class="form-group"><label>\u65e5\u671f *</label><input type="date" class="form-control" id="attDate" value="'+App.today()+'"></div><div class="form-group"><label>\u7b7e\u5230\u65f6\u95f4</label><input type="time" class="form-control" id="attCheckIn" value="'+ts+'"></div><div class="form-group"><label>\u72b6\u6001</label><select class="form-control" id="attStatus"><option value="present">\u51fa\u52e4</option><option value="late">\u8fdf\u5230</option><option value="absent">\u7f3a\u52e4</option></select></div>','<button class="btn btn-primary" onclick="Attendance.saveCheckin()">\u4fdd\u5b58</button><button class="btn btn-outline" onclick="App.closeModal()">\u53d6\u6d88</button>');
  },

  showCheckoutModal(id) {
    var record=Store.getAttendance().find(function(r){return r.id===id;});
    if(!record)return;
    var t=new Date(),ts=t.toTimeString().slice(0,5);
    App.openModal('\u7b7e\u9000','<p>\u7b7e\u9000\u5458\u5de5\uff1a<strong>'+(Store.getEmployees().find(function(e){return e.id===record.employeeId;})?.name||'')+'</strong></p><div class="form-group" style="margin-top:12px;"><label>\u7b7e\u9000\u65f6\u95f4</label><input type="time" class="form-control" id="attCheckOut" value="'+ts+'"></div><input type="hidden" id="attRecordId" value="'+id+'">','<button class="btn btn-primary" onclick="Attendance.saveCheckout()">\u4fdd\u5b58</button><button class="btn btn-outline" onclick="App.closeModal()">\u53d6\u6d88</button>');
  },

  saveCheckin() {
    var eid=parseInt(document.getElementById('attEmployee').value),date=document.getElementById('attDate').value,ci=document.getElementById('attCheckIn').value,st=document.getElementById('attStatus').value;
    if(Store.getAttendance().filter(function(r){return r.employeeId===eid&&r.date===date;}).length>0){App.toast('\u8be5\u5458\u5de5\u5f53\u5929\u5df2\u6709\u8003\u52e4\u8bb0\u5f55','warning');return;}
    Store.addAttendance({employeeId:eid,date:date,checkIn:ci,status:st});App.toast('\u8003\u52e4\u8bb0\u5f55\u5df2\u6dfb\u52a0','success');App.closeModal();App.navigate('attendance');
  },

  saveCheckout() {
    Store.updateAttendance(parseInt(document.getElementById('attRecordId').value),{checkOut:document.getElementById('attCheckOut').value});
    App.toast('\u7b7e\u9000\u6210\u529f','success');App.closeModal();App.navigate('attendance');
  },

  deleteRecord(id) {
    if(App.confirm('\u786e\u5b9a\u5220\u9664\u6b64\u8003\u52e4\u8bb0\u5f55\uff1f')){Store.deleteAttendance(id);App.toast('\u5df2\u5220\u9664','info');App.navigate('attendance');}
  },

  allPresent() {
    var emps=Store.getEmployees(),today=App.today(),existing=Store.getAttendance().filter(function(r){return r.date===today;}),existingIds=new Set(existing.map(function(r){return r.employeeId;}));
    var missing=emps.filter(function(e){return !existingIds.has(e.id);});
    if(missing.length===0){App.toast('\u4eca\u65e5\u6240\u6709\u5458\u5de5\u5747\u5df2\u8003\u52e4','info');return;}
    var t=new Date(),ts=t.toTimeString().slice(0,5);
    if(!App.confirm('\u5c06\u4e3a '+missing.length+' \u540d\u672a\u8003\u52e4\u5458\u5de5\u6dfb\u52a0\u300c\u51fa\u52e4\u300d\u8bb0\u5f55\uff0c\u786e\u8ba4\uff1f'))return;
    missing.forEach(function(e){Store.addAttendance({employeeId:e.id,date:today,checkIn:ts,status:'present'});});
    App.toast('\u5df2\u4e3a '+missing.length+' \u4eba\u6dfb\u52a0\u51fa\u52e4\u8bb0\u5f55','success');App.navigate('attendance');
  },

  showMonthlyReport() {
    var emps=Store.getEmployees(),records=Store.getAttendance(),n=new Date(),y=n.getFullYear(),m=String(n.getMonth()+1).padStart(2,'0'),ym=y+'-'+m;
    var monthRecords=records.filter(function(r){return r.date&&r.date.indexOf(ym)===0;});
    var stats={};
    emps.forEach(function(e){stats[e.id]={name:e.name,dept:e.department,company:e.company,present:0,late:0,absent:0,total:0};});
    monthRecords.forEach(function(r){if(stats[r.employeeId]){stats[r.employeeId].total++;if(r.status==='present')stats[r.employeeId].present++;else if(r.status==='late')stats[r.employeeId].late++;else if(r.status==='absent')stats[r.employeeId].absent++;}});
    var data=[];
    for(var id in stats){if(stats[id].total>0)data.push(stats[id]);}
    data.sort(function(a,b){return (a.total>0?a.present/a.total:0)-(b.total>0?b.present/b.total:0);});
    if(data.length===0){App.openModal(y+'\u5e74'+m+'\u6708 \u8003\u52e4\u7edf\u8ba1','<div class="empty-state"><div class="empty-icon">📊</div><p>\u672c\u6708\u6682\u65e0\u8003\u52e4\u6570\u636e</p></div>','<button class="btn btn-outline" onclick="App.closeModal()">\u5173\u95ed</button>');return;}
    var tp=data.reduce(function(s,d){return s+d.present;},0),tl=data.reduce(function(s,d){return s+d.late;},0),ta=data.reduce(function(s,d){return s+d.absent;},0),tt=tp+tl+ta,or=tt>0?Math.round(tp/tt*100):0;
    var h=[];
    h.push('<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">');
    h.push('<div style="text-align:center;padding:12px;background:#f0fdf4;border-radius:12px;"><div style="font-size:24px;font-weight:700;color:#16a34a;">'+tp+'</div><div style="font-size:12px;color:#666;">\u51fa\u52e4</div></div>');
    h.push('<div style="text-align:center;padding:12px;background:#fefce8;border-radius:12px;"><div style="font-size:24px;font-weight:700;color:#ca8a04;">'+tl+'</div><div style="font-size:12px;color:#666;">\u8fdf\u5230</div></div>');
    h.push('<div style="text-align:center;padding:12px;background:#fef2f2;border-radius:12px;"><div style="font-size:24px;font-weight:700;color:#dc2626;">'+ta+'</div><div style="font-size:12px;color:#666;">\u7f3a\u52e4</div></div>');
    h.push('<div style="text-align:center;padding:12px;background:'+(or>=90?'#f0fdf4':'#fefce8')+';border-radius:12px;"><div style="font-size:24px;font-weight:700;color:'+(or>=90?'#16a34a':'#ca8a04')+';">'+or+'%</div><div style="font-size:12px;color:#666;">\u51fa\u52e4\u7387</div></div></div>');
    h.push('<div class="table-responsive" style="max-height:360px;overflow-y:auto;"><table><thead><tr><th>#</th><th>\u5458\u5de5</th><th>\u90e8\u95e8</th><th>\u516c\u53f8</th><th>\u51fa\u52e4</th><th>\u8fdf\u5230</th><th>\u7f3a\u52e4</th><th>\u51fa\u52e4\u7387</th><th>\u8bc4\u4ef7</th></tr></thead><tbody>');
    for(var i=0;i<data.length;i++){var d=data[i],r=d.total>0?Math.round(d.present/d.total*100):0,rank=i+1,medal=rank===1?'🥇':(rank===2?'🥈':(rank===3?'🥉':rank)),badge=r>=90?'<span class="tag tag-success">\u4f18\u79c0</span>':(r>=70?'<span class="tag tag-warning">\u6ce8\u610f</span>':'<span class="tag tag-danger">\u8b66\u793a</span>'),bg=d.late>2||d.absent>1?' style="background:#fef2f2;"':'';h.push('<tr'+bg+'><td>'+medal+'</td><td><strong>'+d.name+'</strong></td><td>'+(d.dept||'-')+'</td><td style="font-size:12px;">'+(d.company||'-')+'</td><td style="color:var(--success);">'+d.present+'</td><td style="color:var(--warning);">'+d.late+'</td><td style="color:var(--danger);">'+d.absent+'</td><td style="font-weight:600;">'+r+'%</td><td>'+badge+'</td></tr>');}
    h.push('</tbody></table></div><p style="margin-top:12px;font-size:12px;color:var(--text-light);">\u7edf\u8ba1\u5468\u671f\uff1a'+y+'\u5e74'+m+'\u6708 \u00b7 \u6309\u51fa\u52e4\u7387\u5347\u5e8f\u6392\u5217</p>');
    App.openModal(y+'\u5e74'+m+'\u6708 \u8003\u52e4\u7edf\u8ba1',h.join(''),'<button class="btn btn-outline" onclick="App.closeModal()">\u5173\u95ed</button>');
  },

  // ===== Tab 2: 加班 =====
  _renderOtTab(sub) {
    var list=Store.getOvertime(),emps=Store.getEmployees(),today=App.today();
    if (this._isRegular() && !this._isManagerUser()) {
      var myEid = this._getMyEmployeeId();
      if (myEid) list = list.filter(function(o){return o.employeeId===myEid;});
      sub.innerHTML = [
        '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">',
          '<span style="font-size:16px;font-weight:600;">⏰ 我的加班</span>',
          '<button class="btn btn-primary" onclick="Attendance.otShowAddModal()">+ 申请加班</button>',
        '</div>',
        this._durationSummary(Store.getTimeBalance(myEid), '我的'),
        '<div class="card"><div class="card-header"><h3>📋 加班记录</h3></div><div class="card-body">',
          this._otRenderTable(list,emps),"</div></div>"
      ].join("");
      return;
    }
    var list=Store.getOvertime(),emps=Store.getEmployees(),today=App.today();
    var todayList=list.filter(function(o){return o.date===today;}),todayHours=todayList.reduce(function(s,o){return s+(parseFloat(o.hours)||0);},0);
    var month=today.substring(0,7),monthList=list.filter(function(o){return o.date&&o.date.indexOf(month)===0;}),monthHours=monthList.reduce(function(s,o){return s+(parseFloat(o.hours)||0);},0);
    var pending=list.filter(function(o){return o.status==='pending';}).length;
    var duration=Store.getTimeBalance();

    sub.innerHTML = [
      '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">',
        '<span style="font-size:16px;font-weight:600;">⏰ \u52a0\u73ed\u7edf\u8ba1</span>',
        '<button class="btn btn-primary" onclick="Attendance.otShowAddModal()">+ \u7533\u8bf7\u52a0\u73ed</button>',
      '</div>',
      '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);">',
        '<div class="stat-card primary"><div class="stat-icon">⏰</div><div class="stat-label">\u4eca\u65e5\u52a0\u73ed\u4eba\u6b21</div><div class="stat-value">'+todayList.length+'</div></div>',
        '<div class="stat-card success"><div class="stat-icon">⏱️</div><div class="stat-label">\u4eca\u65e5\u52a0\u73ed\u65f6\u957f</div><div class="stat-value">'+todayHours.toFixed(1)+'h</div></div>',
        '<div class="stat-card warning"><div class="stat-icon">📅</div><div class="stat-label">\u672c\u6708\u52a0\u73ed</div><div class="stat-value">'+monthHours.toFixed(1)+'h</div></div>',
        '<div class="stat-card info"><div class="stat-icon">💼</div><div class="stat-label">\u5f85\u5ba1\u6838</div><div class="stat-value">'+pending+'</div></div>',
      '</div>',
      this._durationSummary(duration, '累计'),
      '<div class="card"><div class="card-header"><h3>📋 \u52a0\u73ed\u8bb0\u5f55</h3></div><div class="card-body">',
        this._otRenderTable(list,emps),'</div></div>'
    ].join('');
  },

  _otRenderTable(list, emps) {
    var isSimplified = this._isRegular() && !this._isManagerUser();
    var filtered=[...list].sort(function(a,b){return b.id-a.id;});
    if(filtered.length===0)return '<div class="empty-state"><div class="empty-icon">\u23f0</div><p>\u6682\u65e0\u52a0\u73ed\u8bb0\u5f55</p></div>';
    if (isSimplified) {
      var html='<div class="table-responsive"><table><thead><tr><th>\u65e5\u671f</th><th>\u5458\u5de5</th><th>\u52a0\u73ed\u7c7b\u578b</th><th>\u65f6\u957f</th><th>\u539f\u56e0</th><th>\u72b6\u6001</th></tr></thead><tbody>';
      for(var i=0;i<filtered.length;i++){var o=filtered[i];var emp=emps.find(function(e){return e.id===o.employeeId;});var sl='\u5f85\u5ba1\u6838',sc='tag-warning';if(o.status==='approved'){sl='\u5df2\u6279\u51c6';sc='tag-success';}if(o.status==='rejected'){sl='\u5df2\u62d2\u7edd';sc='tag-danger';}
        html+='<tr><td>'+o.date+'</td><td><strong>'+(emp?emp.name:'-')+'</strong></td><td>'+(o.overtimeType==='compensatory'?'调休加班':'费用加班')+'</td><td>'+(parseFloat(o.hours)||0).toFixed(1)+'h</td><td>'+(o.reason||'-')+'</td><td><span class="tag '+sc+'">'+sl+'</span></td></tr>';}
      html+='</tbody></table></div>';return html;
    }
    var html='<div class="table-responsive"><table><thead><tr><th>\u65e5\u671f</th><th>\u5458\u5de5</th><th>\u90e8\u95e8</th><th>\u52a0\u73ed\u7c7b\u578b</th><th>\u65f6\u957f</th><th>\u539f\u56e0</th><th>\u72b6\u6001</th><th>\u64cd\u4f5c</th></tr></thead><tbody>';
    for(var i=0;i<filtered.length;i++){var o=filtered[i],emp=emps.find(function(e){return e.id===o.employeeId;});var sl='\u5f85\u5ba1\u6838',sc='tag-warning';if(o.status==='approved'){sl='\u5df2\u6279\u51c6';sc='tag-success';}if(o.status==='rejected'){sl='\u5df2\u62d2\u7edd';sc='tag-danger';}
      html+='<tr><td>'+o.date+'</td><td><strong>'+(emp?emp.name:'(\u5df2\u5220\u9664)')+'</strong></td><td>'+(emp?(emp.department||'-'):'-')+'</td><td>'+(o.overtimeType==='compensatory'?'调休加班':'费用加班')+'</td><td>'+(parseFloat(o.hours)||0).toFixed(1)+'h</td><td>'+(o.reason||'-')+'</td><td><span class="tag '+sc+'">'+sl+'</span></td><td>';
      if(o.status==='pending'){html+='<button class="btn btn-success btn-sm" onclick="Attendance.otApprove('+o.id+')">\u6279\u51c6</button> <button class="btn btn-danger btn-sm" onclick="Attendance.otReject('+o.id+')">\u62d2\u7edd</button> ';}
      html+='<button class="btn btn-outline btn-sm" onclick="Attendance.otShowEditModal('+o.id+')">\u7f16\u8f91</button> <button class="btn btn-danger btn-sm" onclick="Attendance.otDeleteRecord('+o.id+')">\u5220\u9664</button></td></tr>';}
    html+='</tbody></table></div>';return html;
  },

  otShowAddModal() {
    var emps=Store.getEmployees();var _cu=Auth.currentUser();if(_cu&&_cu.role!='admin'){emps=emps.filter(function(e){return e.name===_cu.name;});}if(emps.length===0){App.toast('请先添加人员','warning');return;}
    App.openModal('\u7533\u8bf7\u52a0\u73ed','<div class="form-group"><label>\u9009\u62e9\u5458\u5de5 *</label><select class="form-control" id="otEmployee">'+emps.map(function(e){return '<option value="'+e.id+'">'+e.name+' ('+(e.department||'')+')</option>';}).join('')+'</select></div><div class="form-group"><label>\u52a0\u73ed\u7c7b\u578b *</label><select class="form-control" id="otType"><option value="fee">\u8d39\u7528\u52a0\u73ed</option><option value="compensatory">\u8c03\u4f11\u52a0\u73ed</option></select></div><div class="form-group"><label>\u52a0\u73ed\u65e5\u671f *</label><input type="date" class="form-control" id="otDate" value="'+App.today()+'"></div><div class="form-group"><label>\u52a0\u73ed\u65f6\u957f\uff08\u5c0f\u65f6\uff09*</label><input type="number" class="form-control" id="otHours" value="2" min="0.5" step="0.5"></div><div class="form-group"><label>\u52a0\u73ed\u539f\u56e0</label><input type="text" class="form-control" id="otReason" placeholder="\u8bf7\u8f93\u5165\u52a0\u73ed\u539f\u56e0"></div>','<button class="btn btn-primary" onclick="Attendance.otSaveAdd()">\u63d0\u4ea4</button><button class="btn btn-outline" onclick="App.closeModal()">\u53d6\u6d88</button>');
  },

  otSaveAdd() {
    var eid=parseInt(document.getElementById('otEmployee').value),type=document.getElementById('otType').value,date=document.getElementById('otDate').value,hrs=parseFloat(document.getElementById('otHours').value)||0,reason=document.getElementById('otReason').value.trim();
    if(!date||hrs<=0){App.toast('\u8bf7\u586b\u5199\u5b8c\u6574\u4fe1\u606f','error');return;}
    Store.addOvertime({employeeId:eid,overtimeType:type,date:date,hours:hrs,reason:reason,status:'pending'});
    App.toast('\u52a0\u73ed\u7533\u8bf7\u5df2\u63d0\u4ea4','success');App.closeModal();App.navigate('attendance');Attendance._activeTab='overtime';
  },

  otShowEditModal(id) {
    var o=Store.getOvertime().find(function(ot){return ot.id===id;});if(!o)return;
    var emp=Store.getEmployees().find(function(e){return e.id===o.employeeId;});
    App.openModal('\u7f16\u8f91\u52a0\u73ed\u8bb0\u5f55','<div class="form-group"><label>\u5458\u5de5</label><input type="text" class="form-control" value="'+(emp?emp.name:'')+'" disabled></div><div class="form-group"><label>\u52a0\u73ed\u7c7b\u578b</label><select class="form-control" id="otEditType"><option value="fee"'+(o.overtimeType!=='compensatory'?' selected':'')+'>\u8d39\u7528\u52a0\u73ed</option><option value="compensatory"'+(o.overtimeType==='compensatory'?' selected':'')+'>\u8c03\u4f11\u52a0\u73ed</option></select></div><div class="form-group"><label>\u52a0\u73ed\u65e5\u671f</label><input type="date" class="form-control" id="otEditDate" value="'+o.date+'"></div><div class="form-group"><label>\u52a0\u73ed\u65f6\u957f\uff08\u5c0f\u65f6\uff09</label><input type="number" class="form-control" id="otEditHours" value="'+(parseFloat(o.hours)||0)+'" min="0.5" step="0.5"></div><div class="form-group"><label>\u52a0\u73ed\u539f\u56e0</label><input type="text" class="form-control" id="otEditReason" value="'+(o.reason||'')+'"></div><input type="hidden" id="otEditId" value="'+id+'">','<button class="btn btn-primary" onclick="Attendance.otSaveEdit()">\u4fdd\u5b58</button><button class="btn btn-outline" onclick="App.closeModal()">\u53d6\u6d88</button>');
  },

  otSaveEdit() {
    var id=parseInt(document.getElementById('otEditId').value),type=document.getElementById('otEditType').value,date=document.getElementById('otEditDate').value,hrs=parseFloat(document.getElementById('otEditHours').value)||0,reason=document.getElementById('otEditReason').value.trim();
    Store.updateOvertime(id,{overtimeType:type,date:date,hours:hrs,reason:reason});App.toast('\u5df2\u66f4\u65b0','success');App.closeModal();App.navigate('attendance');Attendance._activeTab='overtime';
  },

  otApprove(id){Store.updateOvertime(id,{status:'approved'});App.toast('\u5df2\u6279\u51c6','success');App.navigate('attendance');Attendance._activeTab='overtime';},
  otReject(id){Store.updateOvertime(id,{status:'rejected'});App.toast('\u5df2\u62d2\u7edd','info');App.navigate('attendance');Attendance._activeTab='overtime';},

  otDeleteRecord(id){if(App.confirm('\u786e\u5b9a\u5220\u9664\u6b64\u52a0\u73ed\u8bb0\u5f55\uff1f')){Store.deleteOvertime(id);App.toast('\u5df2\u5220\u9664','info');App.navigate('attendance');Attendance._activeTab='overtime';}},

  // ===== Tab 3: 请假 =====
  _renderLeaveTab(sub) {
    var leaves=Store.getLeaveRequests(),employees=Store.getEmployees();
    if (this._isRegular() && !this._isManagerUser()) {
      var myEid = this._getMyEmployeeId();
      if (myEid) leaves = leaves.filter(function(l){return l.employeeId===myEid;});
      sub.innerHTML = [
        this._durationSummary(Store.getTimeBalance(myEid), '我的'),
        '<div class="card"><div class="card-header"><h3>📋 我的请假</h3><button class="btn btn-primary" onclick="Attendance.lvShowApplyModal()">+ 申请请假</button></div><div class="card-body">',
          this._lvRenderTable(leaves,employees),"</div></div>"
      ].join("");
      return;
    }
    leaves=Store.getLeaveRequests(),employees=Store.getEmployees();
    var pending=leaves.filter(function(l){return l.status==='pending';}).length;
    var approved=leaves.filter(function(l){return l.status==='approved';}).length;
    var rejected=leaves.filter(function(l){return l.status==='rejected';}).length;
    var duration=Store.getTimeBalance();

    sub.innerHTML = [
      '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">',
        '<div class="stat-card info"><div class="stat-icon">📋</div><div class="stat-label">\u603b\u7533\u8bf7</div><div class="stat-value">'+leaves.length+'</div></div>',
        '<div class="stat-card warning"><div class="stat-icon">⏳</div><div class="stat-label">\u5f85\u5ba1\u6279</div><div class="stat-value">'+pending+'</div></div>',
        '<div class="stat-card success"><div class="stat-icon">✅</div><div class="stat-label">\u5df2\u6279\u51c6</div><div class="stat-value">'+approved+'</div></div>',
        '<div class="stat-card danger"><div class="stat-icon">❌</div><div class="stat-label">\u5df2\u62d2\u7edd</div><div class="stat-value">'+rejected+'</div></div>',
      '</div>',
      this._durationSummary(duration, '累计'),
      '<div class="card"><div class="card-header"><h3>📋 \u8bf7\u5047\u5217\u8868</h3><button class="btn btn-primary" onclick="Attendance.lvShowApplyModal()">+ \u7533\u8bf7\u8bf7\u5047</button></div><div class="card-body">',
        '<div class="filter-row"><select class="form-control" id="leaveStatusFilter" style="max-width:140px;" onchange="Attendance._renderLeaveTab(document.getElementById(\'attSubContent\'))"><option value="">\u5168\u90e8\u72b6\u6001</option><option value="pending">\u5f85\u5ba1\u6279</option><option value="approved">\u5df2\u6279\u51c6</option><option value="rejected">\u5df2\u62d2\u7edd</option></select></div>',
        this._lvRenderTable(leaves,employees),'</div></div>'
    ].join('');
  },

  _lvRenderTable(leaves, employees) {
    var isSimplified = this._isRegular() && !this._isManagerUser();
    var filter=isSimplified?'':document.getElementById('leaveStatusFilter')?.value;
    var filtered=[...leaves].sort(function(a,b){return b.id-a.id;});
    if(filter)filtered=filtered.filter(function(l){return l.status===filter;});
    if(filtered.length===0)return '<div class="empty-state"><div class="empty-icon">📋</div><p>\u6682\u65e0\u8bf7\u5047\u8bb0\u5f55</p></div>';
    var sm={pending:'<span class="tag tag-warning">\u23f3 \u5f85\u5ba1\u6279</span>',approved:'<span class="tag tag-success">\u2705 \u5df2\u6279\u51c6</span>',rejected:'<span class="tag tag-danger">\u274c \u5df2\u62d2\u7edd</span>'};
    var tm={compensatory:'调休请假',leave:'请假',shift:'替班请假',sick:'\u75c5\u5047',personal:'\u4e8b\u5047',annual:'\u5e74\u5047',marriage:'\u5a5a\u5047',maternity:'\u4ea7\u5047',other:'\u5176\u4ed6'};
    function durationText(l){return l.type==='compensatory' ? ((parseFloat(l.hours)||0).toFixed(1)+'h') : ((parseFloat(l.days)||0)+'天');}
    if (isSimplified) {
      var html='<div class="table-responsive"><table><thead><tr><th>\u7533\u8bf7\u7f16\u53f7</th><th>\u5458\u5de5</th><th>\u8bf7\u5047\u7c7b\u578b</th><th>\u8d77\u6b62\u65e5\u671f</th><th>\u65f6\u957f</th><th>\u539f\u56e0</th><th>\u72b6\u6001</th></tr></thead><tbody>';
      for(var i=0;i<filtered.length;i++){var l=filtered[i];var emp=employees.find(function(e){return e.id===l.employeeId;});
        html+='<tr><td>#'+String(l.id).padStart(4,'0')+'</td><td><strong>'+(emp?emp.name:'-')+'</strong></td><td>'+(tm[l.type]||l.type)+'</td><td>'+App.formatDate(l.startDate)+' ~ '+App.formatDate(l.endDate)+'</td><td>'+durationText(l)+'</td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+(l.reason||'')+'">'+(l.reason||'-')+'</td><td>'+(sm[l.status]||'-')+'</td></tr>';}
      html+='</tbody></table></div>';return html;
    }
    var html='<div class="table-responsive"><table><thead><tr><th>\u7533\u8bf7\u7f16\u53f7</th><th>\u5458\u5de5</th><th>\u90e8\u95e8</th><th>\u8bf7\u5047\u7c7b\u578b</th><th>\u8d77\u6b62\u65e5\u671f</th><th>\u65f6\u957f</th><th>\u539f\u56e0</th><th>\u72b6\u6001</th><th>\u64cd\u4f5c</th></tr></thead><tbody>';
    for(var i=0;i<filtered.length;i++){var l=filtered[i],emp=employees.find(function(e){return e.id===l.employeeId;});
      html+='<tr><td>#'+String(l.id).padStart(4,'0')+'</td><td><strong>'+(emp?emp.name:'(\u5df2\u5220\u9664)')+'</strong></td><td>'+(emp?(emp.department||'-'):'-')+'</td><td>'+(tm[l.type]||l.type)+'</td><td>'+App.formatDate(l.startDate)+' ~ '+App.formatDate(l.endDate)+'</td><td>'+durationText(l)+'</td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+(l.reason||'')+'">'+(l.reason||'-')+'</td><td>'+(sm[l.status]||'-')+'</td><td>';
      if(l.status==='pending')html+='<button class="btn btn-success btn-sm" onclick="Attendance.lvApprove('+l.id+')">\u6279\u51c6</button> <button class="btn btn-danger btn-sm" onclick="Attendance.lvReject('+l.id+')">\u62d2\u7edd</button>';else html+='-';
      html+='</td></tr>';}
    html+='</tbody></table></div>';return html;
  },

  lvShowApplyModal() {
    var emps=Store.getEmployees();var _cu=Auth.currentUser();if(_cu&&_cu.role!='admin'){emps=emps.filter(function(e){return e.name===_cu.name;});}if(emps.length===0){App.toast('请先添加人员信息','warning');return;}
    App.openModal('\u7533\u8bf7\u8bf7\u5047','<div class="form-group"><label>\u9009\u62e9\u5458\u5de5 *</label><select class="form-control" id="leaveEmployee">'+emps.map(function(e){return '<option value="'+e.id+'">'+e.name+' ('+(e.department||'\u672a\u5206\u914d')+')</option>';}).join('')+'</select></div><div class="form-group"><label>\u8bf7\u5047\u7c7b\u578b *</label><select class="form-control" id="leaveType"><option value="compensatory">调休请假</option><option value="leave">请假</option><option value="shift">替班请假</option></select></div><div class="form-row"><div class="form-group"><label>\u5f00\u59cb\u65e5\u671f *</label><input type="date" class="form-control" id="leaveStart" value="'+App.today()+'"></div><div class="form-group"><label>\u7ed3\u675f\u65e5\u671f *</label><input type="date" class="form-control" id="leaveEnd" value="'+App.today()+'"></div></div><div class="form-group"><label>调休请假时长（小时，调休请假必填）</label><input type="number" class="form-control" id="leaveHours" value="0" min="0.5" step="0.5"></div><div class="form-group"><label>\u8bf7\u5047\u539f\u56e0</label><textarea class="form-control" id="leaveReason" placeholder="\u8bf7\u8f93\u5165\u8bf7\u5047\u539f\u56e0"></textarea></div>','<button class="btn btn-primary" onclick="Attendance.lvSaveApply()">\u63d0\u4ea4\u7533\u8bf7</button><button class="btn btn-outline" onclick="App.closeModal()">\u53d6\u6d88</button>');
  },

  lvSaveApply() {
    var eid=parseInt(document.getElementById('leaveEmployee').value),type=document.getElementById('leaveType').value,sd=document.getElementById('leaveStart').value,ed=document.getElementById('leaveEnd').value,hours=parseFloat(document.getElementById('leaveHours').value)||0,reason=document.getElementById('leaveReason').value.trim();
    if(!sd||!ed){App.toast('\u8bf7\u9009\u62e9\u8d77\u6b62\u65e5\u671f','error');return;}
    var s=new Date(sd),e=new Date(ed);if(e<s){App.toast('\u7ed3\u675f\u65e5\u671f\u4e0d\u80fd\u65e9\u4e8e\u5f00\u59cb\u65e5\u671f','error');return;}
    var days=Math.floor((e-s)/(1000*60*60*24))+1;
    var emp=Store.getEmployees().find(function(item){return item.id===eid;});
    if(type==='shift' && !Store._isOutsourced(emp)){App.toast('替班请假仅限外包单位外派人员使用','error');return;}
    if(type==='compensatory'){
      if(hours<=0){App.toast('调休请假必须填写调休小时数','error');return;}
      var balance=Store.getTimeBalance(eid);
      if(hours>balance.remainingHours){App.toast('调休时长不足，当前剩余 '+balance.remainingHours.toFixed(1)+' 小时','error');return;}
    }
    Store.addLeaveRequest({employeeId:eid,type:type,startDate:sd,endDate:ed,days:days,hours:type==='compensatory'?hours:0,reason:reason});
    App.toast('\u8bf7\u5047\u7533\u8bf7\u5df2\u63d0\u4ea4\uff0c\u7b49\u5f85\u5ba1\u6279','success');App.closeModal();App.navigate('attendance');Attendance._activeTab='leave';
  },

  lvApprove(id){
    var leave=Store.getLeaveRequests().find(function(item){return item.id===id;});
    if(leave && Store.isCompensatoryLeave(leave)){
      var balance=Store.getTimeBalance(leave.employeeId);
      if((parseFloat(leave.hours)||0)>balance.remainingHours){App.toast('调休时长不足，无法批准该申请','error');return;}
    }
    Store.updateLeaveRequest(id,{status:'approved'});App.toast('\u5df2\u6279\u51c6\u8be5\u8bf7\u5047\u7533\u8bf7','success');App.navigate('attendance');Attendance._activeTab='leave';
  },
  lvReject(id){Store.updateLeaveRequest(id,{status:'rejected'});App.toast('\u5df2\u62d2\u7edd\u8be5\u8bf7\u5047\u7533\u8bf7','info');App.navigate('attendance');Attendance._activeTab='leave';},
};
