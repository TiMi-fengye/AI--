const Store = {
  _namespace: "personnel_management_",
  _performanceKey: "personnel_performance",
  _defaultOperator: "",
  _serverSyncTimer: null,
  _serverSyncReady: false,
  _serverHydrating: false,
  _syncPromise: null,
  _writeVersion: 0,
  _syncedVersion: 0,
  _lastServerSnapshot: null,
  _data: Object.create(null),
  _memoryOnly: false,

  init() {
    const list = this.getEmployees();
    if (!this.get("initialized")) this.set("initialized", true);
    if (list.length === 0) {
      const now = new Date().toISOString();
      this.set("employees", []);
    }
    if (!this.get("attendance")) this.set("attendance", []);
    if (!this.get("leave_requests")) this.set("leave_requests", []);
    if (!this.get("overtime")) this.set("overtime", []);
    if (!this.get("settlements")) this.set("settlements", []);
    if (!this.get("update_logs")) this.set("update_logs", []);
    if (!this.get("departments") || this.get("departments").length === 0) this.set("departments", ["部门A", "部门B"]);
    // 迁移旧员工字段
    var _emps = this.getEmployees();
    var _changed = false;
    for (var _i = 0; _i < _emps.length; _i++) {
      var _e = _emps[_i];
      if (!_e.region) { _e.region = "区域A"; _changed = true; }
      if (!_e.room) { _e.room = "机房A"; _changed = true; }
      // 飞书绑定已停用，删除遗留身份字段，保留人员业务资料。
      ["feishuOpenId", "feishuUserId", "feishuUnionId"].forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(_e, field)) { delete _e[field]; _changed = true; }
      });
      // 数据迁移与兼容处理：缺失性别使用中性默认值。
      if (_e.gender !== "男" && _e.gender !== "女") {
        _e.gender = "男"; _changed = true;
      }
    }
    if (_changed) this.set("employees", _emps);
    this.refreshRates();
    this._updateStats();
  },

  get(key) {
    if (this._memoryOnly && this._isServerDataKey(key)) return this._data[key] == null ? null : JSON.parse(JSON.stringify(this._data[key]));
    try { const raw = localStorage.getItem(this._namespace + key); return raw ? JSON.parse(raw) : null; } catch(e) { return null; }
  },
  set(key, value) {
    if (this._memoryOnly && this._isServerDataKey(key)) this._data[key] = JSON.parse(JSON.stringify(value));
    else localStorage.setItem(this._namespace + key, JSON.stringify(value));
    if (this._serverSyncReady && !this._serverHydrating && this._isServerDataKey(key)) { this._writeVersion++; this._queueServerSync(); }
  },
  remove(key) {
    if (this._memoryOnly && this._isServerDataKey(key)) delete this._data[key];
    else localStorage.removeItem(this._namespace + key);
    if (this._serverSyncReady && !this._serverHydrating && this._isServerDataKey(key)) { this._writeVersion++; this._queueServerSync(); }
  },

  _isServerDataKey(key) {
    return ["initialized", "employees", "attendance", "leave_requests", "overtime", "settlements", "departments", "org_structure", "update_logs", "stats", "personnel_performance"].indexOf(key) >= 0;
  },

  _queueServerSync() {
    var self = this;
    if (typeof fetch !== "function") return;
    if (this._serverSyncTimer) clearTimeout(this._serverSyncTimer);
    this._serverSyncTimer = setTimeout(function() {
      self._serverSyncTimer = null;
      self.flushServerSync().catch(function(error) { if (typeof App !== 'undefined') App.toast(error.message, 'error'); });
    }, 700);
  },

  syncSnapshotToServer() { this._writeVersion++; return this.flushServerSync(); },

  async flushServerSync() {
    if (!this._serverSyncReady) throw new Error('数据尚未加载完成，请稍后重试');
    if (this._serverSyncTimer) { clearTimeout(this._serverSyncTimer); this._serverSyncTimer = null; }
    if (this._syncPromise) return this._syncPromise;
    if (this._syncedVersion >= this._writeVersion) return true;
    this._syncPromise = (async () => {
      try {
        while (this._syncedVersion < this._writeVersion) {
          const version = this._writeVersion;
          const snapshot = this.exportSnapshot();
          const response = await fetch('/api/data/snapshot.json', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot)
          });
          const data = await response.json();
          if (!response.ok || data.ok === false || data.status === 'error') throw new Error(data.message || '保存失败，请重试');
          if (data.user && typeof Auth !== 'undefined') { Auth._user = data.user; Auth._updateUI(); }
          this._lastServerSnapshot = snapshot;
          if (data.revision != null) this._revision = data.revision;
          this._syncedVersion = version;
        }
        return true;
      } catch (error) {
        // 撤回被服务器拒绝的乐观更新，避免重试时重复提交申请。
        try { await this.restoreFromServer(); } catch (_) {
          if (this._lastServerSnapshot) this._hydrate(this._lastServerSnapshot);
        }
        this._syncedVersion = this._writeVersion;
        throw error;
      } finally { this._syncPromise = null; }
    })();
    return this._syncPromise;
  },

  _hydrate(snapshot) {
    this._serverHydrating = true;
    try { this.importSnapshot(snapshot); this.set('initialized', true); }
    finally { this._serverHydrating = false; }
  },
  async restoreFromServer() {
    const response = await fetch('/api/data/snapshot.json', { cache: 'no-store', credentials: 'same-origin' });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.message || '服务器数据读取失败');
    const snapshot = payload && Array.isArray(payload.employees) ? payload : { employees: [] };
    this._hydrate(snapshot);
    this._lastServerSnapshot = snapshot;
    this._revision = snapshot.revision;
    return true;
  },
  clearSessionData() {
    this._serverSyncReady = false;
    if (this._serverSyncTimer) clearTimeout(this._serverSyncTimer);
    this._serverSyncTimer = null;
    this._writeVersion = this._syncedVersion = 0;
    this._lastServerSnapshot = null;
    this._data = Object.create(null);
    this._memoryOnly = true;
    if (typeof AI !== 'undefined') AI.messages = [];
    Object.keys(localStorage).filter(key => key.startsWith(this._namespace)).forEach(key => localStorage.removeItem(key));
    localStorage.removeItem(this._performanceKey);
    localStorage.removeItem('personnel_users');
    localStorage.removeItem('personnel_data_owner');
    sessionStorage.removeItem('personnel_auth_session');
  },

  /* ===== 员工数据 ===== */
  setOperator(name) { this._defaultOperator = name || ""; },
  getOperator() { return this._defaultOperator || ""; },

  /* ===== 操作人 ===== */
  getEmployees() { return this.get("employees") || []; },

  _nextId(rows) { return rows.reduce(function(id, row) { return Math.max(id, Number(row.id || 0) + 1); }, Date.now()); },

  addEmployee(emp) {
    var es = this.getEmployees();
    emp.id = this._nextId(es);
    emp.createdAt = new Date().toISOString();
    if (!emp.region) emp.region = "区域A";
    if (!emp.room) emp.room = "机房A";
    if (!emp.gender) emp.gender = "男";
    if (!emp.joinDate) emp.joinDate = new Date().toISOString().split("T")[0];
    es.push(emp);
    this.set("employees", es);
    this.logPersonnelChange("add", emp);
    this.refreshRates();
    this._updateStats();
    return emp;
  },

  updateEmployee(id, data) {
    var es = this.getEmployees();
    for (var i = 0; i < es.length; i++) {
      if (es[i].id === id) {
        es[i] = Object.assign({}, es[i], data, {updatedAt: new Date().toISOString()});
        this.set("employees", es);
        this.logPersonnelChange("update", es[i]);
        this.refreshRates();
        this._updateStats();
        return es[i];
      }
    }
    return null;
  },

  deleteEmployee(id) {
    var removing = this.getEmployees().find(function(e){return e.id === id;});
    this.set("employees", this.getEmployees().filter(function(e){return e.id !== id;}));
    this.set("attendance", this.getAttendance().filter(function(r){return r.employeeId !== id;}));
    this.set("leave_requests", this.getLeaveRequests().filter(function(r){return r.employeeId !== id;}));
    this.set("overtime", this.getOvertime().filter(function(r){return r.employeeId !== id;}));
    if (removing) this.logPersonnelChange("remove", removing);
    this._clearSettlementCache();
    this._updateStats();
  },

  clearEmployees() {
    this.set("employees", []);
    this.set("attendance", []);
    this.set("leave_requests", []);
    this.set("overtime", []);
    this.set("settlements", []);
    this.set(this._performanceKey, []);
    this._updateStats();
  },

  clearEmployeesByRooms(rooms) {
    var self = this;
    var set = {};
    (rooms || []).forEach(function(r){ set[String(r).replace(/机房\s*$/, "").trim()] = true; });
    var kept = this.getEmployees().filter(function(emp){
      var room = String(emp.room || "").replace(/机房\s*$/, "").trim();
      return !set[room];
    });
    var removed = this.getEmployees().length - kept.length;
    if (removed > 0) {
      var ids = {};
      kept.forEach(function(emp){ ids[emp.id] = true; });
      this.set("employees", kept);
      this.set("attendance", this.getAttendance().filter(function(r){return ids[r.employeeId];}));
      this.set("leave_requests", this.getLeaveRequests().filter(function(r){return ids[r.employeeId];}));
      this.set("overtime", this.getOvertime().filter(function(r){return ids[r.employeeId];}));
      this._updateStats();
    }
    return removed;
  },

  /* 数据处理 */
  getUpdateLogs() { return this.get("update_logs") || []; },

  logPersonnelChange(action, employee) {
    var now = new Date();
    var date = now.toISOString().slice(0, 10);
    var logs = this.getUpdateLogs();
    logs.unshift({
      id: Date.now(),
      date: date,
      yearMonth: date.slice(0, 7),
      operator: this.getOperator(),
      action: action,
      employeeName: (employee && employee.name) || "",
      building: (employee && employee.building) || "",
      late: now.getDate() > 10,
      createdAt: now.toISOString()
    });
    this.set("update_logs", logs.slice(0, 500));
  },

  getMonthUpdateLogs() {
    var ym = new Date().toISOString().slice(0, 7);
    return this.getUpdateLogs().filter(function(item){ return item.yearMonth === ym; });
  },

  getLateUpdateCount() {
    var ym = new Date().toISOString().slice(0, 7);
    return this.getUpdateLogs().filter(function(item){ return item.yearMonth === ym && item.late; }).length;
  },

  /* 数据处理 */
  getAttendance() { return this.get("attendance") || []; },
  addAttendance(r) { var a = this.getAttendance(); r.id = this._nextId(a); a.push(r); this.set("attendance", a); this._updateStats(); return r; },
  updateAttendance(id, d) { var a = this.getAttendance(); for(var i=0;i<a.length;i++){if(a[i].id===id){a[i]=Object.assign({},a[i],d);this.set("attendance",a);return a[i];}} return null; },
  deleteAttendance(id) { this.set("attendance", this.getAttendance().filter(function(a){return a.id!==id;})); this._updateStats(); },

  /* ===== 鐠囧嘲浜?===== */
  getLeaveRequests() { return this.get("leave_requests") || []; },

  isCompensatoryLeave(record) {
    if (!record) return false;
    var type = String(record.type || "").toLowerCase();
    return type === "compensatory" || type === "timeoff" || type === "调休" || type.indexOf("调休") >= 0;
  },

  isCompensatoryOvertime(record) {
    return !!record && String(record.overtimeType || "fee") === "compensatory";
  },

  isShiftLeave(record) {
    if (!record) return false;
    var type = String(record.type || "").toLowerCase();
    return type === "shift" || type === "substitute" || type === "替班请假" || type.indexOf("替班") >= 0;
  },

  getTimeBalance(employeeId) {
    var self = this;
    var ot = this.getOvertime().filter(function(o) {
      return o.status === "approved" && self.isCompensatoryOvertime(o) && (employeeId == null || o.employeeId === employeeId);
    });
    var leaves = this.getLeaveRequests().filter(function(l) {
      return l.status === "approved" && self.isCompensatoryLeave(l) && (employeeId == null || l.employeeId === employeeId);
    });
    var overtimeHours = ot.reduce(function(sum, o) { return sum + (parseFloat(o.hours) || 0); }, 0);
    var compensatoryHours = leaves.reduce(function(sum, l) { return sum + (parseFloat(l.hours) || 0); }, 0);
    return {
      overtimeHours: parseFloat(overtimeHours.toFixed(1)),
      compensatoryHours: parseFloat(compensatoryHours.toFixed(1)),
      remainingHours: parseFloat(Math.max(0, overtimeHours - compensatoryHours).toFixed(1))
    };
  },

  addLeaveRequest(l) {
    var lv = this.getLeaveRequests();
    l.id = this._nextId(lv);
    l.createdAt = new Date().toISOString();
    l.status = l.status || "pending";
    if (this.isCompensatoryLeave(l)) l.hours = parseFloat(l.hours) || 0;
    var emp = this.getEmployees().find(function(e){return e.id===l.employeeId;});
    this._applyLeaveCost(l, emp);
    lv.push(l);
    this.set("leave_requests", lv);
    this._updateStats();
    this._clearSettlementCache();
    return l;
  },

  updateLeaveRequest(id, d) {
    var lv = this.getLeaveRequests();
    for(var i=0;i<lv.length;i++){
      if(lv[i].id===id){
        lv[i]=Object.assign({},lv[i],d);
        if (this.isCompensatoryLeave(lv[i])) lv[i].hours = parseFloat(lv[i].hours) || 0;
        var emp = this.getEmployees().find(function(e){return e.id===lv[i].employeeId;});
        this._applyLeaveCost(lv[i], emp);
        this.set("leave_requests",lv);
        this._clearSettlementCache();
        return lv[i];
      }
    }
    return null;
  },

  deleteLeaveRequest(id) { this.set("leave_requests", this.getLeaveRequests().filter(function(l){return l.id!==id;})); this._updateStats(); this._clearSettlementCache(); },

  _applyLeaveCost(record, emp) {
    if (this.isCompensatoryLeave(record) || this.isShiftLeave(record)) {
      record.lvDeduct = 0;
      record.lvRate = "";
      return;
    }
    var cfg = this._getLeaveDeductConfig(emp);
    var days = parseInt(record.days) || 0;
    if (cfg) {
      record.lvDeduct = parseFloat((days * cfg.hoursPerDay * cfg.rate).toFixed(2));
      record.lvRate = cfg.rate.toFixed(2) + "\u5143/h\u00d7" + cfg.hoursPerDay + "h/\u5929";
    } else {
      record.lvDeduct = 0;
      record.lvRate = "";
    }
  },

  /* 加班、请假费用结算 */
  getOvertime() { return this.get("overtime") || []; },

  addOvertime(r) {
    var ot = this.getOvertime();
    r.id = this._nextId(ot);
    r.createdAt = new Date().toISOString();
    r.status = r.status || "pending";
    r.overtimeType = r.overtimeType === "compensatory" ? "compensatory" : "fee";
    var emp = this.getEmployees().find(function(e){return e.id===r.employeeId;});
    this._applyOvertimeCost(r, emp);
    ot.push(r);
    this.set("overtime", ot);
    this._updateStats();
    this._clearSettlementCache();
    return r;
  },

  updateOvertime(id, d) {
    var ot = this.getOvertime();
    for(var i=0;i<ot.length;i++){
      if(ot[i].id===id){
        ot[i]=Object.assign({},ot[i],d);
        ot[i].overtimeType = ot[i].overtimeType === "compensatory" ? "compensatory" : "fee";
        var emp = this.getEmployees().find(function(e){return e.id===ot[i].employeeId;});
        this._applyOvertimeCost(ot[i], emp);
        this.set("overtime",ot);
        this._clearSettlementCache();
        return ot[i];
      }
    }
    return null;
  },

  deleteOvertime(id) { this.set("overtime", this.getOvertime().filter(function(o){return o.id!==id;})); this._updateStats(); this._clearSettlementCache(); },

  _applyOvertimeCost(record, emp) {
    if (this.isCompensatoryOvertime(record)) {
      record.otPay = 0;
      record.otRate = "调休加班";
      return;
    }
    var rate = this._getFixedOtRate(emp);
    var hours = parseFloat(record.hours) || 0;
    if (rate > 0) {
      record.otPay = parseFloat((hours * rate).toFixed(2));
      record.otRate = rate.toFixed(2) + "元/h";
    } else {
      record.otPay = 0;
      record.otRate = rate.toFixed(2) + "元/h";
    }
  },

  /* ===== 缂佹挾鐣?===== */
  getSettlements() { return this.get("settlements") || []; },
  addSettlement(s) { var st = this.getSettlements(); s.id = Date.now(); s.createdAt = new Date().toISOString(); st.push(s); this.set("settlements", st); return s; },
  deleteSettlement(id) { this.set("settlements", this.getSettlements().filter(function(s){return s.id!==id;})); },
  deleteSettlementByMonth(yearMonth) { this.set("settlements", this.getSettlements().filter(function(s){return s.yearMonth!==yearMonth;})); },

  getOrCalcSettlement(ym) {
    var s = this.getSettlements().find(function(sv){return sv.yearMonth===ym;});
    // 数据迁移与兼容处理
    if (s && s.settlementType === "overtime_leave" && s.settlementVersion === 2) return s;
    if (s) this.deleteSettlement(s.id);
    return this._calcSettlement(ym);
  },

  /* 数据处理 */
  getDepartments() { return this.get("departments") || []; },
  addDepartment(d) { var depts = this.getDepartments(); if(depts.indexOf(d)<0){depts.push(d);this.set("departments",depts);} },
  getOrgStructure() { return this.get("org_structure") || {id:1,name:"示例组织",type:"company",children:[]}; },
  saveOrgStructure(t) { this.set("org_structure", t); },
  getOrgEmployeeCounts() { var c=Object.create(null);this.getEmployees().forEach(function(e){if(e.department)c[e.department]=(c[e.department]||0)+1;});return c; },
  getEmployeesByDepartment(d){return this.getEmployees().filter(function(e){return e.department===d;});},
  _findNodeById(t,i){if(t.id===i)return t;if(t.children){for(var j=0;j<t.children.length;j++){var f=this._findNodeById(t.children[j],i);if(f)return f;}}return null;},
  _findParent(t,i){if(!t.children)return null;for(var j=0;j<t.children.length;j++){if(t.children[j].id===i)return t;var f=this._findParent(t.children[j],i);if(f)return f;}return null;},
  getOrgStructure() { return this.get("org_structure") || {id:1,name:"示例组织",type:"company",children:[]}; },
  getOrgStructure() { return this.get("org_structure") || {id:1,name:"示例组织",type:"company",children:[]}; },
  getOrgStructure() { return this.get("org_structure") || {id:1,name:"示例组织",type:"company",children:[]}; },

  getStats() { return this.get("stats") || {totalEmployees:0,todayPresent:0,todayAbsent:0,pendingLeave:0,todayOTHours:0,monthOTHours:0}; },


  // 数据迁移与兼容处理
  // Public package intentionally leaves compensation rates empty. Configure locally.
  _otFixedRates: [],
  _isOutsourced(e) {
    if (!e || !e.company) return false;
    var company = String(e.company).trim();
    return company === "外包单位";
  },
  _getFixedOtRate(e) {
    if (!e || !e.position || !this._isOutsourced(e)) return 0;
    for (var i = 0; i < this._otFixedRates.length; i++) {
      var r = this._otFixedRates[i];
      if (String(e.position).indexOf(r.position) >= 0) return r.rate;
    }
    return 0;
  },
  _leaveDeductRates: [],
  _getLeaveDeductConfig(e) {
    if (!e || !this._isOutsourced(e)) return null;
    for (var i = 0; i < this._leaveDeductRates.length; i++) {
      if (String(e.company).indexOf(this._leaveDeductRates[i].company) >= 0) return this._leaveDeductRates[i];
    }
    return null;
  },

  /** 费用和数据处理 */
  refreshRates() {
    var self = this;
    var emps = this.getEmployees();
    function empOf(id) { return emps.find(function(e){ return e.id === id; }); }
    var ot = this.getOvertime();
    var otChanged = false;
    for (var i = 0; i < ot.length; i++) {
      var before = ot[i].otPay + "|" + ot[i].otRate;
      this._applyOvertimeCost(ot[i], empOf(ot[i].employeeId));
      if (before !== ot[i].otPay + "|" + ot[i].otRate) otChanged = true;
    }
    if (otChanged) this.set("overtime", ot);
    var lv = this.getLeaveRequests();
    var lvChanged = false;
    for (var j = 0; j < lv.length; j++) {
      var b2 = lv[j].lvDeduct + "|" + lv[j].lvRate;
      this._applyLeaveCost(lv[j], empOf(lv[j].employeeId));
      if (b2 !== lv[j].lvDeduct + "|" + lv[j].lvRate) lvChanged = true;
    }
    if (lvChanged) this.set("leave_requests", lv);
    this._clearSettlementCache();
    return { overtime: otChanged, leave: lvChanged };
  },

  /* 加班、请假费用结算 */
  _calcSettlement(yearMonth) {
    var emps = this.getEmployees();
    var otList = this.getOvertime();
    var lvList = this.getLeaveRequests();
    var records = [];
    for (var i = 0; i < emps.length; i++) {
      var e = emps[i];
      var monthOT = otList.filter(function(o){return o.employeeId === e.id && o.date && o.date.indexOf(yearMonth) === 0 && o.status === "approved" && String(o.overtimeType || "fee") !== "compensatory";});
      var otHours = monthOT.reduce(function(sv,o){return sv + (parseFloat(o.hours)||0);}, 0);
      var fixedOtRate = this._getFixedOtRate(e);
      var otPay = 0;
      var otRateLabel = "";
      if (fixedOtRate > 0) {
        otPay = otHours * fixedOtRate;
        otRateLabel = fixedOtRate.toFixed(2) + "元/h";
      }
      var monthLV = lvList.filter(function(l){return l.employeeId === e.id && l.status === "approved" && l.startDate && l.startDate.indexOf(yearMonth) === 0 && !this.isCompensatoryLeave(l) && !this.isShiftLeave(l);}, this);
      var lvDays = monthLV.reduce(function(sv,l){return sv + (parseInt(l.days)||0);}, 0);
      var leaveCfg = this._getLeaveDeductConfig(e);
      var lvDeduct = 0, lvHours = 0, lvRateLabel = "";
      if (leaveCfg) {
        lvHours = lvDays * leaveCfg.hoursPerDay;
        lvDeduct = lvHours * leaveCfg.rate;
        lvRateLabel = leaveCfg.rate.toFixed(2) + "元/h×" + leaveCfg.hoursPerDay + "h/天";
      }
      var feeBalance = otPay - lvDeduct;
      records.push({
        employeeId: e.id, name: e.name, department: e.department, position: e.position,
        building: e.building || "", company: e.company || "",
        otHours: parseFloat(otHours.toFixed(1)), otPay: parseFloat(otPay.toFixed(2)),
        lvDays: lvDays, lvHours: parseFloat(lvHours.toFixed(1)), lvDeduct: parseFloat(lvDeduct.toFixed(2)),
        otRate: otRateLabel, lvRate: lvRateLabel, feeBalance: parseFloat(feeBalance.toFixed(2))
      });
    }
    var totalOtPay = records.reduce(function(sv,r){return sv + r.otPay;}, 0);
    var totalLvDeduct = records.reduce(function(sv,r){return sv + r.lvDeduct;}, 0);
    var totalFee = totalOtPay - totalLvDeduct;
    var settlement = { settlementType: "overtime_leave", settlementVersion: 2, yearMonth: yearMonth, totalEmployees: emps.length,
      totalOtPay: parseFloat(totalOtPay.toFixed(2)), totalLvDeduct: parseFloat(totalLvDeduct.toFixed(2)),
      totalFee: parseFloat(totalFee.toFixed(2)), records: records, createdAt: new Date().toISOString() };
    this.addSettlement(settlement);
    return settlement;
  },

  _clearSettlementCache() { this.remove("settlements"); },

  /* ===== 婢跺洣鍞?/ 閺夆晜锚鐢?===== */
  exportSnapshot() {
    var performance = [];
    try { performance = this.get(this._performanceKey) || JSON.parse(localStorage.getItem(this._performanceKey)) || []; } catch(e) {}
    return {
      employees: this.getEmployees(),
      attendance: this.getAttendance(),
      leaveRequests: this.getLeaveRequests(),
      overtime: this.getOvertime(),
      settlements: this.getSettlements(),
      departments: this.getDepartments(),
      orgStructure: this.getOrgStructure(),
      updateLogs: this.getUpdateLogs(),
      performance: performance,
      exportedAt: new Date().toISOString(),
      revision: this._revision
    };
  },

  importSnapshot(d) {
    if (!d || !Array.isArray(d.employees)) return false;
    this.set("employees", d.employees);
    this.set("attendance", Array.isArray(d.attendance) ? d.attendance : []);
    this.set("leave_requests", Array.isArray(d.leaveRequests) ? d.leaveRequests : []);
    this.set("overtime", Array.isArray(d.overtime) ? d.overtime : []);
    this.set("settlements", Array.isArray(d.settlements) ? d.settlements : []);
    this.set("departments", Array.isArray(d.departments) ? d.departments : []);
    this.set("org_structure", d.orgStructure || { id: 1, name: '组织', type: 'company', children: [] });
    this.set("update_logs", Array.isArray(d.updateLogs) ? d.updateLogs : []);
    this.set(this._performanceKey, Array.isArray(d.performance) ? d.performance : []);
    this._updateStats();
    return true;
  },

  _updateStats() {
    var es = this.getEmployees();
    var at = this.getAttendance();
    var today = new Date().toISOString().split("T")[0];
    var ym = today.slice(0, 7);
    var td = at.filter(function(a){return a.date===today;});
    var monthOt = this.getOvertime().filter(function(o){ return o.date && o.date.indexOf(ym) === 0; });
    this.set("stats", {
      totalEmployees: es.length,
      todayPresent: td.filter(function(a){return a.status==="present"||a.status==="late";}).length,
      todayAbsent: td.filter(function(a){return a.status==="absent";}).length,
      pendingLeave: this.getLeaveRequests().filter(function(l){return l.status==="pending";}).length,
      todayOTHours: 0,
      monthOTHours: monthOt.reduce(function(sum,o){return sum + (parseFloat(o.hours)||0);}, 0)
    });
  }
};
