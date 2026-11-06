'use strict';

/**
 * 错误诊断钩子：任何脚本错误都会以红色横幅显示在页面顶部，
 * 同时输出到 console（配合 electron --enable-logging 可在终端看到）。
 */

function showError(msg) {
  console.error('[WithYou]', msg);
  const mount = () => {
    let el = document.getElementById('error-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'error-banner';
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;' +
        'padding:8px 12px;font-size:12px;z-index:9999;white-space:pre-wrap;font-family:monospace;';
      document.body.appendChild(el);
    }
    el.textContent = tr('[携手错误] ') + msg;
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
}

window.addEventListener('error', (e) => {
  showError((e.message || tr('未知错误')) + (e.filename ? `\n${e.filename}:${e.lineno}` : ''));
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showError(tr('Promise 未处理异常: ') + (r && (r.stack || r.message) || String(r)));
});

window.addEventListener('DOMContentLoaded', () => {
  if (!window.withyou) {
    showError(tr('preload API（window.withyou）未加载，渲染进程无法与主进程通信'));
  }
});
