'use strict';
(() => {
  if (!window.withyou.ai) return;
  const api = window.withyou.ai;
  const mask = document.createElement('div'); mask.id = 'ai-mask'; mask.className = 'modal-mask'; mask.hidden = true;
  mask.innerHTML = `<section class="modal ai-modal" role="dialog" aria-modal="true" aria-labelledby="ai-heading">
    <div class="ai-dialog-heading"><h3 id="ai-heading" data-i18n="确认任务"></h3><button id="ai-close" class="subtle-btn" data-i18n="返回"></button></div>
    <div id="ai-input">
      <details class="ai-advanced"><summary data-i18n="整理选项"></summary>
      <label><span data-i18n="原文参考日期"></span><input id="ai-reference" type="date"></label>
      <label><span data-i18n="记录名称"></span><input id="ai-title" maxlength="200"></label>
      </details>
      <label><span data-i18n="原文（最多 30000 字）"></span><textarea id="ai-text" maxlength="30000"></textarea></label>
      <div class="ai-row"><button id="ai-analyze" class="primary-btn" data-i18n="整理成任务"></button><button id="ai-cancel" class="subtle-btn" data-i18n="取消整理" hidden></button></div>
    </div>
    <button id="ai-edit-source" class="subtle-btn" data-i18n="编辑原文 / 重新整理" hidden></button>
    <p id="ai-status" class="ai-status" role="status" aria-live="polite"></p>
    <section id="ai-preview" hidden>
      <p class="ai-help" data-i18n="勾选要创建的任务，标题可直接修改。补充建议默认不选。"></p>
      <details class="ai-advanced"><summary data-i18n="按负责人筛选"></summary>
      <div class="ai-row"><label><span data-i18n="我的姓名（匹配负责人）"></span><input id="ai-me" maxlength="100"></label>
      <label><span data-i18n="任务范围"></span><select id="ai-scope"><option value="all" data-i18n="全部行动项"></option><option value="mine" data-i18n="只看我的任务"></option></select></label></div>
      </details>
      <details class="ai-advanced"><summary data-i18n="会议结论与讨论"></summary><p id="ai-decisions" class="ai-help"></p></details><div id="ai-drafts"></div>
      <div class="modal-actions"><span id="ai-count" class="ai-help"></span><button id="ai-commit" class="primary-btn" data-i18n="确认并创建任务"></button></div>
    </section>
    <button id="ai-undo" class="subtle-btn" data-i18n="撤销刚才整批任务" hidden></button>
    <details id="ai-history"><summary data-i18n="来源记录"></summary><div id="ai-history-list"></div></details>
    <section id="ai-source" hidden><h4 id="ai-source-title"></h4><p id="ai-source-text" class="ai-source-text" contenteditable="false"></p><button type="button" id="ai-copy-source" class="subtle-btn" data-i18n="复制全文"></button></section>
  </section>`;
  document.body.append(mask); i18n.apply();
  const $ = id => document.getElementById('ai-' + id);
  const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
  let draft = null, busy = false, lastBatch = null, priorFocus, sourceVersion = 0, viewingSource = false, returnContext = null, returning = false;
  const call = async (method, input) => { const r = await api[method](input); if (!r.ok) throw new Error(r.error); return r.data; };
  const act = fn => async () => { try { await fn(); } catch (e) { status(e.message, true); } };
  const localDate = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('reference').value = localDate(new Date());
  function setBusy(value) {
    busy = value;
    for (const id of ['analyze', 'reference', 'text', 'title']) $(id).disabled = value;
    $('cancel').hidden = !value;
  }
  function invalidate() { viewingSource = false; $('close').dataset.i18n = '返回'; $('close').textContent = tr('返回'); sourceVersion++; $('heading').textContent = tr('确认任务'); $('history').hidden = false; $('source').hidden = true; draft = null; $('preview').hidden = true; $('input').hidden = false; $('edit-source').hidden = true; }
  $('edit-source').onclick = () => { $('input').hidden = false; $('text').focus(); };
  for (const id of ['text', 'reference', 'title']) $(id).addEventListener('input', invalidate);
  async function history() {
    const sources = await call('sources'); $('history-list').replaceChildren();
    const pending = await call('drafts');
    for (const source of pending) {
      const b = document.createElement('button'); b.className = 'subtle-btn ai-history-item';
      b.textContent = tr('待确认') + ' · ' + source.text.slice(0, 60);
      b.onclick = () => window.dispatchEvent(new CustomEvent('withyou:ai-draft', { detail: { ...source, draft: source.result } }));
      $('history-list').append(b);
    }

    for (const source of sources.slice().reverse()) {
      const b = document.createElement('button'); b.className = 'subtle-btn ai-history-item';
      b.textContent = source.title + ' · ' + new Date(source.createdAt).toLocaleString();
      b.onclick = act(() => showSource(source.id)); $('history-list').append(b);
    }
  }
  $('copy-source').onclick = async () => {
    try { await navigator.clipboard.writeText($('source-text').textContent); showToast(tr('已复制')); }
    catch (_) { showToast(tr('复制失败，请手动复制')); }
  };
  async function showSource(id, version = ++sourceVersion) {
    $('source').hidden = true;
    const source = await call('source', id);
    if (version !== sourceVersion) return;
    if (!source) throw new Error(tr('来源记录不存在'));
    viewingSource = true; $('close').dataset.i18n = '关闭'; $('close').textContent = tr('关闭');
    $('heading').textContent = tr('任务原文');
    $('input').hidden = true; $('preview').hidden = true; $('edit-source').hidden = true;
    $('history').hidden = true; $('undo').hidden = true; status('');
    $('source-title').textContent = source.title;
    $('source-text').textContent = source.text;
    $('source').hidden = false;
    mask.querySelector('.ai-modal').scrollTop = 0;
  }
  async function open(selection = {}) {
    priorFocus = document.activeElement; mask.hidden = false;
    await history(); $('text').focus();
  }
  $('close').onclick = async () => {
    if (mask.hidden || returning) return;
    if (busy) { status(tr('请先取消整理')); return; }
    returning = true;
    try {
      if (draft && !viewingSource) await persistEdits();
      mask.hidden = true;
      if (viewingSource) { priorFocus?.focus(); return; }
      window.dispatchEvent(new CustomEvent('withyou:ai-return', { detail: returnContext || { text: $('text').value, aiMode: true } }));
    } catch (error) { status(error.message, true); }
    finally { returning = false; }
  };
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); $('close').click(); }
    if (event.key === 'Tab') {
      const items = [...mask.querySelectorAll('button,input,textarea,select,summary')].filter(e => !e.disabled && e.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('withyou:ai-config-saved', invalidate);
  $('cancel').onclick = act(() => call('cancel'));
  $('analyze').onclick = act(async () => {
    if (!$('text').value.trim() || !$('reference').value) throw new Error(tr('请填写原文和参考日期'));
    invalidate(); setBusy(true); status(tr('正在整理，请稍候…'));
    try {
      draft = await call('analyze', { text: $('text').value, title: $('title').value, referenceDate: $('reference').value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      renderDrafts(); $('preview').hidden = false; $('input').hidden = true; $('edit-source').hidden = false;
      status(tr('草稿已生成，请核对后创建'));
    } finally { setBusy(false); }
  });
  function visible(card) {
    const owner = card.querySelector('[data-field=owner]').value.trim();
    const me = $('me').value.trim();
    return $('scope').value === 'all' || (me && owner === me);
  }
  function updateCount() {
    let count = 0, steps = 0;
    for (const card of $('drafts').children) {
      card.hidden = !visible(card);
      if (!card.hidden && card.querySelector('[type=checkbox]').checked) {
        count++; steps += card.querySelector('[data-field=steps]').value.split('\n').filter(s => s.trim()).length;
      }
    }
    $('count').textContent = tr('将创建 {0} 个任务，包含 {1} 个子任务', count, steps);
    $('commit').disabled = !count || busy;
  }
  for (const id of ['me', 'scope']) $(id).oninput = updateCount;
  async function persistEdits() {
    if (!draft) return;
    const tasks = [...$('drafts').children].map((card, index) => {
      const t = { ...card._task, selected: card.querySelector('[type=checkbox]').checked };
      for (const field of card.querySelectorAll('[data-field]')) t[field.dataset.field] = field.dataset.field === 'steps' ? field.value.split('\n').filter(Boolean) : ['startAt','dueAt','reminderAt'].includes(field.dataset.field) ? (field.value ? new Date(field.value).toISOString() : null) : field.value;
      return t;
    });
    await call('editDraft', { id: draft.id, tasks });
  }
  function renderDrafts() {
    $('drafts').replaceChildren();
    $('decisions').textContent = draft.decisions ? tr('决定与讨论事项：') + '\n' + draft.decisions : '';
    $('decisions').parentElement.hidden = !draft.decisions;
    for (const task of draft.tasks) {
      const card = document.createElement('article'); card.className = 'ai-draft'; card._task = task;
      const main = document.createElement('div'); main.className = 'ai-draft-main';
      const timeEditor = document.createElement('details'); timeEditor.className = 'ai-time-editor';
      const timeToggle = document.createElement('summary'); timeToggle.textContent = tr('修改日期与提醒'); timeEditor.append(timeToggle);
      const details = document.createElement('details'); details.className = 'ai-task-details';
      const toggle = document.createElement('summary'); toggle.textContent = tr('编辑详情'); details.append(toggle);
      const detailGrid = document.createElement('div'); detailGrid.className = 'ai-detail-grid';
      const label = document.createElement('label'); label.className = 'ai-select';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = task.selected ?? !task.suggested;
      check.setAttribute('aria-label', tr('选择此任务')); label.append(check); main.append(label); card.append(main, timeEditor);
      for (const [key, caption, type, max] of [['title', '任务标题', 'text', 200], ['project', '所属项目（可选）', 'text', 100], ['startAt', '开始时间', 'datetime-local'], ['dueAt', '截止时间', 'datetime-local'], ['reminderMinutes', '提醒时间', 'select'], ['note', '备注', 'textarea', 500], ['owner', '负责人', 'text', 100], ['dependency', '依赖', 'text', 200], ['steps', '子任务（每行一条，最多 50 条）', 'textarea', 10049], ['questions', '待确认事项', 'textarea', 200]]) {
        const field = document.createElement('label'); if (key !== 'title') field.append(document.createTextNode(tr(caption)));
        const input = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'); if (!['textarea','select'].includes(type)) input.type = type;
        if (type === 'select') for (const minutes of [5,10,30]) { const option = document.createElement('option'); option.value = String(minutes); option.textContent = tr('提前{0}分钟', minutes); input.append(option); }
        input.dataset.field = key; if (max) input.maxLength = max;
        if (key === 'project') input.setAttribute('list', 'task-project-options');
        input.value = key === 'steps' ? task.steps.join('\n') : (type === 'datetime-local' && task[key] ? new Date(new Date(task[key]).getTime() - new Date(task[key]).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : (key === 'reminderMinutes' ? task[key] || 5 : task[key] || ''));
        input.setAttribute('aria-label', tr(caption));
        field.append(input);
        if (key === 'title') { field.className = 'ai-title-field'; main.append(field); } else if (['startAt','dueAt','reminderMinutes'].includes(key)) { field.className = 'ai-visible-time'; timeEditor.append(field); } else if (['owner','dependency'].includes(key)) { detailGrid.append(field); } else details.append(field);
      }
      if (detailGrid.children.length) details.insertBefore(detailGrid, details.children[1] || null);
      const remove = document.createElement('button'); remove.className = 'ghost-btn'; remove.type = 'button'; remove.textContent = '×'; remove.title = tr('移除任务'); remove.setAttribute('aria-label', tr('移除任务'));
      remove.onclick = () => { card.remove(); updateCount(); persistEdits().catch(e => status(e.message, true)); }; main.append(remove);
      const meta = document.createElement('div'); meta.className = 'ai-task-meta'; card.append(meta);
      const warning = document.createElement('div'); warning.className = 'ai-task-warning'; card.append(warning);
      const quote = document.createElement('blockquote'); quote.textContent = task.quote || tr('无对应原文，请核实'); details.append(quote); card.append(details);
      const summarize = () => {
        const value = key => card.querySelector('[data-field=' + key + ']').value;
        const count = value('steps').split('\n').filter(s => s.trim()).length;
        meta.textContent = [value('owner'), value('startAt') ? tr('开始 ') + new Date(value('startAt')).toLocaleString() : '', value('dueAt') ? tr('截止 ') + new Date(value('dueAt')).toLocaleString() : '', (value('startAt') || value('dueAt')) ? tr('提前{0}分钟', value('reminderMinutes')) : '', count ? tr('{0} 个子任务', count) : ''].filter(Boolean).join(' · ');
        meta.hidden = !meta.textContent;
        warning.textContent = [task.suggested ? tr('AI 补充建议（请核实）') : '', value('questions')].filter(Boolean).join(' · ');
        warning.hidden = !warning.textContent;
      };
      card.oninput = () => { summarize(); updateCount(); persistEdits().catch(e => status(e.message, true)); }; summarize(); $('drafts').append(card);
    }
    updateCount();
  }
  $('commit').onclick = act(async () => {
    if (!draft || busy) return;
    const tasks = [...$('drafts').children].filter(c => !c.hidden && c.querySelector('[type=checkbox]').checked).map(card => {
      const task = {};
      for (const field of card.querySelectorAll('[data-field]')) {
        task[field.dataset.field] = field.dataset.field === 'steps' ? field.value.split('\n').map(s => s.trim()).filter(Boolean) :
          ['startAt', 'dueAt', 'reminderAt'].includes(field.dataset.field) ? (field.value ? new Date(field.value).toISOString() : null) : field.value;
      }
      if (task.steps.length > 50 || task.steps.some(s => s.length > 200)) throw new Error(tr('子任务最多 50 条，每条最多 200 字'));
      return task;
    });
    busy = true; $('commit').disabled = true;
    try {
      const result = await call('commit', { id: draft.id, tasks }); lastBatch = result.batchId;
      window.dispatchEvent(new CustomEvent('withyou:ai-created', { detail: result }));
      invalidate(); $('undo').hidden = false; mask.hidden = true;
      const focusTarget = priorFocus?.isConnected && priorFocus.getClientRects().length ? priorFocus : document.getElementById('btn-add-task');
      focusTarget?.focus();
      showToast(tr('已创建 {0} 个任务', result.count), { action: () => undoBatch(result.batchId) });
    } finally { busy = false; updateCount(); }
  });
  async function undoBatch(batchId) {
    if (!batchId || !await window.uiDialogs.confirm(tr('撤销将删除这一批创建的全部任务（包括后续编辑），是否继续？'))) return;
    try {
      const count = await call('undo', batchId);
      if (lastBatch === batchId) { lastBatch = null; $('undo').hidden = true; }
      $('source').hidden = true;
      showToast(tr('已撤销 {0} 个任务', count));
      await history();
    } catch (error) { showToast(error.message); }
  }
  $('undo').onclick = () => undoBatch(lastBatch);
  window.addEventListener('withyou:ai-source', event => {
    const version = ++sourceVersion;
    $('input').hidden = true; $('preview').hidden = true; $('source').hidden = true;
    open().then(() => showSource(event.detail, version)).catch(e => status(e.message, true));
  });
  window.addEventListener('withyou:ai-draft', async event => {
    if (busy) return;
    busy = true;
    try {
      returnContext = event.detail.returnToAdd || null;
      invalidate(); $('text').value = event.detail.text;
      $('scope').value = 'all'; $('source').hidden = true;
      await open(event.detail);
      if (event.detail.referenceDate) $('reference').value = event.detail.referenceDate;
      draft = event.detail.draft;
      renderDrafts(); $('preview').hidden = false; $('input').hidden = true; $('edit-source').hidden = false;
      status(tr('草稿已生成，请核对后创建'));
      mask.querySelector('.ai-modal').scrollTop = 0;
    } catch (error) { status(error.message, true); }
    finally { busy = false; updateCount(); if (!$('preview').hidden) ($('commit').disabled ? $('close') : $('commit')).focus({ preventScroll: true }); }
  });
  window.addEventListener('withyou:ai-input', event => {
    if (busy) return;
    returnContext = event.detail.returnToAdd || null;
    invalidate(); $('text').value = event.detail.text || '';
    $('scope').value = 'all';
    open(event.detail).catch(e => status(e.message, true));
  });
  let receivingPreview = false;
  async function receiveQuickPreview() {
    if (receivingPreview) return;
    if (busy || !mask.hidden) { setTimeout(receiveQuickPreview, 300); return; }
    receivingPreview = true;
    try {
      const payload = await call('takePreview');
      if (payload) window.dispatchEvent(new CustomEvent('withyou:ai-draft', { detail: payload }));
    } catch (error) { status(error.message, true); }
    finally { receivingPreview = false; }
  }
  window.withyou.app.onAIPreview(receiveQuickPreview);
  receiveQuickPreview();
  window.addEventListener('withyou:language', () => { i18n.apply(); if (draft) updateCount(); });
})();
