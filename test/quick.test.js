'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function element() {
  return { value: '', textContent: '', disabled: false, children: [], handlers: {},
    addEventListener(name, fn) { this.handlers[name] = fn; },
    append(row) { this.children.push(row); }, replaceChildren() { this.children = []; }, focus() {}, select() {} };
}
const ids = Object.fromEntries(['title-input', 'btn-create', 'quick-status', 'quick-preview', 'btn-manual'].map(id => [id, element()]));
let analyzeCalls = 0, commits = 0, manual = 0, previews = 0, resolveAnalysis;
const api = { ai: {
  config: async () => ({ ok: true, data: { model: 'test' } }),
  analyze: input => { analyzeCalls++; assert.match(input.referenceDate, /^\d{4}-\d{2}-\d{2}$/); assert.ok(input.timeZone); return new Promise(resolve => { resolveAnalysis = resolve; }); },
  preview: async ({ id }) => { assert.equal(id, 'draft'); previews++; return { ok: true, data: true }; },
  commit: async ({ id, tasks }) => { assert.equal(id, 'draft'); assert.equal(tasks[0].startAt, '2026-11-07T15:00:00+08:00'); commits++; return { ok: true, data: {} }; }
}, tasks: { create: async () => { manual++; } }, app: { onQuickFocus() {}, hideQuick() {} } };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/quick.js'), 'utf8'), {
  window: { withyou: api }, document: { getElementById: id => ids[id], createElement: element },
  Intl, Date, tr: (s, ...values) => s.replace(/\{(\d+)\}/g, (_, n) => values[n])
});
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const input = ids['title-input']; input.value = '明天下午三点参加会议';
  input.handlers.keydown({ key: 'Enter', isComposing: true }); await tick(); assert.equal(analyzeCalls, 0);
  const pending = ids['btn-create'].handlers.click(); await tick();
  await ids['btn-create'].handlers.click(); assert.equal(analyzeCalls, 1); assert.equal(commits, 0);
  resolveAnalysis({ ok: true, data: { id: 'draft', tasks: [{ title: '参加会议', startAt: '2026-11-07T15:00:00+08:00', suggested: false }] } });
  await pending; assert.equal(commits, 0); assert.equal(previews, 1); assert.equal(input.value, '');
  input.value = '失败后保留原文'; const failed = ids['btn-create'].handlers.click(); await tick();
  resolveAnalysis({ ok: false, error: 'HTTP 400 diagnostic' }); await failed;
  assert.equal(input.value, '失败后保留原文'); assert.match(ids['quick-status'].textContent, /HTTP 400/); assert.equal(input.disabled, false);
  api.ai.config = async () => ({ ok: true, data: {} });
  await ids['btn-create'].handlers.click(); assert.equal(manual, 0); assert.match(ids['quick-status'].textContent, /配置默认/);
  await ids['btn-manual'].handlers.click(); assert.equal(manual, 1);
  let finishSave;
  api.tasks.create = () => new Promise(resolve => { finishSave = resolve; });
  input.value = '保存中的任务';
  const saving = ids['btn-manual'].handlers.click();
  assert.equal(input.disabled, true); assert.equal(ids['btn-manual'].disabled, true);
  await ids['btn-manual'].handlers.click();
  finishSave(); await saving;
  assert.equal(input.disabled, false); assert.equal(ids['btn-manual'].disabled, false);
  api.tasks.create = async () => { throw new Error('disk full'); };
  input.value = '失败后保留'; await ids['btn-manual'].handlers.click();
  assert.equal(input.value, '失败后保留'); assert.equal(input.disabled, false);
  console.log('Quick capture: default AI, time preview before commit, duplicate prevention, IME, error preservation and manual fallback passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
