/**
 * 飞书集成模块：服务端应用消息 + 兼容群机器人 Webhook。
 * App Secret 只保存在本地 Node 服务端，不写入浏览器。
 */
const Feishu = {
  _key: "personnel_feishu_config",
  getConfig() { try { return JSON.parse(localStorage.getItem(this._key)) || {}; } catch(e) { return {}; } },
  saveConfig(cfg) { localStorage.setItem(this._key, JSON.stringify(cfg || {})); },
  getWebhook() { return this.getConfig().webhook || ""; },
  loadAppConfig() {
    return fetch("/api/feishu/config", { cache: "no-store" }).then(function(r) { return r.json(); }).catch(function() { return {}; });
  },
  saveAppConfig(cfg) {
    return fetch("/api/feishu/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg || {}) }).then(function(r) {
      return r.json().then(function(d) { if (!r.ok || d.ok === false) throw new Error(d.message || "保存飞书配置失败"); return d; });
    });
  },
  loadLoginConfig() {
    return fetch("/api/feishu/login-config", { cache: "no-store" }).then(function(r) { return r.json(); }).catch(function() { return { enabled: false, autoProvision: true }; });
  },
  saveLoginConfig(cfg) {
    return fetch("/api/feishu/login-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg || {}) }).then(function(r) {
      return r.json().then(function(d) { if (!r.ok || d.ok === false) throw new Error(d.message || "保存飞书登录配置失败"); return d; });
    });
  },
  isFeishuClient() {
    return !!(window.tt && (typeof window.tt.requestAccess === "function" || typeof window.tt.requestAuthCode === "function"));
  },
  exchangeAuthCode(code) {
    return fetch("/api/feishu/auth-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) }).then(function(r) {
      return r.json().then(function(d) { if (!r.ok || d.ok === false) throw new Error(d.message || "飞书免登校验失败"); return d.user; });
    });
  },
  startClientLogin(appId) {
    var api = window.tt;
    if (!api) return Promise.reject(new Error("当前页面不在飞书客户端内"));
    var self = this;
    return new Promise(function(resolve, reject) {
      var done = false;
      function finishError(error) {
        if (done) return;
        done = true;
        reject(new Error((error && (error.errString || error.message)) || "飞书工作台免登失败"));
      }
      function finishCode(result) {
        if (done) return;
        var code = result && result.code;
        if (!code) { finishError({ message: "飞书未返回授权码" }); return; }
        self.exchangeAuthCode(code).then(function(user) {
          if (done) return;
          done = true;
          resolve(user);
        }).catch(finishError);
      }
      function requestAuthCode() {
        if (typeof api.requestAuthCode !== "function") { finishError({ message: "当前飞书客户端不支持免登接口" }); return; }
        try {
          api.requestAuthCode({ appId: appId, success: finishCode, fail: finishError });
        } catch (e) { finishError(e); }
      }
      if (typeof api.requestAccess === "function") {
        try {
          api.requestAccess({
            appID: appId,
            scopeList: [],
            success: finishCode,
            fail: function(error) {
              // 103 表示客户端版本较低，按官方兼容流程回退到 requestAuthCode。
              if (error && error.errno === 103) requestAuthCode();
              else finishError(error);
            }
          });
        } catch (e) { requestAuthCode(); }
      } else {
        requestAuthCode();
      }
    });
  },
  startLogin() {
    return this.loadLoginConfig().then(function(cfg) {
      if (!cfg.enabled) throw new Error("系统尚未启用飞书登录");
      if (Feishu.isFeishuClient()) return Feishu.startClientLogin(cfg.appId);
      return fetch("/api/feishu/auth-url", { cache: "no-store" }).then(function(r) {
        return r.json().then(function(d) { if (!r.ok || d.ok === false) throw new Error(d.message || "无法创建飞书登录授权"); return d; });
      });
    }).then(function(d) {
      return new Promise(function(resolve, reject) {
        var popup = window.open(d.authUrl, "feishu_oauth", "width=520,height=680,resizable=yes,scrollbars=yes");
        if (!popup) { reject(new Error("浏览器阻止了登录窗口，请允许弹出窗口后重试")); return; }
        var timer = null;
        var done = false;
        function cleanup() { if (done) return; done = true; window.removeEventListener("message", onMessage); if (timer) clearInterval(timer); }
        function onMessage(e) {
          if (e.origin !== window.location.origin || !e.data || e.data.type !== "feishu-auth-result") return;
          cleanup();
          if (e.data.payload && e.data.payload.ok) resolve(e.data.payload.user);
          else reject(new Error((e.data.payload && e.data.payload.message) || "飞书授权失败"));
        }
        window.addEventListener("message", onMessage);
        timer = setInterval(function() { if (popup.closed) { cleanup(); reject(new Error("飞书登录窗口已关闭")); } }, 500);
      });
    });
  },
  send(text) {
    var webhook = this.getWebhook();
    return fetch("/api/feishu/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text }) })
      .then(function(r) { return r.json().then(function(d) { if (r.ok && d.ok !== false) return d; throw new Error(d.message || "发送飞书消息失败"); }); })
      .catch(function(err) {
        if (!webhook) throw err;
        return fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msg_type: "text", content: { text: text } })
        });
      });
  },
  test(text) {
    var webhook = this.getWebhook();
    return fetch("/api/feishu/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text || "人员管理系统已接入飞书！" }) })
      .then(function(r) { return r.json().then(function(d) { if (r.ok && d.ok !== false) return d; throw new Error(d.message || "飞书测试消息发送失败"); }); })
      .catch(function(err) { if (webhook) return Feishu.send(text || "人员管理系统已接入飞书！"); throw err; });
  },
  notifyLeave(emp, lv) {
    var msg = "✅ 新请假申请\n员工: " + emp.name + "\n类型: " + lv.type + "\n天数: " + lv.days + "\n日期: " + lv.startDate + " ~ " + lv.endDate;
    return this.send(msg).catch(function() {});
  },
  notifyOvertime(emp, ot) {
    var msg = "⏰ 新加班申请\n员工: " + emp.name + "\n时长: " + (parseFloat(ot.hours) || 0) + " 小时\n日期: " + ot.date;
    return this.send(msg).catch(function() {});
  }
};
