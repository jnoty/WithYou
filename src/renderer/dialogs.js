'use strict';
(() => {
  let queue = Promise.resolve();
  function show(message, confirmation) {
    const request = () => new Promise(resolve => {
      const previous = document.activeElement;
      const dialog = document.createElement('dialog'); dialog.className = 'app-dialog';
      dialog.setAttribute('aria-label', tr(confirmation ? '确认' : '提示'));
      const text = document.createElement('p'); text.textContent = message;
      const actions = document.createElement('div'); actions.className = 'modal-actions';
      const finish = value => { dialog.close(); dialog.remove(); if (previous?.isConnected && !previous.disabled && previous.getClientRects().length) previous.focus(); resolve(value); };
      const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'primary-btn dialog-accept'; accept.textContent = tr(confirmation ? '确认' : '关闭'); accept.onclick = () => finish(true);
      let cancel;
      if (confirmation) { cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'subtle-btn dialog-cancel'; cancel.textContent = tr('取消'); cancel.onclick = () => finish(false); actions.append(cancel); }
      actions.append(accept); dialog.append(text, actions); dialog.oncancel = e => { e.preventDefault(); finish(false); };
      dialog.addEventListener('keydown', e => e.stopPropagation());
      document.body.append(dialog); dialog.showModal(); (cancel || accept).focus();
    });
    const result = queue.then(request); queue = result.catch(() => {}); return result;
  }
  window.uiDialogs = { confirm: message => show(message, true), alert: message => show(message, false) };
})();
