/**
 * 微信网页登录模块。
 * AppSecret 只在服务端使用，浏览器只获取登录授权地址和已校验的身份信息。
 */
const Wechat = {
  loadLoginConfig() {
    return fetch('/api/wechat/login-config', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { enabled: false, autoProvision: false }; });
  },

  saveLoginConfig(cfg) {
    return fetch('/api/wechat/login-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg || {})
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.message || '保存微信登录配置失败');
        return d;
      });
    });
  },

  startLogin() {
    return this.loadLoginConfig().then(function (cfg) {
      if (!cfg.enabled) throw new Error('系统尚未启用微信登录');
      return fetch('/api/wechat/auth-url', { cache: 'no-store' }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.message || '无法创建微信登录授权');
          return d;
        });
      });
    }).then(function (d) {
      return new Promise(function (resolve, reject) {
        var popup = window.open(d.authUrl, 'wechat_oauth', 'width=520,height=680,resizable=yes,scrollbars=yes');
        if (!popup) { reject(new Error('浏览器阻止了登录窗口，请允许弹出窗口后重试')); return; }
        var timer = null;
        var done = false;
        function cleanup() {
          if (done) return;
          done = true;
          window.removeEventListener('message', onMessage);
          if (timer) clearInterval(timer);
        }
        function onMessage(e) {
          if (e.origin !== window.location.origin || !e.data || e.data.type !== 'wechat-auth-result') return;
          cleanup();
          if (e.data.payload && e.data.payload.ok) resolve(e.data.payload.user);
          else reject(new Error((e.data.payload && e.data.payload.message) || '微信授权失败'));
        }
        window.addEventListener('message', onMessage);
        timer = setInterval(function () {
          if (popup.closed) { cleanup(); reject(new Error('微信登录窗口已关闭')); }
        }, 500);
      });
    });
  }
};
