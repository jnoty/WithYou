'use strict';

/**
 * 文档截图专用 mock 预加载脚本：
 * 在不触碰用户真实数据（%APPDATA%\WithYou）的前提下，
 * 用临时目录中的数据为渲染层提供与 preload.js 完全一致的 window.withyou API，
 * 从而截取真实界面（HTML/CSS/JS 均为应用原文件）。
 */

const os = require('os');
const path = require('path');
const { contextBridge } = require('electron');
const {
  TaskStore, expandOccurrences,
} = require(path.join(__dirname, '..', 'src', 'store.js'));

const DATA_FILE = process.env.SMALLLIST_UI_DATA || path.join(os.tmpdir(), 'withyou-docs-shots', 'tasks.json');
const store = new TaskStore(DATA_FILE);

const settings = {
  alwaysOnTop: false,
  opacity: 1,
  roundedCorners: true,
  autostart: false,
  hotkey: 'CommandOrControl+Alt+N',
  petEnabled: true,
  petScale: 1.5,
  petBubbles: true,
  petSnapToEdge: true,
  petCenterAnimation: true,
  notifySystem: true,
  petPos: { x: 100, y: 100 },
  colorPriorities: [
    { color: 'red', name: '紧急' },
    { color: 'orange', name: '高' },
    { color: 'amber', name: '中' },
    { color: 'green', name: '低' },
    { color: 'blue', name: '普通' },
    { color: 'purple', name: '' },
    { color: 'pink', name: '' },
    { color: 'gray', name: '' },
  ],
};

const petState = {
  level: 3,
  exp: 235,
  mood: 92,
  fedAt: Date.now() - 60 * 60 * 1000,
  lastInteractAt: Date.now(),
  lastPatAt: Date.now(),
  lastDecayAt: Date.now(),
};

const noop = () => {};
const off = () => {};
// 与真实 preload（ipcRenderer.invoke）保持一致：所有数据接口都返回 Promise
const P = (fn) => (...args) => {
  try {
    return Promise.resolve(fn(...args));
  } catch (err) {
    return Promise.reject(err);
  }
};

const resources = [];
let resourceSeq = 0;
const resourceKey = item => `${item.project || ''}\u0000${item.location || ''}`.trim().toLowerCase();
contextBridge.exposeInMainWorld('withyou', {
  projectResources: {
    list: P(() => resources.map(item => ({ ...item }))),
    check: P(() => Object.fromEntries(resources.map(item => [item.id, { kind: 'directory', exists: true }]))),
    save: P(async (input) => {
      if (process.env.WITHYOU_TEST_RESOURCE_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.WITHYOU_TEST_RESOURCE_DELAY)));
      const now = new Date().toISOString();
      const existing = input.id ? resources.find(item => item.id === input.id) : null;
      const item = { id: existing?.id || `resource-${++resourceSeq}`, project: String(input.project || '').trim(),
        name: String(input.name || '').trim(), location: String(input.location || '').trim(),
        note: String(input.note || '').trim(), createdAt: existing?.createdAt || now, updatedAt: now };
      if (!item.project || !item.name || !item.location) return { ok: false, error: '项目、名称和路径不能为空' };
      if (resources.some(other => other.id !== item.id && resourceKey(other) === resourceKey(item))) return { ok: false, error: '同一项目下已存在相同的路径或链接' };
      if (existing) resources[resources.indexOf(existing)] = item; else resources.push(item);
      return { ok: true, item: { ...item } };
    }),
    delete: P((id) => {
      const index = resources.findIndex(item => item.id === id);
      if (index < 0) return { ok: false };
      resources.splice(index, 1);
      return { ok: true };
    }),
    open: P(() => ({ ok: true })),
    reveal: P(() => ({ ok: true })),
    choosePath: P(() => 'C:\\mock\\relocated'),
  },
  tasks: {
    list: P(() => store.list()),
    create: P((input) => store.create(input)),
    update: P((id, patch) => store.update(id, patch)),
    delete: P((id) => store.remove(id)),
    restore: P((task, index) => store.restore(task, index)),
    reorder: P((status, orderedIds) => store.reorder(status, orderedIds)),
    planRecurring: P((input) => {
      try {
        const plan = expandOccurrences(input || {});
        const first = plan[0];
        const last = plan[plan.length - 1];
        return {
          ok: true,
          count: plan.length,
          firstAt: first.startAt || first.dueAt,
          lastAt: last.startAt || last.dueAt,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }),
    createRecurring: P((input) => {
      try {
        const plan = expandOccurrences(input || {});
        const base = input || {};
        const anchor = (base.startAt || base.dueAt);
        const reminderOffset = base.reminderAt && anchor
          ? new Date(base.reminderAt).getTime() - new Date(anchor).getTime() : null;
        const created = store.createMany(plan.map((occ) => ({
          title: base.title,
          project: base.project,
          note: base.note,
          status: 'todo',
          color: typeof base.color === 'string' ? base.color : '',
          startAt: occ.startAt,
          dueAt: occ.dueAt,
          reminderMinutes: Number(base.reminderMinutes) || 5,
          reminderAt: reminderOffset == null ? null
            : new Date(new Date((occ.startAt || occ.dueAt)).getTime() + reminderOffset).toISOString(),
        })));
        return { ok: true, count: created.length };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }),
    export: P(() => ({ ok: true, filePath: 'WithYou-备份-demo.json' })),
    import: P(() => ({ ok: true, count: 0 })),
    onChanged: () => off,
  },
  settings: {
    get: P(() => ({ ...settings })),
    set: P((patch) => {
      Object.assign(settings, patch || {});
      return { ...settings };
    }),
  },
  app: {
    quickCapture: P(() => true),
    hideQuick: P(() => true),
    onQuickFocus: () => off,
    onOpenSettings: () => off,
    onSettingsChanged: () => off,
    onLanguageChanged: () => off,
  },
  pet: {
    onDock: () => off,
    setInteractive: noop,
    previewClips: P(() => undefined),
    previewReminder: P(() => ({ ok: true })),
    onMotion: () => off,
    load: P(() => ({
      scale: 1.5,
      bubbles: true,
      snapToEdge: true,
      moodType: 'happy',
      state: { ...petState },
    })),
    interact: P((action) => {
      const r = {
        accepted: true,
        levelUp: false,
        moodType: 'happy',
        state: { ...petState, mood: Math.min(100, petState.mood + 3), lastInteractAt: Date.now() },
      };
      if (action === 'feed') {
        r.message = '小鱼干真好吃，喵～';
        r.state.mood = 100;
      } else {
        r.message = '好舒服，再摸摸嘛～';
      }
      return r;
    }),
    message: P(() => ({ message: '今天也要加油鸭！' })),
    dragStart: noop,
    dragEnd: noop,
    contextMenu: noop,
    onEvent: () => off,
    onStats: () => off,
    onCommand: () => off,
  },
});
