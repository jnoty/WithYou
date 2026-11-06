'use strict';
(() => {
  const mask = document.getElementById('settings-mask');
  const tabs = [...mask.querySelectorAll('[data-settings-tab]')];
  const panels = [...mask.querySelectorAll('[data-settings-panel]')];
  const api = window.withyou.ai;
  const $ = id => document.getElementById(id);
  const status = (text, error = false) => { $('settings-ai-status').textContent = text; $('settings-ai-status').classList.toggle('error', error); };
  const call = async (name, input) => { const result = await api[name](input); if (!result.ok) throw new Error(result.error); return result.data; };
  let dirty = false;
  $('ai-config').addEventListener('input', () => { dirty = true; });
  let leavePending = false;
  const canLeave = async () => {
    if (leavePending) return false;
    if (!dirty) return true;
    leavePending = true;
    try { return await window.uiDialogs.confirm(tr('尚有未保存的连接设置，放弃修改？')); }
    finally { leavePending = false; }
  };
  const requestClose = async () => {
    if (!await canLeave()) return;
    dirty = false; mask.hidden = true; $('btn-settings').focus();
  };
  mask.addEventListener('click', e => {
    if (e.target === mask || e.target.closest('#btn-close-settings')) {
      e.preventDefault(); e.stopImmediatePropagation(); requestClose();
    }
  }, true);
  let providers = [], configuredModels = [], editingProviderId = '';
  const renderConfiguredModels = preferred => {
    $('ai-model').replaceChildren(); $('ai-configured-models').replaceChildren();
    for (const model of configuredModels) {
      const option = document.createElement('option'); option.value = model; option.textContent = model; $('ai-model').append(option);
      const row = document.createElement('div'); row.className = 'configured-model-row';
      const name = document.createElement('code'); name.textContent = model; row.append(name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = tr('移除模型'); remove.setAttribute('aria-label', tr('移除模型') + ': ' + model);
      remove.onclick = () => { dirty = true; configuredModels = configuredModels.filter(id => id !== model); renderConfiguredModels($('ai-model').value); };
      row.append(remove); $('ai-configured-models').append(row);
    }
    if (configuredModels.includes(preferred)) $('ai-model').value = preferred;
  };
  async function editProvider(provider = {}) {
    if (dirty && !await canLeave()) return; dirty = false;
    editingProviderId = provider.id || ''; resetModels();
    $('ai-provider').value = editingProviderId;
    $('ai-provider-name').value = provider.name || '';
    $('ai-format').value = provider.format || 'openai'; syncFormat();
    $('ai-endpoint').value = provider.endpoint || '';
    configuredModels = [...(provider.models || [])]; renderConfiguredModels(provider.model);
    $('ai-model-input').value = ''; $('ai-key').value = ''; $('ai-clear-key').checked = false;
    $('ai-key').placeholder = tr(provider.hasKey ? '已保存密钥' : '本机无密钥服务可留空');
    $('ai-delete-provider').disabled = !editingProviderId;
    $('ai-config').hidden = false;
    $('ai-editor-title').textContent = tr(editingProviderId ? '编辑供应商' : '添加供应商');
    $('ai-custom-settings').open = !editingProviderId;
    const target = [...$('ai-provider-cards').children].find(card => card.dataset.providerId === editingProviderId);
    (target || $('ai-add-provider')).after($('ai-config'));
    for (const card of $('ai-provider-cards').children) card.classList.toggle('editing', card.dataset.providerId === editingProviderId);
    status('');
  }
  async function closeEditor() {
    if (dirty && !await canLeave()) return; dirty = false;
    $('ai-config').hidden = true; $('ai-key').value = ''; resetModels();
    for (const card of $('ai-provider-cards').children) card.classList.remove('editing');
    $('ai-add-provider').focus();
  }
  $('ai-cancel-edit').onclick = closeEditor;
  function renderProviders(config, preferred) {
    $('ai-add-provider').after($('ai-config'));
    providers = config.providers; $('ai-provider').replaceChildren();
    const defaultSelect = $('ai-global-default'); defaultSelect.replaceChildren();
    for (const provider of providers) for (const model of provider.models) {
      const option = document.createElement('option'); option.value = JSON.stringify([provider.id, model]);
      option.textContent = provider.name + ' / ' + model; defaultSelect.append(option);
    }
    defaultSelect.value = JSON.stringify([config.providerId, config.model]);
    defaultSelect.disabled = !providers.length; defaultSelect.dataset.savedValue = defaultSelect.value;

    const empty = document.createElement('option'); empty.value = ''; empty.textContent = tr('新增供应商'); $('ai-provider').append(empty);
    for (const provider of providers) { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name; $('ai-provider').append(option); }
    $('ai-provider-cards').replaceChildren();
    for (const provider of providers) {
      const card = document.createElement('article'); card.className = 'provider-card'; card.dataset.providerId = provider.id;
      const icon = document.createElement('span'); icon.className = 'provider-avatar'; icon.textContent = provider.name.slice(0, 1).toUpperCase();
      const info = document.createElement('div'); info.className = 'provider-card-info';
      const title = document.createElement('strong'); title.textContent = provider.name;
      const meta = document.createElement('span'); meta.textContent = { openai: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic Messages' }[provider.format] + ' · ' + tr('{0} 个模型', provider.models.length);
      const keyState = document.createElement('small'); keyState.className = 'provider-key-state'; keyState.textContent = tr(provider.hasKey ? '密钥已保存' : '未配置密钥'); keyState.classList.toggle('configured', provider.hasKey);
      info.append(title, meta, keyState);
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'subtle-btn provider-edit'; edit.textContent = tr('编辑'); edit.onclick = () => editProvider(provider);
      card.append(icon, info, edit); $('ai-provider-cards').append(card);
    }
    editProvider(providers.find(p => p.id === preferred) || providers.find(p => p.id === config.providerId) || {});
    closeEditor();
  }
  $('ai-global-default').onchange = async () => {
    const select = $('ai-global-default');
    if (dirty) { status(tr('请先保存或取消连接修改'), true); select.value = select.dataset.savedValue; return; }
    select.disabled = true;
    try {
      const [providerId, model] = JSON.parse(select.value);
      renderProviders(await call('setDefault', { providerId, model }));
      status(tr('默认模型已保存'));
      window.dispatchEvent(new Event('withyou:ai-config-saved'));
    } catch (error) { status(i18n.error(error.message), true); await load(); }
    finally { select.disabled = !providers.length; }
  };
  $('ai-provider').onchange = () => editProvider(providers.find(p => p.id === $('ai-provider').value));
  $('ai-test-connection').onclick = async () => {
    const button = $('ai-test-connection'); button.disabled = true;
    try {
      if (dirty) throw new Error(tr('请先保存连接设置后测试'));
      status(tr('正在测试默认模型…'));
      await call('testConnection'); status(tr('默认模型连接成功，可以生成任务'));
    } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  };
  $('ai-preset').onchange = () => {
    const presets = { deepseek: ['https://api.deepseek.com/v1',''], kimi: ['https://api.moonshot.cn/v1',''], coding: ['https://api.kimi.com/coding/v1','kimi-for-coding'], opencode: ['https://opencode.ai/zen/go/v1',''] };
    const preset = presets[$('ai-preset').value]; if (!preset) return;
    $('ai-endpoint').value = preset[0]; $('ai-format').value = 'openai'; $('ai-model-input').value = preset[1];
    $('ai-provider-name').value = $('ai-preset').selectedOptions[0].textContent;
    dirty = true; resetModels(); syncFormat();
  };
  $('ai-add-provider').onclick = () => editProvider();
  $('ai-add-model').onclick = () => {
    const model = $('ai-model-input').value.trim();
    if (!model) return;
    if (!configuredModels.includes(model)) { configuredModels.push(model); dirty = true; }
    renderConfiguredModels(model); $('ai-model-input').value = '';
  };
  $('ai-delete-provider').onclick = async () => {
    if (!editingProviderId || saving || detecting || !await window.uiDialogs.confirm(tr('删除此供应商及其模型配置？已有任务不受影响。'))) return;
    try { const config = await call('deleteProvider', editingProviderId); dirty = false; renderProviders(config); window.dispatchEvent(new Event('withyou:ai-config-saved')); }
    catch (error) { status(i18n.error(error.message), true); }
  };
  let detecting = false, revision = 0;
  const resetModels = () => {
    revision++; $('ai-models-field').hidden = true;
    $('ai-model-results').replaceChildren(); $('ai-model-search').value = ''; $('ai-models-status').textContent = '';
  };
  const syncFormat = () => { $('ai-format-hint').textContent = tr($('ai-format').value === 'responses' ? 'Responses 格式使用 /responses，Key 通过 Bearer 认证发送。' : $('ai-format').value === 'anthropic' ? 'Anthropic 格式使用 /messages，Key 通过 x-api-key 发送。' : 'OpenAI 格式使用 /chat/completions，Key 通过 Bearer 认证发送。'); };
  for (const id of ['ai-endpoint', 'ai-key', 'ai-clear-key', 'ai-format']) $(id).addEventListener('input', resetModels);
  $('ai-format').addEventListener('change', syncFormat);
  window.addEventListener('withyou:language', syncFormat);
  $('ai-model-search').oninput = () => {
    const query = $('ai-model-search').value.toLowerCase();
    for (const row of $('ai-model-results').children) row.hidden = !row.textContent.toLowerCase().includes(query);
  };
  $('ai-add-selected').onclick = () => {
    const selected = [...$('ai-model-results').querySelectorAll('input:checked')].map(input => input.value);
    for (const model of selected) if (!configuredModels.includes(model)) { configuredModels.push(model); dirty = true; }
    renderConfiguredModels($('ai-model').value || selected[0]);
    for (const input of $('ai-model-results').querySelectorAll('input:checked')) input.checked = false;
  };
  $('ai-fetch-models').onclick = async () => {
    if (!api || detecting || saving) return;
    resetModels(); const currentRevision = revision;
    detecting = true; $('ai-fetch-models').disabled = true; $('ai-save-config').disabled = true;
    $('ai-models-status').classList.remove('error'); $('ai-models-status').textContent = tr('正在检测并获取模型…');
    try {
      const models = await call('listModels', { providerId: editingProviderId, format: $('ai-format').value, endpoint: $('ai-endpoint').value.trim(), key: $('ai-key').value, clearKey: $('ai-clear-key').checked });
      if (revision !== currentRevision) return;
      for (const model of models) { const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; check.value = model; label.append(check, document.createTextNode(model)); $('ai-model-results').append(label); }
      $('ai-models-field').hidden = !models.length;
      $('ai-models-status').textContent = models.length ? tr('已获取 {0} 个模型，请选择后保存连接设置', models.length) : tr('服务未返回可用模型，请手动填写模型名称');
    } catch (error) {
      if (revision !== currentRevision) return;
      $('ai-models-status').textContent = i18n.error(error.message); $('ai-models-status').classList.add('error');
    } finally { detecting = false; $('ai-fetch-models').disabled = false; $('ai-save-config').disabled = saving; }
  };
  async function select(id) {
    if (dirty && !await canLeave()) return; dirty = false;
    if (!panels.some(panel => panel.dataset.settingsPanel === id)) id = 'general';
    for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.settingsTab === id));
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== id;
    mask.querySelector('.settings-content').scrollTop = 0;
  }
  for (const tab of tabs) tab.onclick = () => select(tab.dataset.settingsTab);
  async function load() {
    resetModels();
    if (!api) { status(tr('当前会话不支持 AI 配置'), true); return; }
    try {
      const config = await call('config');
      renderProviders(config);
    } catch (error) { status(i18n.error(error.message), true); }
  }
  $('btn-settings').addEventListener('click', () => { select('general'); load(); });
  window.addEventListener('withyou:open-settings', event => { $('btn-settings').click(); select(event.detail || 'general'); });
  let saving = false;
  $('ai-save-config').onclick = async () => {
    if (!api || saving || detecting) return;
    saving = true; $('ai-save-config').disabled = true;
    try {
      if ($('ai-model-input').value.trim()) $('ai-add-model').click();
      const config = await call('saveConfig', { providerId: editingProviderId, name: $('ai-provider-name').value, models: configuredModels, format: $('ai-format').value, endpoint: $('ai-endpoint').value.trim(), model: $('ai-model').value, key: $('ai-key').value, clearKey: $('ai-clear-key').checked });
      dirty = false; renderProviders(config, config.providerId);
      $('ai-key').value = ''; $('ai-clear-key').checked = false;
      $('ai-key').placeholder = tr(config.hasKey ? '已保存密钥' : '本机无密钥服务可留空');
      status(tr('连接设置已保存'));
      window.dispatchEvent(new Event('withyou:ai-config-saved'));
    } catch (error) { status(i18n.error(error.message), true); }
    finally { saving = false; $('ai-save-config').disabled = false; }
  };
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); requestClose(); return; }
    if (event.key === 'Tab') {
      const items = [...mask.querySelectorAll('button,input,select')].filter(e => !e.disabled && e.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
})();
