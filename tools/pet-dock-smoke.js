'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createPetDock } = require('../src/pet-dock');
const { createPetReminder } = require('../src/pet-reminder');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-pet-dock-'));
app.setPath('userData', path.join(temp, 'profile'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let dock, reminder;
  try {
    const area = screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({ x: area.x + area.width - 160, y: area.y + 200,
      width: 160, height: 180, show: false, frame: false, transparent: true, focusable: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), backgroundThrottling: false,
        contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    let cursor = { x: area.x - 100, y: area.y - 100 };
    dock = createPetDock({ getWindow: () => win, getWorkArea: () => area, getCursor: () => cursor,
      send: (channel, payload) => win.webContents.send(channel, payload) });
    reminder = createPetReminder({ getWindow: () => win, getWorkArea: () => area,
      send: (channel, payload) => {
        win.webContents.send(channel, payload);
        if (channel === 'pet:motion' && payload.phase === 'idle') dock.resume();
      } });
    ipcMain.handle('settings:get', () => ({ language: 'zh-CN' }));
    ipcMain.handle('pet:load', () => ({ state: { mood: 80, level: 1 }, moodType: 'happy', bubbles: true, scale: 1 }));
    ipcMain.on('pet:hit-test', (_event, interactive) => {
      win.setIgnoreMouseEvents(!interactive, { forward: true }); dock.hover(interactive);
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'pet.html'));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript('typeof petState !== "undefined" && petState !== null')) break;
      await delay(50);
    }
    win.showInactive();
    const run = (code) => win.webContents.executeJavaScript(code);
    const phase = () => run('document.querySelector("#stage").dataset.dock');
    await delay(150);
    dock.dock();
    await delay(100); assert.equal(await phase(), 'hide');
    await delay(650); assert.equal(await phase(), 'peek');
    assert.equal(await run('getComputedStyle(document.querySelector("#hud")).visibility'), 'hidden');
    assert.equal(await run('getComputedStyle(document.querySelector(".pet-sprite")).backgroundImage.includes("pet-peek-strip.png")'), true);
    fs.writeFileSync(path.join(temp, 'peek.png'), (await win.webContents.capturePage()).toPNG());
    // Idle longer than the emerge clip: switching clips must restart from frame one.
    await delay(2200);
    // Hover an opaque pixel of the visible head through the actual renderer alpha hit test.
    cursor = { x: win.getBounds().x + 80, y: win.getBounds().y + 155 };
    await run(`(() => { const r = document.querySelector('#pet-wrap').getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.bottom - 22;
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, screenX: screenX + x, screenY: screenY + y })); })()`);
    await delay(60); assert.equal(await phase(), 'emerge');
    const firstEmergeFrame = await run('getComputedStyle(document.querySelector(".pet-sprite")).backgroundPositionX');
    assert.notEqual(firstEmergeFrame, '100%', '长时间探头后，跑出动画必须从前面的帧开始');
    await delay(150);
    assert.notEqual(await run('getComputedStyle(document.querySelector(".pet-sprite")).backgroundPositionX'), firstEmergeFrame, '跑出动画应实际逐帧推进');
    await delay(670); assert.equal(await phase(), 'sit');
    assert.equal(await run('getComputedStyle(document.querySelector("#pet-img")).visibility'), 'visible');
    fs.writeFileSync(path.join(temp, 'sitting.png'), (await win.webContents.capturePage()).toPNG());
    cursor = { x: area.x - 100, y: area.y - 100 };
    await run('document.dispatchEvent(new MouseEvent("mouseleave"))');
    await delay(1950); assert.equal(await phase(), 'peek');
    dock.suspend(); reminder.start({ type: 'due', title: '会议提醒', message: '时间到啦', moodType: 'happy' });
    await delay(3200); assert.equal(await phase(), 'sit');
    dock.cancel(true); await delay(30);
    assert.equal(await phase(), 'idle');
    assert.deepEqual(errors, []);
    console.log('PASS: hide clip, head-only idle, alpha hover runs out and sits, pointer leave re-hides, reminder restores dock, cancel expands.');
    console.log('Artifacts: ' + temp);
    app.exit(0);
  } catch (error) {
    if (reminder) reminder.cancel(); if (dock) dock.cancel();
    console.error(error); console.error('Artifacts: ' + temp); app.exit(1);
  }
});
