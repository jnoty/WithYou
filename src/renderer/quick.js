'use strict';

const api = window.withyou;
const input = document.getElementById('title-input');
const button = document.getElementById('btn-create');
const status = document.getElementById('quick-status');
let busy = false, draft = null;
const call = async (method, value) => {
  const result = await api.ai[method](value);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
function reset() { draft = null; button.textContent = tr('AI 整理'); }
try { input.value = window.localStorage?.getItem('withyou-quick-input') || ''; } catch (_) {}
input.addEventListener('input', () => { reset(); try { window.localStorage?.setItem('withyou-quick-input', input.value); } catch (_) {} });
async function create() {
  if (busy || !input.value.trim()) return;
  busy = true; button.disabled = true; input.disabled = true;
  try {
    if (draft) {
      await call('preview', { id: draft.id });
      input.value = ''; try { window.localStorage?.removeItem('withyou-quick-input'); } catch (_) {} reset(); status.textContent = '';
      return;
    }
    const config = await call('config');
    if (!config.model) { status.textContent = tr('请先在设置中配置默认 AI 模型，或点击普通创建'); return; }
    status.textContent = tr('正在识别任务和时间…');
    const now = new Date();
    const referenceDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const result = await call('analyze', { text: input.value.trim(), referenceDate, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    draft = result;
    await call('preview', { id: draft.id });
    input.value = ''; try { window.localStorage?.removeItem('withyou-quick-input'); } catch (_) {} reset(); status.textContent = '';
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; button.disabled = false; input.disabled = false; input.focus(); }
}
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); create(); }
  if (e.key === 'Escape') { e.preventDefault(); api.app.hideQuick(); }
});
button.addEventListener('click', create);
document.getElementById('btn-manual').addEventListener('click', async () => {
  if (busy || !input.value.trim()) return;
  const title = input.value.trim();
  if (title.length > 1200) {
    status.textContent = tr('普通创建最多保存 1200 字，请缩短内容或使用 AI 整理');
    return;
  }
  busy = true; input.disabled = true; button.disabled = true; document.getElementById('btn-manual').disabled = true;
  try { await api.tasks.create({ title: title.slice(0, 200), note: title.slice(200), status: 'todo' }); input.value = ''; try { window.localStorage?.removeItem('withyou-quick-input'); } catch (_) {} reset(); status.textContent = tr('已创建 {0} 个任务', 1); }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; input.disabled = false; button.disabled = false; document.getElementById('btn-manual').disabled = false; input.focus(); }
});
api.app.onQuickFocus(() => { input.focus(); if (!draft) input.select(); });
reset();
