'use strict';

// node node_modules/electron/cli.js tools/pet-reminder-smoke.js
// 真实透明窗口 / preload / 渲染层 / 移动控制器，独立临时数据，无系统设置变更。
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createPetReminder } = require('../src/pet-reminder');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-pet-motion-'));
app.setPath('userData', path.join(temp, 'profile'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let reminder;
  try {
    const area = screen.getPrimaryDisplay().workArea;
    const origin = { x: area.x + area.width - 200, y: area.y + area.height - 220 };
    const win = new BrowserWindow({ ...origin, width: 160, height: 180, show: false,
      frame: false, transparent: true, focusable: false, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    let baseScale = 1;
    let interactive = null;
    ipcMain.on('pet:hit-test', (_event, value) => {
      interactive = value;
      win.setIgnoreMouseEvents(!value, { forward: true });
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    ipcMain.handle('settings:get', () => ({ language: 'zh-CN' }));
    ipcMain.handle('pet:load', () => ({ state: { mood: 80, level: 1 }, moodType: 'happy', bubbles: true, scale: baseScale }));
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'pet.html'));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript('typeof petState !== "undefined" && petState !== null')) break;
      await delay(50);
    }
    win.showInactive();
    const run = (code) => win.webContents.executeJavaScript(code);
    await delay(100);
    const checkScale = async (scale) => {
      await delay(40);
      const measured = await run('(() => { const r = document.querySelector("#stage").getBoundingClientRect(); return { width: r.width, height: r.height }; })()');
      assert.ok(Math.abs(measured.width - 160 * scale) < 1, '猫的实时宽度与设置一致: ' + JSON.stringify(measured));
      assert.ok(Math.abs(measured.height - 180 * scale) < 1, '猫的实时高度与设置一致');
      await run(`(() => {
        const r = document.querySelector('#pet-img').getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, screenX: screenX + x, screenY: screenY + y }));
      })()`);
      await delay(20);
      assert.equal(interactive, true, '猫身体可以交互');
      await run(`(() => {
        const r = document.querySelector('#pet-wrap').getBoundingClientRect();
        const x = r.left + 1, y = r.top + 1;
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, screenX: screenX + x, screenY: screenY + y }));
      })()`);
      await delay(20);
      assert.equal(interactive, false, '猫周围的透明留白点穿到桌面');
    };
    const resizePet = async (scale) => {
      baseScale = scale;
      const width = Math.round(160 * scale), height = Math.round(180 * scale);
      win.setBounds({ x: Math.min(origin.x, area.x + area.width - width),
        y: Math.min(origin.y, area.y + area.height - height), width, height });
      win.webContents.send('pet:stats', { scale, bubbles: true });
      await checkScale(scale);
    };
    // Exercise real preload notifications and rendered dimensions at both slider limits.
    for (const scale of [0.8, 1, 1.5, 0.8, 1.5]) await resizePet(scale);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'pet.html'));
    await checkScale(1.5);
    const phases = [];
    let returnCheck;
    reminder = createPetReminder({ getWindow: () => win, getWorkArea: () => area,
      send: (channel, payload) => {
        if (channel === 'pet:motion') phases.push(payload.phase);
        win.webContents.send(channel, payload);
        if (channel === 'pet:motion' && payload.phase === 'return') {
          returnCheck = run('(async () => { const sprite = document.querySelector(".pet-sprite"); await new Promise(r => setTimeout(r, 60)); const first = getComputedStyle(sprite).backgroundPositionX; await new Promise(r => setTimeout(r, 130)); return document.querySelector("#pet").classList.contains("anim-leap") && getComputedStyle(sprite).backgroundImage.includes("pet-jump-strip.png") && getComputedStyle(sprite).backgroundPositionX !== first; })()');
        }
      } });
    const initial = win.getBounds();
    const started = Date.now();
    reminder.start({ type: 'due', title: '项目评审会议', message: '会议时间到啦，准备出发！', moodType: 'happy' });
    await delay(200);
    assert.equal(await run('document.querySelector("#pet").classList.contains("anim-running")'), true);
    assert.equal(await run('getComputedStyle(document.querySelector(".pet-sprite")).backgroundImage.includes("pet-run-strip.png")'), true);
    assert.equal(await run('getComputedStyle(document.querySelector("#pet-img")).visibility'), 'hidden');
    await delay(600);
    const center = win.getBounds();
    assert.equal(center.width, Math.round(initial.width * 1.5));
    assert.equal(center.height, Math.round(initial.height * 1.5));
    assert.ok(Math.abs(center.x - (area.x + (area.width - center.width) / 2)) <= 1);
    assert.ok(Math.abs(center.y - (area.y + (area.height - center.height) / 2)) <= 1);
    assert.equal(await run('document.querySelector("#bubble").hidden'), false);
    assert.ok(await run('document.querySelector("#bubble").textContent.includes("项目评审会议")'));
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(250);
    const size = await run('(() => { const stage = document.querySelector("#stage"); const rect = stage.getBoundingClientRect(); return { width: rect.width, height: rect.height, motion: stage.dataset.motion, style: stage.getAttribute("style"), transform: getComputedStyle(stage).transform }; })()');
    assert.ok(Math.abs(size.width - initial.width * 1.5) < 1, '中央在设置的大小上放大 1.5 倍: ' + JSON.stringify(size));
    fs.writeFileSync(path.join(temp, 'center.png'), (await win.webContents.capturePage()).toPNG());
    await delay(Math.max(20, 3150 - (Date.now() - started)));
    assert.deepEqual(phases, ['outbound', 'center', 'return', 'idle']);
    assert.equal(await returnCheck, true, '返程实际使用跳跃动画');
    assert.equal(reminder.isActive(), false);
    assert.deepEqual(win.getBounds(), initial);
    assert.equal(await run('document.querySelector("#bubble").hidden'), true);
    await checkScale(1.5);
    // Changing the setting during a reminder cancels the trip and applies the new base scale.
    reminder.start({ type: 'due', title: '调整大小回归' });
    await delay(750);
    reminder.cancel();
    await resizePet(0.8);
    assert.equal(reminder.isActive(), false);
    assert.equal(await run('document.querySelector("#stage").style.getPropertyValue("--reminder-scale")'), '1');
    assert.deepEqual(errors, []);
    console.log('PASS: live 80/100/150% sizes, reload, scaled reminder, original size restored and resizing during a reminder.');
    console.log('Artifacts: ' + temp);
    app.exit(0);
  } catch (error) {
    if (reminder) reminder.cancel();
    console.error(error);
    console.error('Artifacts: ' + temp);
    app.exit(1);
  }
});
