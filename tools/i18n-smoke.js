'use strict';
// Real preload and renderer, isolated persisted settings and task data.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../src/store');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-language-'));
app.setPath('userData', path.join(temp, 'profile'));
const settingsPath = path.join(temp, 'settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({ language: 'zh-CN', colorPriorities: [{ color: 'red', name: '紧急' }, {color: 'blue', name: '我的分类'}] }));
const store = new TaskStore(path.join(temp, 'tasks.json'));
store.create({title: '用户任务标题', note: '保留用户原文', color: 'blue'});
store.create({title: 'Review notes', color: 'red', steps: [{content: '用户子任务', status: 'todo'}]});
ipcMain.handle('settings:get', () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
ipcMain.handle('settings:set', (_event, patch) => {
  const settings = {...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), ...patch};
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  if (patch.language) for (const win of BrowserWindow.getAllWindows()) win.webContents.send('app:language-changed', patch.language);
  return settings;
});
ipcMain.handle('tasks:list', () => store.list());
ipcMain.handle('tasks:create', (_event, input) => store.create(input));
ipcMain.handle('project-resources:list', () => []);
ipcMain.handle('project-resources:check', () => ({}));
ipcMain.handle('ai:take-preview', () => null);
ipcMain.handle('ai:config', () => ({ model: '', providerId: '', providers: [] }));
const errors = [];
const run = (win, script) => win.webContents.executeJavaScript(script, true);
async function waitFor(win, script) {
  for (let i = 0; i < 100; i++) {
    if (await run(win, script)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + script);
}
async function shot(win, name) {
  win.show();
  await run(win, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await new Promise(resolve => setTimeout(resolve, 180));
  const image = await win.webContents.capturePage();
  assert.ok(!image.isEmpty(), 'Screenshot must contain pixels: ' + name);
  fs.writeFileSync(path.join(temp, name + '.png'), image.toPNG());
}
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({width: 1180, height: 760, show: true, titleBarStyle: 'hidden', titleBarOverlay: {color:'#eaf3e5',symbolColor:'#234c3a',height:40}, webPreferences: {preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    await waitFor(win, `document.querySelectorAll('.card').length === 2`);
    assert.equal(await run(win, `document.querySelector('[data-brand]').textContent`), '携手');
    await run(win, `document.querySelector('#btn-settings').click()`);
    await waitFor(win, `!document.querySelector('#settings-mask').hidden`);
    await run(win, `document.querySelector('#set-language').value = 'en'; document.querySelector('#set-language').dispatchEvent(new Event('change'))`);
    await waitFor(win, `document.documentElement.lang === 'en' && document.querySelector('#list-title').textContent === 'All tasks'`);
    assert.equal(await run(win, `document.querySelector('[data-brand]').textContent`), 'WithYou');
    assert.equal(await run(win, `document.querySelector('#settings-mask h3').textContent`), 'Settings');
    assert.equal(await run(win, `document.querySelector('#btn-add-task').textContent`), 'New task');
    assert.equal(await run(win, `document.querySelector('#priority-list [data-color="red"] input').value`), 'Urgent');
    assert.equal(await run(win, `document.querySelector('#priority-list [data-color="blue"] input').value`), '我的分类');
    assert.equal(JSON.parse(fs.readFileSync(settingsPath)).language, 'en');
    await shot(win, 'settings-en');
    await run(win, `document.querySelector('#btn-close-settings').click()`);
    assert.equal(await run(win, `[...document.querySelectorAll('.card-title')].some(el => el.textContent === '用户任务标题')`), true);
    assert.equal(await run(win, `document.querySelector('.card-note').textContent`), '保留用户原文');
    await shot(win, 'board-en');
    await run(win, `document.querySelector('#btn-add-task').click()`);
    await shot(win, 'add-en');
    assert.equal(await run(win, `document.querySelector('#add-task-mask h3').textContent`), 'Add task');
    await run(win, `document.querySelector('#btn-cancel-add').click(); document.querySelector('.card-title').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))`);
    assert.equal(await run(win, `document.querySelector('.edit-form input').placeholder`), 'Task title (required)');
    await shot(win, 'edit-en');
    await run(win, `document.querySelector('.edit-actions .subtle-btn').click(); document.querySelector('[data-view="calendar"]').click()`);
    await shot(win, 'calendar-en');
    assert.equal(await run(win, `document.querySelector('.cal-weekdays').textContent.includes('Mon')`), true);
    await win.reload();
    await waitFor(win, `document.querySelectorAll('.card').length === 2 && document.documentElement.lang === 'en'`);
    win.setSize(1024, 640);
    await run(win, `document.querySelector('#btn-toggle-filters').click()`);
    await shot(win, 'minimum-en');
    assert.equal(await run(win, `['#btn-add-task', '#btn-toggle-filters', '#task-extra-filters'].every(s => {const r=document.querySelector(s).getBoundingClientRect();return r.right <= innerWidth && r.bottom <= innerHeight;})`), true);
    const quick = new BrowserWindow({width:460,height:170,frame:false,show:true,webPreferences:{preload:path.join(root,'preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    await quick.loadFile(path.join(root,'src/renderer/quick.html'));
    await waitFor(quick, `document.documentElement.lang === 'en'`);
    await shot(quick,'quick-en');
    assert.ok(await run(quick, `document.querySelector('#btn-create').getBoundingClientRect().bottom <= innerHeight`));
    await run(win, `document.querySelector('#btn-settings').click()`);
    await waitFor(win, `!document.querySelector('#settings-mask').hidden`);
    await run(win, `document.querySelector('#set-language').value = 'zh-CN'; document.querySelector('#set-language').dispatchEvent(new Event('change'))`);
    await waitFor(win, `document.documentElement.lang === 'zh-CN' && document.querySelector('#list-title').textContent === '全部任务'`);
    await waitFor(quick, `document.documentElement.lang === 'zh-CN'`);
    assert.equal(await run(win, `document.querySelector('[data-brand]').textContent`), '携手');
    assert.equal(await run(win, `document.querySelector('#priority-list [data-color="red"] input').value`), '紧急');
    assert.equal(JSON.parse(fs.readFileSync(settingsPath)).language, 'zh-CN');
    assert.deepEqual(errors, []);
    console.log('PASS: live zh/en switch, product names, persisted locale/reload, shared quick window, custom content, editors, calendar, minimum layout.');
    console.log('Screenshots: ' + temp);
    app.exit(0);
  } catch(error) {console.error(error); console.error('Screenshots: ' + temp);app.exit(1);}
});
