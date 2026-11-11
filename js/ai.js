/**
 * 华北一部酒仙桥人力资源管理平台 - AI 智能问答模块
 * 支持 OpenAI 兼容 API（可对接 Ollama / 本地 LLM / 在线 API）
 */
const AI = {
  _configKey: 'personnel_ai_config',

  defaultConfig: {
    endpoint: '/api/ai/chat',
    model: 'deepseek-chat',
    apiKey: '',
    systemPrompt: '',
    maxTokens: 2048,
    temperature: 0.7,
  },

  messages: [],
  _messageKey() { return 'personnel_ai_messages_' + (Auth.currentUser() ? Auth.currentUser().username : ''); },

  getConfig() {
    try {
      const raw = localStorage.getItem(this._configKey);
      const cfg = raw ? { ...this.defaultConfig, ...JSON.parse(raw) } : { ...this.defaultConfig };
      // 迁移旧版默认 Ollama 地址，改由服务端代理，兼容局域网访问。
      if (!cfg.endpoint || /localhost:11434|127\.0\.0\.1:11434/.test(cfg.endpoint)) cfg.endpoint = '/api/ai/chat';
      return cfg;
    } catch (e) {
      return { ...this.defaultConfig };
    }
  },

  saveConfig(cfg) {
    const cur = this.getConfig();
    Object.assign(cur, cfg);
    localStorage.setItem(this._configKey, JSON.stringify(cur));
  },

  _buildSystemPrompt() {
    const employees = Store.getEmployees();
    const departments = Store.getDepartments();
    const stats = Store.getStats();
    const attendance = Store.getAttendance();
    const leaves = Store.getLeaveRequests();
    const overtime = Store.getOvertime();

    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);

    const deptCounts = {};
    employees.forEach(function(e) { if (e.department) deptCounts[e.department] = (deptCounts[e.department] || 0) + 1; });

    const companyCounts = {};
    employees.forEach(function(e) { if (e.company) companyCounts[e.company] = (companyCounts[e.company] || 0) + 1; });

    const monthAttendance = attendance.filter(function(a) { return a.date && a.date.indexOf(month) === 0; });
    const monthPresent = monthAttendance.filter(function(a) { return a.status === 'present' || a.status === 'late'; }).length;
    const monthAbsent = monthAttendance.filter(function(a) { return a.status === 'absent'; }).length;

    const monthLeaves = leaves.filter(function(l) { return l.startDate && l.startDate.indexOf(month) === 0; });
    const approvedLeaves = monthLeaves.filter(function(l) { return l.status === 'approved'; });

    const monthOT = overtime.filter(function(o) { return o.date && o.date.indexOf(month) === 0; });
    let monthOTHours = 0;
    monthOT.forEach(function(o) { monthOTHours += (parseFloat(o.hours) || 0); });

    const empLines = employees.slice(0, 50).map(function(e) {
      return e.name + ' / ' + (e.department || '-') + ' / ' + (e.position || '-') + ' / ' + (e.company || '-');
    });
    const empList = empLines.join('\n');

    const lines = [];
    lines.push('你是一个华北一部酒仙桥人力资源管理平台的智能助手，以下是当前系统的实时数据，请根据这些数据回答用户的问题。');
    lines.push('');
    lines.push('【系统概况】');
    lines.push('总人数：' + (stats.totalEmployees || employees.length) + ' 人');
    lines.push('部门数：' + departments.length + ' 个');
    lines.push('部门分布：' + Object.entries(deptCounts).map(function(kv) { return kv[0] + ' ' + kv[1] + '人'; }).join('、'));
    lines.push('公司分布：' + Object.entries(companyCounts).map(function(kv) { return kv[0] + ' ' + kv[1] + '人'; }).join('、'));
    lines.push('');
    lines.push('【今日概览】');
    lines.push('日期：' + today);
    lines.push('今日出勤：' + (stats.todayPresent || 0) + ' 人');
    lines.push('今日缺勤：' + (stats.todayAbsent || 0) + ' 人');
    lines.push('待审批请假：' + (stats.pendingLeave || 0) + ' 条');
    lines.push('');
    lines.push('【本月数据（' + month + '）】');
    lines.push('月度出勤：' + monthPresent + ' 人次');
    lines.push('月度缺勤：' + monthAbsent + ' 人次');
    lines.push('已批准请假：' + approvedLeaves.length + ' 条');
    lines.push('月度加班总时长：' + monthOTHours.toFixed(1) + ' 小时');
    lines.push('');
    lines.push('【人员列表（共' + employees.length + '人）】');
    lines.push(empList);
    lines.push('');
    lines.push('请用中文回答，保持简洁准确。如果用户问到不在此数据范围内的信息，请如实告知。');
    return lines.join('\n');
  },

  render(container) {
    container.innerHTML =
      '<div class="ai-chat-container">'
      + '<div class="ai-chat-header">'
        + '<div class="ai-chat-header-left">'
          + '<span class="ai-chat-avatar">🤖</span>'
          + '<div>'
            + '<div class="ai-chat-title">AI 智能问答</div>'
            + '<div class="ai-chat-subtitle">基于系统实时数据，回答人员管理相关问题</div>'
          + '</div>'
        + '</div>'
        + '<div class="ai-chat-header-right">'
          + '<button class="btn btn-outline btn-sm" onclick="AI.showSettings()" title="API 设置">⚙️ 设置</button>'
          + '<button class="btn btn-outline btn-sm" onclick="AI.clearChat()" title="清空对话">🗑️ 清空</button>'
        + '</div>'
      + '</div>'
      + '<div class="ai-chat-messages" id="aiMessages">'
        + '<div class="ai-message ai-message-system">'
          + '<div class="ai-message-avatar">🤖</div>'
          + '<div class="ai-message-content">'
            + '<div class="ai-message-text">你好！我是 AI 智能助手，我可以回答关于华北一部酒仙桥人力资源管理平台的任何问题，比如：</div>'
            + '<div class="ai-suggestions">'
              + '<span class="ai-suggestion" onclick="AI.quickAsk(\'📊 公司总共有多少人？\')">📊 公司总共有多少人？</span>'
              + '<span class="ai-suggestion" onclick="AI.quickAsk(\'🏢 各部门人员分布如何？\')">🏢 各部门人员分布如何？</span>'
              + '<span class="ai-suggestion" onclick="AI.quickAsk(\'👤 交付运维部有哪些人？\')">👤 交付运维部有哪些人？</span>'
              + '<span class="ai-suggestion" onclick="AI.quickAsk(\'⏰ 今天出勤情况如何？\')">⏰ 今天出勤情况如何？</span>'
            + '</div>'
          + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="ai-chat-input-area">'
        + '<textarea class="ai-chat-input" id="aiChatInput" placeholder="输入你的问题，按 Enter 发送，Shift+Enter 换行..." rows="1"></textarea>'
        + '<button class="btn btn-primary ai-send-btn" id="aiSendBtn" onclick="AI.sendMessage()">发送</button>'
      + '</div>'
      + '</div>';
    this._bindEvents();
    this._loadMessages();
    const self = this;
    setTimeout(function() { self._scrollToBottom(); }, 50);
  },

  _bindEvents() {
    const input = document.getElementById('aiChatInput');
    if (!input) return;
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); AI.sendMessage(); }
      setTimeout(function() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }, 0);
    });
    input.addEventListener('input', function() {
      input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      document.getElementById('aiSendBtn').disabled = !input.value.trim();
    });
  },

  quickAsk(text) {
    document.getElementById('aiChatInput').value = text;
    this.sendMessage();
  },

  sendMessage() {
    const input = document.getElementById('aiChatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('aiSendBtn').disabled = true;
    this._addMessage('user', text);
    this._saveMessages();
    this._callAPI(text);
  },

  _callAPI(userText) {
    const self = this;
    const config = this.getConfig();

    const msgEl = this._addMessage('assistant', '', true);
    const textEl = msgEl.querySelector('.ai-message-text');
    textEl.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
    this._scrollToBottom();

    let systemPrompt;
    try {
      systemPrompt = config.systemPrompt || this._buildSystemPrompt();
    } catch (e) {
      console.error('AI buildPrompt error:', e);
      systemPrompt = '你是华北一部酒仙桥人力资源管理平台的智能助手，请根据用户问题回答。如需要具体数据，请告知用户先配置 AI API。';
    }
    const recentMessages = this.messages.slice(-21, -1);
    const apiMessages = [{ role: 'system', content: systemPrompt }];
    for (let i = 0; i < recentMessages.length; i++) {
      apiMessages.push({ role: recentMessages[i].role, content: recentMessages[i].content });
    }
    apiMessages.push({ role: 'user', content: userText });

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;

    fetch(config.endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: config.model,
        messages: apiMessages,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        stream: false,
      }),
    })
    .then(function(response) {
      if (!response.ok) {
        return response.text().then(function(errText) { throw new Error('API 请求失败 (' + response.status + '): ' + errText); });
      }
      return response.json();
    })
    .then(function(data) {
      const reply = (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content
        : (data.response || JSON.stringify(data));
      textEl.textContent = reply;
      self._updateLastMessage(reply);
      self._saveMessages();
    })
    .catch(function(err) {
      console.error('AI API error:', err);
      var errMsg = err.message || '未知错误';
      if (errMsg.indexOf('Failed to fetch') >= 0 || errMsg.indexOf('NetworkError') >= 0 || errMsg.indexOf('net::ERR_') >= 0) {
        errMsg = '无法连接到 API 服务，请确认：<br>1. API 服务已启动<br>2. 右上角 ⚙️ 设置中 API 地址和模型名称正确<br>3. 如有 API Key 已填写';
      } else if (errMsg.indexOf('401') >= 0 || errMsg.indexOf('Unauthorized') >= 0) {
        errMsg = 'API 认证失败，请在 ⚙️ 设置中填写有效的 API Key';
      } else if (errMsg.indexOf('404') >= 0) {
        errMsg = 'API 接口地址不正确，请在 ⚙️ 设置中检查 endpoint';
      }
      textEl.innerHTML = '<div class="ai-error">' + errMsg + '</div><div style="margin-top:8px;"><button class="btn btn-outline btn-sm" onclick="AI.showSettings()">⚙️ 去配置</button></div>';
      self._updateLastMessage('[错误] ' + err.message);
      self._saveMessages();
    })
    .finally(function() {
      self._scrollToBottom();
      document.getElementById('aiSendBtn').disabled = false;
    });
  },

  _addMessage(role, text, isLoading) {
    const container = document.getElementById('aiMessages');
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = 'ai-message ai-message-' + role;
    if (isLoading) div.classList.add('ai-message-loading');
    div.innerHTML =
      '<div class="ai-message-avatar">' + (isUser ? '👤' : '🤖') + '</div>'
      + '<div class="ai-message-content">'
        + '<div class="ai-message-role">' + (isUser ? '你' : 'AI') + '</div>'
        + '<div class="ai-message-text">' + (text ? this._escapeHtml(text) : '') + '</div>'
      + '</div>';
    container.appendChild(div);
    this._scrollToBottom();
    if (!isLoading) { this.messages.push({ role: role, content: text }); }
    return div;
  },

  _updateLastMessage(text) {
    if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'assistant') {
      this.messages[this.messages.length - 1].content = text;
    } else {
      this.messages.push({ role: 'assistant', content: text });
    }
  },

  _saveMessages() {
    const toSave = this.messages.slice(-50);
    try { localStorage.setItem(this._messageKey(), JSON.stringify(toSave)); } catch(e) {}
  },

  _loadMessages() {
    try {
      const raw = localStorage.getItem(this._messageKey());
      if (raw) {
        this.messages = JSON.parse(raw);
        const container = document.getElementById('aiMessages');
        const sysMsg = container.querySelector('.ai-message-system');
        container.innerHTML = '';
        if (sysMsg) container.appendChild(sysMsg);
        for (let i = 0; i < this.messages.length; i++) {
          const msg = this.messages[i];
          const div = document.createElement('div');
          const isUser = msg.role === 'user';
          div.className = 'ai-message ai-message-' + msg.role;
          div.innerHTML =
            '<div class="ai-message-avatar">' + (isUser ? '👤' : '🤖') + '</div>'
            + '<div class="ai-message-content">'
              + '<div class="ai-message-role">' + (isUser ? '你' : 'AI') + '</div>'
              + '<div class="ai-message-text">' + this._escapeHtml(msg.content) + '</div>'
            + '</div>';
          container.appendChild(div);
        }
      }
    } catch(e) { this.messages = []; }
  },

  clearChat() {
    if (!App.confirm('确定清空所有对话历史？')) return;
    this.messages = [];
    localStorage.removeItem(this._messageKey());
    const container = document.getElementById('aiMessages');
    if (container) {
      container.innerHTML =
        '<div class="ai-message ai-message-system">'
        + '<div class="ai-message-avatar">🤖</div>'
        + '<div class="ai-message-content">'
          + '<div class="ai-message-text">对话已清空，有什么想问的吗？</div>'
        + '</div>'
        + '</div>';
    }
  },

  showSettings() {
    const cfg = this.getConfig();
    const helpHtml = '<div style="font-size:12px;color:var(--text-light);margin-bottom:12px;line-height:1.6;">'
      + '<strong>💡 配置说明</strong><br>'
      + '• 默认对接本地 Ollama 服务（http://localhost:11434）<br>'
      + '• 如使用 OpenAI 请填写 API Key，并将 endpoint 改为 https://api.openai.com/v1/chat/completions<br>'
      + '• 也可对接其他 OpenAI 兼容服务（如 DeepSeek、通义千问等）'
    + '</div>';

    App.openModal('AI 配置',
      helpHtml
      + '<div class="form-group"><label>API 地址</label><input type="text" class="form-control" id="aiEndpoint" value="' + this._escapeHtml(cfg.endpoint) + '" placeholder="http://localhost:11434/v1/chat/completions"></div>'
      + '<div class="form-group"><label>模型名称</label><input type="text" class="form-control" id="aiModel" value="' + this._escapeHtml(cfg.model) + '" placeholder="qwen2.5 / gpt-4o-mini / deepseek-chat"></div>'
      + '<div class="form-group"><label>API Key（可选）</label><input type="password" class="form-control" id="aiApiKey" value="' + this._escapeHtml(cfg.apiKey) + '" placeholder="sk-..."></div>'
      + '<div class="form-row">'
        + '<div class="form-group"><label>最大 Token</label><input type="number" class="form-control" id="aiMaxTokens" value="' + cfg.maxTokens + '" min="256" max="8192"></div>'
        + '<div class="form-group"><label>温度</label><input type="number" class="form-control" id="aiTemperature" value="' + cfg.temperature + '" min="0" max="2" step="0.1"></div>'
      + '</div>',
      '<button class="btn btn-primary" onclick="AI._saveSettings()">保存</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>'
    );
  },

  _saveSettings() {
    this.saveConfig({
      endpoint: document.getElementById('aiEndpoint').value.trim(),
      model: document.getElementById('aiModel').value.trim(),
      apiKey: document.getElementById('aiApiKey').value.trim(),
      maxTokens: parseInt(document.getElementById('aiMaxTokens').value) || 2048,
      temperature: parseFloat(document.getElementById('aiTemperature').value) || 0.7,
    });
    App.closeModal();
    App.toast('AI 配置已保存', 'success');
  },

  _scrollToBottom() {
    const container = document.getElementById('aiMessages');
    if (container) { setTimeout(function() { container.scrollTop = container.scrollHeight; }, 50); }
  },

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};


// AI资料及聊天仅管理员可访问，隐藏导航和直接调用采用同一身份检查。
Object.keys(AI).forEach(function(name) {
  if (typeof AI[name] !== 'function') return;
  var action = AI[name];
  AI[name] = function() {
    if (!Auth.isAdmin()) return name === 'getConfig' ? {} : undefined;
    return action.apply(this, arguments);
  };
});
