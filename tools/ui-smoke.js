'use strict';

// Run: node_modules/.bin/electron tools/ui-smoke.js
// Uses the real renderer and TaskStore with an isolated temporary data directory.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-ui-'));
process.env.WITHYOU_TEST_RESOURCE_DELAY = '100';
process.env.SMALLLIST_UI_DATA = path.join(TMP, 'tasks.json');
app.setPath('userData', path.join(TMP, 'profile'));
const { TaskStore } = require('../src/store');
const store = new TaskStore(process.env.SMALLLIST_UI_DATA);
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
store.create({ title: '整理本周项目进度', note: '把想法记下来，让每一步都清晰可见。', status: 'todo', color: 'orange', dueAt: tomorrow.toISOString(), steps: [{ content: '汇总本周完成的事项', status: 'done' }, { content: '安排下周计划', status: 'todo' }] });
store.create({ title: '准备下周会议材料', note: '整理评审结论与行动项', status: 'todo', color: 'blue' });
store.create({ title: '规划本周运动安排', note: '工作之外，也留一点时间给自己。', status: 'doing', color: 'green' });
store.create({ title: '采购周末生活用品', status: 'done', color: 'amber' });
store.create({ title: '整理桌面与下载文件夹', status: 'done', color: '' });
store.create({ title: '调整周末出行计划', status: 'cancelled', cancelReason: '留到下个晴天再出发' });
const errors = [];
const create = (opts) => {
  const win = new BrowserWindow({ show: true, autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#eaf3e5', symbolColor: '#234c3a', height: 40 }, ...opts, webPreferences: { preload: path.join(__dirname, 'doc-mock-preload.js'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  return win;
};
const run = (win, code) => win.webContents.executeJavaScript(code, true);
async function waitFor(win, condition) {
  for (let i = 0; i < 80; i++) {
    if (await run(win, condition)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + condition);
}
async function shot(win, name) {
  await run(win, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  fs.writeFileSync(path.join(TMP, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function layout(win) {
  const result = await run(win, `(() => {
    const selectors = ['.toolbar-right', '.workspace', '.filterbar', '.board-foot', '#btn-add-task', '#btn-settings'];
    const overflow = selectors.filter(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; });
    return { overflow, boardHeight: document.querySelector('#view-board').getBoundingClientRect().height };
  })()`);
  assert.deepEqual(result.overflow, []);
  assert.ok(result.boardHeight > 180, 'Board must keep useful height');
}
app.whenReady().then(async () => {
  try {
    const win = create({ width: 1180, height: 760 });
    await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
    await waitFor(win, `document.querySelectorAll('.card').length === 6`);
    assert.equal(await run(win, `document.querySelector('#progress-value').textContent`), '40');
    await layout(win);
    await shot(win, 'board');
    // 单一列表 + 4 个状态筛选按钮，全部常驻在折叠筛选区外。
    assert.equal(await run(win, `document.querySelectorAll('.task-list-panel').length`), 1);
    assert.equal(await run(win, `document.querySelectorAll('#status-filters [data-filter]').length`), 4);
    const visibleStatuses = () => run(win, `[...document.querySelectorAll('#list-all .card')].map(c => c.dataset.status)`);
    assert.deepEqual(await visibleStatuses(), ['todo', 'todo', 'doing', 'done', 'done', 'cancelled']);
    await run(win, `document.querySelector('#status-filters [data-filter="active"]').click()`);
    assert.deepEqual(await visibleStatuses(), ['todo', 'todo', 'doing']);
    await shot(win, 'board-active');
    await run(win, `document.querySelector('#status-filters [data-filter="active"]').click()`);
    await run(win, `document.querySelector('#status-filters [data-filter="done"]').click()`);
    assert.deepEqual(await visibleStatuses(), ['done', 'done']);
    await shot(win, 'board-done');
    await run(win, `document.querySelector('#status-filters [data-filter="done"]').click()`);
    await run(win, `document.querySelector('#status-filters [data-filter="cancelled"]').click()`);
    assert.deepEqual(await visibleStatuses(), ['cancelled']);
    await shot(win, 'board-cancelled');
    await run(win, `document.querySelector('#status-filters [data-filter="cancelled"]').click()`);
    assert.equal(await run(win, `document.querySelectorAll('#list-all .card').length`), 6);
    // Secondary filters collapse without losing active conditions; clear restores the full list.
    assert.equal(await run(win, `document.querySelector('#task-extra-filters').hidden`), true);
    await run(win, `document.querySelector('#btn-toggle-filters').click()`);
    assert.equal(await run(win, `document.querySelector('#btn-toggle-filters').getAttribute('aria-expanded')`), 'true');
    await run(win, `document.querySelector('#due-filters [data-due="today"]').click(); document.querySelector('#btn-toggle-filters').click()`);
    assert.equal(await run(win, `document.querySelector('#task-extra-filters').hidden`), true);
    assert.equal(await run(win, `document.querySelector('#filter-summary').textContent`), ' · 今日');
    assert.equal(await run(win, `document.querySelectorAll('#list-all .card').length`), 0);
    await shot(win, 'collapsed-filter');
    // The external All button clears status, date and priority while the panel is collapsed.
    await run(win, `document.querySelector('#status-filters [data-filter="active"]').click(); state.colorFilter = 'red'; syncFilterChips(); document.querySelector('#status-filters [data-filter="all"]').click()`);
    assert.deepEqual(await run(win, `[state.statusFilter, state.dueFilter, state.colorFilter]`), ['all', 'all', 'all']);
    assert.equal(await run(win, `document.querySelector('#task-extra-filters').hidden`), true);
    assert.equal(await run(win, `document.querySelector('#status-filters [data-filter="all"]').getAttribute('aria-pressed')`), 'true');
    await run(win, `document.querySelector('#btn-toggle-filters').click(); document.querySelector('#btn-clear-filters').click()`);
    assert.equal(await run(win, `document.querySelector('#filter-summary').textContent`), '');
    assert.equal(await run(win, `document.querySelectorAll('#list-all .card').length`), 6);
    await shot(win, 'expanded-filters');
    await run(win, `document.querySelector('#btn-toggle-filters').click()`);
    // Adding a subtask is only available from the context menu; successful save closes the input.
    assert.equal(await run(win, `document.querySelectorAll('.step-add-input, .step-add-btn').length`), 0);
    await run(win, `document.querySelector('.card-steps-summary')?.click()`);
    assert.equal(await run(win, `document.querySelector('.card-steps-summary').getAttribute('aria-expanded')`), 'true');
    const stepTaskId = await run(win, `document.querySelector('.step').closest('.card').dataset.id`);
    const openStepInput = (id) => run(win, `(() => {
      document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      [...document.querySelectorAll('.context-menu button')].find(item => item.textContent === '添加子任务').click();
    })()`);
    await openStepInput(stepTaskId);
    await waitFor(win, `document.activeElement === document.querySelector('.step-add-input')`);
    assert.equal(await run(win, `document.querySelector('.context-menu') === null`), true);
    await run(win, `(() => {
      const input = document.querySelector('.step-add-input');
      input.value = '右键添加的子任务';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await waitFor(win, `!document.querySelector('.step-add-input') && [...document.querySelectorAll('.step-content')].some(el => el.textContent === '右键添加的子任务')`);
    assert.equal(await run(win, `(async () => (await api.tasks.list()).find(t => t.id === '${stepTaskId}').steps.length)()`), 3);
    await run(win, `render()`);
    assert.equal(await run(win, `document.querySelector('.step-add-input') === null`), true);
    // Parent and child edits share a panel, are saved together, and are discarded on cancel.
    const beforeEdit = await run(win, `(async () => (await api.tasks.list()).find(t => t.id === '${stepTaskId}'))()`);
    const openCombinedEditor = () => run(win, `(() => {
      document.querySelector('.card[data-id="${stepTaskId}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      [...document.querySelectorAll('.context-menu button')].find(item => item.textContent === '编辑任务').click();
    })()`);
    const changeCombinedDraft = () => run(win, `(() => {
      const form = document.querySelector('.edit-form');
      form.querySelector('input[aria-label="任务标题"]').value = '父子任务统一编辑';
      const content = form.querySelector('.edit-step-content');
      content.value = '修改后的子任务';
      content.dispatchEvent(new Event('input', { bubbles: true }));
      form.querySelectorAll('.edit-step-row input[type="checkbox"]')[1].click();
      form.querySelectorAll('.edit-step-delete')[2].click();
      form.querySelector('.edit-step-add').click();
      const inputs = form.querySelectorAll('.edit-step-content');
      const added = inputs[inputs.length - 1];
      added.value = '面板内新建的子任务';
      added.dispatchEvent(new Event('input', { bubbles: true }));
      added.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await openCombinedEditor();
    await changeCombinedDraft();
    assert.equal(await run(win, `!!document.querySelector('.edit-form')`), true);
    assert.deepEqual(await run(win, `(async () => (await api.tasks.list()).find(t => t.id === '${stepTaskId}'))()`), beforeEdit);
    await run(win, `document.querySelector('.edit-actions .subtle-btn').click()`);
    await openCombinedEditor();
    assert.equal(await run(win, `document.querySelector('.edit-step-content').value`), beforeEdit.steps[0].content);
    await changeCombinedDraft();
    await shot(win, 'combined-task-editor');
    await run(win, `document.querySelector('.edit-actions .primary-btn').click()`);
    await waitFor(win, `!document.querySelector('.edit-form')`);
    const afterEdit = await run(win, `(async () => (await api.tasks.list()).find(t => t.id === '${stepTaskId}'))()`);
    assert.equal(afterEdit.title, '父子任务统一编辑');
    assert.equal(afterEdit.steps.length, 3);
    assert.equal(afterEdit.steps[0].id, beforeEdit.steps[0].id);
    assert.equal(afterEdit.steps[0].content, '修改后的子任务');
    assert.equal(afterEdit.steps[1].status, 'done');
    assert.equal(afterEdit.steps[2].content, '面板内新建的子任务');
    assert.ok(afterEdit.steps[2].id);
    await openStepInput(stepTaskId);
    await run(win, `document.querySelector('.step-add-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await run(win, `document.querySelector('.step-add-input') === null`), true);
    const emptyStepTaskId = await run(win, `[...document.querySelectorAll('.card')].find(card => !card.querySelector('.step')).dataset.id`);
    await openStepInput(emptyStepTaskId);
    await waitFor(win, `document.activeElement === document.querySelector('.step-add-input')`);
    await run(win, `document.querySelector('.step-add-input').blur()`);
    assert.equal(await run(win, `document.querySelector('.step-add-input') === null`), true);
    // Completion updates both the persisted task and the global progress.
    await run(win, `document.querySelector('#list-all .card[data-status="todo"] .check').click()`);
    await waitFor(win, `document.querySelector('#progress-value').textContent === '60'`);
    await run(win, `document.querySelector('#due-filters [data-due="today"]').click()`);
    assert.equal(await run(win, `document.querySelector('#progress-value').textContent`), '60');
    await run(win, `document.querySelector('#status-filters [data-filter="all"]').click()`);
    assert.equal(await run(win, `document.querySelector('#add-date')`), null, 'retired date-only input is removed');
    // Full create form and inline edit remain functional.
    await run(win, `document.querySelector('#btn-add-task').click(); document.querySelector('#add-title').value = '界面验证任务'; document.querySelector('#add-reminder').value='10'; document.querySelector('#add-task-mask').click();`);
    assert.equal(await run(win, `document.querySelector('#add-task-mask').hidden`), false, 'backdrop clicks keep task entry open');
    assert.equal(await run(win, `document.querySelector('#add-title').value`), '界面验证任务');
    await run(win, `document.querySelector('#btn-create-task').click()`);
    await waitFor(win, `document.querySelector('#add-task-mask').hidden && document.querySelector('#progress-value').textContent === '50'`);
    assert.equal(await run(win, `(async () => (await api.tasks.list()).find(t => t.title === '界面验证任务').reminderMinutes)()`), 10);
    await run(win, `document.querySelector('#btn-add-task').click()`);
    await shot(win, 'add-task');
    await run(win, `document.querySelector('#btn-cancel-add').click(); document.querySelector('#list-all .card[data-status="doing"] .card-title').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));`);
    assert.equal(await run(win, `!!document.querySelector('.edit-form')`), true);
    await run(win, `document.querySelector('.edit-actions .subtle-btn').click(); document.querySelector('#view-switch [data-view="calendar"]').click();`);
    assert.equal(await run(win, `document.querySelectorAll('.cal-cell').length`), 42);
    await shot(win, 'calendar');
    // Calendar ranges include both endpoints and keep a single underlying task.
    const calendarCases = await run(win, `(async () => {
      const local = (month, day, hour = 9, minute = 0, second = 0, ms = 0) => new Date(2026, month, day, hour, minute, second, ms).toISOString();
      const cases = [
        { title: '跨天日历回归', startAt: local(10, 4), dueAt: local(10, 7, 18) },
        { title: '只有开始日期', startAt: local(10, 9, 9, 20, 35, 125) },
        { title: '只有截止日期', dueAt: local(10, 10, 17, 45, 30, 250) },
        { title: '跨年日历回归', startAt: local(11, 31), dueAt: new Date(2027, 0, 2, 0).toISOString() },
        { title: '未排期拖动回归' },
        { title: '同日时间段拖动回归', startAt: local(10, 13, 10, 15), dueAt: local(10, 13, 12, 45) },
      ];
      const ids = [];
      for (const task of cases) ids.push((await api.tasks.create(task)).id);
      state.calMonth = new Date(2026, 10, 1);
      await refresh();
      return ids;
    })()`);
    const daysForTask = (id) => run(win, `[...document.querySelectorAll('.cal-cell')].filter(cell => [...cell.querySelectorAll('.cal-chip')].some(chip => chip.dataset.id === ${JSON.stringify(id)})).map(cell => cell.dataset.date)`);
    assert.deepEqual(await daysForTask(calendarCases[0]), ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    assert.deepEqual(await daysForTask(calendarCases[1]), ['2026-11-09']);
    assert.deepEqual(await daysForTask(calendarCases[2]), ['2026-11-10']);
    // Week navigation covers year boundaries; switching preserves the anchor date.
    await run(win, `state.calMonth = new Date(2026, 11, 31); document.querySelector('[data-cal-view="week"]').click()`);
    const weekDates = () => run(win, `[...document.querySelectorAll('.cal-cell')].map(cell => cell.dataset.date)`);
    assert.deepEqual(await weekDates(), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    assert.equal(await run(win, `document.querySelector('#cal-prev').title`), '上一周');
    await run(win, `document.querySelector('#cal-next').click()`);
    assert.equal((await weekDates())[0], '2027-01-04');
    await run(win, `document.querySelector('#cal-prev').click()`);
    assert.equal((await weekDates())[0], '2026-12-28');
    await run(win, `state.calMonth = new Date(2026, 10, 6); renderCalendar()`);
    assert.deepEqual(await daysForTask(calendarCases[0]), ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    assert.equal(await run(win, `document.querySelectorAll('.cal-time-slot').length`), 140);
    const timelineIds = await run(win, `(async () => {
      const cases = [
        { title: '上午时间块', startAt: new Date(2026, 10, 2, 8, 30).toISOString(), dueAt: new Date(2026, 10, 2, 9, 30).toISOString() },
        { title: '重叠时间块', startAt: new Date(2026, 10, 2, 9).toISOString(), dueAt: new Date(2026, 10, 2, 10).toISOString() },
        { title: '下午时间块', startAt: new Date(2026, 10, 2, 13).toISOString(), dueAt: new Date(2026, 10, 2, 14).toISOString() },
        { title: '晚间时间块', dueAt: new Date(2026, 10, 2, 20).toISOString() },
      ];
      const ids = []; for (const task of cases) ids.push((await api.tasks.create(task)).id);
      await refresh(); return ids;
    })()`);
    const eventStyle = id => run(win, `(() => { const el = document.querySelector('.cal-time-event[data-id="${id}"]'); return [el.style.top, el.style.height, el.style.width]; })()`);
    assert.deepEqual(await eventStyle(timelineIds[0]), ['36px', '72px', '50%']);
    assert.deepEqual(await eventStyle(timelineIds[1]), ['72px', '72px', '50%']);
    assert.deepEqual(await eventStyle(timelineIds[2]), ['360px', '72px', '100%']);
    assert.equal(await run(win, `!!document.querySelector('.cal-outside .cal-chip[data-id="${timelineIds[3]}"]')`), true);
    // Dropping on a half-hour cell changes the time and keeps the duration.
    await run(win, `(async () => {
      const chip = document.querySelector('.cal-time-event[data-id="${timelineIds[0]}"]');
      const slot = document.querySelector('.cal-cell[data-date="2026-11-03"] .cal-time-slot[data-minutes="810"]');
      const dataTransfer = new DataTransfer();
      chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      await new Promise(resolve => setTimeout(resolve, 100)); await refresh();
    })()`);
    assert.deepEqual(await eventStyle(timelineIds[0]), ['396px', '72px', '100%']);
    await new Promise(resolve => setTimeout(resolve, 200));
    await shot(win, 'calendar-week');
    await run(win, `document.querySelector('#cal-today').click()`);
    assert.equal(await run(win, `!!document.querySelector('.cal-cell.today')`), true);
    await run(win, `document.querySelector('[data-cal-view="month"]').click(); state.calMonth = new Date(2026, 10, 1); renderCalendar()`);
    assert.equal(await run(win, `document.querySelectorAll('.cal-cell').length`), 42);
    // Exercise the actual dragstart / drop / dragend handlers, including the grabbed day of a range.
    const dragCalendarTask = (id, from, to) => run(win, `(async () => {
      const source = ${JSON.stringify(from)};
      const chip = source
        ? document.querySelector('.cal-cell[data-date="' + source + '"] .cal-chip[data-id="${id}"]')
        : document.querySelector('#unscheduled-list .cal-chip[data-id="${id}"]');
      const target = document.querySelector('.cal-cell[data-date="${to}"]');
      if (!chip || !target) throw new Error('Missing calendar drag source / target: ' + source + ' -> ${to}');
      const dataTransfer = new DataTransfer();
      chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      const dialog = document.querySelector('.schedule-dialog');
      if (dialog) { dialog.querySelector('input').value = '18:00'; dialog.querySelectorAll('button')[1].click(); await new Promise(r => setTimeout(r, 50)); }
      await refresh();
      return (await api.tasks.list()).find(task => task.id === '${id}');
    })()`);
    const localISO = (year, month, day, hour = 9, minute = 0, second = 0, ms = 0) => new Date(year, month - 1, day, hour, minute, second, ms).toISOString();
    const duration = (task) => new Date(task.dueAt) - new Date(task.startAt);
    // Dragging the middle day onto the old end date must shift both endpoints, rather than do nothing.
    const originalRange = await run(win, `(async () => (await api.tasks.list()).find(task => task.id === '${calendarCases[0]}'))()`);
    const movedRange = await dragCalendarTask(calendarCases[0], '2026-11-05', '2026-11-07');
    assert.equal(movedRange.startAt, localISO(2026, 11, 6));
    assert.equal(movedRange.dueAt, localISO(2026, 11, 9, 18));
    assert.equal(duration(movedRange), duration(originalRange));
    assert.deepEqual(await daysForTask(calendarCases[0]), ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    const persistedRange = new TaskStore(process.env.SMALLLIST_UI_DATA).get(calendarCases[0]);
    assert.equal(persistedRange.startAt, movedRange.startAt);
    assert.equal(persistedRange.dueAt, movedRange.dueAt);
    // Dropping on the grabbed date is a true no-op, including updatedAt and reminder state.
    assert.deepEqual(await dragCalendarTask(calendarCases[0], '2026-11-07', '2026-11-07'), movedRange);
    const earlierRange = await dragCalendarTask(calendarCases[0], '2026-11-08', '2026-11-04');
    assert.equal(earlierRange.startAt, localISO(2026, 11, 2));
    assert.equal(earlierRange.dueAt, localISO(2026, 11, 5, 18));
    assert.equal(duration(earlierRange), duration(originalRange));
    assert.deepEqual(await daysForTask(calendarCases[0]), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    const startOnly = await dragCalendarTask(calendarCases[1], '2026-11-09', '2026-11-11');
    assert.equal(startOnly.startAt, localISO(2026, 11, 11, 9, 20, 35, 125));
    assert.equal(startOnly.dueAt, null);
    assert.deepEqual(await daysForTask(calendarCases[1]), ['2026-11-11']);
    const dueOnly = await dragCalendarTask(calendarCases[2], '2026-11-10', '2026-11-12');
    assert.equal(dueOnly.startAt, null);
    assert.equal(dueOnly.dueAt, localISO(2026, 11, 12, 17, 45, 30, 250));
    const scheduled = await dragCalendarTask(calendarCases[4], null, '2026-11-14');
    assert.equal(scheduled.startAt, null);
    assert.equal(scheduled.dueAt, localISO(2026, 11, 14, 18));
    assert.deepEqual(await daysForTask(calendarCases[4]), ['2026-11-14']);
    const sameDayRange = await dragCalendarTask(calendarCases[5], '2026-11-13', '2026-11-01');
    assert.equal(sameDayRange.startAt, localISO(2026, 11, 1, 10, 15));
    assert.equal(sameDayRange.dueAt, localISO(2026, 11, 1, 12, 45));
    await run(win, `state.calMonth = new Date(2027, 0, 1); renderCalendar();`);
    assert.deepEqual(await daysForTask(calendarCases[3]), ['2026-12-31', '2027-01-01', '2027-01-02']);
    const acrossYear = await dragCalendarTask(calendarCases[3], '2027-01-01', '2026-12-31');
    assert.equal(acrossYear.startAt, localISO(2026, 12, 30));
    assert.equal(acrossYear.dueAt, localISO(2027, 1, 1, 0));
    assert.deepEqual(await daysForTask(calendarCases[3]), ['2026-12-30', '2026-12-31', '2027-01-01']);
    await shot(win, 'calendar-rescheduled');
    await run(win, `(async () => {
      for (const id of ${JSON.stringify(calendarCases)}) await api.tasks.delete(id);
      state.calMonth = new Date();
      await refresh();
    })()`);
    // Project resources: empty state, create, search no-result, edit, Escape, delete/undo.
    await run(win, `document.querySelector('#view-switch [data-view="resources"]').click()`);
    await waitFor(win, `!document.querySelector('#view-resources').hidden`);
    assert.equal(await run(win, `document.querySelectorAll('.resource-card').length`), 0);
    assert.equal(await run(win, `document.querySelector('.resource-empty').textContent.includes('还没有项目资料')`), true);
    await run(win, `document.querySelector('.resource-empty .primary-btn').click()`);
    assert.equal(await run(win, `document.querySelector('#resource-mask').hidden`), false);
    await run(win, `(() => {
      document.querySelector('#resource-project').value = '携手';
      document.querySelector('#resource-name').value = '设计稿';
      document.querySelector('#resource-location').value = 'C:/work/design';
      document.querySelector('#resource-form').requestSubmit();
      if (!resourceSaving) throw new Error('Resource save must be pending');
      closeResourceEditor(); openResourceEditor();
      if (document.querySelector('#resource-mask').hidden || document.querySelector('#resource-name').value !== '设计稿' || !document.querySelector('#resource-name').disabled) throw new Error('Pending resource form must remain locked and open');
    })()`);
    await waitFor(win, `document.querySelectorAll('.resource-card').length === 1`);
    assert.equal(await run(win, `document.querySelector('.resource-info strong').textContent`), '设计稿');
    assert.equal(await run(win, `document.querySelector('.resource-card button.resource-location-button').textContent`), 'C:/work/design');
    assert.equal(await run(win, `document.querySelector('#resource-count').textContent.includes('1 个项目')`), true);
    await run(win, `(() => { const input = document.querySelector('#search-input'); input.value = '不存在'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(win, `document.querySelector('.resource-empty') && document.querySelector('.resource-empty').textContent.includes('没有匹配')`);
    await run(win, `document.querySelector('.resource-empty .ghost-btn').click()`);
    await waitFor(win, `document.querySelectorAll('.resource-card').length === 1`);
    await run(win, `document.querySelector('.resource-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:150})); [...document.querySelectorAll('.resource-context-menu button')].find(b => b.textContent === '编辑').click()`);
    assert.equal(await run(win, `document.querySelector('#resource-form-title').textContent`), '编辑项目资料');
    await run(win, `document.querySelector('#resource-name').value = '设计稿 v2'; document.querySelector('#resource-form').requestSubmit()`);
    await waitFor(win, `[...document.querySelectorAll('.resource-info strong')].some(el => el.textContent === '设计稿 v2')`);
    await run(win, `document.querySelector('#resource-add').click(); document.querySelector('#resource-mask').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(win, `document.querySelector('#resource-mask').hidden`);
    await run(win, `document.querySelector('.resource-delete').click()`);
    await waitFor(win, `document.querySelectorAll('.resource-card').length === 0`);
    assert.equal(await run(win, `document.querySelector('#undo-toast').hidden`), false);
    await run(win, `document.querySelector('#resource-add').click()`);
    await win.webContents.insertText('删除后新增项目');
    assert.equal(await run(win, `document.querySelector('#resource-project').value`), '删除后新增项目', 'real text entry works after deletion');
    await run(win, `document.querySelector('#resource-name').focus()`); await win.webContents.insertText('新资料');
    assert.equal(await run(win, `document.querySelector('#resource-name').value`), '新资料');
    await run(win, `document.querySelector('#resource-cancel').click(); document.querySelector('#btn-undo').click()`);
    await waitFor(win, `document.querySelectorAll('.resource-card').length === 1`);
    assert.equal(await run(win, `[...document.querySelectorAll('.resource-actions button')].some(b => b.textContent === '重新定位')`), false);
    await run(win, `document.querySelector('.resource-project > summary').click()`);
    await waitFor(win, `!document.querySelector('.resource-project').open && collapsedResourceProjects.has('携手')`);
    await run(win, `renderProjectResources()`);
    assert.equal(await run(win, `document.querySelector('.resource-project').open`), false, 'fold state survives rerender');
    await run(win, `document.querySelector('#search-input').value='设计稿'; document.querySelector('#search-input').dispatchEvent(new Event('input'))`);
    assert.equal(await run(win, `document.querySelector('.resource-project').open`), true, 'search reveals matching resources');
    await run(win, `document.querySelector('#search-input').value=''; document.querySelector('#search-input').dispatchEvent(new Event('input'))`);
    assert.equal(await run(win, `document.querySelector('.resource-project').open`), false);
    await run(win, `document.querySelector('.resource-project-add').click()`);
    assert.equal(await run(win, `document.querySelector('#resource-project-select').value`), '携手');
    assert.equal(await run(win, `document.querySelector('#resource-project').readOnly`), true);
    assert.equal(await run(win, `document.querySelector('.resource-project-add').textContent`), '＋');
    await run(win, `document.querySelector('#resource-name').value='会议资料'; document.querySelector('#resource-location').value='C:/work/meeting'; document.querySelector('#resource-form').requestSubmit()`);
    await waitFor(win, `document.querySelectorAll('.resource-card').length === 2`);
    assert.equal(await run(win, `document.querySelector('.resource-project').open`), true, 'saving reveals the destination project');
    await run(win, `document.querySelector('#resource-add').click()`);
    assert.equal(await run(win, `document.querySelector('#resource-project').value`), '');
    assert.equal(await run(win, `document.querySelector('#resource-project').hidden`), false);
    assert.equal(await run(win, `document.querySelector('#resource-project').readOnly`), false);
    assert.equal(await run(win, `document.querySelector('#resource-project-select').hidden`), true);
    await run(win, `document.querySelector('#resource-cancel').click()`);
    await run(win, `document.querySelector('.resource-delete').click()`);
    await waitFor(win, `document.querySelectorAll('.resource-card').length === 1`);
    await run(win, `document.querySelector('.resource-project-add').click()`);
    await win.webContents.insertText('项目内删除后新增');
    assert.equal(await run(win, `document.querySelector('#resource-name').value`), '项目内删除后新增');
    await run(win, `document.querySelector('#resource-cancel').click()`);
    await run(win, `document.querySelector('#resource-add').click()`);
    assert.equal(await run(win, `document.querySelector('#resource-name').disabled`), false, 'new form unlocks after save');
    await run(win, `document.querySelector('#resource-cancel').click(); void window.uiDialogs.alert('信息提示测试')`);
    await waitFor(win, `!!document.querySelector('.app-dialog[open]')`);
    await run(win, `document.querySelector('.app-dialog .dialog-accept').click()`);
    await waitFor(win, `!document.querySelector('.app-dialog')`);
    await run(win, `document.querySelector('#resource-add').click()`);
    await win.webContents.insertText('提示后可以输入');
    assert.equal(await run(win, `document.querySelector('#resource-project').value`), '提示后可以输入');
    await run(win, `document.querySelector('#resource-cancel').click()`);
    await run(win, `document.querySelector('.resource-project-add').click(); document.querySelector('#resource-name').value='重复资料'; document.querySelector('#resource-location').value=state.projectResources[0].location; document.querySelector('#resource-form').requestSubmit()`);
    await waitFor(win, `!resourceSaving`);
    assert.equal(await run(win, `document.querySelector('#resource-mask').hidden`), false, 'failed save preserves form');
    assert.equal(await run(win, `document.querySelector('#resource-name').disabled`), false, 'failed save unlocks input');
    await run(win, `document.querySelector('#resource-name').focus()`); await win.webContents.insertText('可修改');
    assert.equal(await run(win, `document.querySelector('#resource-name').value.includes('可修改')`), true);
    await run(win, `document.querySelector('#resource-cancel').click()`);
    assert.equal(await run(win, `document.querySelector('.resource-actions').querySelectorAll('button').length`), 1, 'the path is clickable and only the trash button remains in the action area');
    assert.equal(await run(win, `!!document.querySelector('.resource-delete svg')`),true);
    await run(win, `document.querySelector('.resource-card').focus(); document.querySelector('.resource-card').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`);
    assert.equal(await run(win, `!!document.querySelector('.resource-context-menu')`),true);
    await run(win, `document.querySelector('.resource-context-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await run(win, `document.activeElement.classList.contains('resource-card')`),true);
    await shot(win, 'resources');
    await run(win, `document.querySelector('#view-switch [data-view="board"]').click()`);
    await run(win, `document.querySelector('#btn-settings').click()`);
    await waitFor(win, `!document.querySelector('#settings-mask').hidden`);
    for (const percent of [80, 150]) {
      await run(win, `(() => { const input = document.querySelector('#set-pet-scale'); input.value = '${percent}'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await waitFor(win, `state.settings.petScale === ${percent / 100}`);
      await run(win, `document.querySelector('#btn-close-settings').click(); document.querySelector('#btn-settings').click()`);
      await waitFor(win, `!document.querySelector('#settings-mask').hidden`);
      assert.equal(await run(win, `document.querySelector('#set-pet-scale').value`), String(percent));
      assert.equal(await run(win, `document.querySelector('#pet-scale-value').textContent`), `${percent}%`);
    }
    await shot(win, 'settings');
    await run(win, `document.querySelector('#btn-close-settings').click(); document.querySelector('#view-switch [data-view="board"]').click()`);
    win.setSize(1024, 640);
    await run(win, 'new Promise(r => requestAnimationFrame(r))');
    await layout(win);
    await shot(win, 'board-minimum');
    await run(win, `document.querySelector('#btn-toggle-filters').click()`);
    await layout(win);
    await shot(win, 'filters-minimum');
    await run(win, `document.querySelector('#btn-toggle-filters').click()`);
    await run(win, `document.querySelector('#view-switch [data-view="resources"]').click();
      document.querySelector('.resource-project-add').click();
      document.querySelector('#resource-name').value = '多份参考资料';
      document.querySelector('#resource-location').value = 'https://example.com/a\\n\\nhttps://example.com/b';
      document.querySelector('#resource-form').requestSubmit();`);
    const multiResource = `[...document.querySelectorAll('.resource-card')].find(card => card.querySelector('strong').textContent === '多份参考资料')`;
    await waitFor(win, `Boolean(${multiResource})`);
    assert.deepEqual(await run(win, `[...${multiResource}.querySelectorAll('.resource-location-button')].map(b => b.textContent)`),
      ['https://example.com/a', 'https://example.com/b']);
    await shot(win, 'resources-multiple');
    await run(win, `document.querySelector('#view-switch [data-view="board"]').click();
      document.querySelector('#btn-add-task').click(); document.querySelector('#add-mode-manual').click();
      document.querySelector('#add-title').value = '按项目归类';
      document.querySelector('#add-project').value = '携手';
      document.querySelector('#btn-create-task').click();`);
    const projectLabel = `document.querySelector('.task-project-label')`;
    await waitFor(win, `${projectLabel}.textContent === '携手'`);
    assert.deepEqual(await run(win, `[...document.querySelectorAll('.task-project-label')].map(label => label.textContent)`), ['携手', '未分类']);
    await run(win, `${projectLabel}.click()`);
    await waitFor(win, `state.collapsedTaskProjects.has('携手')`);
    await run(win, `render()`);
    assert.equal(await run(win, `${projectLabel}.closest('details').open`), false);
    const searchProject = value => run(win, `(() => { const input = document.querySelector('#search-input');
      input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); })()`);
    await searchProject('携手');
    assert.equal(await run(win, `${projectLabel}.closest('details').open`), true);
    await searchProject('');
    await run(win, `${projectLabel}.click();
      ${projectLabel}.closest('details').querySelector('.card-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      document.querySelector('.edit-form [list="task-project-options"]').value = '';
      document.querySelector('.edit-actions .primary-btn').click();`);
    await waitFor(win, `${projectLabel}.textContent === '未分类'`);
    // Empty and all-cancelled datasets must display 0%, never NaN.
    await run(win, `(async () => { for (const t of await window.withyou.tasks.list()) await window.withyou.tasks.update(t.id, { status: 'cancelled' }); await refresh(); })()`);
    assert.equal(await run(win, `document.querySelector('#progress-value').textContent`), '0');
    await run(win, `(async () => { for (const t of await window.withyou.tasks.list()) await window.withyou.tasks.delete(t.id); await refresh(); })()`);
    assert.equal(await run(win, `document.querySelector('#progress-summary').textContent`), '已完成 0 / 0');
    await shot(win, 'empty');
    const quick = create({ width: 460, height: 270, frame: false });
    await quick.loadFile(path.join(ROOT, 'src/renderer/quick.html'));
    await shot(quick, 'quick');
    assert.ok(await run(quick, `document.querySelector('#btn-create').getBoundingClientRect().bottom <= innerHeight`));
    assert.deepEqual(errors, [], 'Renderer console errors');
    console.log('PASS: progress, filters, create/edit, calendar ranges and drag rescheduling, settings, 1180/1024 layouts, empty/cancelled, quick window.');
    console.log('Screenshots: ' + TMP);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error('Artifacts: ' + TMP);
    app.exit(1);
  }
});
