'use strict';

/**
 * 数据层：任务模型 + 本地持久化（原子落盘）。
 * 数据文件为 userData/tasks.json，结构：
 * { "version": 1, "tasks": [Task, ...] }
 *
 * Task 字段见 PRD 第 3 节：
 * id / title / note / status / color / startAt / dueAt / sortOrder
 * / steps / createdAt / updatedAt / completedAt
 * （额外维护 notifiedAt：提醒去重标记）
 * 其中 dueAt 为结束（截止）时间，startAt 为开始时间。
 * 普通提醒按开始时间计算，只有截止时间时按截止时间计算。兼容旧的独立提醒时间。
 * steps 为子任务清单：[{ id, content, status }]，status 取 todo | done。
 *
 * 导入（importJSON）额外兼容旧版 MoliTodo v3 备份格式：
 * { version: "3.0.0", tasks: [{ content, status, completed, metadata: { note, steps },
 *   scheduledStartAt, scheduledEndAt, dueDate, dueTime, ... }] }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TITLE = 200;
const MAX_PROJECT = 100;
const MAX_NOTE = 1000;
const MAX_STEP_CONTENT = 200;
const MAX_STEPS = 50;
const MAX_BATCH = 200;
const STATUSES = ['todo', 'doing', 'done', 'cancelled'];
const STEP_STATUSES = ['todo', 'done'];
const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'];

function nowISO() {
  return new Date().toISOString();
}

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now().toString(16)}-${crypto.randomBytes(8).toString('hex')}`;
}

function clampText(value, max) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function normalizeStatus(value) {
  return STATUSES.includes(value) ? value : 'todo';
}

function normalizeISO(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Retired date-only data is retained as a note, without inventing a time or reminder.
function preserveLegacyDate(note, dateAt) {
  const migrated = /(?:^|\n)原日期：\d{4}-\d{2}-\d{2}$/.test(String(note || ''));
  const text = clampText(note, MAX_NOTE + (migrated ? 40 : 0));
  return /^\d{4}-\d{2}-\d{2}$/.test(dateAt || '') ? text + '\n原日期：' + dateAt : text;
}

function normalizeStepStatus(value) {
  return STEP_STATUSES.includes(value) ? value : 'todo';
}

/** 清洗子任务清单：丢弃空内容条目，补 id / 状态，限制条数与长度。 */
function sanitizeSteps(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const s of value) {
    if (!s || typeof s !== 'object') continue;
    const content = clampText(s.content, MAX_STEP_CONTENT).trim();
    if (!content) continue;
    if (out.length >= MAX_STEPS) break;
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : newId(),
      content,
      status: normalizeStepStatus(s.status),
    });
  }
  return out;
}

/**
 * 导入条目适配：识别旧版 MoliTodo v3 备份格式并映射到当前任务模型。
 * v3 特征：用 content 表示标题（无 title 字段），备注 / 子任务放在 metadata 内，
 * 时间字段为 scheduledStartAt / scheduledEndAt（或 dueDate + dueTime）。
 * 本应用导出格式 / 裸 Task 数组原样返回。
 *
 * 映射：content→title，metadata.note→note，metadata.steps→steps，
 * scheduledStartAt→startAt，scheduledEndAt（缺省时 dueDate+dueTime）→dueAt，
 * completed / status→status，createdAt / updatedAt / completedAt 原样保留。
 * lists / config / tools 等清单与应用配置不导入。
 */
function adaptImportedTask(t, index = 0, baseOrder = 0) {
  if (!t || typeof t !== 'object') return t;
  if (typeof t.content !== 'string' || t.title !== undefined) return t;
  const meta = t.metadata && typeof t.metadata === 'object' ? t.metadata : {};
  const done = t.completed === true || t.status === 'done';
  const cancelled = t.status === 'cancelled';
  let dueAt = t.scheduledEndAt || null;
  if (!dueAt && typeof t.dueDate === 'string' && t.dueDate) {
    const time = /^\d{2}:\d{2}$/.test(String(t.dueTime || '')) ? t.dueTime : '09:00';
    dueAt = `${t.dueDate}T${time}:00`;
  }
  // 历史到期任务标记为已提醒，避免导入瞬间弹出一串过期通知
  const dueMs = dueAt ? new Date(dueAt).getTime() : NaN;
  const overdue = !done && !cancelled && Number.isFinite(dueMs) && dueMs < Date.now();
  return {
    id: typeof t.id === 'string' && t.id ? t.id : undefined,
    title: t.content,
    note: typeof meta.note === 'string' ? meta.note : '',
    steps: sanitizeSteps(meta.steps),
    status: cancelled ? 'cancelled' : (done ? 'done' : normalizeStatus(t.status)),
    color: typeof t.color === 'string' ? t.color : '',
    startAt: t.scheduledStartAt || null,
    dueAt,
    sortOrder: baseOrder + (index + 1) * 1000,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: done ? (t.completedAt || t.updatedAt) : null,
    cancelledAt: cancelled ? (t.cancelledAt || t.updatedAt) : null,
    cancelReason: typeof t.cancelReason === 'string' ? t.cancelReason : '',
    notifiedAt: overdue ? nowISO() : undefined,
  };
}

/** 同步小睡（仅 Node 主线程使用）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    // 退化为立即重试
  }
}

/**
 * 带有限重试的原子改名：Windows 下杀毒 / 索引服务可能短暂占用目标文件，
 * 导致 rename 抛 EPERM / EACCES / EBUSY，短暂等待后重试。
 */
function renameWithRetry(from, to, attempts = 5, delayMs = 30) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const retryable = err && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
      if (!retryable || i >= attempts - 1) throw err;
      sleepSync(delayMs * (i + 1));
    }
  }
}

/**
 * 原子写 JSON：先写临时文件再重命名（带 Windows 占用重试），
 * 供任务数据之外的轻量状态文件（如桌宠 pet.json）复用。
 */
function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameWithRetry(tmp, filePath);
}

class TaskStore {
  /**
   * @param {string} filePath 任务数据文件路径（tasks.json）
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.tasks = [];
    this.sources = [];
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.tasks)) {
        this.tasks = data.tasks.map((t) => this._sanitize(t)).filter(Boolean);
        this.sources = Array.isArray(data.sources) ? data.sources : [];
      }
    } catch (err) {
      // 文件不存在或损坏时从空数据开始，避免启动失败
      this.tasks = [];
    }
    return this.tasks;
  }

  _sanitize(t) {
    if (!t || typeof t !== 'object' || !t.title) return null;
    return {
      id: typeof t.id === 'string' && t.id ? t.id : newId(),
      title: clampText(t.title, MAX_TITLE),
      project: clampText(t.project, MAX_PROJECT).trim(),
      note: preserveLegacyDate(t.note, t.dateAt),
      status: normalizeStatus(t.status),
      color: typeof t.color === 'string' ? t.color : '',
      startAt: normalizeISO(t.startAt),
      dueAt: normalizeISO(t.dueAt),
      reminderAt: normalizeISO(t.reminderAt),
      reminderMinutes: [5,10,30].includes(t.reminderMinutes) ? t.reminderMinutes : null,
      reminderDisabled: t.reminderDisabled === true,
      seriesId: typeof t.seriesId === 'string' ? t.seriesId : null,
      sortOrder: Number.isFinite(t.sortOrder) ? t.sortOrder : 0,
      steps: sanitizeSteps(t.steps),
      createdAt: normalizeISO(t.createdAt) || nowISO(),
      updatedAt: normalizeISO(t.updatedAt) || nowISO(),
      completedAt: normalizeISO(t.completedAt),
      cancelledAt: normalizeISO(t.cancelledAt),
      cancelReason: clampText(t.cancelReason, MAX_NOTE),
      notifiedAt: normalizeISO(t.notifiedAt),
      sourceId: typeof t.sourceId === 'string' ? t.sourceId : null,
      batchId: typeof t.batchId === 'string' ? t.batchId : null,
    };
  }

  /** 原子落盘：先写临时文件再重命名，断电/崩溃不产生半截文件。 */
  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    const payload = JSON.stringify({ version: 1, savedAt: nowISO(), tasks: this.tasks, sources: this.sources }, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    renameWithRetry(tmp, this.filePath);
    return this.tasks;
  }

  list() {
    return this.tasks;
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  create(input = {}) {
    const task = this._newTask(input);
    this.tasks.push(task);
    this.save();
    return task;
  }

  /** 批量创建（一次落盘），供重复任务展开使用。 */
  createMany(inputs = []) {
    if (!Array.isArray(inputs)) throw new Error('inputs 必须是数组');
    if (inputs.length > MAX_BATCH) throw new Error(`单次最多创建 ${MAX_BATCH} 条任务`);
    const before = this.tasks.slice();
    const created = inputs.map((input, i) => ({ ...this._newTask(input), sortOrder: this.tasks.reduce((m, t) => Math.max(m, t.sortOrder), 0) + (i + 1) * 1000 }));
    this.tasks.push(...created);
    try { if (created.length) this.save(); }
    catch (error) { this.tasks = before; throw error; }
    return created;
  }

  createAIBatch(inputs, source) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50) throw new Error('请选择 1–50 个任务');
    const existing = this.sources.find(s => s.id === source.id);
    if (existing) return { batchId: existing.id, count: this.tasks.filter(t => t.batchId === existing.id).length };
    const before = this.tasks.slice();
    const record = { id: source.id, title: source.title, text: source.text, mode: source.mode, createdAt: nowISO() };
    this.sources.push(record);
    try {
      const created = inputs.map((input, i) => ({ ...this._newTask(input), sourceId: record.id, batchId: record.id,
        sortOrder: before.reduce((m, t) => Math.max(m, t.sortOrder), 0) + (i + 1) * 1000 }));
      this.tasks.push(...created);
      this.save();
      return { batchId: record.id, count: created.length };
    } catch (error) { this.tasks = before; this.sources.pop(); throw error; }
  }

  undoAIBatch(batchId) {
    const before = this.tasks;
    const sources = this.sources;
    this.tasks = before.filter(t => t.batchId !== batchId);
    this.sources = sources.filter(s => s.id !== batchId);
    try { this.save(); } catch (error) { this.tasks = before; this.sources = sources; throw error; }
    return before.length - this.tasks.length;
  }

  /** 构造一条新任务（不落盘、不入列）。 */
  _newTask(input) {
    const title = clampText(input.title, MAX_TITLE).trim();
    if (!title) throw new Error('任务标题不能为空');
    const status = normalizeStatus(input.status);
    const siblings = this.tasks.filter((t) => t.status === status);
    const maxOrder = siblings.reduce((m, t) => Math.max(m, t.sortOrder), 0);
    return {
      id: newId(),
      title,
      project: clampText(input.project, MAX_PROJECT).trim(),
      note: preserveLegacyDate(input.note, input.dateAt),
      status,
      color: typeof input.color === 'string' ? input.color : '',
      startAt: normalizeISO(input.startAt),
      dueAt: normalizeISO(input.dueAt),
      reminderAt: normalizeISO(input.reminderAt),
      reminderMinutes: [5,10,30].includes(Number(input.reminderMinutes)) ? Number(input.reminderMinutes) : (input.reminderAt ? null : 5),
      reminderDisabled: input.reminderDisabled === true,
      seriesId: input.seriesId || null,
      sortOrder: maxOrder + 1000,
      steps: sanitizeSteps(input.steps),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      completedAt: status === 'done' ? nowISO() : null,
      cancelledAt: status === 'cancelled' ? nowISO() : null,
      cancelReason: '',
      notifiedAt: null,
    };
  }

  update(id, patch = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在: ' + id);
    const previousReminderTime = reminderTime(task);
    if (patch.title !== undefined) {
      const title = clampText(patch.title, MAX_TITLE).trim();
      if (!title) throw new Error('任务标题不能为空');
      task.title = title;
    }
    if (patch.note !== undefined) task.note = preserveLegacyDate(patch.note);
    if (patch.project !== undefined) task.project = clampText(patch.project, MAX_PROJECT).trim();
    if (patch.steps !== undefined) task.steps = sanitizeSteps(patch.steps);
    if (patch.color !== undefined) task.color = String(patch.color);
    if (patch.startAt !== undefined) task.startAt = normalizeISO(patch.startAt);
    if (patch.reminderMinutes !== undefined) {
      const minutes = Number(patch.reminderMinutes);
      if (![5,10,30].includes(minutes)) throw new Error('提醒仅支持提前5、10或30分钟');
      task.reminderMinutes = minutes; task.reminderAt = null;
    }
    if (patch.reminderAt !== undefined) task.reminderAt = normalizeISO(patch.reminderAt);
    if (patch.reminderDisabled !== undefined) task.reminderDisabled = patch.reminderDisabled === true;
    if (patch.dueAt !== undefined) task.dueAt = normalizeISO(patch.dueAt);
    if (reminderTime(task) !== previousReminderTime) task.notifiedAt = null;
    if (patch.status !== undefined) {
      const status = normalizeStatus(patch.status);
      if (status !== task.status) {
        task.status = status;
        task.completedAt = status === 'done' ? nowISO() : null;
        task.cancelledAt = status === 'cancelled' ? nowISO() : null;
        // 移动到目标列末尾
        const siblings = this.tasks.filter((t) => t.status === status && t.id !== id);
        const maxOrder = siblings.reduce((m, t) => Math.max(m, t.sortOrder), 0);
        task.sortOrder = maxOrder + 1000;
      }
    }
    if (patch.cancelReason !== undefined) task.cancelReason = clampText(patch.cancelReason, MAX_NOTE);
    task.updatedAt = nowISO();
    this.save();
    return task;
  }

  updateSeries(id, patch, scope = 'one') {
    const anchor = this.get(id);
    if (!anchor) throw new Error('任务不存在');
    if (scope === 'one' || !anchor.seriesId) return this.update(id, patch);
    const original = JSON.parse(JSON.stringify(this.tasks));
    const occurrenceTime = t => new Date(t.startAt || t.dueAt).getTime();
    const selected = this.tasks.filter(t => t.seriesId === anchor.seriesId && (scope === 'all' || t.id === anchor.id || occurrenceTime(t) >= occurrenceTime(anchor)));
    const anchorTimes = { startAt: anchor.startAt, dueAt: anchor.dueAt, reminderAt: anchor.reminderAt };
    try {
      for (const task of selected) {
        const next = { ...patch };
        for (const key of ['startAt','dueAt','reminderAt']) if (patch[key] && task[key] && anchorTimes[key]) next[key] = new Date(new Date(task[key]).getTime() + new Date(patch[key]).getTime() - new Date(anchorTimes[key]).getTime()).toISOString();
        this.update(task.id, next);
      }
    } catch (error) { this.tasks = original; this.save(); throw error; }
    return selected.length;
  }
  remove(id) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const [removed] = this.tasks.splice(idx, 1);
    this.save();
    return removed;
  }

  /** 删除撤销：恢复到原来的位置。 */
  restore(task, index) {
    const t = this._sanitize(task);
    if (!t) throw new Error('无法恢复该任务');
    if (this.get(t.id)) return this.get(t.id);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, this.tasks.length)) : this.tasks.length;
    this.tasks.splice(at, 0, t);
    this.save();
    return t;
  }

  /**
   * 列内重排：按给定 id 顺序重写该列 sortOrder。
   * @param {string} status 目标列
   * @param {string[]} orderedIds 目标列内完整顺序
   */
  reorder(status, orderedIds) {
    const s = normalizeStatus(status);
    if (!Array.isArray(orderedIds)) throw new Error('orderedIds 必须是数组');
    let order = 0;
    for (const id of orderedIds) {
      const t = this.get(id);
      if (t && t.status === s) {
        order += 1000;
        t.sortOrder = order;
        t.updatedAt = nowISO();
      }
    }
    // 未包含的同列任务按原相对顺序补到末尾
    for (const t of this.tasks.filter((x) => x.status === s && !orderedIds.includes(x.id)).sort((a, b) => a.sortOrder - b.sortOrder)) {
      order += 1000;
      t.sortOrder = order;
    }
    this.save();
    return this.tasks;
  }

  /** 导出为可移植 JSON（不含内部提醒标记）。 */
  exportJSON() {
    return JSON.stringify({
      app: 'WithYou',
      version: 1,
      exportedAt: nowISO(),
      tasks: this.tasks,
      sources: this.sources,
    }, null, 2);
  }

  /**
   * 从 JSON 导入（合并追加：保留现有任务，新任务追加到末尾；id 冲突时重新生成）。
   * 支持三种来源：
   * 1. 本应用导出格式 { app, version, exportedAt, tasks: [Task, ...] }
   * 2. 裸 Task 数组
   * 3. 旧版 MoliTodo v3 备份格式（content / metadata.steps / scheduledStartAt 等，见 adaptImportedTask）
   * @returns {Array} 本次导入的任务
   */
  importJSON(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('导入失败：文件不是有效的 JSON');
    }
    const arr = Array.isArray(data) ? data : data && Array.isArray(data.tasks) ? data.tasks : null;
    if (!arr) throw new Error('导入失败：缺少 tasks 字段');
    const baseOrder = this.tasks.reduce((m, t) => Math.max(m, t.sortOrder), 0);
    const incoming = arr
      .map((t, i) => this._sanitize(adaptImportedTask(t, i, baseOrder)))
      .filter(Boolean);
    const sourceIds = new Map();
    if (!Array.isArray(data) && Array.isArray(data.sources)) {
      for (const source of data.sources) {
        if (!source || typeof source.id !== 'string' || typeof source.text !== 'string') continue;
        const nextId = newId(); sourceIds.set(source.id, nextId);
        this.sources.push({ id: nextId, title: clampText(source.title, 200), text: clampText(source.text, 30000), mode: ['meeting', 'work'].includes(source.mode) ? source.mode : 'auto', createdAt: normalizeISO(source.createdAt) || nowISO() });
      }
    }
    for (const t of incoming) {
      t.sourceId = sourceIds.get(t.sourceId) || null;
      t.batchId = sourceIds.get(t.batchId) || null;
      if (this.get(t.id)) t.id = newId();
      this.tasks.push(t);
    }
    if (incoming.length) this.save();
    return incoming;
  }

  clear() {
    this.tasks = [];
    this.sources = [];
    this.save();
  }
}

/** 本地日期键 'YYYY-MM-DD'（用于按天比较）。 */
function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 按频率偏移日期：保持本地时刻；monthly 目标月无此日号时取该月最后一天。 */
function shiftDate(base, freq, i) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), base.getMinutes(), 0, 0);
  if (freq === 'daily') {
    d.setDate(d.getDate() + i);
  } else if (freq === 'weekly') {
    d.setDate(d.getDate() + 7 * i);
  } else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  return d;
}

/**
 * 展开重复任务为逐次出现（含 until 当天）。
 * @param {{startAt?: string, dueAt?: string, freq: string, until: string}} opts
 *   freq: daily | weekly | monthly；until: 'YYYY-MM-DD'（重复截止日期）
 *   startAt / dueAt 至少填一个，作为每次任务的时间锚点（都填时保持时长）
 * @returns {Array<{startAt: string|null, dueAt: string|null}>}
 */
function expandOccurrences(opts = {}) {
  const { freq } = opts;
  if (!RECURRENCE_FREQS.includes(freq)) throw new Error('不支持的重复频率');
  const s = normalizeISO(opts.startAt);
  const d = normalizeISO(opts.dueAt);
  if (!s && !d) throw new Error('重复任务需要填写开始时间或截止时间');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(opts.until || ''));
  if (!m) throw new Error('请填写重复截止日期');
  const untilKey = `${m[1]}-${m[2]}-${m[3]}`;
  const base = new Date(s || d);
  const duration = s && d ? new Date(d).getTime() - new Date(s).getTime() : 0;

  const out = [];
  for (let i = 0; ; i++) {
    const shifted = shiftDate(base, freq, i);
    const occStart = (s ? shifted : null);
    const occDue = (s ? new Date(shifted.getTime() + duration) : shifted);
    const key = localDateKey(occStart || occDue);
    if (key > untilKey) break;
    if (out.length >= MAX_BATCH) {
      throw new Error(`超出单次上限（最多 ${MAX_BATCH} 条），请缩短重复范围`);
    }
    out.push({
      startAt: occStart ? occStart.toISOString() : null,
      dueAt: d ? occDue.toISOString() : null,
    });
  }
  if (!out.length) throw new Error('重复截止日期不能早于开始日期');
  return out;
}

function reminderTime(task) {
  if (task.reminderDisabled) return null;
  const minutes = [5, 10, 30].includes(task.reminderMinutes) ? task.reminderMinutes : null;
  if (minutes === null && task.reminderAt) return Date.parse(task.reminderAt);
  const anchor = task.startAt || task.dueAt;
  return anchor ? Date.parse(anchor) - (minutes ?? 5) * 60_000 : null;
}

/** 到期未提醒的任务（供主进程通知调度使用）。 */
function dueForReminder(tasks, now = Date.now()) {
  return tasks.filter((t) => {
    if (t.notifiedAt || t.status === 'done' || t.status === 'cancelled' || t.completedAt) return false;
    const reminder = reminderTime(t);
    return reminder !== null && reminder <= now;
  });
}

module.exports = {
  TaskStore, dueForReminder, expandOccurrences,
  STATUSES, STEP_STATUSES, RECURRENCE_FREQS,
  MAX_TITLE, MAX_NOTE, MAX_STEP_CONTENT, MAX_STEPS, MAX_BATCH,
  nowISO, newId, atomicWriteJSON,
};
