'use strict';

/**
 * 携手 WithYou 看板渲染逻辑
 * - 快速新建（回车即建）/ 添加任务表单（任务名 / 内容 / 开始时间 / 结束时间）
 *   与重复任务（每天 / 每周 / 每月，按日期范围批量生成）
 * - 双击就地编辑 / 勾选完成
 * - 子任务清单（勾选 / 新增 / 删除，随任务卡片展示）
 * - 删除 + 5 秒撤销 Toast
 * - 拖拽排序（列内 / 跨列）
 * - 逾期高亮置顶 / 已完成折叠
 * - 搜索 / 优先级（颜色）/ 截止时间筛选
 * - 设置（置顶 / 透明度 / 圆角 / 自启 / 颜色与优先级 / 数据导入导出）
 */

// 注意：不能用 const withyou —— 会与 contextBridge 暴露的全局属性 window.withyou 冲突导致 SyntaxError
const api = window.withyou;

const COLORS = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  gray: '#64748b',
};
const COLOR_LIST = Object.keys(COLORS);
const NONE_COLOR = 'none';
const COLOR_LABELS = {
  red: '红', orange: '橙', amber: '黄', green: '绿',
  blue: '蓝', purple: '紫', pink: '粉', gray: '灰',
};
/** 默认 4 级优先级 + 无色；旧版 8 色配置由用户 settings 原样保留。 */
const DEFAULT_PRIORITIES = [
  { color: 'red', name: '紧急' },
  { color: 'orange', name: '高' },
  { color: 'blue', name: '普通' },
  { color: 'gray', name: '低' },
  { color: 'none', name: '无' },
];

const state = {
  tasks: [],
  view: 'board', // board | calendar
  calMonth: new Date(),
  calView: 'month', // month | week
  expandedDays: new Set(),
  search: '',
  statusFilter: 'all', // all | active | done | cancelled
  dueFilter: 'all', // all | today | week | overdue
  colorFilter: 'all', // all | <color> | none
  editingId: null,
  stepsInputId: null, // 正在显示「添加子任务」输入框的任务 id
  expandedSteps: new Set(), // 已展开子任务列表的任务 id（默认折叠为进度）
  expandedTaskNotes: new Set(),
  settings: null,
  projectResources: [],
  resourceSearch: '',
  resourceStatus: {},
  editingResourceId: null,
};
const manualOrderStatuses = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('withyou-manual-order-statuses') || '[]');
  if (Array.isArray(saved)) for (const status of saved) if (typeof status === 'string') manualOrderStatuses.add(status);
} catch (_) {}

// ---------- 工具函数 ----------

const $ = (sel, root = document) => root.querySelector(sel);

function isOverdue(task) {
  if (task.status === 'done' || task.completedAt) return false;
  return Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
}

function formatDateKey(dateKeyStr) {
  const [y, m, d] = dateKeyStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(target, today)) return tr('今天');
  if (sameDay(target, tomorrow)) return tr('明天');
  return tr`${m}月${d}日`;
}

function formatDue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, today)) return tr`今天 ${hm}`;
  if (sameDay(d, tomorrow)) return tr`明天 ${hm}`;
  return tr`${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatMD(iso) {
  // 兼容全天日期（YYYY-MM-DD）和 ISO 时间字符串。
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return tr`${m}月${d}日`;
  }
  const d = new Date(iso);
  return tr`${d.getMonth() + 1}月${d.getDate()}日`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek() {
  // 本周日 23:59:59（周一为一周起点）
  const d = startOfToday();
  const monIndex = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() + (6 - monIndex));
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfTomorrow() {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

function endOfTomorrow() {
  const d = startOfTomorrow();
  d.setHours(23, 59, 59, 999);
  return d;
}

function matchesFilters(task) {
  if (state.search) {
    const q = state.search.toLowerCase();
    const stepText = (task.steps || []).map((s) => s.content).join('\n');
    const hay = [task.title, task.project || tr('未分类'), task.note || '', stepText].join('\n').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (state.colorFilter !== 'all') {
    const c = task.color || NONE_COLOR;
    if (c !== state.colorFilter) return false;
  }
  if (state.dueFilter !== 'all') {
    if (!task.dueAt) return false;
    const t = new Date(task.dueAt).getTime();
    const now = Date.now();
    if (state.dueFilter === 'today' && !(t >= startOfToday().getTime() && t <= startOfToday().getTime() + 86400000)) return false;
    if (state.dueFilter === 'tomorrow' && !(t >= startOfTomorrow().getTime() && t <= endOfTomorrow().getTime())) return false;
    if (state.dueFilter === 'week' && !(t >= startOfToday().getTime() && t <= endOfWeek().getTime())) return false;
    if (state.dueFilter === 'overdue' && !(t < now && task.status !== 'done' && task.status !== 'cancelled')) return false;
  }
  return true;
}

/** 当前优先级配置；旧版 9 级配置原样保留，新安装默认 4 级 + 无色。 */
function priorityList() {
  const raw = state.settings && Array.isArray(state.settings.colorPriorities)
    ? state.settings.colorPriorities : null;
  if (!raw || !raw.length) return DEFAULT_PRIORITIES.map(p => ({ ...p }));
  const list = [];
  const seen = new Set();
  for (const p of raw) {
    const c = p && p.color;
    if (!(COLORS[c] || c === NONE_COLOR) || seen.has(c)) continue;
    seen.add(c);
    list.push({ color: c, name: typeof p.name === 'string' ? p.name.trim() : '' });
  }
  return list;
}

/** 颜色对应的优先级名称；未命名 / 未知颜色返回空串（空颜色归一为无色级）。 */
function priorityName(color) {
  const p = priorityList().find((x) => x.color === (color || NONE_COLOR));
  const standard = DEFAULT_PRIORITIES.find((entry) => entry.color === (color || NONE_COLOR));
  return p ? (p.name === standard?.name ? tr(p.name) : p.name) : '';
}

/** 优先级名次（越小越高）；无色对应 none 级，未知颜色排最后。 */
function priorityRank(color) {
  const i = priorityList().findIndex((x) => x.color === (color || NONE_COLOR));
  return i === -1 ? Infinity : i;
}

/** 颜色的中文名（红 / 橙 / … / 无色），用于提示兜底。 */
function colorLabel(color) {
  if (!color || color === NONE_COLOR) return tr('无色');
  return COLOR_LABELS[color] ? tr(COLOR_LABELS[color]) : color;
}

/** 排序：逾期置顶 → 优先级（颜色，高→低）→ 截止近者在前 → sortOrder */
function sortTasks(tasks) {
  if (tasks.length && manualOrderStatuses.has(tasks[0].status)) {
    return [...tasks].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return [...tasks].sort((a, b) => {
    const ao = isOverdue(a) ? 0 : 1;
    const bo = isOverdue(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ap = priorityRank(a.color);
    const bp = priorityRank(b.color);
    if (ap !== bp) return ap - bp;
    if (a.dueAt && b.dueAt) {
      const d = new Date(a.dueAt) - new Date(b.dueAt);
      if (d !== 0) return d;
    } else if (a.dueAt && !b.dueAt) return -1;
    else if (!a.dueAt && b.dueAt) return 1;
    return a.sortOrder - b.sortOrder;
  });
}

function sortDone(tasks) {
  // 已完成列按完成时间倒序
  return [...tasks].sort((a, b) =>
    new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt));
}

function sortCancelled(tasks) {
  // 已取消列按取消时间倒序
  return [...tasks].sort((a, b) =>
    new Date(b.cancelledAt || b.updatedAt) - new Date(a.cancelledAt || a.updatedAt));
}

// ---------- 日历视图 ----------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function tasksOnDay(key) {
  return state.tasks
    .filter((task) => matchesFilters(task) && (BOARD_FILTERS[state.statusFilter] || BOARD_FILTERS.all).statuses.includes(task.status))
    .filter((t) => {
      const start = t.startAt || t.dueAt;
      const end = t.dueAt || t.startAt;
      if (!start || !end) return false;
      // 按本地日期比较，开始日和结束日都包含在日历范围内。
      return dateKey(new Date(start)) <= key && key <= dateKey(new Date(end));
    })
    .sort((a, b) => {
      const ao = isOverdue(a) ? 0 : 1;
      const bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return new Date(b.dueAt || b.startAt) - new Date(a.dueAt || a.startAt);
    });
}

function renderChip(task) {
  const chip = document.createElement('div');
  chip.className = 'cal-chip';
  chip.dataset.id = task.id;
  chip.draggable = true;
  if (isOverdue(task)) chip.classList.add('overdue');
  if (task.status === 'done') chip.classList.add('done');
  if (task.status === 'cancelled') chip.classList.add('cancelled');
  const color = task.color && COLORS[task.color] ? COLORS[task.color] : null;
  if (color) chip.style.borderLeftColor = color;

  const title = document.createElement('span');
  title.className = 'chip-title';
  title.textContent = task.title;
  chip.appendChild(title);

  if (task.dueAt) {
    const time = document.createElement('span');
    time.className = 'chip-time';
    const d = new Date(task.dueAt);
    time.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    chip.appendChild(time);
  }

  const pname = task.color ? priorityName(task.color) : '';
  chip.title = (pname ? `[${pname}] ` : '') + task.title + (task.note ? '\n' + task.note : '');
  chip.addEventListener('dblclick', () => openTaskInBoard(task.id));
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showStatusMenu(e.clientX, e.clientY, task);
  });
  chip.addEventListener('dragstart', (e) => {
    dragId = task.id;
    dragDate = chip.closest('.cal-cell')?.dataset.date || null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  });
  chip.addEventListener('dragend', () => {
    dragId = null;
    dragDate = null;
  });
  return chip;
}

function openTaskInBoard(id, { addStep = false } = {}) {
  const task = state.tasks.find(item => item.id === id);
  if (!task) return;
  state.view = 'board';
  state.statusFilter = 'all';
  state.search = '';
  state.dueFilter = 'all';
  state.colorFilter = 'all';
  $('#search-input').value = '';
  syncFilterChips();
  syncStatusFilterChips();
  collapsedTaskProjects.delete(task.project || '');
  saveTaskCollapse();
  state.editingId = addStep ? null : id;
  state.stepsInputId = addStep ? id : null;
  updateViewSwitch();
  render();
  setTimeout(() => {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, 60);
}

// Week timeline: 20 half-hour rows, with separate space for out-of-hours items.
function renderWeekCalendar(grid, start) {
  const timeText = minutes => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
  const axis = document.createElement('div');
  axis.className = 'cal-time-axis';
  const axisHead = document.createElement('div');
  axisHead.className = 'cal-week-head';
  axisHead.textContent = tr('时间');
  const outsideLabel = document.createElement('div');
  outsideLabel.className = 'cal-outside';
  outsideLabel.textContent = tr('时段外');
  const ticks = document.createElement('div');
  ticks.className = 'cal-time-ticks';
  for (let i = 0; i <= 20; i++) {
    const tick = document.createElement('div');
    tick.className = 'cal-time-tick';
    tick.style.top = `${i * 36}px`;
    tick.textContent = (i === 0 ? tr('上午') + ' ' : i === 8 ? tr('下午') + ' ' : '') + timeText(480 + i * 30);
    ticks.append(tick);
  }
  axis.append(axisHead, outsideLabel, ticks);
  grid.append(axis);
  for (let day = 0; day < 7; day++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    const key = dateKey(date);
    const cell = document.createElement('div');
    cell.className = 'cal-cell cal-week-column';
    cell.dataset.date = key;
    if (key === dateKey(new Date())) cell.classList.add('today');
    const heading = document.createElement('div');
    heading.className = 'cal-week-head';
    heading.textContent = new Intl.DateTimeFormat(i18n.language, { weekday: 'short', month: 'numeric', day: 'numeric' }).format(date);
    const outside = document.createElement('div');
    outside.className = 'cal-outside';
    const timeline = document.createElement('div');
    timeline.className = 'cal-day-timeline';
    for (let slot = 0; slot < 20; slot++) {
      const target = document.createElement('div');
      target.className = 'cal-time-slot';
      target.dataset.minutes = String(480 + slot * 30);
      target.title = `${key} ${timeText(480 + slot * 30)}`;
      timeline.append(target);
    }
    const entries = [];
    for (const task of tasksOnDay(key)) {
      const begin = new Date(task.startAt || task.dueAt);
      const finish = task.startAt && task.dueAt ? new Date(task.dueAt) : new Date(begin.getTime() + 30 * 60000);
      const minutes = value => value.getHours() * 60 + value.getMinutes();
      const from = dateKey(begin) < key ? 0 : minutes(begin);
      const to = dateKey(finish) > key ? 1440 : minutes(finish);
      const chip = renderChip(task);
      chip.title += `\n${timeText(from)} – ${timeText(to)}`;
      if (to <= 480 || from >= 1080) { outside.append(chip); continue; }
      entries.push({ chip, from: Math.max(480, from), to: Math.min(1080, Math.max(from + 30, to)) });
    }
    entries.sort((a, b) => a.from - b.from || b.to - a.to);
    // Allocate lanes per overlapping group so every task remains reachable.
    let group = [], groupEnd = 0;
    const place = () => {
      const lanes = [];
      for (const entry of group) {
        let lane = lanes.findIndex(end => end <= entry.from);
        if (lane < 0) lane = lanes.length;
        lanes[lane] = entry.to;
        entry.lane = lane;
      }
      for (const entry of group) {
        entry.chip.classList.add('cal-time-event');
        entry.chip.style.top = `${(entry.from - 480) / 30 * 36}px`;
        entry.chip.style.height = `${(entry.to - entry.from) / 30 * 36}px`;
        entry.chip.style.left = `${entry.lane / lanes.length * 100}%`;
        entry.chip.style.width = `${100 / lanes.length}%`;
        const time = entry.chip.querySelector('.chip-time') || document.createElement('span');
        time.className = 'chip-time';
        time.textContent = `${timeText(entry.from)}–${timeText(entry.to)}`;
        entry.chip.append(time);
        timeline.append(entry.chip);
      }
    };
    for (const entry of entries) {
      if (group.length && entry.from >= groupEnd) { place(); group = []; groupEnd = 0; }
      group.push(entry);
      groupEnd = Math.max(groupEnd, entry.to);
    }
    place();
    cell.append(heading, outside, timeline);
    cell.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
    cell.addEventListener('drop', event => {
      event.preventDefault();
      const target = event.target.closest('.cal-time-slot');
      dropOnDay(event, key, target ? Number(target.dataset.minutes) : null);
    });
    grid.append(cell);
  }
}

function renderCalendar() {
  const titleEl = $('#cal-title');
  const gridEl = $('#cal-grid');
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  const weekly = state.calView === 'week';
  for (const button of document.querySelectorAll('[data-cal-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.calView === state.calView));
  }
  for (const [id, label] of [['cal-prev', weekly ? '上一周' : '上个月'], ['cal-next', weekly ? '下一周' : '下个月']]) {
    const button = $('#' + id);
    button.dataset.i18nTitle = label;
    button.title = tr(label);
    button.setAttribute('aria-label', tr(label));
  }
  gridEl.classList.toggle('cal-grid-week', weekly);
  $('#view-calendar').classList.toggle('calendar-week', weekly);
  const hint = $('#view-calendar .cal-hint');
  hint.dataset.i18n = weekly
    ? '拖到半小时格可调整时间，双击任务可编辑'
    : '拖动任务可整体平移时间段，未排期任务拖入日期时询问截止时间；双击任务可编辑';
  hint.textContent = tr(hint.dataset.i18n);

  const first = weekly ? new Date(y, m, state.calMonth.getDate()) : new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // 周一为一周起点
  const start = new Date(y, m, first.getDate() - offset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const formatDay = (date) => new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(date);
  titleEl.textContent = weekly ? `${formatDay(start)} – ${formatDay(end)}` : tr`${y} 年 ${m + 1} 月`;
  const todayKey = dateKey(new Date());

  gridEl.innerHTML = '';
  if (weekly) {
    renderWeekCalendar(gridEl, start);
    renderUnscheduled();
    return;
  }
  for (let i = 0; i < (weekly ? 7 : 42); i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dateKey(d);
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.dataset.date = key;
    if (!weekly && d.getMonth() !== m) cell.classList.add('other-month');
    if (key === todayKey) cell.classList.add('today');

    const dayEl = document.createElement('div');
    dayEl.className = 'cal-day';
    dayEl.textContent = weekly ? `${d.getMonth() + 1}/${d.getDate()}` : String(d.getDate());
    cell.appendChild(dayEl);

    const dayTasks = tasksOnDay(key);
    const expanded = state.expandedDays.has(key);
    const shown = (weekly || expanded) ? dayTasks : dayTasks.slice(0, 4);
    for (const t of shown) cell.appendChild(renderChip(t));
    if (dayTasks.length > shown.length) {
      const more = document.createElement('button');
      more.className = 'cal-more';
      more.textContent = tr`+${dayTasks.length - shown.length} 更多`;
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        state.expandedDays.add(key);
        renderCalendar();
      });
      cell.appendChild(more);
    }

    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      dropOnDay(e, key);
    });

    gridEl.appendChild(cell);
  }

  renderUnscheduled();
}

function renderUnscheduled() {
  const listEl = $('#unscheduled-list');
  listEl.innerHTML = '';
  const items = state.tasks
    .filter((t) => !t.startAt && !t.dueAt && t.status !== 'done' && t.status !== 'cancelled' && matchesFilters(t))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (!items.length) {
    const empty = document.createElement('span');
    empty.className = 'unscheduled-empty';
    empty.textContent = tr('所有未完成任务都已安排时间 ✓');
    listEl.appendChild(empty);
    return;
  }
  for (const t of items) listEl.appendChild(renderChip(t));
}

/** 按拖起日到落点日的偏移平移整个时间段；未排期任务先询问当天截止时间。 */
function chooseScheduleTime() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'schedule-dialog';
    const label = document.createElement('label'); label.textContent = tr('请选择截止时间');
    const input = document.createElement('input'); input.type = 'time'; input.value = '18:00'; label.append(input);
    const cancel = document.createElement('button'); cancel.textContent = tr('取消');
    const confirm = document.createElement('button'); confirm.textContent = tr('确认');
    const done = value => { dialog.close(); dialog.remove(); resolve(value); };
    cancel.onclick = () => done(null); confirm.onclick = () => done(input.value);
    dialog.oncancel = e => { e.preventDefault(); done(null); };
    dialog.append(label,cancel,confirm); document.body.append(dialog); dialog.showModal(); input.focus();
  });
}
async function dropOnDay(e, key, slotMinutes = null) {
  const id = dragId || e.dataTransfer.getData('text/plain');
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  const [yy, mm, dd] = key.split('-').map(Number);
  const anchor = task.startAt || task.dueAt;
  const patch = {};
  if (anchor) {
    const current = new Date(anchor);
    const source = dragDate || dateKey(current);
    if (source === key && slotMinutes === null) return;
    const [sy, sm, sd] = source.split('-').map(Number);
    // 用日历日期计算天数，避免夏令时让一天变成 23 / 25 小时。
    const days = (Date.UTC(yy, mm - 1, dd) - Date.UTC(sy, sm - 1, sd)) / 86400000;
    const next = new Date(current);
    next.setDate(next.getDate() + days);
    if (slotMinutes !== null) next.setHours(Math.floor(slotMinutes / 60), slotMinutes % 60, 0, 0);
    // 开始 / 截止使用同一毫秒偏移，保证任务时长不变。
    const offset = next.getTime() - current.getTime();
    if (task.startAt) patch.startAt = new Date(new Date(task.startAt).getTime() + offset).toISOString();
    if (task.dueAt) patch.dueAt = new Date(new Date(task.dueAt).getTime() + offset).toISOString();
  } else {
    const time = slotMinutes === null ? await chooseScheduleTime() : `${pad2(Math.floor(slotMinutes / 60))}:${pad2(slotMinutes % 60)}`;
    if (time === null) return;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { showToast(tr('时间格式无效')); return; }
    const [hour, minute] = time.split(':').map(Number);
    patch.dueAt = new Date(yy, mm - 1, dd, hour, minute).toISOString();
  }
  const previous = { startAt: task.startAt, dueAt: task.dueAt };
  await api.tasks.update(id, patch);
  await refresh();
  showToast(tr('已调整时间'), { label: tr('撤销'), action: async () => { await api.tasks.update(id, previous); await refresh(); } });
}

// ---------- 视图切换 ----------

function updateViewSwitch() {
  document.querySelectorAll('#view-switch .view-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#view-board').hidden = state.view !== 'board';
  $('#view-calendar').hidden = state.view !== 'calendar';
  $('#view-resources').hidden = state.view !== 'resources';
  $('#status-filters').hidden = state.view === 'resources';
  $('#task-extra-filters').hidden = state.view === 'resources' || !state.filtersExpanded;
  $('#btn-toggle-filters').setAttribute('aria-expanded', String(!$('#task-extra-filters').hidden));
  document.body.dataset.view = state.view;
  $('#btn-add-task').hidden = state.view === 'resources';
  const search = $('#search-input');
  const resourceView = state.view === 'resources';
  search.placeholder = tr(resourceView ? '搜索项目资料' : '搜索任务');
  // 资料页和任务页各自保留搜索词，避免切视图后互相过滤。
  search.setAttribute('aria-label', tr(resourceView ? '搜索项目资料' : '搜索任务'));
  const wanted = resourceView ? state.resourceSearch : state.search;
  if (document.activeElement !== search && search.value !== wanted) search.value = wanted;
}

const isRemoteLocation = value => /^(https?|mailto|svn):/i.test(String(value || '').trim());

const collapsedResourceProjects = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('withyou-resource-collapsed') || '[]');
  if (Array.isArray(saved)) for (const name of saved) if (typeof name === 'string') collapsedResourceProjects.add(name);
} catch (_) {}
const collapsedTaskProjects = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('withyou-task-collapsed') || '[]');
  if (Array.isArray(saved)) for (const name of saved) if (typeof name === 'string') collapsedTaskProjects.add(name);
} catch (_) {}
function saveResourceCollapse() {
  try { localStorage.setItem('withyou-resource-collapsed', JSON.stringify([...collapsedResourceProjects])); } catch (_) {}
}
function saveTaskCollapse() {
  try { localStorage.setItem('withyou-task-collapsed', JSON.stringify([...collapsedTaskProjects])); } catch (_) {}
}

function renderProjectResources() {
  const root = $('#resource-list');
  root.innerHTML = '';
  const all = state.projectResources;
  const query = state.resourceSearch.toLocaleLowerCase();
  const matches = all.filter(x => !query || `${x.project} ${x.name} ${x.location} ${x.note}`.toLocaleLowerCase().includes(query));
  const projectCount = new Set(all.map(x => x.project)).size;
  const countEl = $('#resource-count');
  if (countEl) countEl.textContent = all.length ? tr`${projectCount} 个项目 · ${all.length} 项资料` : '';
  $('#board-foot-count').textContent = all.length
    ? tr`${all.length} 项资料 · ${projectCount} 个项目`
    : tr('从一件小事开始，记录你的工作与生活');
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'resource-empty';
    if (!all.length) {
      empty.textContent = tr('还没有项目资料，添加常用路径或链接');
      const add = document.createElement('button');
      add.className = 'primary-btn';
      add.textContent = tr('添加第一条资料');
      add.onclick = () => openResourceEditor();
      empty.appendChild(add);
    } else {
      empty.textContent = tr`没有匹配「${state.resourceSearch}」的资料`;
      const clear = document.createElement('button');
      clear.className = 'ghost-btn';
      clear.textContent = tr('清除搜索');
      clear.onclick = () => { state.resourceSearch = ''; $('#search-input').value = ''; renderProjectResources(); };
      empty.appendChild(clear);
    }
    root.appendChild(empty);
    return;
  }
  const groups = new Map();
  matches.forEach(x => { if (!groups.has(x.project)) groups.set(x.project, []); groups.get(x.project).push(x); });
  for (const [project, items] of groups) {
    const section = document.createElement('details'); section.className = 'resource-project'; section.dataset.project = project;
    section.open = Boolean(query) || !collapsedResourceProjects.has(project);
    const heading = document.createElement('summary'); heading.className = 'resource-project-heading';
    const title = document.createElement('span'); title.textContent = project;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = String(items.length);
    const add = document.createElement('button'); add.type = 'button'; add.className = 'ghost-btn resource-project-add'; add.textContent = '＋';
    add.setAttribute('aria-label', tr('在项目中添加资料：') + project); add.title = tr('在项目中添加资料：') + project;
    add.onclick = e => { e.preventDefault(); e.stopPropagation(); openResourceEditor(null, project); };
    heading.append(title, count, add); section.append(heading);
    section.addEventListener('toggle', () => {
      if (query || !section.isConnected) return;
      if (section.open) collapsedResourceProjects.delete(project); else collapsedResourceProjects.add(project);
      saveResourceCollapse();
    });
    for (const item of items) {
      const status = state.resourceStatus[item.id];
      const locations = item.location.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
      const multiple = locations.length > 1;
      const remote = isRemoteLocation(locations[0]);
      const openLocation = async (location) => {
        const r = isRemoteLocation(location)
          ? await api.projectResources.open(location)
          : await api.projectResources.reveal(location);
        if (!r.ok) showToast(i18n.error(r.error));
      };
      const missing = status && status.exists === false;
      const card = document.createElement('article'); card.className = 'resource-card' + (missing ? ' missing' : '');
      const info = document.createElement('div'); info.className = 'resource-info';
      const name = document.createElement('strong'); name.textContent = item.name; info.appendChild(name);
      for (const location of locations) {
        const loc = document.createElement('button');
        loc.type = 'button';
        loc.className = 'resource-location resource-location-button';
        loc.textContent = loc.title = location;
        loc.onclick = () => openLocation(location);
        info.appendChild(loc);
      }
      if (item.note) { const note = document.createElement('small'); note.className = 'resource-note'; note.textContent = item.note; info.appendChild(note); }
      if (missing) { const warn = document.createElement('span'); warn.className = 'resource-missing'; warn.textContent = tr('路径不存在或已移动'); info.appendChild(warn); }
      const actions = document.createElement('div'); actions.className = 'resource-actions';
      const commands = [];
      card.dataset.resourceId = item.id; card.tabIndex = 0; card.setAttribute('aria-label', item.name);
      const addAction = (label, handler) => {
        commands.push({ label: tr(label), handler });
      };
      if (!multiple) addAction(remote ? '打开链接' : '在文件夹中显示', () => openLocation(locations[0]));
      addAction(multiple ? '复制全部地址' : (remote ? '复制链接' : '复制路径'), async () => {
        try { await navigator.clipboard.writeText(item.location); showToast(tr('已复制')); }
        catch (_) { showToast(tr('复制失败，请手动复制')); }
      });
      addAction('编辑', () => openResourceEditor(item));
      const deleteResource = async () => {
        const r = await api.projectResources.delete(item.id);
        if (!r.ok) { showToast(i18n.error(r.error)); return; }
        const deleted = { ...item };
        await loadProjectResources();
        showToast(tr`已删除「${item.name}」`, { label: tr('撤销'), action: async () => {
          const restored = await api.projectResources.save(deleted);
          if (!restored.ok) showToast(i18n.error(restored.error)); else await loadProjectResources();
        } });
      };
      addAction('删除', deleteResource);
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'card-menu-btn resource-delete';
      deleteButton.setAttribute('aria-label', tr('删除') + '：' + item.name);
      deleteButton.title = tr('删除');
      deleteButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
      deleteButton.onclick = deleteResource;
      actions.appendChild(deleteButton);
      card.addEventListener('contextmenu', e => { e.preventDefault(); showResourceMenu(e.clientX, e.clientY, commands, card); });
      card.addEventListener('keydown', e => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault(); const rect = card.getBoundingClientRect(); showResourceMenu(rect.left + 20, rect.top + 20, commands, card);
        }
      });
      card.append(info, actions); section.appendChild(card);
    }
    root.appendChild(section);
  }
}

let resourceSaving = false;
let resourceReturnFocus = null;
let resourceEditorDirty = false;

async function closeResourceEditor(force = false) {
  if (resourceSaving && force !== true) return;
  if (!force && resourceEditorDirty && !await window.uiDialogs.confirm(tr('关闭将丢弃未保存的更改，是否继续？'))) return;
  $('#resource-mask').hidden = true;
  resourceEditorDirty = false;
  resourceReturnFocus?.focus?.();
}

function openResourceEditor(item = null, project = '') {
  if (resourceSaving) return;
  state.editingResourceId = item ? item.id : null;
  resourceEditorDirty = false;
  resourceReturnFocus = document.activeElement;
  $('#resource-form').reset();
  $('#resource-form-title').textContent = item ? tr('编辑项目资料') : project ? tr('添加资料') + ' · ' + project : tr('新建项目与资料');
  const selectedProject = item ? item.project : project;
  const projects = [...new Set(state.projectResources.map(x => x.project))];
  const select = $('#resource-project-select'); select.replaceChildren();
  for (const name of projects) { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); }
  const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = tr('＋ 新建项目'); select.append(fresh);
  select.value = projects.includes(selectedProject) ? selectedProject : '';
  $('#resource-project').value = selectedProject;
  select.hidden = !item;
  $('#resource-project').hidden = Boolean(item && select.value);
  $('#resource-project').readOnly = !item && Boolean(project);
  $('#resource-project').required = !select.value;
  for (const field of $('#resource-form').querySelectorAll('input, textarea, select')) {
    field.disabled = false; field.setCustomValidity('');
    if (field.id !== 'resource-project') field.readOnly = false;
  }
  $('#resource-name').value = item ? item.name : '';
  $('#resource-location').value = item ? item.location : '';
  $('#resource-note').value = item ? item.note : '';
  $('#resource-save').disabled = false;
  $('#resource-mask').hidden = false;
  const firstInput = select.value ? $('#resource-name') : $('#resource-project');
  firstInput.focus();
  requestAnimationFrame(() => { if (!$('#resource-mask').hidden && document.activeElement === document.body) firstInput.focus(); });
}

async function loadProjectResources() {
  if (!api.projectResources) {
    state.projectResources = [];
    state.resourceStatus = {};
    renderProjectResources();
    return;
  }
  try { state.projectResources = await api.projectResources.list(); }
  catch (_) { state.projectResources = []; }
  syncTaskProjectOptions();
  renderProjectResources();
  // 路径检查可能涉及网络盘，先渲染列表，再异步补上“路径不存在”提示。
  if (typeof api.projectResources.check === 'function') {
    api.projectResources.check().then((status) => {
      state.resourceStatus = status || {};
      if (state.view === 'resources') renderProjectResources();
    }).catch(() => { state.resourceStatus = {}; });
  }
}

function setupProjectResources() {
  $('#resource-project-select').onchange = e => {
    const input = $('#resource-project'); input.value = e.target.value; input.hidden = Boolean(e.target.value); input.required = !e.target.value;
    (e.target.value ? $('#resource-name') : input).focus();
  };
  $('#resource-add').onclick = () => openResourceEditor();
  $('#resource-cancel').onclick = closeResourceEditor;
  $('#resource-browse').onclick = async () => {
    const location = $('#resource-location');
    const p = await api.projectResources.choosePath(location.value.split(/\r\n?|\n/)[0]);
    if (p) {
      location.value = [...new Set([...location.value.split(/\r\n?|\n/).map(value => value.trim()).filter(Boolean), p])].join('\n');
      resourceEditorDirty = true;
    }
  };
  $('#resource-form').onsubmit = async e => {
    e.preventDefault();
    if (resourceSaving) return;
    resourceSaving = true;
    const fields = [...$('#resource-form').querySelectorAll('input,textarea,select,button')];
    fields.forEach(field => { field.disabled = true; });
    const save = $('#resource-save'); save.disabled = true;
    try {
      const r = await api.projectResources.save({ id: state.editingResourceId, project: $('#resource-project').value,
        name: $('#resource-name').value, location: $('#resource-location').value, note: $('#resource-note').value });
      if (!r.ok) { showToast(i18n.error(r.error)); return; }
      collapsedResourceProjects.delete($('#resource-project').value.trim()); saveResourceCollapse();
      closeResourceEditor(true);
      await loadProjectResources();
      showToast(tr('资料已保存'));
    } catch (error) {
      showToast(i18n.error(error.message || String(error)));
    } finally {
      resourceSaving = false; fields.forEach(field => { field.disabled = false; }); save.disabled = false;
    }
  };
  const mask = $('#resource-mask');
  $('#resource-form').addEventListener('input', () => { resourceEditorDirty = true; });
  $('#resource-form').addEventListener('change', () => { resourceEditorDirty = true; });
  mask.addEventListener('click', e => { if (e.target === mask) closeResourceEditor(); });
  mask.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); closeResourceEditor(); return; }
    if (e.key === 'Tab') {
      const items = [...mask.querySelectorAll('button,input,textarea,select')].filter(el => !el.disabled && el.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

function setupViewSwitch() {
  $('#view-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    updateViewSwitch();
    render();
  });
}

function setupCalendar() {
  document.querySelectorAll('[data-cal-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.calView = button.dataset.calView;
      renderCalendar();
    });
  });
  $('#cal-prev').addEventListener('click', () => {
    state.calMonth = state.calView === 'week'
      ? new Date(state.calMonth.getFullYear(), state.calMonth.getMonth(), state.calMonth.getDate() + (-1 * 7))
      : new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + (-1), 1);
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', () => {
    state.calMonth = state.calView === 'week'
      ? new Date(state.calMonth.getFullYear(), state.calMonth.getMonth(), state.calMonth.getDate() + (1 * 7))
      : new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + (1), 1);
    renderCalendar();
  });
  $('#cal-today').addEventListener('click', () => {
    state.calMonth = new Date();
    renderCalendar();
  });
}

// ---------- 渲染 ----------

function renderOverview() {
  // Completion is global and excludes cancelled tasks, independent of filters.
  const total = state.tasks.filter((task) => task.status !== 'cancelled').length;
  const done = state.tasks.filter((task) => task.status === 'done').length;
  const pending = total - done;
  const progress = total ? Math.round(done / total * 100) : 0;
  $('#board-date').textContent = new Intl.DateTimeFormat(i18n.language, {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date()) + tr(' · 工作与生活');
  $('#progress-value').textContent = String(progress);
  $('#progress-summary').textContent = tr`已完成 ${done} / ${total}`;
  $('#board-progress').value = progress;
  $('#board-progress').setAttribute('aria-valuetext', tr`已完成 ${done} / ${total}，${progress}%`);
  $('#board-foot-count').textContent = total
    ? tr`已完成 ${done} 件 · ${pending ? tr`还有 ${pending} 件待推进` : tr('计划中的事都完成了，休息一下吧')}`
    : tr('从一件小事开始，记录你的工作与生活');
}

const BOARD_FILTERS = {
  all: { label: '全部任务', statuses: ['todo', 'doing', 'done', 'cancelled'] },
  active: { label: '待完成', statuses: ['todo', 'doing'] },
  done: { label: '已完成', statuses: ['done'] },
  cancelled: { label: '已取消', statuses: ['cancelled'] },
};

function syncTaskProjectOptions() {
  const projects = new Set([
    ...state.tasks.map(task => task.project),
    ...state.projectResources.map(resource => resource.project),
  ].filter(Boolean));
  const options = [...projects].sort((a, b) => a.localeCompare(b, i18n.language)).map(project => {
    const option = document.createElement('option');
    option.value = project;
    return option;
  });
  $('#task-project-options').replaceChildren(...options);
}

function orderedBoardTasks(status) {
  const tasks = state.tasks.filter(task => task.status === status && matchesFilters(task));
  return status === 'done' ? sortDone(tasks)
    : (status === 'cancelled' ? sortCancelled(tasks) : sortTasks(tasks));
}

function render() {
  updateViewSwitch();
  if (state.view === 'resources') { renderProjectResources(); return; }
  renderOverview();
  if (state.view === 'calendar') {
    renderCalendar();
    return;
  }

  const filter = BOARD_FILTERS[state.statusFilter] || BOARD_FILTERS.all;
  const ordered = filter.statuses.flatMap(orderedBoardTasks);

  $('#list-title').textContent = tr(filter.label);
  $('#list-count').textContent = String(ordered.length);
  const listEl = $('#list-all');
  listEl.innerHTML = '';

  if (!ordered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.tasks.length
      ? tr`没有符合条件的${state.statusFilter === 'all' ? '' : tr(filter.label)}任务`
      : tr('还没有任务，点击「新任务」开始记录');
    if (!state.tasks.length) {
      const createButton = document.createElement('button');
      createButton.className = 'primary-btn empty-create';
      createButton.textContent = tr('新任务');
      createButton.addEventListener('click', () => $('#btn-add-task').click());
      empty.appendChild(createButton);
    }
    listEl.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const task of ordered) {
    const project = task.project || '';
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(task);
  }
  const projects = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, i18n.language));
  if (groups.has('')) projects.push('');
  for (const project of projects) {
    const tasks = groups.get(project);
    const section = document.createElement('details');
    section.className = 'task-project';
    section.open = Boolean(state.search) || !collapsedTaskProjects.has(project);
    const heading = document.createElement('summary');
    heading.className = 'task-project-heading';
    const name = document.createElement('span');
    name.className = 'task-project-label';
    name.textContent = project || tr('未分类');
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(tasks.length);
    heading.append(name, count);
    const cards = document.createElement('div');
    cards.className = 'task-project-cards';
    for (const task of tasks) cards.appendChild(renderCard(task));
    section.append(heading, cards);
    section.addEventListener('toggle', () => {
      if (state.search || !section.isConnected) return;
      if (section.open) collapsedTaskProjects.delete(project);
      else collapsedTaskProjects.add(project);
      saveTaskCollapse();
    });
    listEl.appendChild(section);
  }
}

/** 子任务折叠摘要：显示进度并可展开/收起完整清单。 */
function renderStepsSummary(task, expanded) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const done = steps.filter((step) => step.status === 'done').length;
  const percent = steps.length ? Math.round(done / steps.length * 100) : 0;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card-steps-summary' + (expanded ? ' expanded' : '');
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', expanded
    ? tr`子任务 ${done}/${steps.length}，点击收起`
    : tr`子任务 ${done}/${steps.length}，点击展开`);

  const label = document.createElement('span');
  label.className = 'steps-summary-label';
  label.textContent = tr`子任务 ${done}/${steps.length}`;

  const track = document.createElement('span');
  track.className = 'steps-summary-track';
  const fill = document.createElement('span');
  fill.className = 'steps-summary-fill';
  fill.style.width = `${percent}%`;
  track.appendChild(fill);

  const chevron = document.createElement('span');
  chevron.className = 'steps-summary-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  button.append(label, track, chevron);
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (expanded) {
      state.expandedSteps.delete(task.id);
      if (state.stepsInputId === task.id) state.stepsInputId = null;
    } else state.expandedSteps.add(task.id);
    render();
    $(`.card[data-id="${CSS.escape(task.id)}"] .card-steps-summary`)?.focus({ preventScroll: true });
  });
  return button;
}

/** 子任务清单：勾选切换 / 行内删除 / 右键打开追加输入框。 */
function renderSteps(task) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const showInput = state.stepsInputId === task.id;

  const wrap = document.createElement('div');
  wrap.className = 'card-steps';
  // 子任务区域内的交互不触发卡片拖拽 / 点击冒泡
  wrap.addEventListener('click', (e) => e.stopPropagation());
  wrap.addEventListener('dblclick', (e) => e.stopPropagation());
  wrap.addEventListener('dragstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  for (const step of steps) {
    const row = document.createElement('div');
    row.className = 'step' + (step.status === 'done' ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'step-check' + (step.status === 'done' ? ' checked' : '');
    check.textContent = '✓';
    check.title = step.status === 'done' ? tr('取消完成') : tr('标记完成');
    check.addEventListener('click', () => {
      const next = steps.map((s) =>
        s.id === step.id ? { ...s, status: s.status === 'done' ? 'todo' : 'done' } : s);
      api.tasks.update(task.id, { steps: next }).then(refresh);
    });
    row.appendChild(check);

    const content = document.createElement('span');
    content.className = 'step-content';
    content.textContent = step.content;
    row.appendChild(content);

    const del = document.createElement('button');
    del.className = 'step-del';
    del.textContent = '×';
    del.title = tr('删除子任务');
    del.addEventListener('click', () => {
      api.tasks.update(task.id, { steps: steps.filter((s) => s.id !== step.id) }).then(refresh);
    });
    row.appendChild(del);

    wrap.appendChild(row);
  }

  if (showInput) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.className = 'step-add-input';
    input.placeholder = tr('添加子任务，回车确认');
    let saving = false;
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        if (e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        if (saving) return;
        const content = input.value.trim();
        if (!content) return;
        saving = true;
        input.disabled = true;
        state.stepsInputId = null;
        state.expandedSteps.add(task.id);
        try {
          await api.tasks.update(task.id, {
            steps: [...steps, { content, status: 'todo' }],
          });
          await refresh();
        } catch (err) {
          state.stepsInputId = task.id;
          saving = false;
          input.disabled = false;
          await window.uiDialogs.alert(tr('添加子任务失败：') + i18n.error(err.message));
          input.focus();
        }
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        state.stepsInputId = null;
        render();
      }
    });
    input.addEventListener('blur', () => {
      if (!saving && !input.value.trim() && state.stepsInputId === task.id) {
        state.stepsInputId = null;
        render();
      }
    });
    wrap.appendChild(input);
    setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
  }

  return wrap;
}

function renderCard(task) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = task.id;
  card.dataset.status = task.status;
  if (task.status === 'done') card.classList.add('done');
  if (task.status === 'cancelled') card.classList.add('cancelled');
  if (isOverdue(task)) card.classList.add('overdue');
  if (state.settings && !state.settings.roundedCorners) card.classList.add('no-radius');

  const color = task.color && COLORS[task.color] ? COLORS[task.color] : null;

  if (state.editingId === task.id) {
    card.appendChild(renderEditForm(task));
    return card;
  }

  // 拖拽
  card.draggable = true;

  const top = document.createElement('div');
  top.className = 'card-top';

  const check = document.createElement('button');
  check.className = 'check' + (task.status === 'done' || task.status === 'cancelled' ? ' checked' : '');
  check.textContent = '✓';
  check.title = task.status === 'done' ? tr('取消完成') : (task.status === 'cancelled' ? tr('恢复为待办') : tr('标记完成'));
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    if (task.status === 'cancelled') {
      api.tasks.update(task.id, { status: 'todo', cancelReason: '' }).then(refresh);
    } else {
      toggleDone(task);
    }
  });
  top.appendChild(check);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = task.title;
  title.title = tr('双击编辑');
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    state.editingId = task.id;
    render();
  });
  top.appendChild(title);

  const menuBtn = document.createElement('button');
  menuBtn.className = 'card-menu-btn';
  menuBtn.textContent = '🗑';
  menuBtn.title = tr('删除任务');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task);
  });
  top.appendChild(menuBtn);

  card.appendChild(top);

  if (task.note) {
    const note = document.createElement('div');
    const noteExpanded = state.expandedTaskNotes.has(task.id);
    note.className = 'card-note' + (noteExpanded ? ' expanded' : '');
    note.textContent = task.note;
    card.appendChild(note);
    if (task.note.length > 100) {
      const toggleNote = document.createElement('button');
      toggleNote.type = 'button';
      toggleNote.className = 'card-note-toggle';
      toggleNote.textContent = tr(noteExpanded ? '收起备注' : '展开备注');
      toggleNote.onclick = event => {
        event.stopPropagation();
        if (noteExpanded) state.expandedTaskNotes.delete(task.id);
        else state.expandedTaskNotes.add(task.id);
        render();
      };
      card.appendChild(toggleNote);
    }
  }

  if (task.status === 'cancelled' && task.cancelReason) {
    const reason = document.createElement('div');
    reason.className = 'cancel-reason';
    reason.textContent = tr('取消原因：') + task.cancelReason;
    card.appendChild(reason);
  }

  const hasSteps = Boolean(task.steps && task.steps.length);
  const showStepsInput = state.stepsInputId === task.id;
  if (hasSteps || showStepsInput) {
    const expanded = showStepsInput || state.expandedSteps.has(task.id);
    if (hasSteps) card.appendChild(renderStepsSummary(task, expanded));
    // 展开时渲染完整清单；从未添加过子任务时只渲染输入框。
    if (expanded || !hasSteps) card.appendChild(renderSteps(task));
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const statusBadge = document.createElement('span');
  statusBadge.className = `badge status-badge status-${task.status}`;
  statusBadge.textContent = tr(STATUS_LABELS[task.status] || task.status);
  meta.appendChild(statusBadge);
  const pname = priorityName(task.color);
  if (color || pname) {
    const badge = document.createElement('span');
    badge.className = 'badge priority-badge';
    badge.title = pname
      ? (color ? `${pname}（${colorLabel(task.color)}）` : pname)
      : colorLabel(task.color);
    const dot = document.createElement('span');
    dot.className = 'color-dot' + (color ? '' : ' none');
    dot.style.background = color || '#e5e7eb';
    badge.appendChild(dot);
    if (pname) {
      const label = document.createElement('span');
      label.className = 'priority-name';
      label.textContent = pname;
      badge.appendChild(label);
    }
    meta.appendChild(badge);
  }
  if (task.startAt) {
    const start = document.createElement('span');
    start.className = 'badge start';
    start.textContent = tr('开始 ') + formatDue(task.startAt);
    meta.appendChild(start);
  }
  if (task.dueAt) {
    const due = document.createElement('span');
    due.className = 'badge ' + (isOverdue(task) ? 'overdue' : 'due');
    due.textContent = (isOverdue(task) ? tr('已逾期 · ') : tr('截止 ')) + formatDue(task.dueAt);
    meta.appendChild(due);
  }
  if (task.status === 'done' && task.completedAt) {
    const done = document.createElement('span');
    done.className = 'badge';
    done.textContent = tr('完成于 ') + formatDue(task.completedAt);
    meta.appendChild(done);
  }
  if (task.status === 'cancelled' && task.cancelledAt) {
    const cancelled = document.createElement('span');
    cancelled.className = 'badge';
    cancelled.textContent = tr('取消于 ') + formatDue(task.cancelledAt);
    meta.appendChild(cancelled);
  }
  if (task.sourceId) {
    const sourceButton = document.createElement('button');
    sourceButton.type = 'button';
    sourceButton.className = 'ghost-btn source-action';
    sourceButton.textContent = tr('查看原文');
    sourceButton.addEventListener('click', e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('withyou:ai-source', { detail: task.sourceId })); });
    meta.appendChild(sourceButton);
  }
  card.appendChild(meta);

  // 色条（逾期时红色优先）
  if (color && !isOverdue(task)) {
    card.style.borderLeft = `5px solid ${color}`;
  }

  attachDrag(card, task);
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showStatusMenu(e.clientX, e.clientY, task);
  });
  return card;
}

function renderEditForm(task) {
  const form = document.createElement('div');
  form.className = 'edit-form';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = 200;
  titleInput.value = task.title;
  titleInput.placeholder = tr('任务标题（必填）');
  titleInput.setAttribute('aria-label', tr('任务标题'));
  form.appendChild(titleInput);

  const projectInput = document.createElement('input');
  projectInput.type = 'text';
  projectInput.maxLength = 100;
  projectInput.setAttribute('list', 'task-project-options');
  projectInput.setAttribute('aria-label', tr('所属项目（可选）'));
  projectInput.placeholder = tr('所属项目（可选）');
  projectInput.value = task.project || '';
  form.appendChild(projectInput);

  const noteInput = document.createElement('textarea');
  noteInput.maxLength = 1000;
  noteInput.placeholder = tr('备注（可选，≤1000 字）');
  noteInput.value = task.note || '';
  form.appendChild(noteInput);

  const row = document.createElement('div');
  row.className = 'edit-row';

  const makeTimeField = (label, iso, tip) => {
    const wrap = document.createElement('label');
    wrap.className = 'time-field';
    const cap = document.createElement('span');
    cap.textContent = label;
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.value = toLocalInputValue(iso);
    input.title = tip;
    wrap.appendChild(cap);
    wrap.appendChild(input);
    row.appendChild(wrap);
    return input;
  };
  const scopeSelect = document.createElement('select');
  for (const [value, label] of [['one','仅此任务'],['future','此任务及后续'],['all','整个重复系列']]) { const o = document.createElement('option'); o.value = value; o.textContent = tr(label); scopeSelect.append(o); }
  if (task.seriesId) form.append(scopeSelect);

  const startInput = makeTimeField(tr('开始'), task.startAt, tr('开始时间'));
  const dueInput = makeTimeField(tr('截止'), task.dueAt, tr('截止时间'));
  const reminderInput = document.createElement('select');
  for (const minutes of [5,10,30]) { const option = document.createElement('option'); option.value = String(minutes); option.textContent = tr('提前{0}分钟', minutes); reminderInput.append(option); }
  reminderInput.value = String(task.reminderMinutes || 5);
  const reminderWrap = document.createElement('label'); reminderWrap.className = 'time-field'; reminderWrap.append(document.createTextNode(tr('提醒时间')), reminderInput); row.append(reminderWrap);
  const reminderOff = document.createElement('input'); reminderOff.type = 'checkbox'; reminderOff.checked = task.reminderDisabled;
  const reminderLabel = document.createElement('label'); reminderLabel.append(reminderOff, document.createTextNode(tr('不提醒'))); row.append(reminderLabel);

  const swatches = document.createElement('div');
  swatches.className = 'color-swatches';
  let selectedColor = task.color || NONE_COLOR;
  const renderSwatches = () => {
    swatches.innerHTML = '';
    for (const p of priorityList()) {
      const c = p.color;
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'swatch' + (c === selectedColor ? ' selected' : '');
      s.style.background = c === NONE_COLOR ? '#e5e7eb' : COLORS[c];
      const name = priorityName(c);
      s.title = name ? (c === NONE_COLOR ? name : `${name} (${colorLabel(c)})`) : colorLabel(c);
      s.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedColor = c;
        renderSwatches();
      });
      swatches.appendChild(s);
    }
  };
  renderSwatches();
  row.appendChild(swatches);
  form.appendChild(row);

  // 子任务使用独立草稿，和主任务一起保存；取消时不修改原始数据。
  const stepDrafts = (task.steps || []).map((step) => ({ ...step }));
  const stepsEditor = document.createElement('section');
  stepsEditor.className = 'edit-steps';
  stepsEditor.setAttribute('aria-label', tr('子任务编辑'));
  const stepsHeading = document.createElement('div');
  stepsHeading.className = 'edit-steps-heading';
  stepsHeading.textContent = tr('子任务');
  stepsEditor.appendChild(stepsHeading);
  const stepRows = document.createElement('div');
  stepRows.className = 'edit-step-list';
  stepsEditor.appendChild(stepRows);
  const addStepBtn = document.createElement('button');
  addStepBtn.type = 'button';
  addStepBtn.className = 'subtle-btn edit-step-add';
  addStepBtn.textContent = tr('＋ 添加子任务');
  const updateStepLimit = () => {
    addStepBtn.disabled = stepDrafts.length >= 50;
    addStepBtn.title = addStepBtn.disabled ? tr('每个任务最多添加 50 条子任务') : '';
  };
  const appendStepRow = (draft) => {
    const stepRow = document.createElement('div');
    stepRow.className = 'edit-step-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = draft.status === 'done';
    check.setAttribute('aria-label', tr('子任务已完成'));
    check.addEventListener('change', () => { draft.status = check.checked ? 'done' : 'todo'; });
    const content = document.createElement('input');
    content.type = 'text';
    content.className = 'edit-step-content';
    content.maxLength = 200;
    content.value = draft.content;
    content.placeholder = tr('子任务内容（必填）');
    content.setAttribute('aria-label', tr('子任务内容'));
    content.addEventListener('input', () => { draft.content = content.value; });
    // 在子任务输入框中确认文字时，不触发整个任务的保存。
    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'subtle-btn edit-step-delete';
    remove.textContent = tr('删除');
    remove.setAttribute('aria-label', tr('删除此子任务'));
    remove.addEventListener('click', () => {
      stepDrafts.splice(stepDrafts.indexOf(draft), 1);
      stepRow.remove();
      updateStepLimit();
      addStepBtn.focus();
    });
    stepRow.append(check, content, remove);
    stepRows.appendChild(stepRow);
    return content;
  };
  stepDrafts.forEach(appendStepRow);
  addStepBtn.addEventListener('click', () => {
    if (stepDrafts.length >= 50) return;
    const draft = { content: '', status: 'todo' };
    stepDrafts.push(draft);
    appendStepRow(draft).focus();
    updateStepLimit();
  });
  updateStepLimit();
  stepsEditor.appendChild(addStepBtn);
  form.appendChild(stepsEditor);

  const errEl = document.createElement('div');
  errEl.className = 'form-error';
  errEl.hidden = true;
  form.appendChild(errEl);
  form.addEventListener('input', () => {
    errEl.hidden = true;
  });

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const delBtn = document.createElement('button');
  delBtn.className = 'danger-btn';
  delBtn.textContent = tr('删除');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task);
    state.editingId = null;
    render();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'subtle-btn';
  cancelBtn.textContent = tr('取消');
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.editingId = null;
    render();
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary-btn';
  saveBtn.textContent = tr('保存');
  const save = async (e) => {
    e.stopPropagation();
    const t = titleInput.value.trim();
    if (!t) {
      errEl.textContent = tr('任务标题不能为空');
      errEl.hidden = false;
      titleInput.focus();
      return;
    }
    const startVal = (startInput.value ? new Date(startInput.value).toISOString() : null);
    const dueVal = (dueInput.value ? new Date(dueInput.value).toISOString() : null);
    if (startVal && dueVal && new Date(startVal) > new Date(dueVal)) {
      errEl.textContent = tr('开始时间不能晚于结束时间');
      errEl.hidden = false;
      startInput.focus();
      return;
    }
    const emptyStep = stepDrafts.findIndex((step) => !step.content.trim());
    if (emptyStep !== -1) {
      errEl.textContent = tr('子任务内容不能为空，请填写或删除空白子任务');
      errEl.hidden = false;
      stepRows.children[emptyStep].querySelector('.edit-step-content').focus();
      return;
    }
    const patch = {
      title: t,
      project: projectInput.value,
      note: noteInput.value,
      startAt: startVal,
      dueAt: dueVal,
      reminderMinutes: Number(reminderInput.value), reminderAt: null, reminderDisabled: reminderOff.checked,
      color: selectedColor === NONE_COLOR ? '' : selectedColor,
      steps: stepDrafts.map((step) => ({ ...step, content: step.content.trim() })),
    };
    if (task.seriesId && scopeSelect.value !== 'one') await api.tasks.updateSeries({ id: task.id, patch, scope: scopeSelect.value });
    else await api.tasks.update(task.id, patch);
    state.editingId = null;
    refresh();
  };
  saveBtn.addEventListener('click', save);

  form.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.target.closest('button') && e.target.type !== 'checkbox') {
      e.preventDefault();
      save(e);
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      state.editingId = null;
      render();
    }
  });
  form.addEventListener('click', (e) => e.stopPropagation());

  actions.appendChild(delBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  form.appendChild(actions);

  setTimeout(() => {
    titleInput.focus();
    titleInput.select();
  }, 0);
  return form;
}

// ---------- 操作 ----------

async function refresh() {
  state.tasks = await api.tasks.list();
  syncTaskProjectOptions();
  render();
}

function toggleDone(task) {
  api.tasks.update(task.id, {
    status: task.status === 'done' ? 'todo' : 'done',
  }).then(refresh);
}

// 删除 + 撤销
let undoPayload = null;
let undoTimer = null;

function deleteTask(task) {
  const index = state.tasks.findIndex((t) => t.id === task.id);
  api.tasks.delete(task.id).then(() => {
    undoPayload = { task, index };
    showToast(tr`已删除「${task.title}」`);
    refresh();
  });
}

function showToast(text, action) {
  if (action) undoPayload = { action: action.action };
  const toast = $('#undo-toast');
  $('#undo-text').textContent = text;
  $('#btn-undo').hidden = !undoPayload;
  toast.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    toast.hidden = true;
    undoPayload = null;
  }, 5000);
}

function undoDelete() {
  if (!undoPayload) return;
  if (undoPayload.action) { const action = undoPayload.action; undoPayload = null; $('#undo-toast').hidden = true; action(); return; }
  const { task, index } = undoPayload;
  undoPayload = null;
  clearTimeout(undoTimer);
  $('#undo-toast').hidden = true;
  api.tasks.restore(task, index).then(refresh);
}

// ---------- 右键状态菜单 ----------

const STATUS_LABELS = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};

let openMenu = null;

function closeStatusMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

function showResourceMenu(x, y, commands, card) {
  closeStatusMenu();
  const menu = document.createElement('div'); menu.className = 'context-menu resource-context-menu'; menu.setAttribute('role', 'menu');
  for (const command of commands) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'context-menu-item';
    button.textContent = command.label; button.setAttribute('role', 'menuitem');
    button.onclick = async () => { closeStatusMenu(); if (card.isConnected) card.focus(); try { await command.handler(); } catch (e) { showToast(e.message); } };
    menu.append(button);
  }
  menu.style.left = Math.max(8,x) + 'px'; menu.style.top = Math.max(8,y) + 'px'; document.body.append(menu); openMenu = menu;
  const rect = menu.getBoundingClientRect();
  if (rect.right > innerWidth) menu.style.left = Math.max(8,innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > innerHeight) menu.style.top = Math.max(8,innerHeight - rect.height - 8) + 'px';
  menu.addEventListener('keydown', e => {
    const buttons = [...menu.querySelectorAll('button')];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeStatusMenu(); if (card.isConnected) card.focus(); }
    if (['ArrowDown','ArrowUp'].includes(e.key)) { e.preventDefault(); const i = buttons.indexOf(document.activeElement); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
  });
  menu.querySelector('button')?.focus();
}

function showStatusMenu(x, y, task) {
  closeStatusMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const editItem = document.createElement('button');
  editItem.type = 'button';
  editItem.className = 'context-menu-item';
  editItem.textContent = tr('编辑任务');
  editItem.addEventListener('click', () => {
    closeStatusMenu();
    openTaskInBoard(task.id);
  });
  menu.appendChild(editItem);

  const addStepItem = document.createElement('button');
  addStepItem.type = 'button';
  addStepItem.className = 'context-menu-item';
  addStepItem.textContent = tr('添加子任务');
  addStepItem.disabled = (task.steps || []).length >= 50;
  if (addStepItem.disabled) addStepItem.title = tr('每个任务最多添加 50 条子任务');
  addStepItem.addEventListener('click', () => {
    closeStatusMenu();
    openTaskInBoard(task.id, { addStep: true });
  });
  menu.appendChild(addStepItem);

  const editDivider = document.createElement('div');
  editDivider.className = 'context-menu-divider';
  menu.appendChild(editDivider);

  for (const status of ['todo', 'doing', 'done', 'cancelled']) {
    if (status === 'cancelled') {
      const divider = document.createElement('div');
      divider.className = 'context-menu-divider';
      menu.appendChild(divider);
    }
    const item = document.createElement('div');
    item.className = 'context-menu-item' + (task.status === status ? ' current' : '');
    item.textContent = tr(STATUS_LABELS[status]);
    if (task.status !== status) {
      item.addEventListener('click', () => {
        closeStatusMenu();
        changeTaskStatus(task, status);
      });
    }
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  openMenu = menu;

  // 边界调整：避免贴边溢出
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
}

let pendingCancelTask = null;

function openCancelReasonModal(task) {
  pendingCancelTask = task;
  const mask = $('#cancel-reason-mask');
  const input = $('#cancel-reason-input');
  input.value = task.cancelReason || '';
  mask.hidden = false;
  setTimeout(() => input.focus(), 0);
}

function closeCancelReasonModal() {
  $('#cancel-reason-mask').hidden = true;
  pendingCancelTask = null;
}

async function confirmCancelReason() {
  if (!pendingCancelTask) return;
  const reason = $('#cancel-reason-input').value.trim();
  await api.tasks.update(pendingCancelTask.id, { status: 'cancelled', cancelReason: reason });
  closeCancelReasonModal();
  refresh();
}

async function changeTaskStatus(task, status) {
  if (status === 'cancelled') {
    openCancelReasonModal(task);
  } else {
    const patch = { status };
    if (task.status === 'cancelled') patch.cancelReason = '';
    await api.tasks.update(task.id, patch);
    refresh();
  }
}

document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeStatusMenu();
});
document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeStatusMenu();
});

// ---------- 拖拽 ----------

let dragId = null;
let dragDate = null;

function attachDrag(card, task) {
  card.addEventListener('dragstart', (e) => {
    dragId = task.id;
    dragDate = null;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    dragDate = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.card-list').forEach((l) => l.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDrop(e, task);
  });
}

function setupColumnDnD() {
  const listEl = $('#list-all');
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    listEl.classList.add('drag-over');
  });
  listEl.addEventListener('dragleave', () => listEl.classList.remove('drag-over'));
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    listEl.classList.remove('drag-over');
  });
}

async function handleDrop(e, targetTask) {
  const id = dragId || e.dataTransfer.getData('text/plain');
  if (!id || !targetTask || targetTask.id === id) return;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;

  const targetStatus = targetTask.status;
  // 项目分组和折叠只影响展示；排序仍按原有状态顺序处理。
  if (task.status !== targetStatus || (task.project || '') !== (targetTask.project || '')) {
    showToast(tr('请在同一项目、同一状态内拖动排序'));
    return;
  }
  const ids = orderedBoardTasks(targetStatus).map(t => t.id).filter(taskId => taskId !== id);
  const at = ids.indexOf(targetTask.id);
  ids.splice(at === -1 ? ids.length : at, 0, id);

  await api.tasks.reorder(targetStatus, ids);
  manualOrderStatuses.add(targetStatus);
  try { localStorage.setItem('withyou-manual-order-statuses', JSON.stringify([...manualOrderStatuses])); } catch (_) {}
  refresh();
}

// ---------- 搜索 / 筛选 ----------

function setupFilters() {
  $('#btn-toggle-filters').addEventListener('click', () => {
    const panel = $('#task-extra-filters');
    state.filtersExpanded = !state.filtersExpanded;
    panel.hidden = !state.filtersExpanded;
    $('#btn-toggle-filters').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('#btn-clear-filters').addEventListener('click', () => {
    state.dueFilter = 'all';
    state.colorFilter = 'all';
    syncFilterChips();
    render();
  });
  $('#search-input').addEventListener('input', (e) => {
    const value = e.target.value.trim();
    if (state.view === 'resources') {
      state.resourceSearch = value;
      renderProjectResources();
      return;
    }
    state.search = value;
    render();
  });

  // 状态快速筛选（全部/待完成/已完成/已取消）
  const statusFiltersEl = $('#status-filters');
  if (statusFiltersEl) {
    statusFiltersEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      // 「全部」恢复所有状态和条件；再次点击当前状态也可取消状态筛选。
      state.statusFilter = state.statusFilter === btn.dataset.filter ? 'all' : btn.dataset.filter;
      if (btn.dataset.filter === 'all') {
        state.dueFilter = 'all';
        state.colorFilter = 'all';
        syncFilterChips();
      }
      syncStatusFilterChips();
      render();
    });
  }

  $('#due-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-due]');
    if (!btn) return;
    const v = btn.dataset.due;
    // 再点一次当前项则取消筛选。
    state.dueFilter = state.dueFilter === v ? 'all' : v;
    syncFilterChips();
    render();
  });

  $('#color-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    // 再点一次当前项则取消优先级筛选
    state.colorFilter = state.colorFilter === btn.dataset.color ? 'all' : btn.dataset.color;
    syncFilterChips();
    render();
  });

  // 颜色圆点 / 优先级名同步
  renderColorFilterChips();
  syncStatusFilterChips();
}

function syncStatusFilterChips() {
  for (const btn of document.querySelectorAll('#status-filters [data-filter]')) {
    const active = btn.dataset.filter === state.statusFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

/** 同步已选条件和筛选按钮摘要。 */
function syncFilterChips() {
  const labels = [];
  if (state.dueFilter !== 'all') {
    labels.push(({ today: tr('今日'), tomorrow: tr('明日'), week: tr('本周'), overdue: tr('逾期') })[state.dueFilter]);
  }
  if (state.colorFilter !== 'all') labels.push(priorityName(state.colorFilter) || colorLabel(state.colorFilter) || tr('无色'));
  $('#filter-summary').textContent = labels.length ? ' · ' + labels.join(' / ') : '';
  $('#btn-toggle-filters').classList.toggle('active', labels.length > 0);
  for (const btn of document.querySelectorAll('#due-filters [data-due]')) {
    const v = btn.dataset.due;
    const active = v === 'all'
      ? (state.dueFilter === 'all' && state.colorFilter === 'all')
      : state.dueFilter === v;
    btn.classList.toggle('active', active);
  }
  for (const btn of document.querySelectorAll('#color-filters [data-color]')) {
    btn.classList.toggle('active', state.colorFilter !== 'all' && btn.dataset.color === state.colorFilter);
  }
}

/** 按当前优先级配置重建筛选 chips；默认 4 级，旧 9 级配置仍原样显示。 */
function renderColorFilterChips() {
  const wrap = $('#color-filters');
  if (!wrap) return;
  wrap.querySelectorAll('[data-color]').forEach(element => element.remove());
  const priorities = priorityList();
  if (state.colorFilter !== 'all' && !priorities.some(priority => priority.color === state.colorFilter)) state.colorFilter = 'all';
  for (const priority of priorities) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (priority.color === NONE_COLOR ? '' : ' chip-dot');
    chip.dataset.color = priority.color;
    wrap.appendChild(chip);
  }
  syncColorFilterChips();
  syncFilterChips();
}

/**
 * 颜色筛选 chips：填充色点；级别已命名时展开为「圆点 + 名称」，
 * 提示显示「优先级名（颜色）」。优先级配置变化后需重新调用。
 */
function syncColorFilterChips() {
  for (const chip of document.querySelectorAll('#color-filters [data-color]')) {
    const key = chip.dataset.color;
    if (key === 'all') continue;
    const name = priorityName(key);
    chip.innerHTML = '';
    if (name) {
      chip.classList.add('named');
      chip.style.background = '';
      const dot = document.createElement('span');
      dot.className = 'chip-swatch' + (key === NONE_COLOR ? ' none' : '');
      dot.style.background = key === NONE_COLOR ? '#e5e7eb' : COLORS[key];
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.title = key === NONE_COLOR ? name : `${name}（${colorLabel(key)}）`;
    } else if (key === NONE_COLOR) {
      chip.classList.remove('named');
      chip.style.background = '';
      chip.textContent = tr('无色');
      chip.title = tr('无色');
    } else {
      chip.classList.remove('named');
      chip.style.background = COLORS[key];
      chip.title = colorLabel(key);
    }
  }
}

// ---------- 添加任务弹窗（任务名 / 任务内容 / 开始时间 / 结束时间） ----------

function setupAddTask() {
  const mask = $('#add-task-mask');
  const titleInput = $('#add-title');
  const projectInput = $('#add-project');
  const noteInput = $('#add-note');
  const startInput = $('#add-start');
  const endInput = $('#add-end');
  const reminderInput = $('#add-reminder');
  const errorEl = $('#add-error');
  const repeatSelect = $('#add-repeat');
  const untilInput = $('#add-until');
  const untilField = $('#add-until-field');
  const previewEl = $('#add-preview');
  let creating = false;
  const hasAI = Boolean(api.ai);
  let aiMode = hasAI, aiBusy = false, aiDraft = null, aiModePicked = false;
  let aiConfigReady = Promise.resolve();
  const aiText = $('#add-ai-text');
  aiText.value = localStorage.getItem('withyou-ai-input') || '';
  aiText.addEventListener('input', () => localStorage.setItem('withyou-ai-input', aiText.value));
  const aiStatus = (message, error = false) => {
    $('#add-ai-status').textContent = message;
    $('#add-ai-status').classList.toggle('error', error);
  };
  const aiCall = async (method, input) => {
    const result = await api.ai[method](input);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  const syncAddMode = () => {
    $('#add-mode-tabs').hidden = !hasAI;
    $('#add-ai-fields').hidden = !aiMode;
    $('#add-manual-fields').hidden = aiMode;
    $('#btn-create-task').hidden = aiMode;
    $('#btn-ai-create-task').hidden = !aiMode;
    $('#add-mode-ai').className = aiMode ? 'primary-btn' : 'subtle-btn';
    $('#add-mode-manual').className = aiMode ? 'subtle-btn' : 'primary-btn';
  };
  const setAIBusy = value => {
    aiBusy = value;
    for (const id of ['add-ai-text', 'btn-ai-create-task', 'add-mode-ai', 'add-mode-manual']) $( '#' + id).disabled = value;
    $('#btn-cancel-add').textContent = tr(value ? '取消整理' : '取消');
  };
  const createWithAI = async () => {
    if (aiBusy) return;
    const text = aiText.value.trim();
    if (!text) { aiStatus(tr('请填写工作内容或会议记录'), true); aiText.focus(); return; }
    setAIBusy(true); aiStatus(tr('正在整理，请稍候…'));
    try {
      await aiConfigReady;
      const config = await aiCall('config');
      if (!config.model || !config.endpoint) throw new Error(tr('请先在设置的「AI 与模型」中配置模型连接'));
      if (!aiDraft) {
        const now = new Date();
        const referenceDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        aiDraft = await aiCall('analyze', { text, referenceDate, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      }
      mask.hidden = true;
      window.dispatchEvent(new CustomEvent('withyou:ai-draft', { detail: { draft: aiDraft, text } }));
      aiStatus('');
    } catch (error) { aiStatus(i18n.error(error.message), true); }
    finally { setAIBusy(false); }
  };
  for (const element of [aiText]) element.addEventListener('input', () => {
    aiDraft = null; $('#btn-ai-create-task').disabled = false; aiStatus('');
  });
  window.addEventListener('withyou:ai-config-saved', () => { aiDraft = null; aiConfigReady = aiCall('config').then(config => aiStatus(config.model ? tr('当前默认模型：') + config.model : tr('尚未配置模型，可前往设置或使用手动填写'))).catch(error => aiStatus(error.message, true)); });
  $('#add-mode-ai').onclick = () => { aiModePicked = true; aiMode = true; localStorage.setItem('withyou-add-mode', 'ai'); syncAddMode(); aiText.focus(); };
  $('#add-mode-manual').onclick = () => { aiModePicked = true; aiMode = false; localStorage.setItem('withyou-add-mode', 'manual'); syncAddMode(); titleInput.focus(); };
  $('#btn-ai-create-task').onclick = createWithAI;
  window.addEventListener('withyou:ai-created', () => { aiDraft = null; aiText.value = ''; localStorage.removeItem('withyou-ai-input'); });

  // 紧急程度（颜色 → 优先级，默认 4 级 + 无色）
  let addPriority = NONE_COLOR;
  const renderPriorityPicks = () => {
    const wrap = $('#add-priority');
    wrap.innerHTML = '';
    for (const p of priorityList()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip priority-chip' + (p.color === addPriority ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'chip-swatch' + (p.color === NONE_COLOR ? ' none' : '');
      dot.style.background = p.color === NONE_COLOR ? '#e5e7eb' : COLORS[p.color];
      btn.appendChild(dot);
      const name = priorityName(p.color);
      btn.appendChild(document.createTextNode(name || colorLabel(p.color)));
      btn.title = name && p.color !== NONE_COLOR ? `${name} (${colorLabel(p.color)})` : (name || colorLabel(p.color));
      btn.addEventListener('click', () => {
        addPriority = p.color;
        renderPriorityPicks();
      });
      wrap.appendChild(btn);
    }
  };

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  };
  const clearForm = () => {
    titleInput.value = '';
    projectInput.value = '';
    noteInput.value = '';
    startInput.value = '';
    endInput.value = '';
    reminderInput.value = '5';
    repeatSelect.value = '';
    untilInput.value = '';
    untilField.hidden = true;
    previewEl.hidden = true;
    errorEl.hidden = true;
    addPriority = NONE_COLOR;
    renderPriorityPicks();
  };
  const loadAddDrafts = async () => {
    const drafts = await aiCall('drafts');
    const panel = $('#add-pending'), list = $('#add-pending-list'); list.replaceChildren(); panel.hidden = !drafts.length;
    $('#add-pending-summary').textContent = tr('待确认草稿') + ' (' + drafts.length + ')';
    for (const source of drafts) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'subtle-btn ai-history-item';
      button.textContent = source.text.slice(0,100);
      button.onclick = () => { if (aiBusy) return; mask.hidden = true; window.dispatchEvent(new CustomEvent('withyou:ai-draft', { detail: { ...source, draft: source.result, returnToAdd: { text: aiText.value, aiMode } } })); };
      list.append(button);
    }
  };
  const openAddTask = () => {
    if (aiBusy) return;
    clearForm();
    if (hasAI) loadAddDrafts().catch(error => aiStatus(error.message, true));
    aiMode = hasAI && localStorage.getItem('withyou-add-mode') !== 'manual';
    aiModePicked = false;
    if (hasAI) aiConfigReady = aiCall('config').then(config => {
      if (!config.model && !aiModePicked) {
        aiMode = false;
        syncAddMode();
        aiStatus(tr('尚未配置模型，已切换为手动填写；可在设置中配置 AI 模型'));
        if (!mask.hidden) titleInput.focus();
        return;
      }
      aiStatus(config.model ? tr('当前默认模型：') + config.model : tr('尚未配置模型，可前往设置或使用手动填写'));
    }).catch(error => aiStatus(error.message, true));
    syncAddMode();
    mask.hidden = false;
    setTimeout(() => (aiMode ? aiText : titleInput).focus(), 0);
  };
  window.addEventListener('withyou:ai-return', event => {
    aiDraft = null;
    aiText.value = event.detail.text || '';
    localStorage.setItem('withyou-ai-input', aiText.value);
    aiMode = event.detail.aiMode !== false; aiModePicked = true;
    syncAddMode(); aiStatus(''); mask.hidden = false;
    loadAddDrafts().catch(error => aiStatus(error.message, true));
    (aiMode ? aiText : titleInput).focus();
  });
  const closeAddTask = () => {
    if (aiBusy) { api.ai.cancel().catch(error => aiStatus(error.message, true)); return; }
    mask.hidden = true;
  };

  /** 重复任务生成预览（实时显示将创建的条数与日期范围）。 */
  const updatePreview = async () => {
    const freq = repeatSelect.value;
    if (!freq) {
      previewEl.hidden = true;
      return;
    }
    const r = await api.tasks.planRecurring({
      startAt: (startInput.value ? new Date(startInput.value).toISOString() : null),
      dueAt: (endInput.value ? new Date(endInput.value).toISOString() : null),
      freq,
      until: untilInput.value,
    });
    if (!r.ok) {
      previewEl.textContent = i18n.error(r.error);
      previewEl.classList.add('error');
    } else {
      previewEl.textContent = tr`将创建 ${r.count} 条重复任务（${formatMD(r.firstAt)} ~ ${formatMD(r.lastAt)}）`;
      previewEl.classList.remove('error');
    }
    previewEl.hidden = false;
  };

  const create = async () => {
    if (creating) return;
    const title = titleInput.value.trim();
    if (!title) {
      showError(tr('请填写任务名'));
      titleInput.focus();
      return;
    }
    const startAt = (startInput.value ? new Date(startInput.value).toISOString() : null);
    const dueAt = (endInput.value ? new Date(endInput.value).toISOString() : null);
    const reminderMinutes = Number(reminderInput.value);
    if (startAt && dueAt && new Date(startAt) > new Date(dueAt)) {
      showError(tr('开始时间不能晚于结束时间'));
      startInput.focus();
      return;
    }
    const freq = repeatSelect.value;
    if (freq && !startAt && !dueAt) {
      showError(tr('重复任务需要填写开始时间或截止时间（作为每次任务的时间）'));
      startInput.focus();
      return;
    }
    creating = true;
    try {
      const color = addPriority === NONE_COLOR ? '' : addPriority;
      if (freq) {
        const r = await api.tasks.createRecurring({
          title,
          project: projectInput.value,
          note: noteInput.value,
          color,
          startAt,
          dueAt,
          reminderMinutes,
          freq,
          until: untilInput.value,
        });
        if (!r.ok) {
          showError(i18n.error(r.error) || tr('创建重复任务失败'));
          return;
        }
        closeAddTask();
        refresh();
        showToast(tr`已创建 ${r.count} 条重复任务`);
      } else {
        await api.tasks.create({ title, project: projectInput.value, note: noteInput.value, color, startAt, dueAt, reminderMinutes, status: 'todo' });
        closeAddTask();
        refresh();
      }
    } finally {
      creating = false;
    }
  };

  $('#btn-add-task').addEventListener('click', openAddTask);
  $('#btn-cancel-add').addEventListener('click', closeAddTask);
  $('#btn-create-task').addEventListener('click', create);
  mask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeAddTask();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (aiMode) {
        if (e.target === aiText && !(e.ctrlKey || e.metaKey)) return;
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); createWithAI(); }
        return;
      }
      e.preventDefault();
      create();
    }
  });
  repeatSelect.addEventListener('change', () => {
    untilField.hidden = !repeatSelect.value;
    updatePreview();
  });

  mask.addEventListener('input', () => {
    errorEl.hidden = true;
    updatePreview();
  });
}

function setupCancelReasonModal() {
  const mask = $('#cancel-reason-mask');
  $('#btn-cancel-reason-cancel').addEventListener('click', closeCancelReasonModal);
  $('#btn-cancel-reason-confirm').addEventListener('click', confirmCancelReason);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeCancelReasonModal();
  });
  mask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeCancelReasonModal();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirmCancelReason();
    }
  });
}

// ---------- 设置 ----------

function setupSettings() {
  let quietModePreferences = null;
  const applyReading = s => { document.documentElement.dataset.theme = s.theme || 'system'; document.documentElement.style.zoom = Number(s.textSize) || 1; document.documentElement.classList.toggle('reduce-motion', !!s.reducedMotion); };
  api.settings.get().then(applyReading);
  api.app.onSettingsChanged?.((next) => {
    state.settings = next;
    applyReading(next);
    renderColorFilterChips();
    syncSettingsUI();
    if (next.language && next.language !== i18n.language) i18n.setLanguage(next.language);
    render();
  });
  for (const [id,key] of [['set-text-size','textSize'],['set-theme','theme'],['set-reduced-motion','reducedMotion']]) $( '#' + id).onchange = async e => { const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value; state.settings = await api.settings.set({ [key]: value }); applyReading(state.settings); };

  $('#btn-export-full').onclick = async () => { const r = await api.tasks.export({ full: true }); if (r.ok) showToast(tr('完整备份已保存')); };
  $('#set-language').addEventListener('change', async (e) => {
    const selected = e.target.value;
    try {
      state.settings = await api.settings.set({ language: selected });
      i18n.setLanguage(state.settings.language);
    } catch (error) {
      e.target.value = i18n.language;
      showToast(error.message);
    }
  });
  $('#btn-preview-pet-clips').addEventListener('click', () => api.pet.previewClips());
  $('#btn-preview-pet-reminder').addEventListener('click', async () => {
    const result = await api.pet.previewReminder();
    if (!result.ok) showToast(i18n.error(result.error));
  });
  const mask = $('#settings-mask');
  const openSettings = async () => {
    state.settings = await api.settings.get();
    mask.hidden = false;
    syncSettingsUI();
    mask.querySelector('[data-settings-tab][aria-pressed="true"]')?.focus();
  };
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', () => {
    mask.hidden = true;
  });
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.hidden = true;
  });

  $('#set-always-on-top').addEventListener('change', (e) => {
    api.settings.set({ alwaysOnTop: e.target.checked });
  });
  $('#set-opacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#opacity-value').textContent = `${v}%`;
    api.settings.set({ opacity: v / 100 });
  });
  $('#set-rounded').addEventListener('change', (e) => {
    api.settings.set({ roundedCorners: e.target.checked }).then((s) => {
      state.settings = s;
      render();
    });
  });
  $('#set-autostart').addEventListener('change', (e) => {
    api.settings.set({ autostart: e.target.checked });
  });

  // 桌面宠物
  $('#set-pet-enabled').addEventListener('change', (e) => {
    api.settings.set({ petEnabled: e.target.checked });
  });
  $('#set-pet-scale').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#pet-scale-value').textContent = `${v}%`;
    api.settings.set({ petScale: v / 100 }).then((s) => { state.settings = s; });
  });
  $('#set-pet-bubbles').addEventListener('change', (e) => {
    api.settings.set({ petBubbles: e.target.checked }).then((s) => { state.settings = s; syncSettingsUI(); });
  });
  $('#set-pet-animation').addEventListener('change', (e) => {
    api.settings.set({ petCenterAnimation: e.target.checked }).then((s) => { state.settings = s; syncSettingsUI(); });
  });
  $('#set-notify-system').addEventListener('change', (e) => {
    api.settings.set({ notifySystem: e.target.checked }).then((s) => { state.settings = s; syncSettingsUI(); });
  });
  $('#set-quiet-mode').addEventListener('change', (e) => {
    const quiet = e.target.checked;
    if (quiet) {
      quietModePreferences = {
        notifySystem: state.settings.notifySystem !== false,
        petBubbles: state.settings.petBubbles !== false,
        petCenterAnimation: state.settings.petCenterAnimation !== false,
      };
    }
    const patch = quiet
      ? { notifySystem: false, petBubbles: false, petCenterAnimation: false }
      : quietModePreferences || { notifySystem: true, petBubbles: true, petCenterAnimation: true };
    api.settings.set(patch)
      .then((s) => { state.settings = s; syncSettingsUI(); });
    if (!quiet) quietModePreferences = null;
  });
  $('#set-pet-snap').addEventListener('change', (e) => {
    api.settings.set({ petSnapToEdge: e.target.checked });
  });

  // 托盘 / 桌宠菜单「打开设置」
  api.app.onOpenSettings(openSettings);
}

function syncSettingsUI() {
  const s = state.settings || {};
  $('#set-text-size').value = String(s.textSize || 1); $('#set-theme').value = s.theme || 'system'; $('#set-reduced-motion').checked = !!s.reducedMotion;
  $('#set-language').value = i18n.language;
  $('#set-language').disabled = Boolean(state.editingId || state.stepsInputId);
  $('#set-language').title = $('#set-language').disabled ? tr('请先保存或取消当前编辑') : '';
  $('#set-always-on-top').checked = Boolean(s.alwaysOnTop);
  $('#set-opacity').value = Math.round((s.opacity ?? 1) * 100);
  $('#opacity-value').textContent = `${Math.round((s.opacity ?? 1) * 100)}%`;
  $('#set-rounded').checked = s.roundedCorners !== false;
  $('#set-autostart').checked = Boolean(s.autostart);
  $('#set-pet-enabled').checked = s.petEnabled !== false;
  $('#set-pet-scale').value = Math.round((s.petScale ?? 1) * 100);
  $('#pet-scale-value').textContent = `${Math.round((s.petScale ?? 1) * 100)}%`;
  $('#set-pet-bubbles').checked = s.petBubbles !== false;
  $('#set-pet-animation').checked = s.petCenterAnimation !== false;
  $('#set-notify-system').checked = s.notifySystem !== false;
  $('#set-quiet-mode').checked = s.notifySystem === false && s.petBubbles === false && s.petCenterAnimation === false;
  $('#set-pet-snap').checked = s.petSnapToEdge !== false;
  renderPrioritySettings();
}

// ---------- 颜色与优先级设置 ----------

/** 渲染「颜色与优先级」列表：上移 / 下移调整等级，名称可自定义。 */
function renderPrioritySettings() {
  const list = priorityList();
  const wrap = $('#priority-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'priority-row';
    row.dataset.color = p.color;

    const moves = document.createElement('div');
    moves.className = 'priority-moves';
    for (const dir of [-1, 1]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'move-btn';
      btn.textContent = dir < 0 ? '▲' : '▼';
      btn.title = dir < 0 ? tr('提升优先级') : tr('降低优先级');
      btn.disabled = dir < 0 ? idx === 0 : idx === list.length - 1;
      btn.addEventListener('click', () => movePriority(p.color, dir));
      moves.appendChild(btn);
    }
    row.appendChild(moves);

    const dot = document.createElement('span');
    dot.className = 'prio-dot' + (p.color === NONE_COLOR ? ' none' : '');
    dot.style.background = p.color === NONE_COLOR ? '#e5e7eb' : COLORS[p.color];
    dot.title = colorLabel(p.color);
    row.appendChild(dot);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prio-name';
    input.maxLength = 24;
    input.value = priorityName(p.color);
    input.dataset.originalName = p.name;
    input.dataset.displayName = input.value;
    input.placeholder = tr('如：紧急');
    input.title = tr`自定义「${colorLabel(p.color)}」代表的紧急度名称，留空则不显示标签`;
    input.addEventListener('change', () => savePriorities(readPriorityRows()));
    row.appendChild(input);

    wrap.appendChild(row);
  });
}

/** 读取设置面板中当前的优先级配置（按行顺序 = 等级从高到低）。 */
function readPriorityRows() {
  return Array.from(document.querySelectorAll('#priority-list .priority-row')).map((row) => ({
    color: row.dataset.color,
    name: (() => { const input = row.querySelector('.prio-name'); return input.value === input.dataset.displayName ? input.dataset.originalName : input.value.trim(); })(),
  }));
}

/** 保存优先级配置并刷新筛选栏 / 看板 / 设置列表。 */
function savePriorities(list) {
  api.settings.set({ colorPriorities: list }).then((s) => {
    state.settings = s;
    renderColorFilterChips();
    syncFilterChips();
    render();
    renderPrioritySettings();
  });
}

/** 上移 / 下移某个颜色的优先级等级。 */
function movePriority(color, dir) {
  const list = readPriorityRows();
  const i = list.findIndex((p) => p.color === color);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  savePriorities(list);
}

// ---------- 导入导出 ----------

function setupImportExport() {
  $('#btn-export').addEventListener('click', async () => {
    const r = await api.tasks.export();
    if (r && r.ok) await window.uiDialogs.alert(tr`已导出到：\n${r.filePath}`);
  });
  $('#btn-import').addEventListener('click', async () => {
    let r;
    try {
      r = await api.tasks.import();
    } catch (err) {
      await window.uiDialogs.alert(tr('导入失败：') + (err && err.message ? i18n.error(err.message) : tr('未知错误')));
      return;
    }
    if (r && r.ok) {
      const resources = r.resources;
      await window.uiDialogs.alert(tr`导入完成，新增 ${r.count} 条任务` + (resources ? '\n' + tr('资料：新增 {0}，重复 {1}，无效 {2}', resources.imported, resources.duplicates, resources.invalid) : ''));
      await loadProjectResources();
      refresh();
    } else if (r && r.error) {
      await window.uiDialogs.alert(i18n.error(r.error));
    }
  });
}

// ---------- 启动 ----------

async function init() {
  state.settings = await api.settings.get();
  window.addEventListener('withyou:language', () => {
    state.settings.language = i18n.language;
    syncColorFilterChips();
    syncFilterChips();
    syncStatusFilterChips();
    syncSettingsUI();
    if (!state.editingId && !state.stepsInputId) render();
  });
  await refresh();
  await loadProjectResources();

  setupAddTask();
  setupCancelReasonModal();
  setupFilters();
  setupSettings();
  setupImportExport();
  setupColumnDnD();
  setupViewSwitch();
  setupProjectResources();
  setupCalendar();

  $('#btn-undo').addEventListener('click', undoDelete);

  // 主进程推送的数据变更（托盘新建 / 速记窗新建 / 通知后状态变化等）
  api.tasks.onChanged((tasks) => {
    state.tasks = tasks;
    syncTaskProjectOptions();
    render();
  });

  // 每 30s 刷新一次逾期状态显示
  setInterval(() => {
    if (!state.editingId && !state.stepsInputId) render();
  }, 30000);
}

init();
