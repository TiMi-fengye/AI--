/**
 * 手机端/PWA 支持：注册 Service Worker，并在支持的浏览器显示安装入口。
 * 手机登录仍使用系统现有账号密码；本模块不保存或处理任何额外凭据。
 */
(function (window, document) {
  'use strict';

  var deferredPrompt = null;

  function getInstallButton() {
    return document.getElementById('installAppBtn');
  }

  function setInstallButtonVisible(visible) {
    var button = getInstallButton();
    if (!button) return;
    button.hidden = !visible;
    button.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function isMobileBrowser() {
    var ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
      (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
  }

  function showInstallHelp() {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return;
    var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    var message;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      message = '当前地址是 HTTP，手机浏览器不会弹出自动安装窗口。\n\n请先配置 HTTPS 域名；现在也可以打开浏览器菜单，选择“添加到主屏幕”或“添加到桌面”。';
    } else if (isIOS) {
      message = '请点击 Safari 底部“分享”按钮，再选择“添加到主屏幕”。';
    } else {
      message = '请打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。';
    }
    window.alert(message);
  }

  function promptInstall() {
    if (!deferredPrompt) {
      showInstallHelp();
      return false;
    }
    try {
      deferredPrompt.prompt();
    } catch (e) {
      showInstallHelp();
      return false;
    }
    deferredPrompt.userChoice.then(function () {
      deferredPrompt = null;
      setInstallButtonVisible(false);
    }).catch(function () {
      deferredPrompt = null;
      showInstallHelp();
    });
    return true;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {
      // 无 HTTPS 或浏览器不支持时，系统仍可作为普通手机网页使用。
    });
  }

  function init() {
    registerServiceWorker();
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferredPrompt = event;
      setInstallButtonVisible(true);
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      setInstallButtonVisible(false);
    });
    var button = getInstallButton();
    if (button) {
      button.addEventListener('click', promptInstall);
      // HTTP、iOS 或部分浏览器不会发送 beforeinstallprompt，仍显示按钮并给出可执行说明。
      if (isMobileBrowser()) setInstallButtonVisible(true);
    }
  }

  window.MobileClient = {
    init: init,
    promptInstall: promptInstall
  };
})(window, document);
