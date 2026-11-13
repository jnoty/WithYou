'use strict';

/**
 * 携手 WithYou 主进程
 * - 主窗口 / 速记小窗 / 系统托盘
 * - 全局热键（Ctrl+Alt+N）唤起速记小窗
 * - 到期任务系统通知
 * - 任务数据 IPC（增删改查、排序、导入导出）
 * - 窗口置顶 / 透明度 / 开机自启 等设置
 * - 桌面宠物：透明置顶小窗、拖拽贴边吸附、任务联动、轻养成状态
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, dialog, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { createPetReminder } = require('./src/pet-reminder');
const { createPetDock } = require('./src/pet-dock');
const { TaskStore, dueForReminder, expandOccurrences, nowISO, atomicWriteJSON } = require('./src/store');
const { ProjectResourceStore } = require('./src/project-resources');
const { AIService } = require('./src/ai-service');
const { locateResource } = require('./src/resource-navigation');
const { canAccessAI } = require('./src/ai-access');
const {
  defaultPetState, sanitizePetState, applyInteraction, decayMood, pickMood, pickMessage,
  snapToEdge, clampToWorkArea, countOverdue, countDueSoon,
} = require('./src/pet-behavior');

const { translate } = require('./src/i18n');
let uiLanguage = 'zh-CN';
const tr = (message, ...values) => translate(uiLanguage, message, ...values);

/** 项目资料的“位置”既可能是 URL，也可能是本机路径。 */
function isRemoteLocation(value) {
  return /^(https?|mailto|svn):/i.test(String(value || '').trim());
}
function localLocation(value) {
  const target = String(value || '').trim();
  if (/^file:\/\//i.test(target)) {
    try { return require('url').fileURLToPath(target); } catch (_) { /* 回退为普通路径 */ }
  }
  return path.resolve(target);
}

const ICON = path.join(__dirname, 'assets', 'icon.png');

// 数据目录固定使用英文名，避免随 productName（中文名）或历史改名漂移：
// MoliTODO → 咱俩的小事 → 携手 WithYou → WithYou，每次改名 app.getPath('userData')
// 都会跟着换目录，用户会突然“丢”掉全部任务。
const DATA_DIR_NAME = 'WithYou';
// 历史版本留下的数据目录，按新到旧排列；仅在新目录还没有 tasks.json 时整体接管。
const LEGACY_DATA_DIR_NAMES = ['携手 WithYou', '咱俩的小事', 'MoliTODO', 'moli-todo', 'smalllist'];
const DATA_FILES = ['tasks.json', 'settings.json', 'pet.json'];

/**
 * 一次性迁移：当前数据目录还没有 tasks.json、而某个历史目录有时，
 * 把 tasks.json / settings.json / pet.json 复制过来（只补缺失文件，不覆盖）。
 * 失败只记日志，绝不阻塞启动。
 */
function adoptLegacyData(appDataRoot, userDataDir) {
  try {
    if (fs.existsSync(path.join(userDataDir, 'tasks.json'))) return;
    for (const name of LEGACY_DATA_DIR_NAMES) {
      const legacyDir = path.join(appDataRoot, name);
      if (!fs.existsSync(path.join(legacyDir, 'tasks.json'))) continue;
      fs.mkdirSync(userDataDir, { recursive: true });
      for (const file of DATA_FILES) {
        const from = path.join(legacyDir, file);
        const to = path.join(userDataDir, file);
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
      }
      console.log(`[withyou] 已从历史数据目录「${name}」接续数据 → ${userDataDir}`);
      return;
    }
  } catch (err) {
    console.error('[withyou] 历史数据迁移失败（已忽略）:', err && err.message);
  }
}

// 在申请单实例锁之前固定数据目录：锁文件也落在同一个目录里，改名不会让两个实例并存。
const appDataRoot = process.env.APPDATA || app.getPath('appData');
const userDataDir = path.join(appDataRoot, DATA_DIR_NAME);
app.setPath('userData', userDataDir);
adoptLegacyData(appDataRoot, userDataDir);

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  main();
}

function main() {
  /** @type {BrowserWindow | null} */
  let mainWindow = null;
  /** @type {BrowserWindow | null} */
  let quickWindow = null;
  /** @type {BrowserWindow | null} */
  let petWindow = null;
  let petClipsWindow = null;
  /** @type {Tray | null} */
  let tray = null;
  let rebuildTrayMenu = () => {};
  let quitting = false;

  let store = null;
  let projectResources = null;
  let aiService = null;
  let pendingAIPreview = null;
  let settings = null;
  /** @type {object} 桌宠养成状态（mood/exp/level/时间戳），由主进程统一维护 */
  let petState = defaultPetState();
  let petSaveTimer = null;
  let petDragOffset = null;
  let petDragTimer = null;
  let appliedPetSettingsKey = null;
  let lastOverdueCount = 0;
  const petReminder = createPetReminder({
    getWindow: () => petWindow,
    getWorkArea: (pos, size) => screen.getDisplayNearestPoint({
      x: Math.round(pos.x + size.width / 2), y: Math.round(pos.y + size.height / 2),
    }).workArea,
    send: (channel, payload) => {
      sendPet(channel, payload);
      if (channel === 'pet:motion' && payload.phase === 'idle') petDock.resume();
    },
  });
  const petDock = createPetDock({
    getWindow: () => petWindow,
    getWorkArea: (b) => screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }).workArea,
    getCursor: () => screen.getCursorScreenPoint(),
    send: (channel, payload) => sendPet(channel, payload),
  });

  const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
  const tasksPath = () => path.join(app.getPath('userData'), 'tasks.json');
  const petStatePath = () => path.join(app.getPath('userData'), 'pet.json');

  function loadSettings() {
    const defaults = {
      language: 'zh-CN',
      alwaysOnTop: false,
      opacity: 1,
      roundedCorners: true,
      autostart: false,
      hotkey: 'CommandOrControl+Alt+N',
      petEnabled: true,
      petScale: 1,
      petBubbles: true,
      petSnapToEdge: true,
      petCenterAnimation: true,
      notifySystem: true,
      petPos: null,
      // 默认 4 级优先级 + 无色；旧版 9 级配置读取时原样保留，不强制迁移。
      colorPriorities: [
        { color: 'red', name: '紧急' },
        { color: 'orange', name: '高' },
        { color: 'blue', name: '普通' },
        { color: 'gray', name: '低' },
        { color: 'none', name: '无' },
      ],
    };
    try {
      const raw = fs.readFileSync(settingsPath(), 'utf8');
      const merged = { ...defaults, ...JSON.parse(raw) };
      merged.language = merged.language === 'en' ? 'en' : 'zh-CN';
      // 旧版 8 级配置（缺 none 级）整体升级为当前默认映射
      const cp = merged.colorPriorities;
      if (!Array.isArray(cp) || !cp.some((p) => p && p.color === 'none')) {
        merged.colorPriorities = defaults.colorPriorities;
      }
      return merged;
    } catch (err) {
      return { ...defaults };
    }
  }

  function saveSettings() {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
      console.error(tr('保存设置失败:'), err);
    }
  }

  function applySettings() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(Boolean(settings.alwaysOnTop), 'screen-saver');
      const opacity = Math.min(1, Math.max(0.5, Number(settings.opacity) || 1));
      mainWindow.setOpacity(opacity);
    }
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.autostart),
      ...(app.isPackaged ? {} : {
        // 开发模式下随 electron 启动本项目
        path: process.execPath,
        args: [path.resolve(__dirname)],
      }),
    });
    if (quickWindow && !quickWindow.isDestroyed()) {
      quickWindow.setAlwaysOnTop(true, 'screen-saver');
    }
    applyPetSettings();
  }

  function broadcastTasks() {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('tasks:changed', store.list());
    }
  }

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 1024,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#eaf3e5', symbolColor: '#234c3a', height: 40 },
      backgroundColor: '#f7faf3',
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      applySettings();
    });
    // 关闭时最小化到托盘（托盘菜单「退出」才真正结束进程）
    mainWindow.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function createQuickWindow() {
    const display = screen.getPrimaryDisplay();
    const width = 460;
    const height = 270;
    quickWindow = new BrowserWindow({
      width,
      height,
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: Math.round(display.workArea.y + 120),
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#ffffff',
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    quickWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'quick.html'));
    quickWindow.on('blur', () => {
      if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
    });
    quickWindow.on('closed', () => {
      quickWindow = null;
    });
  }

  function showQuickCapture() {
    if (!quickWindow || quickWindow.isDestroyed()) createQuickWindow();
    quickWindow.show();
    quickWindow.focus();
    quickWindow.webContents.send('quick:focus');
  }

  function createTray() {
    if (!fs.existsSync(ICON)) return;
    tray = new Tray(nativeImage.createFromPath(ICON));
    tray.setToolTip(tr('携手 — 轻量任务看板'));
    const rebuildMenu = () => {
      tray.setToolTip(tr('携手 — 轻量任务看板'));
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: tr('打开主窗口'), click: showMainWindow },
        { label: tr('快速新建任务'), click: showQuickCapture },
        { type: 'separator' },
        { label: tr`开机自启 ${settings.autostart ? '✓' : ''}`, click: () => {
          settings.autostart = !settings.autostart;
          saveSettings();
          applySettings();
          rebuildMenu();
        } },
        { type: 'separator' },
        { label: settings.petEnabled === false ? tr('显示桌宠') : tr('隐藏桌宠'), click: () => {
          settings.petEnabled = settings.petEnabled === false;
          saveSettings();
          applySettings();
          rebuildMenu();
        } },
        { type: 'separator' },
        { label: tr('退出'), click: () => { quitting = true; app.quit(); } },
      ]));
    };
    rebuildTrayMenu = rebuildMenu;
    rebuildMenu();
    tray.on('double-click', showMainWindow);
  }

  function notifyDueTasks() {
    const due = dueForReminder(store.list());
    for (const task of due) {
      if (settings.notifySystem !== false) {
        const n = new Notification({
          title: tr('任务提醒'),
          body: task.title,
          icon: fs.existsSync(ICON) ? ICON : undefined,
        });
        n.on('click', showMainWindow);
        n.show();
      }
      task.notifiedAt = nowISO();
    }
    if (due.length) {
      store.save();
      emitPetEvent('due', { title: due.length === 1 ? due[0].title : tr`${due[0].title} 等 ${due.length} 项任务` });
    }
  }

  // ---------- 桌面宠物 ----------
  function loadPetState() {
    try {
      return sanitizePetState(JSON.parse(fs.readFileSync(petStatePath(), 'utf8')));
    } catch (err) {
      return defaultPetState();
    }
  }

  /** 防抖落盘（≥1s 一次），避免高频交互抖盘。 */
  function requestSavePetState() {
    if (petSaveTimer) return;
    petSaveTimer = setTimeout(() => {
      petSaveTimer = null;
      flushPetSave();
    }, 1000);
  }

  function flushPetSave() {
    if (petSaveTimer) {
      clearTimeout(petSaveTimer);
      petSaveTimer = null;
    }
    try {
      atomicWriteJSON(petStatePath(), { version: 1, savedAt: nowISO(), ...petState });
    } catch (err) {
      console.error(tr('保存桌宠状态失败:'), err);
    }
  }

  function petScaleValue() {
    return Math.min(1.5, Math.max(0.8, Number(settings.petScale) || 1));
  }

  function petWindowSize() {
    const scale = petScaleValue();
    return { width: Math.round(160 * scale), height: Math.round(180 * scale) };
  }

  function petMoodType() {
    const overdue = store ? countOverdue(store.list()) : 0;
    return pickMood(petState, overdue);
  }

  function sendPet(channel, payload) {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send(channel, payload);
    }
  }

  /** 计算桌宠落点：优先 hint / 记忆位置，钳回最近显示器工作区；无记忆时停靠主屏右下角。 */
  function resolvePetPos(size, hint) {
    const pos = hint && Number.isFinite(hint.x) && Number.isFinite(hint.y)
      ? hint
      : (settings.petPos && Number.isFinite(settings.petPos.x) && Number.isFinite(settings.petPos.y)
        ? settings.petPos
        : null);
    if (!pos) {
      const wa = screen.getPrimaryDisplay().workArea;
      return { x: wa.x + wa.width - size.width - 24, y: wa.y + wa.height - size.height - 24 };
    }
    const display = screen.getDisplayNearestPoint({
      x: Math.round(pos.x + size.width / 2),
      y: Math.round(pos.y + size.height / 2),
    });
    return clampToWorkArea(pos, size, display.workArea);
  }

  function createPetWindow() {
    if (petWindow && !petWindow.isDestroyed()) return;
    const size = petWindowSize();
    const pos = resolvePetPos(size, null);
    petWindow = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: pos.x,
      y: pos.y,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      focusable: false,
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    // 透明留白不拦截桌面；渲染层按当前动作的 alpha 轮廓开启交互。
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    petWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'pet.html'));
    petWindow.once('ready-to-show', () => {
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.showInactive();
        petWindow.setAlwaysOnTop(true, 'screen-saver');
        if (settings.petSnapToEdge !== false) petDock.dock();
      }
    });
    petWindow.on('closed', () => {
      petReminder.cancel(false);
      petDock.cancel();
      stopPetDrag();
      petWindow = null;
    });
  }

  function applyPetSettings() {
    const key = JSON.stringify([settings.petEnabled !== false, petScaleValue(),
      settings.petSnapToEdge !== false, settings.petBubbles !== false]);
    // Saving language, AI or task preferences must not restart docking/reminder motion.
    if (key === appliedPetSettingsKey && petWindow && !petWindow.isDestroyed()) return;
    appliedPetSettingsKey = key;
    const wasDocked = petDock.isDocked();
    petReminder.cancel();
    petDock.cancel(true);
    if (settings.petEnabled === false) {
      if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
      petWindow = null;
      return;
    }
    if (!petWindow || petWindow.isDestroyed()) {
      createPetWindow();
      return;
    }
    // 调整大小时保持当前位置（钳回可见区）
    const size = petWindowSize();
    const b = petWindow.getBounds();
    const pos = resolvePetPos(size, { x: b.x, y: b.y });
    petWindow.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    // 窗口尺寸与渲染比例必须同时更新，避免只改变透明画布、猫仍保持旧尺寸。
    sendPet('pet:stats', { scale: petScaleValue(), bubbles: settings.petBubbles !== false });
    if (wasDocked && settings.petSnapToEdge !== false) petDock.dock(true);
  }

  function startPetDrag() {
    if (!petWindow || petWindow.isDestroyed() || petDragTimer) return;
    petReminder.cancel(false);
    petDock.cancel();
    const b = petWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    petDragOffset = { dx: cursor.x - b.x, dy: cursor.y - b.y };
    petDragTimer = setInterval(() => {
      if (!petDragOffset || !petWindow || petWindow.isDestroyed()) {
        stopPetDrag();
        return;
      }
      const p = screen.getCursorScreenPoint();
      const cur = petWindow.getBounds();
      const nx = p.x - petDragOffset.dx;
      const ny = p.y - petDragOffset.dy;
      if (nx !== cur.x || ny !== cur.y) petWindow.setPosition(nx, ny, false);
    }, 30);
  }

  function stopPetDrag() {
    if (petDragTimer) {
      clearInterval(petDragTimer);
      petDragTimer = null;
    }
    petDragOffset = null;
  }

  /** 拖动结束：贴边吸附（可关）+ 钳位 + 持久化位置。 */
  function endPetDrag() {
    if (petWindow && !petWindow.isDestroyed()) {
      const b = petWindow.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2),
      });
      const size = { width: b.width, height: b.height };
      const settled = settings.petSnapToEdge === false
        ? clampToWorkArea({ x: b.x, y: b.y }, size, display.workArea)
        : snapToEdge({ x: b.x, y: b.y }, size, display.workArea);
      if (settled.x !== b.x || settled.y !== b.y) {
        petWindow.setPosition(settled.x, settled.y, false);
      }
      const home = settings.petSnapToEdge !== false ? petDock.dock() : null;
      settings.petPos = home || { x: settled.x, y: settled.y };
      saveSettings();
    }
    stopPetDrag();
  }

  function showPetMenu() {
    if (!petWindow || petWindow.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      { label: tr('打开主窗口'), click: showMainWindow },
      { label: tr('快速新建任务'), click: showQuickCapture },
      { label: tr('喂食'), click: () => sendPet('pet:command', 'feed') },
      { type: 'separator' },
      { label: tr('打开设置'), click: () => {
        showMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:open-settings');
        }
      } },
      { label: tr('隐藏桌宠'), click: () => {
        settings.petEnabled = false;
        saveSettings();
        applySettings();
      } },
    ]);
    // 非焦点窗口（focusable:false）弹出菜单的兼容处理：弹出期间临时允许聚焦，关闭后恢复
    try {
      petWindow.setFocusable(true);
    } catch (err) { /* 忽略 */ }
    menu.once('menu-will-close', () => {
      if (petWindow && !petWindow.isDestroyed()) petWindow.setFocusable(false);
    });
    menu.popup({ window: petWindow });
  }

  /** 任务联动事件：气泡文案 + 心情由主进程统一计算后下发。 */
  function emitPetEvent(type, task) {
    if (!petWindow || petWindow.isDestroyed()) return;
    const extra = {};
    if (type === 'done') {
      const r = applyInteraction(petState, 'task-done', Date.now());
      petState = r.state;
      requestSavePetState();
      extra.levelUp = r.levelUp;
    }
    const payload = {
      type,
      title: task && task.title ? String(task.title) : '',
      message: tr(pickMessage(type)),
      moodType: petMoodType(),
      state: petState,
      ...extra,
    };
    if (type === 'due' && settings.petCenterAnimation !== false && !petDragTimer) {
      petDock.suspend();
      if (petReminder.start(payload)) return;
      petDock.resume();
    }
    sendPet('pet:event', payload);
  }

  /** 每分钟：mood 衰减 + 逾期/临期统计推送（逾期增多时补发提醒事件）。 */
  function updatePetStats() {
    if (!petWindow || petWindow.isDestroyed()) return;
    const now = Date.now();
    const tasks = store.list();
    const before = petState.mood;
    petState = decayMood(petState, now);
    if (petState.mood !== before) requestSavePetState();
    const overdueCount = countOverdue(tasks, now);
    const dueSoonCount = countDueSoon(tasks, now);
    if (overdueCount > lastOverdueCount) {
      const first = tasks.find((t) => t.dueAt && t.status !== 'done' && t.status !== 'cancelled' && !t.completedAt
        && new Date(t.dueAt).getTime() < now);
      sendPet('pet:event', {
        type: 'overdue',
        title: first ? String(first.title) : '',
        message: tr(pickMessage('overdue')),
        moodType: petMoodType(),
      });
    }
    lastOverdueCount = overdueCount;
    sendPet('pet:stats', {
      scale: petScaleValue(),
      overdueCount,
      dueSoonCount,
      moodType: petMoodType(),
      bubbles: settings.petBubbles !== false,
      state: petState,
    });
  }

  // ---------- IPC ----------
  function setupIpc() {
    const aiHandle = (name, handler) => ipcMain.handle('ai:' + name, async (event, input) => {
      if (!canAccessAI(event, name, mainWindow, quickWindow)) return { ok: false, error: '无权访问 AI 服务' };
      try { return { ok: true, data: await handler(input) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    aiHandle('test-connection', () => aiService.testConnection());
    aiHandle('drafts', () => aiService.listDrafts());
    aiHandle('edit-draft', input => aiService.editDraft(input));
    aiHandle('config', () => aiService.getConfig());
    aiHandle('set-default', input => aiService.setDefault(input || {}));
    aiHandle('delete-provider', id => aiService.deleteProvider(id));
    aiHandle('list-models', input => aiService.listModels(input || {}));
    aiHandle('save-config', input => aiService.saveConfig(input || {}));
    aiHandle('analyze', input => aiService.analyzeDefault(input || {}));
    aiHandle('cancel', () => aiService.cancel());
    aiHandle('preview', input => {
      const source = aiService.drafts.get(input?.id);
      if (!source?.result) throw new Error('草稿已失效，请重新整理');
      if (pendingAIPreview) throw new Error('请先处理上一份任务预览');
      pendingAIPreview = { text: source.text, draft: source.result, providerId: source.providerId, model: source.model, referenceDate: source.referenceDate };
      showMainWindow();
      if (!mainWindow.webContents.isLoading()) mainWindow.webContents.send('ai:preview-ready');
      quickWindow?.hide();
      return true;
    });
    aiHandle('take-preview', () => { const result = pendingAIPreview; pendingAIPreview = null; return result; });
    aiHandle('commit', input => { const result = aiService.commit(input || {}); broadcastTasks(); return result; });
    aiHandle('undo', id => { const count = store.undoAIBatch(id); broadcastTasks(); return count; });
    aiHandle('sources', () => store.sources.map(({ id, title, mode, createdAt }) => ({ id, title, mode, createdAt })));
    aiHandle('source', id => store.sources.find(s => s.id === id) || null);
    ipcMain.handle('tasks:update-series', (_e, input) => { const r = store.updateSeries(input.id, input.patch, input.scope); broadcastTasks(); return r; });
    ipcMain.handle('tasks:list', () => store.list());
    ipcMain.handle('tasks:create', (_e, input) => {
      const t = store.create(input || {});
      broadcastTasks();
      emitPetEvent('created', t);
      return t;
    });
    ipcMain.handle('tasks:update', (_e, id, patch) => {
      // update 会原地修改任务对象，须在更新前保存状态值。
      const previousStatus = store.get(id)?.status;
      const t = store.update(id, patch || {});
      broadcastTasks();
      if (previousStatus && previousStatus !== 'done' && t.status === 'done') {
        emitPetEvent('done', t);
      }
      return t;
    });
    ipcMain.handle('tasks:delete', (_e, id) => {
      const removed = store.remove(id);
      broadcastTasks();
      return removed;
    });
    ipcMain.handle('tasks:restore', (_e, task, index) => {
      const t = store.restore(task, index);
      broadcastTasks();
      return t;
    });
    ipcMain.handle('tasks:reorder', (_e, status, orderedIds) => {
      store.reorder(status, orderedIds);
      broadcastTasks();
      return true;
    });
    ipcMain.handle('tasks:plan-recurring', (_e, input) => {
      // 重复任务展开预览：返回条数与起止，不落盘
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
    });
    ipcMain.handle('tasks:create-recurring', (_e, input) => {
      // 重复任务批量创建：展开为独立任务，一次落盘
      try {
        const plan = expandOccurrences(input || {});
        const base = input || {};
        const seriesId = require('crypto').randomUUID();
        // 重复任务按第一次的时间锚点平移提醒时间；没有锚点时保持原值。
        const anchor = (base.startAt || base.dueAt);
        const reminderOffset = base.reminderAt && anchor
          ? new Date(base.reminderAt).getTime() - new Date(anchor).getTime() : null;
        const created = store.createMany(plan.map((occ) => ({
          seriesId, title: base.title, project: base.project,
          note: base.note,
          status: 'todo',
          color: typeof base.color === 'string' ? base.color : '',
          startAt: occ.startAt,
          dueAt: occ.dueAt,
          reminderMinutes: Number(base.reminderMinutes) || 5,
          reminderAt: reminderOffset == null ? null
            : new Date(new Date((occ.startAt || occ.dueAt)).getTime() + reminderOffset).toISOString(),
        })));
        broadcastTasks();
        emitPetEvent('created', { title: tr`重复任务 ×${created.length}` });
        return { ok: true, count: created.length };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
    ipcMain.handle('tasks:export', async (_e, options = {}) => {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: tr('导出任务数据'),
        defaultPath: tr`WithYou-备份-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      const data = JSON.parse(store.exportJSON());
      if (options.full) { data.resources = projectResources.list(); data.settings = settings; data.backupType = 'full'; data.modelConnections = aiService.getConfig().providers; }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, filePath };
    });
    ipcMain.handle('tasks:import', async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: tr('导入任务数据'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (canceled || !filePaths.length) return { ok: false, canceled: true };
      try {
        const text = fs.readFileSync(filePaths[0], 'utf8');
        const data = JSON.parse(text);
        const count = Array.isArray(data) ? data.length : data.tasks?.length || 0;
        const decision = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['取消', '合并导入'], defaultId: 0, cancelId: 0,
          message: `将合并 ${count} 个任务、${data.resources?.length || 0} 项资料。已有任务保留；重复资料会跳过，重复导入任务会增加副本。`, detail: '导入前会自动保存本机恢复副本。模型密钥不导入，配置须在新设备重新填写。' });
        if (decision.response !== 1) return { ok: false, canceled: true };
        const recovery = { tasks: JSON.parse(store.exportJSON()), resources: projectResources.list(), settings };
        atomicWriteJSON(path.join(app.getPath('userData'), 'before-import.json'), recovery);
        const tasks = store.importJSON(text);
        let resourceCounts = { imported: 0, duplicates: 0, invalid: 0 };
        try {
          if (Array.isArray(data.resources)) resourceCounts = projectResources.importItems(data.resources);
        } catch (error) {
          broadcastTasks();
          throw new Error(`任务已导入 ${tasks.length} 条，但项目资料保存失败；资料未修改。请勿重复导入任务，可使用 before-import.json 恢复副本。原因：${error.message}`);
        }
        if (data.backupType === 'full' && data.settings) {
          const previousLanguage = settings.language;
          // 只恢复与机器无关的非敏感偏好；位置、热键等本机配置保留。
          for (const key of ['language','theme','textSize','reducedMotion','roundedCorners','colorPriorities',
            'petEnabled','petScale','petBubbles','petSnapToEdge','petCenterAnimation','notifySystem',
            'alwaysOnTop','opacity','autostart']) {
            if (Object.hasOwn(data.settings, key)) settings[key] = data.settings[key];
          }
          settings.language = settings.language === 'en' ? 'en' : 'zh-CN';
          uiLanguage = settings.language;
          saveSettings(); applySettings();
          if (settings.language !== previousLanguage) {
            rebuildTrayMenu();
            rebuildAppMenu();
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('app:language-changed', settings.language);
            }
          }
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('app:settings-changed', settings);
          }
        }
        broadcastTasks();
        return { ok: true, count: tasks.length, resources: resourceCounts };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });
    ipcMain.handle('project-resources:list', () => projectResources.list());
    ipcMain.handle('project-resources:check', async () => {
      const result = {};
      const checkLocation = async (location) => {
        if (isRemoteLocation(location)) return { kind: 'url', exists: true };
        try {
          const stat = await fs.promises.stat(localLocation(location));
          return { kind: stat.isDirectory() ? 'directory' : 'file', exists: true };
        } catch (_) {
          return { kind: 'missing', exists: false };
        }
      };
      await Promise.all(projectResources.list().map(async (item) => {
        const locations = item.location.split('\n');
        const checks = await Promise.all(locations.map(checkLocation));
        result[item.id] = locations.length === 1 ? checks[0]
          : { kind: 'multiple', exists: checks.every(check => check.exists) };
      }));
      return result;
    });
    ipcMain.handle('project-resources:save', (_e, input) => {
      try { return { ok: true, item: projectResources.upsert(input) }; }
      catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('project-resources:delete', (_e, id) => {
      try {
        const removed = projectResources.delete(id);
        return removed ? { ok: true } : { ok: false, error: tr('资料不存在') };
      } catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('project-resources:choose-path', async (_e, current) => {
      const options = { properties: ['openFile', 'openDirectory'] };
      current = String(current || '').split(/\r\n?|\n/, 1)[0].trim();
      if (current && !isRemoteLocation(current)) {
        const target = localLocation(current);
        if (fs.existsSync(target)) options.defaultPath = target;
      }
      const r = await dialog.showOpenDialog(mainWindow, options);
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    });
    ipcMain.handle('project-resources:open', async (_e, location) => {
      const target = String(location || '').trim();
      try {
        if (isRemoteLocation(target)) await shell.openExternal(target);
        else {
          const error = await shell.openPath(localLocation(target));
          if (error) return { ok: false, error };
        }
        return { ok: true };
      } catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('project-resources:reveal', async (_e, location) => {
      const target = String(location || '').trim();
      if (!target || isRemoteLocation(target)) return { ok: false, error: tr('链接不能定位到文件夹') };
      try { await locateResource(localLocation(target), shell); return { ok: true }; }
      catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('settings:get', () => settings);
    ipcMain.handle('settings:set', (_e, patch) => {
      const previousLanguage = settings.language;
      settings = { ...settings, ...(patch || {}) };
      settings.language = settings.language === 'en' ? 'en' : 'zh-CN';
      uiLanguage = settings.language;
      saveSettings();
      applySettings();
      if (settings.language !== previousLanguage) {
        rebuildTrayMenu();
        rebuildAppMenu();
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('app:language-changed', settings.language);
        }
      }
      return settings;
    });
    // ---- 桌宠 ----
    ipcMain.handle('pet:load', () => ({
      state: petState,
      moodType: petMoodType(),
      scale: petScaleValue(),
      bubbles: settings.petBubbles !== false,
    }));
    ipcMain.handle('pet:interact', (_e, action) => {
      const r = applyInteraction(petState, action, Date.now());
      petState = r.state;
      requestSavePetState();
      const message = r.accepted
        ? (r.levelUp ? tr(pickMessage('levelup')) : tr(pickMessage(action === 'feed' ? 'feed' : 'pat')))
        : (action === 'feed' ? tr(pickMessage('feed-cooldown')) : '');
      return { ...r, message, moodType: petMoodType() };
    });
    ipcMain.handle('pet:message', (_e, event) => ({
      message: tr(pickMessage(typeof event === 'string' ? event : '')),
      moodType: petMoodType(),
    }));
    ipcMain.on('pet:drag-start', () => startPetDrag());
    ipcMain.on('pet:hit-test', (event, interactive) => {
      if (petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents) {
        petWindow.setIgnoreMouseEvents(!interactive, { forward: true });
        petDock.hover(interactive);
      }
    });
    ipcMain.handle('pet:preview-reminder', () => {
      if (!petWindow || petWindow.isDestroyed()) return { ok: false, error: tr('请先开启桌宠') };
      if (settings.petCenterAnimation === false) return { ok: false, error: tr('请先开启居中提醒动画') };
      emitPetEvent('due', { title: tr('会议即将开始（动画预览）') });
      return { ok: true };
    });
    ipcMain.handle('pet:preview-clips', () => {
      if (petClipsWindow && !petClipsWindow.isDestroyed()) {
        petClipsWindow.show(); petClipsWindow.focus(); return;
      }
      petClipsWindow = new BrowserWindow({ width: 1100, height: 820, autoHideMenuBar: true,
        icon: fs.existsSync(ICON) ? ICON : undefined,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
      petClipsWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'pet-animation-preview.html'));
      petClipsWindow.on('closed', () => { petClipsWindow = null; });
    });
    ipcMain.on('pet:drag-end', () => endPetDrag());
    ipcMain.on('pet:context-menu', () => showPetMenu());
    ipcMain.handle('app:quick-capture', showQuickCapture);
    ipcMain.handle('app:hide-quick', () => {
      if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
    });
  }

  // ---------- 生命周期 ----------
  // 精简中文菜单（含开发者工具，便于排查问题）
  function rebuildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: tr('视图'),
      submenu: [
        { label: tr('重载'), role: 'reload' },
        { label: tr('开发者工具'), role: 'toggleDevTools' },
        { type: 'separator' },
        { label: tr('实际大小'), role: 'resetZoom' },
        { label: tr('放大'), role: 'zoomIn' },
        { label: tr('缩小'), role: 'zoomOut' },
      ],
    },
  ]));
  }

  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    settings = loadSettings();
    uiLanguage = settings.language === 'en' ? 'en' : 'zh-CN';
    rebuildAppMenu();
    store = new TaskStore(tasksPath());
    aiService = new AIService({ filePath: path.join(app.getPath('userData'), 'ai-config.json'), safeStorage: require('electron').safeStorage, store, fetchImpl: (url, options) => require('electron').net.fetch(url, options) });
    projectResources = new ProjectResourceStore(path.join(app.getPath('userData'), 'project-resources.json'));
    petState = loadPetState();
    setupIpc();
    createMainWindow();
    createTray();
    applySettings();

    try {
      globalShortcut.register(settings.hotkey, showQuickCapture);
    } catch (err) {
      console.error(tr('注册全局热键失败:'), err);
    }

    // 到期提醒轮询（≤1s 级落盘由数据层保证；提醒每 15s 检查一次）
    setInterval(notifyDueTasks, 15000);
    setTimeout(notifyDueTasks, 3000);

    // 桌宠心情衰减 / 逾期统计（每分钟）
    setInterval(updatePetStats, 60000);
    setTimeout(updatePetStats, 5000);

    let petDisplayTimer = null;
    const recoverPetDisplay = () => {
      clearTimeout(petDisplayTimer);
      petDisplayTimer = setTimeout(() => {
        if (!petWindow || petWindow.isDestroyed()) return;
        stopPetDrag();
        petReminder.cancel();
        petDock.cancel();
        const size = petWindowSize();
        const bounds = petWindow.getBounds();
        const pos = resolvePetPos(size, bounds);
        petWindow.setBounds({ ...pos, ...size });
        petWindow.showInactive();
        petWindow.setAlwaysOnTop(true, 'screen-saver');
        if (settings.petSnapToEdge !== false) petDock.dock();
      }, 200);
    };
    screen.on('display-removed', recoverPetDisplay);
    screen.on('display-added', recoverPetDisplay);
    screen.on('display-metrics-changed', (_event, _display, metrics) => {
      if (metrics.some(metric => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(metric))) recoverPetDisplay();
    });

    app.on('activate', showMainWindow);
  });

  app.on('before-quit', () => {
    quitting = true;
    petReminder.cancel();
    petDock.cancel();
    globalShortcut.unregisterAll();
    flushPetSave();
  });

  app.on('window-all-closed', () => {
    // 常驻托盘：不因窗口关闭而退出（Windows 行为）
  });
}
