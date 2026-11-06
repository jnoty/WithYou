'use strict';

/** 运行真实主进程 IPC / 数据层 / 桌宠行为层；仅替换 Electron 外壳，数据使用临时目录。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { defaultPetState } = require('../src/pet-behavior');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-task-pet-'));
const dataDir = path.join(temp, 'WithYou');
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'pet.json'), JSON.stringify({ ...defaultPetState(), mood: 50, exp: 95 }));

const handlers = new Map();
const listeners = new Map();
const windows = [];
class TestWindow extends EventEmitter {
  constructor(options) {
    super();
    this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
    this.messages = [];
    this.webContents = {
      send: (channel, payload) => this.messages.push({ channel, payload: structuredClone(payload) }),
    };
    windows.push(this);
  }
  loadFile(file) { this.file = file; }
  isDestroyed() { return false; }
  showInactive() {}
  setAlwaysOnTop() {}
  setOpacity() {}
  setIgnoreMouseEvents() {}
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
  static getAllWindows() { return windows; }
}
const trays = [];
class TestTray extends EventEmitter {
  constructor() { super(); trays.push(this); }
  setToolTip(text) { this.tooltip = text; }
  setContextMenu(menu) { this.menu = menu; }
}
let ready;
const paths = { appData: temp };
const app = Object.assign(new EventEmitter(), {
  getPath: (key) => paths[key],
  setPath: (key, value) => { paths[key] = value; },
  requestSingleInstanceLock: () => true,
  whenReady: () => ({ then: (fn) => { ready = fn; } }),
  setLoginItemSettings() {},
});
const electron = {
  app,
  BrowserWindow: TestWindow,
  Tray: TestTray,
  Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, handler) => listeners.set(channel, handler) },
  globalShortcut: { register: () => true, unregisterAll() {} },
  nativeImage: { createFromPath: (file) => file },
  screen: Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: -100, y: -100 }),
  }),
};
const displayTimers = [];
const mainRequire = createRequire(mainPath);
vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
  require: (name) => name === 'electron' ? electron : mainRequire(name),
  __dirname: root,
  process: { env: { APPDATA: temp }, execPath: process.execPath },
  console,
  // 定时器不自动执行，避免测试依赖时间和轮询；退出事件仍会正常落盘。
  setTimeout: (fn, ms) => { if (ms === 200) displayTimers.push(fn); return 1; },
  setInterval: () => 1,
  clearTimeout() {},
  clearInterval() {},
}, { filename: mainPath });
ready();

const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
const pet = windows.find((win) => path.basename(win.file) === 'pet.html');
assert.ok(pet, '桌宠窗口已创建');
const doneEvents = () => pet.messages.filter(({ channel, payload }) => channel === 'pet:event' && payload.type === 'done');
const petState = () => invoke('pet:load').state;
let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('任务与桌宠联动测试:');
const task = invoke('tasks:create', { title: '待办任务' });
ok('待办完成：发送一次反馈，增加心情 / 经验并同步升级状态', () => {
  pet.messages.length = 0;
  const updated = invoke('tasks:update', task.id, { title: '刚完成的任务', status: 'done' });
  const events = doneEvents();
  assert.equal(updated.status, 'done');
  assert.ok(updated.completedAt);
  assert.equal(events.length, 1);
  const payload = events[0].payload;
  assert.equal(payload.title, '刚完成的任务');
  assert.ok(payload.message);
  assert.equal(payload.levelUp, true);
  assert.equal(payload.state.mood, 60);
  assert.equal(payload.state.exp, 115);
  assert.equal(payload.state.level, 2);
  assert.deepEqual(payload.state, petState());
});

ok('编辑已完成任务 / 重复设置已完成：不重复反馈或奖励', () => {
  const before = structuredClone(petState());
  pet.messages.length = 0;
  invoke('tasks:update', task.id, { title: '编辑已完成任务', note: '只修改内容' });
  invoke('tasks:update', task.id, { status: 'done' });
  assert.equal(doneEvents().length, 0);
  assert.deepEqual(petState(), before);
});

ok('恢复待办和编辑待办：不触发完成反馈；再次完成时反馈一次', () => {
  const before = structuredClone(petState());
  pet.messages.length = 0;
  invoke('tasks:update', task.id, { status: 'todo' });
  invoke('tasks:update', task.id, { note: '继续处理' });
  assert.equal(doneEvents().length, 0);
  assert.deepEqual(petState(), before);
  invoke('tasks:update', task.id, { status: 'done' });
  assert.equal(doneEvents().length, 1);
  assert.equal(petState().exp, before.exp + 20);
});

ok('进行中 / 已取消切换到完成：各触发一次反馈', () => {
  for (const status of ['doing', 'cancelled']) {
    const item = invoke('tasks:create', { title: status, status });
    const beforeExp = petState().exp;
    pet.messages.length = 0;
    invoke('tasks:update', item.id, { status: 'done' });
    assert.equal(doneEvents().length, 1, status);
    assert.equal(petState().exp, beforeExp + 20, status);
    assert.equal(doneEvents()[0].payload.state.exp, petState().exp);
  }
});

ok('更新失败：不触发反馈或奖励', () => {
  const before = structuredClone(petState());
  pet.messages.length = 0;
  assert.throws(() => invoke('tasks:update', 'missing-task', { status: 'done' }), /任务不存在/);
  assert.equal(doneEvents().length, 0);
  assert.deepEqual(petState(), before);
});

ok('宠物大小设置：窗口、实时渲染消息和持久化比例一致', () => {
  for (const scale of [0.8, 1.5, 1]) {
    invoke('settings:set', { petScale: scale });
    assert.equal(pet.getBounds().width, Math.round(160 * scale));
    assert.equal(pet.getBounds().height, Math.round(180 * scale));
    assert.equal(pet.messages.at(-1).channel, 'pet:stats');
    assert.equal(pet.messages.at(-1).payload.scale, scale);
    assert.equal(invoke('pet:load').scale, scale);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(saved.petScale, scale);
  }
});

ok('主进程贴边躲藏：保存桌角位置，关闭开关后展开并停止躲藏', () => {
  pet.setBounds({ x: 1760, y: 300, width: 160, height: 180 });
  listeners.get('pet:drag-end')({ sender: pet.webContents });
  assert.ok(pet.messages.some(({ channel, payload }) => channel === 'pet:dock' && payload.phase === 'hide'));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.petPos, { x: 1760, y: 900 });
  const before = pet.getBounds();
  const dockEvents = pet.messages.filter(message => message.channel === 'pet:dock').length;
  invoke('settings:set', { language: 'en' });
  assert.deepEqual(pet.getBounds(), before, '保存无关设置不应移动桌宠');
  assert.equal(pet.messages.filter(message => message.channel === 'pet:dock').length, dockEvents);
  invoke('settings:set', { language: 'zh-CN' });
  invoke('settings:set', { petSnapToEdge: false });
  assert.equal(pet.getBounds().x, 1712);
  assert.equal(pet.getBounds().y, 882);
  assert.equal(pet.getBounds().width, 160);
  assert.equal(pet.messages.filter(({ channel }) => channel === 'pet:dock').at(-1).payload.phase, 'idle');
});

ok('显示器断开 / 分辨率变化：把离屏宠物恢复到可见工作区', () => {
  for (const event of ['display-removed', 'display-added', 'display-metrics-changed']) {
    pet.setBounds({ x: 3000, y: -800, width: 160, height: 180 });
    electron.screen.emit(event, {}, {}, ['bounds']);
    assert.equal(displayTimers.length, 1);
    displayTimers.shift()();
    assert.equal(pet.getBounds().x, 1760);
    assert.equal(pet.getBounds().y, 0);
  }
  electron.screen.emit('display-metrics-changed', {}, {}, ['colorSpace']);
  assert.equal(displayTimers.length, 0, '不相关的屏幕属性变化不移动桌宠');
});

ok('语言设置保存并通知全部窗口，桌宠提示使用所选语言', () => {
  assert.equal(trays[0].tooltip, '携手 — 轻量任务看板');
  const titles = invoke('tasks:list').map(task => task.title);
  invoke('settings:set', { language: 'en' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).language, 'en');
  for (const win of windows) assert.ok(win.messages.some(message => message.channel === 'app:language-changed' && message.payload === 'en'));
  assert.equal(trays[0].tooltip, 'WithYou — Desktop tasks');
  assert.equal(trays[0].menu[0].label, 'Open main window');
  const message = invoke('pet:message', 'idle-chat').message;
  assert.ok(message && !/[\u3400-\u9fff]/.test(message));
  assert.deepEqual(invoke('tasks:list').map(task => task.title), titles);
  invoke('settings:set', { language: 'zh-CN' });
  assert.ok(/[\u3400-\u9fff]/.test(invoke('pet:message', 'idle-chat').message));
});

ok('退出时保存完成奖励后的桌宠状态', () => {
  app.emit('before-quit');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8'));
  assert.equal(saved.mood, petState().mood);
  assert.equal(saved.exp, petState().exp);
  assert.equal(saved.level, petState().level);
});

console.log(`\n任务与桌宠联动: ${passed} 项全部通过`);
