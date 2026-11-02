/**
 * 华北一部酒仙桥人力资源管理平台 - 主应用逻辑
 */
const App = {
  
  /** 侧边栏导航配置 - 可调整顺序 */
  _navItems: [
    { page: "dashboard", icon: "📊", label: "数据看板" },
    { page: "employees", icon: "👤", label: "人力资源" },
    { page: "attendance", icon: "⏰", label: "考勤管理" },
    { page: "performance", icon: "📊", label: "绩效管理" },
    { page: "cost", icon: "💰", label: "费用结算" },
    { page: "org", icon: "🏢", label: "组织架构" },
    { page: "ai", icon: "🤖", label: "AI 智能问答" },
    { page: "admin", icon: "⚙️", label: "系统设置" },
  ],

  /** 获取导航项（含自定义顺序） */
  _getNavItems() {
    var custom = this._getCustomNavOrder();
    if (false) {}
    return this._navItems;
  },

  /** 读取自定义导航顺序 */
  _getCustomNavOrder() { try { localStorage.removeItem("personnel_nav_order"); } catch(e) {}
    try {
      var raw = localStorage.getItem("personnel_nav_order");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return parsed;
    } catch(e) { return null; }
  },

  /** 保存自定义导航顺序 */
  _saveNavOrder(items) {
    localStorage.setItem("personnel_nav_order", JSON.stringify(items));
  },

  /** 重新渲染侧边栏 */
  _renderSidebar() {
    try {
    var nav = document.querySelector(".sidebar-nav");
    if (!nav) return;
    var user = Auth.currentUser();
    var items = this._getNavItems();
    nav.innerHTML = "";
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (user && user.role !== "admin") {
        var allowed = ["dashboard", "attendance", "leave", "overtime"];
        if (allowed.indexOf(item.page) < 0) continue;
      }
      var div = document.createElement("div");
      div.className = "nav-item" + (this.currentPage === item.page ? " active" : "");
      div.dataset.page = item.page;
      div.innerHTML = '<span class="nav-icon">' + item.icon + '</span><span>' + item.label + '</span>';
      div.addEventListener("click", (function(p){ return function(){ App.navigate(p); }; })(item.page));
      nav.appendChild(div);
    } } catch(e) { console.error(e); }
  },

  currentPage: 'dashboard',

  init() {
    Auth.init();
    // 未登录时拦截
    if (!Auth.isLoggedIn()) {
      window.location.href = 'login.html';
      return;
    }
    // 初始化数据结构，并把本机浏览器数据同步到本地服务器；空浏览器自动从服务器恢复。
    Store.init();
    var hasLocalEmployees = Store.getEmployees().length > 0;
    if (hasLocalEmployees) {
      Store._serverSyncReady = true;
      Store.syncSnapshotToServer().catch(function() {});
    } else if (Store.restoreFromServer) {
      Store.restoreFromServer().then(function(restored) {
        Store._serverSyncReady = true;
        if (restored) {
          App.navigate(App.currentPage || 'dashboard');
          Auth._updateUI();
        }
      });
    } else {
      Store._serverSyncReady = true;
    }
    if (!hasLocalEmployees) {
      setTimeout(function() {
        if (Store.getEmployees().length === 0) App.toast('当前访问地址没有人员数据，请检查服务器地址或通过系统管理导入备份', 'warning');
      }, 900);
    }
    this._bindNav();
    this._clock();
    this.navigate('dashboard');
    // 登录后更新界面
    Auth._updateUI();
    this._monthlyReminder();
  },

  _monthlyReminder() {
    var u = Auth.currentUser();
    if (!u || u.role === 'user') return;
    var now = new Date();
    var ym = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    var d = {};
    try { d = JSON.parse(localStorage.getItem('personnel_month_remind')) || {}; } catch(e) {}
    if (d[ym]) return;
    var emps = Store.getEmployees();
    var joins = emps.filter(function(e){ var jd = e.joinDate || ''; return jd.indexOf(ym) === 0; }).length;
    var leaves = emps.filter(function(e){ var ld = e.leaveDate || ''; return ld.indexOf(ym) === 0; }).length;
    var msg = '本月入职 ' + joins + ' 人，离职 ' + leaves + ' 人。';
    if (joins === 0 && leaves === 0) msg = '本月暂无入职/离职记录，请核对人员信息是否准确。';
    App.openModal('月初人员信息更新提醒',
      '<div style="text-align:center;padding:10px 4px;">' +
        '<div style="font-size:44px;margin-bottom:10px;">📋</div>' +
        '<p style="font-size:14px;color:var(--text);line-height:1.8;">请及时更新本月人员信息</p>' +
        '<p style="font-size:13px;color:var(--text-light);margin-top:6px;">' + msg + '</p>' +
        '<div style="display:flex;gap:8px;justify-content:center;margin-top:14px;">' +
          '<span class="tag tag-success">✅ 入职 ' + joins + ' 人</span>' +
          '<span class="tag tag-danger">👥 离职 ' + leaves + ' 人</span>' +
        '</div>' +
      '</div>',
      '<button class="btn btn-primary" onclick="App.navigate(\'employees\')">去更新人员信息</button>' +
      '<button class="btn btn-outline" onclick="App._dismissMonthRemind(\'' + ym + '\')">本月不再提醒</button>'
    );
  },

  _dismissMonthRemind(ym) {
    var d = {};
    try { d = JSON.parse(localStorage.getItem('personnel_month_remind')) || {}; } catch(e) {}
    d[ym] = true;
    localStorage.setItem('personnel_month_remind', JSON.stringify(d));
    App.closeModal();
    App.toast('已记录，本月不再提醒', 'info');
  },

  /** 绑定导航事件 */
  _bindNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
        // 普通用户只显示允许的页面
        var _user = Auth.currentUser();
        if (_user && _user.role !== "admin") {
          var _allowed = ["attendance", "leave", "overtime"];
          if (_allowed.indexOf(item.dataset.page) < 0) {
            item.style.display = "none";
          }
        }
        // 普通用户只显示允许的页面
        var user = Auth.currentUser();
        if (user && user.role !== "admin") {
          var allowed = ["dashboard", "attendance", "leave", "overtime"];
          if (allowed.indexOf(item.dataset.page) < 0) {
            item.style.display = "none";
          }
        }
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        this.navigate(page);
      });
    });
  },

  /** 实时时钟 */
  _clock() {
    const el = document.getElementById('currentTime');
    const update = () => {
      const now = new Date();
      const opts = { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
      el.textContent = now.toLocaleDateString('zh-CN', opts);
    };
    update();
    setInterval(update, 1000);
  },


  _introKey: "personnel_intro_video",

  getIntroVideo() {
    try { return JSON.parse(localStorage.getItem(this._introKey)) || {}; } catch(e) { return {}; }
  },
  saveIntroVideo(cfg) { localStorage.setItem(this._introKey, JSON.stringify(cfg)); },

  showIntroVideo() {
    var cfg = this.getIntroVideo();
    var src = cfg.src || "";
    var title = cfg.title || "智能体介绍";
    var body = "";
    if (src) {
      body = '<div style="position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;">' +
        '<video id="introVideoPlayer" controls autoplay style="width:100%;height:100%;object-fit:contain;">' +
        '<source src="' + src + '">' +
        '</video></div>' +
        '<p style="font-size:12px;color:var(--text-light);margin-top:10px;">' + (cfg.description || "系统智能体功能介绍视频") + '</p>';
    } else {
      // 内置动画智能体介绍（无视频文件时自动播放）
      body = '<div style="width:100%;aspect-ratio:16/9;background:#0f172a;border-radius:12px;overflow:hidden;position:relative;">' +
        '<canvas id="introVideoCanvas" style="width:100%;height:100%;display:block;"></canvas>' +
        '<div style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.4);color:#fff;border-radius:20px;padding:4px 12px;font-size:11px;">智能体介绍 · 自动播放</div>' +
        '</div>' +
        '<p style="font-size:12px;color:var(--text-light);margin-top:10px;">华北一部酒仙桥人力资源管理平台 · AI 智能体功能介绍</p>' +
        '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">' +
          '<span class="tag tag-primary" style="font-size:11px;">员工管理</span>' +
          '<span class="tag tag-success" style="font-size:11px;">考勤签到</span>' +
          '<span class="tag tag-warning" style="font-size:11px;">请假审批</span>' +
          '<span class="tag tag-info" style="font-size:11px;">加班统计</span>' +
          '<span class="tag tag-danger" style="font-size:11px;">成本结算</span>' +
        '</div>';
    }
    App.openModal(title, body, '<button class="btn btn-outline" onclick="App.closeModal()">关闭</button>');
    if (!src) {
      setTimeout(function() {
        App._renderIntroVideo();
      }, 150);
    }
  },

  _renderIntroVideo() {
    var canvas = document.getElementById("introVideoCanvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width = canvas.offsetWidth || 640;
    var h = canvas.height = canvas.offsetHeight || 360;
    var t = 0;
    var particles = [];
    for (var i = 0; i < 40; i++) {
      particles.push({x: Math.random()*w, y: Math.random()*h, r: Math.random()*3+1, s: Math.random()*0.5+0.2, o: Math.random()*0.5+0.2});
    }
    var frames = [
      {icon:"👥", title:"华北一部酒仙桥人力资源管理平台", sub:"智能人员管理平台"},
      {icon:"⏰", title:"考勤管理", sub:"签到 / 请假 / 加班一站式处理"},
      {icon:"📈", title:"费用数据看板", sub:"加班费与扣款自动统计"},
      {icon:"🤖", title:"AI 智能体", sub:"简历解析 / 人员简介自动生成"},
      {icon:"✅", title:"高效协同", sub:"主管审批 · 数据实时同步"}
    ];
    var frameIdx = 0;
    var frameTime = 0;
    function draw() {
      t += 0.016;
      frameTime += 0.016;
      if (frameTime > 3) { frameTime = 0; frameIdx = (frameIdx+1) % frames.length; }
      // Background
      var g = ctx.createLinearGradient(0,0,0,h);
      g.addColorStop(0,"#0f172a");
      g.addColorStop(1,"#1e3a8a");
      ctx.fillStyle = g;
      ctx.fillRect(0,0,w,h);
      // Particles
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.y -= p.s;
        if (p.y < -10) { p.y = h+10; p.x = Math.random()*w; }
        ctx.globalAlpha = p.o;
        ctx.fillStyle = "#60a5fa";
        ctx.beginPath();
        ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Grid lines
      ctx.strokeStyle = "rgba(96,165,250,0.08)";
      ctx.lineWidth = 1;
      for (var x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for (var y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
      // Icon
      var f = frames[frameIdx];
      var iconScale = 1 + Math.sin(t*2)*0.03;
      ctx.save();
      ctx.translate(w/2, h*0.32);
      ctx.scale(iconScale, iconScale);
      ctx.font = Math.min(w,h)*0.16 + "px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(f.icon, 0, 0);
      ctx.restore();
      // Title
      ctx.font = "bold " + Math.min(w*0.045, 28) + "px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(f.title, w/2, h*0.62);
      // Subtitle
      ctx.font = Math.min(w*0.024, 16) + "px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(f.sub, w/2, h*0.7);
      // Progress dots
      for (var d = 0; d < frames.length; d++) {
        var dx = w/2 + (d - (frames.length-1)/2) * 18;
        ctx.fillStyle = d === frameIdx ? "#3b82f6" : "rgba(255,255,255,0.3)";
        ctx.beginPath();
        ctx.arc(dx, h*0.86, d === frameIdx ? 5 : 3, 0, Math.PI*2);
        ctx.fill();
      }
      // Bottom bar
      var barW = w * 0.5;
      var barX = (w-barW)/2;
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(barX, h*0.9, barW, 3);
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(barX, h*0.9, barW * ((frameTime % 3)/3), 3);
    }
    setInterval(draw, 16);
  },

  /** 显示 Auth 管理菜单 */
  showAuthMenu() {
    if (!Auth.isLoggedIn()) { Auth.renderLoginModal(); return; }
    const u = Auth.currentUser();
    App.openModal('账号管理',
      '<div class="auth-menu" style="text-align:center;padding:8px 0 16px;">' +
        '<div style="font-size:48px;margin-bottom:8px;">🔐</div>' +
        '<h3 style="margin:0;font-size:18px;">' + u.name + '</h3>' +
        '<p style="font-size:13px;color:var(--text-light);">' + u.username + ' · ' + (u.role === 'admin' ? '管理员' : '普通用户') + '</p>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
        '<button class="btn btn-outline" onclick="App.closeModal();Auth.showChangePasswordModal()" style="width:100%;">🔑 修改密码</button>' +
        '<button class="btn btn-outline" onclick="App.closeModal();Auth.showUserManageModal()" style="width:100%;">👥 用户管理</button>' +
        '<button class="btn btn-danger" onclick="App.closeModal();Auth.logout()" style="width:100%;">🚪 退出登录</button>' +
      '</div>',
      '<button class="btn btn-outline" onclick="App.closeModal()">关闭</button>'
    );
  },

  /** 页面导航 */
    navigate(page) {
    // 权限检查：普通用户只能访问考勤、请假、加班
    var user = Auth.currentUser();
    if (user && user.role !== "admin") {
      var allowed = ["attendance", "leave", "overtime"];
      if (allowed.indexOf(page) < 0) {
        App.toast("没有权限访问此页面", "error");
        return;
      }
    }
this.currentPage = page;

    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });

    // 更新标题
    const titles = {
      dashboard: '📊 数据看板',
      employees: '👤 人力资源',
      attendance: '⏰ 考勤管理',
      
      cost: '💰 费用结算',
      admin: '⚙️ 系统管理',
      org: '🏢 组织架构',
      ai: '🤖 AI 智能问答'
    };
    document.getElementById('pageTitle').textContent = titles[page] || '数据看板';

    // 渲染对应页面
    const container = document.getElementById('pageContent');
    switch (page) {
      case 'dashboard': try{Dashboard.render(container);}catch(e){console.error('Dashboard.render:',e);App.toast('数据看板加载失败','error');} break;
      case 'employees': try{Employees.render(container);}catch(e){console.error('Employees.render:',e);App.toast('人力资源加载失败','error');} break;
      case 'attendance': try{Attendance.render(container);}catch(e){console.error('Attendance.render:',e);App.toast('考勤管理加载失败','error');} break;
      
      case 'cost': try{Cost.render(container);}catch(e){console.error('Cost.render:',e);App.toast('成本管理加载失败','error');} break;
      case 'admin': try{Admin.render(container);}catch(e){console.error('Admin.render:',e);App.toast('系统管理加载失败','error');} break;
      case 'org': try{Org.render(container);}catch(e){console.error('Org.render:',e);App.toast('组织架构加载失败','error');} break;
      case 'performance': try{Performance.render(container);}catch(e){console.error(e);App.toast('加载失败','error');} break;
      case 'ai': try{AI.render(container);}catch(e){console.error('AI.render:',e);App.toast('AI问答加载失败','error');} break;
    }
  },

  /** 打开模态框 */
  openModal(title, bodyHtml, footerHtml = '') {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml;
    document.getElementById('modalOverlay').classList.add('show');
  },

  /** 关闭模态框 */
  closeModal() {
    document.getElementById('modalOverlay').classList.remove('show');
  },

  /** 格式化日期 */
  formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('zh-CN');
  },

  /** 格式化日期时间 */
  formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleString('zh-CN');
  },

  /** 获取今天日期字符串 */
  today() {
    return new Date().toISOString().split('T')[0];
  },

  /** 显示通知 */
  toast(message, type = 'success') {
    const colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:20px;right:20px;padding:12px 20px;background:${colors[type]||colors.success};color:white;border-radius:8px;font-size:14px;z-index:2000;box-shadow:0 4px 12px rgba(0,0,0,0.15);animation:slideUp 0.3s;`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 2500);
  },

  /** 提示确认 */
  confirm(message) {
    return window.confirm(message);
  },
  /** 侧边栏切换（移动端） */
  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    let overlay = document.querySelector('.sidebar-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      overlay.onclick = () => this.toggleSidebar();
      document.body.appendChild(overlay);
    }
    overlay.classList.toggle('show');
  },

};
