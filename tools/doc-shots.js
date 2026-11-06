'use strict';

/**
 * 文档截图脚本（不触碰用户真实数据）：
 *   npx electron tools/doc-shots.js
 * 使用 tools/doc-mock-preload.js 提供 window.withyou API（数据落在系统临时目录），
 * 加载应用真实的渲染层页面，驱动各个界面状态并截取 PNG 到 docs/images/。
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
const TMP = path.join(os.tmpdir(), 'withyou-docs-shots');
const DATA_FILE = path.join(TMP, 'tasks.json');

// 与用户真实数据（%APPDATA%\WithYou）完全隔离
app.setPath('userData', path.join(TMP, 'profile'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localDT(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function localD(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function at(dayOffset, hh, mm) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

/** 写入示例任务数据（临时目录）。 */
function seed() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const now = new Date().toISOString();
  const step = (id, content, status = 'todo') => ({ id: String(id), content, status });
  const tasks = [
    {
      id: 'demo-overdue-1', title: '回复客户关于数据导出的邮件',
      note: '客户询问 JSON 导出字段含义，以及旧版 MoliTodo 备份的兼容方案',
      status: 'todo', color: 'orange', startAt: null, dueAt: at(-1, 17, 0), sortOrder: 2000,
      steps: [], createdAt: at(-3, 9, 0), updatedAt: at(-3, 9, 0), completedAt: null, notifiedAt: at(-1, 17, 0),
    },
    {
      id: 'demo-todo-1', title: '整理周会纪要并同步到团队 Wiki',
      note: '重点记录：新版本发布时间线、缺陷跟进人、下周评审安排',
      status: 'todo', color: 'red', startAt: at(1, 16, 0), dueAt: at(1, 18, 0), sortOrder: 1000,
      steps: [
        step(1, '导出本周任务清单', 'done'),
        step(2, '整理评审结论与行动项'),
        step(3, '同步到团队 Wiki 并 @ 相关同学'),
      ],
      createdAt: at(-1, 10, 0), updatedAt: at(0, 9, 30), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-2a', title: '每日站会（15:00）',
      note: '同步进度与阻塞项，控制在 15 分钟内',
      status: 'todo', color: 'green', startAt: at(1, 15, 0), dueAt: at(1, 15, 30), sortOrder: 3000,
      steps: [], createdAt: at(-7, 9, 0), updatedAt: at(-7, 9, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-2b', title: '每日站会（15:00）',
      note: '同步进度与阻塞项，控制在 15 分钟内',
      status: 'todo', color: 'green', startAt: at(2, 15, 0), dueAt: at(2, 15, 30), sortOrder: 3500,
      steps: [], createdAt: at(-7, 9, 0), updatedAt: at(-7, 9, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-2c', title: '每日站会（15:00）',
      note: '同步进度与阻塞项，控制在 15 分钟内',
      status: 'todo', color: 'green', startAt: at(3, 15, 0), dueAt: at(3, 15, 30), sortOrder: 3750,
      steps: [], createdAt: at(-7, 9, 0), updatedAt: at(-7, 9, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-3', title: '准备 v1.1 版本发布说明',
      note: '汇总新功能、修复列表与已知问题',
      status: 'todo', color: 'amber', startAt: at(3, 9, 30), dueAt: at(3, 18, 0), sortOrder: 4000,
      steps: [], createdAt: at(-2, 14, 0), updatedAt: at(-2, 14, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-4', title: '学习 Electron 自动化测试',
      note: '调研 Playwright 驱动 Electron 的方案，跑通一个冒烟用例',
      status: 'todo', color: 'blue', startAt: null, dueAt: at(4, 20, 0), sortOrder: 5000,
      steps: [], createdAt: at(-5, 21, 0), updatedAt: at(-5, 21, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-5', title: '购买猫粮和猫砂',
      note: '', status: 'todo', color: 'gray', startAt: null, dueAt: at(6, 12, 0), sortOrder: 6000,
      steps: [], createdAt: at(-1, 20, 0), updatedAt: at(-1, 20, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-6', title: '预约下周体检',
      note: '记得带上身份证和医保卡', status: 'todo', color: '', startAt: null, dueAt: null, sortOrder: 7000,
      steps: [], createdAt: at(0, 8, 0), updatedAt: at(0, 8, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-todo-7', title: '月度复盘会议',
      note: '回顾本月目标完成度，输出改进清单',
      status: 'todo', color: 'purple', startAt: at(8, 16, 0), dueAt: at(8, 17, 30), sortOrder: 8000,
      steps: [], createdAt: at(-2, 11, 0), updatedAt: at(-2, 11, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-doing-1', title: '撰写 携手 WithYou 使用说明文档',
      note: '包含界面截图、功能讲解与常见问题',
      status: 'doing', color: 'amber', startAt: at(0, 14, 0), dueAt: at(1, 20, 0), sortOrder: 1000,
      steps: [
        step(1, '梳理功能清单', 'done'),
        step(2, '截取界面截图', 'done'),
        step(3, '编写功能讲解'),
        step(4, '整理常见问题'),
      ],
      createdAt: at(-2, 10, 0), updatedAt: at(0, 14, 5), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-doing-2', title: '重构任务导入兼容逻辑',
      note: '兼容旧版 MoliTodo v3 备份格式（content / metadata.note / metadata.steps）',
      status: 'doing', color: 'purple', startAt: at(-1, 10, 0), dueAt: at(2, 18, 0), sortOrder: 2000,
      steps: [], createdAt: at(-4, 15, 0), updatedAt: at(-1, 10, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-doing-3', title: '设计桌面宠物新动作',
      note: '庆祝、打瞌睡、伸懒腰', status: 'doing', color: 'pink', startAt: null,
      dueAt: at(9, 18, 0), sortOrder: 3000,
      steps: [], createdAt: at(-3, 19, 0), updatedAt: at(-3, 19, 0), completedAt: null, notifiedAt: null,
    },
    {
      id: 'demo-done-1', title: '晨间阅读 30 分钟',
      note: '', status: 'done', color: 'green', startAt: null, dueAt: at(0, 8, 0), sortOrder: 1000,
      steps: [], createdAt: at(-1, 22, 0), updatedAt: at(0, 8, 30), completedAt: at(0, 8, 30), notifiedAt: null,
    },
    {
      id: 'demo-done-2', title: '整理桌面与下载文件夹',
      note: '', status: 'done', color: 'gray', startAt: null, dueAt: at(-1, 20, 0), sortOrder: 2000,
      steps: [], createdAt: at(-2, 18, 0), updatedAt: at(-1, 20, 10), completedAt: at(-1, 20, 10), notifiedAt: null,
    },
    {
      id: 'demo-done-3', title: '缴纳本月房租',
      note: '', status: 'done', color: 'blue', startAt: null, dueAt: at(-2, 12, 0), sortOrder: 3000,
      steps: [], createdAt: at(-3, 9, 0), updatedAt: at(-2, 12, 20), completedAt: at(-2, 12, 20), notifiedAt: null,
    },
    {
      id: 'demo-done-4', title: '参加需求评审会',
      note: '确认 v1.1 范围与验收标准', status: 'done', color: 'blue', startAt: at(-20, 14, 0),
      dueAt: at(-20, 15, 30), sortOrder: 4000,
      steps: [], createdAt: at(-21, 9, 0), updatedAt: at(-20, 15, 30), completedAt: at(-20, 15, 30), notifiedAt: null,
    },
    {
      id: 'demo-done-5', title: '编写 v1.0 安装文档',
      note: '', status: 'done', color: 'purple', startAt: null, dueAt: at(-15, 18, 0), sortOrder: 5000,
      steps: [], createdAt: at(-17, 10, 0), updatedAt: at(-15, 18, 20), completedAt: at(-15, 18, 20), notifiedAt: null,
    },
    {
      id: 'demo-done-6', title: '修复数据导入 Bug',
      note: '旧版备份的子任务映射错误', status: 'done', color: 'red', startAt: null,
      dueAt: at(-10, 17, 0), sortOrder: 6000,
      steps: [], createdAt: at(-11, 9, 0), updatedAt: at(-10, 19, 0), completedAt: at(-10, 19, 0), notifiedAt: null,
    },
    {
      id: 'demo-done-7', title: '团队建设活动',
      note: '', status: 'done', color: 'pink', startAt: at(-6, 9, 0), dueAt: at(-6, 18, 0), sortOrder: 7000,
      steps: [], createdAt: at(-8, 9, 0), updatedAt: at(-6, 18, 10), completedAt: at(-6, 18, 10), notifiedAt: null,
    },
    {
      id: 'demo-done-8', title: '整理本月账单',
      note: '', status: 'done', color: 'gray', startAt: null, dueAt: at(-3, 20, 0), sortOrder: 8000,
      steps: [], createdAt: at(-4, 20, 0), updatedAt: at(-3, 20, 30), completedAt: at(-3, 20, 30), notifiedAt: null,
    },
  ];
  fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, savedAt: now, tasks }, null, 2), 'utf8');
  console.log('[seed]', tasks.length, 'tasks ->', DATA_FILE);
}

function createWindow(opts) {
  const win = new BrowserWindow({
    show: true,
    autoHideMenuBar: true,
    alwaysOnTop: true, // 防止被遮挡导致合成器停止出画（不影响窗口内截图内容）
    webPreferences: {
      preload: path.join(__dirname, 'doc-mock-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
    ...opts,
  });
  win.webContents.on('console-message', (e, _level, message) => {
    console.log('[renderer]', message || (e && e.message) || '');
  });
  return win;
}

async function shot(win, name) {
  // 等待两帧确保合成器已出画
  await evl(win, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`).catch(() => {});
  for (let i = 0; i < 12; i++) {
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
      console.log('[shot]', name, JSON.stringify(size));
      return;
    }
    console.log('[shot-retry]', name, i, 'visible=' + win.isVisible(), JSON.stringify(win.getBounds()));
    await sleep(500);
  }
  throw new Error('截图为空: ' + name);
}

const evl = (win, code) => win.webContents.executeJavaScript(code, true);

async function waitFor(win, expr, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evl(win, expr)) return true;
    } catch (err) { /* 页面尚未就绪 */ }
    await sleep(150);
  }
  throw new Error('waitFor 超时: ' + expr);
}

app.whenReady().then(async () => {
  try {
    seed();

    // ---------- 主窗口 ----------
    const win = createWindow({
      width: 1180, height: 760, x: 60, y: 40, backgroundColor: '#f4f5f7',
    });
    win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await waitFor(win, `document.querySelectorAll('#list-all .card').length >= 18`);
    await sleep(600);
    await shot(win, '01-overview.png');

    // 快速新建（顶部输入框）
    await evl(win, `(() => {
      document.getElementById('btn-add-task').click();
      const input = document.getElementById('add-title');
      input.value = '周五前提交季度总结';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    })()`);
    await sleep(350);
    await shot(win, '02-quick-add.png');

    // 完整添加任务（表单 + 重复任务预览）
    await evl(win, `(() => {
      document.getElementById('btn-add-task').click();
      const setVal = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pad = (n) => String(n).padStart(2, '0');
      const fmtDT = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      const fmtD = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const base = new Date();
      base.setDate(base.getDate() + ((8 - base.getDay()) % 7 || 7));
      base.setHours(14, 0, 0, 0);
      const end = new Date(base); end.setHours(15, 30, 0, 0);
      const until = new Date(base); until.setDate(until.getDate() + 50);
      setVal(document.getElementById('add-title'), '产品迭代评审会');
      setVal(document.getElementById('add-note'), '评审新版本功能清单，确认发布时间与灰度策略');
      setVal(document.getElementById('add-start'), fmtDT(base));
      setVal(document.getElementById('add-end'), fmtDT(end));
      const repeat = document.getElementById('add-repeat');
      repeat.value = 'weekly';
      repeat.dispatchEvent(new Event('change', { bubbles: true }));
      setVal(document.getElementById('add-until'), fmtD(until));
      document.querySelectorAll('#add-priority .priority-chip')[1].click();
    })()`);
    await waitFor(win, `!document.getElementById('add-preview').hidden
      && /将创建/.test(document.getElementById('add-preview').textContent)`);
    await sleep(350);
    await shot(win, '03-add-task.png');

    // 双击卡片就地编辑
    await evl(win, `(() => {
      document.getElementById('btn-cancel-add').click();
      const t = document.querySelector('#list-all .card[data-status="todo"] .card-title');
      t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    })()`);
    await waitFor(win, `!!document.querySelector('.edit-form')`);
    await sleep(350);
    await shot(win, '04-edit-card.png');
    await evl(win, `document.querySelector('.edit-actions .subtle-btn').click();`);

    // 已完成标签：同一列表只显示已完成任务
    await evl(win, `document.querySelector('#status-filters [data-filter="done"]').click();`);
    await waitFor(win, `document.querySelectorAll('#list-all .card[data-status="done"]').length > 0`);
    await sleep(350);
    await shot(win, '05-done-expanded.png');

    // 删除 + 撤销 Toast
    await evl(win, `(() => {
      document.querySelector('#status-filters [data-filter="all"]').click();
      document.querySelector('#list-all .card[data-status="doing"] .card-menu-btn').click();
    })()`);
    await waitFor(win, `!document.getElementById('undo-toast').hidden`);
    await sleep(260);
    await shot(win, '06-undo-toast.png');
    await evl(win, `document.getElementById('btn-undo').click();`);
    await sleep(300);

    // 日历视图
    await evl(win, `document.querySelector('#view-switch .view-btn[data-view="calendar"]').click();`);
    await waitFor(win, `!document.getElementById('view-calendar').hidden
      && document.querySelectorAll('#cal-grid .cal-cell').length > 20`);
    await sleep(450);
    await shot(win, '07-calendar.png');

    // 搜索 + 筛选
    await evl(win, `(() => {
      document.querySelector('#view-switch .view-btn[data-view="board"]').click();
      const s = document.getElementById('search-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '会');
      s.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#due-filters [data-due="week"]').click();
    })()`);
    await sleep(400);
    await shot(win, '08-search-filter.png');

    // 设置面板
    await evl(win, `document.getElementById('btn-settings').click();`);
    await waitFor(win, `!document.getElementById('settings-mask').hidden`);
    await sleep(350);
    await shot(win, '09-settings.png');
    await evl(win, `document.getElementById('btn-close-settings').click();`);

    // ---------- 速记小窗 ----------
    const quick = createWindow({
      width: 460, height: 170, x: 420, y: 220,
      frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      backgroundColor: '#ffffff',
    });
    quick.loadFile(path.join(ROOT, 'src', 'renderer', 'quick.html'));
    await waitFor(quick, `!!document.getElementById('title-input')`);
    await sleep(300);
    await evl(quick, `(() => {
      const el = document.getElementById('title-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        .call(el, '明天下午三点和小王过一下方案');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    })()`);
    await sleep(350);
    await shot(quick, '10-quick-window.png');

    // ---------- 桌面宠物 ----------
    const pet = createWindow({
      width: 240, height: 270, x: 560, y: 300,
      frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    });
    pet.loadFile(path.join(ROOT, 'src', 'renderer', 'pet.html'));
    await waitFor(pet, `const i = document.getElementById('pet-img'); !!i && i.complete && i.naturalWidth > 0`);
    await sleep(700);
    await evl(pet, `document.getElementById('pet-wrap')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(430);
    await shot(pet, '11-pet.png');
    await sleep(200);

    console.log('[done] all screenshots saved to', OUT_DIR);
    app.exit(0);
  } catch (err) {
    console.error('[error]', err);
    app.exit(1);
  }
});
