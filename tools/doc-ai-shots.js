'use strict';
// Documentation images: real UI, isolated profile, simulated AI; no personal data or requests.
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, expandOccurrences } = require('../src/store');
const { AIService } = require('../src/ai-service');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-manual-'));
app.setPath('userData', path.join(temp, 'profile'));
app.whenReady().then(async () => {
  const store = new TaskStore(path.join(temp, 'tasks.json'));
  store.create({ title: '整理官网首页文案', note: '核对产品介绍、联系方式和产品图片' });
  const text = '官网新版首页需要在11月13日18:00前上线。请整理首页文案和产品配图，完成页面开发与手机端适配，上线前检查按钮链接和表单提交，并请同事验收。';
  const ai = new AIService({ filePath: path.join(temp, 'ai.json'), safeStorage, store, fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [
    { title: '整理首页文案与产品配图', quote: '整理首页文案和产品配图', steps: ['核对首页文案', '准备并压缩产品图片'] },
    { title: '完成首页开发与手机端适配', quote: '完成页面开发与手机端适配', steps: ['实现首页页面', '检查手机端布局'] },
    { title: '完成上线检查并邀请同事验收', quote: '上线前检查按钮链接和表单提交，并请同事验收', dueAt: '2026-11-13T18:00:00+08:00', steps: ['检查按钮链接', '验证表单提交', '邀请同事验收'] }
  ], decisions: '' }) } }] }) }) });
  ai.saveConfig({ providerId: '', name: '工作模型', endpoint: 'https://api.deepseek.com/v1', format: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'], model: 'deepseek-chat', key: 'documentation-example-not-a-real-key' });
  ipcMain.handle('settings:get', () => ({ language: 'zh-CN', roundedCorners: true, colorPriorities: [], opacity: 1, petScale: 1, petEnabled: true }));
  ipcMain.handle('tasks:list', () => store.list()); ipcMain.handle('project-resources:list', () => []);
  ipcMain.handle('tasks:plan-recurring', (_e, input) => { const plan = expandOccurrences(input); return { ok: true, count: plan.length, firstAt: plan[0].startAt, lastAt: plan[plan.length - 1].startAt }; });
  for (const [name, fn] of Object.entries({ config: () => ai.getConfig(), analyze: i => ai.analyze(i), sources: () => store.sources })) ipcMain.handle('ai:' + name, async (_e, input) => ({ ok: true, data: await fn(input) }));
  const win = new BrowserWindow({ show: false, width: 1180, height: 850, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const wait = async code => { for (let i = 0; i < 100; i++) { if (await run(code)) return; await new Promise(r => setTimeout(r, 40)); } throw new Error(code); };
  const shot = async name => { await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); fs.writeFileSync(path.join(root, 'docs/images', name), (await win.webContents.capturePage()).toPNG()); console.log(name); };
  try {
    await win.loadFile(path.join(root, 'src/renderer/index.html')); await wait(`!!document.querySelector('#ai-mask')`);
    await run(`document.querySelector('#btn-add-task').click(); document.querySelector('#add-ai-text').value=${JSON.stringify(text)}`);
    await shot('12-ai-input.png');
    await run(`document.querySelector('#add-mode-manual').click(); document.querySelector('#add-title').value='产品迭代评审会'; document.querySelector('#add-note').value='评审功能清单，确认发布时间与验收标准'; document.querySelector('#add-start').value='2026-11-09T14:00'; document.querySelector('#add-end').value='2026-11-09T15:30'; document.querySelector('#add-until').value='2026-12-28'; document.querySelector('#add-repeat').value='weekly'; document.querySelector('#add-repeat').dispatchEvent(new Event('change'))`);
    await wait(`!document.querySelector('#add-preview').hidden`); await shot('03-add-task.png');
    await run(`document.querySelector('#add-mode-ai').click()`);
    await run(`document.querySelector('#btn-ai-create-task').click()`);
    await wait(`!document.querySelector('#ai-preview').hidden && !document.querySelector('#btn-ai-create-task').disabled`);
    await shot('13-ai-preview.png');
    await run(`document.querySelector('.ai-task-details').open=true; document.querySelector('.ai-modal').scrollTop=0`);
    await shot('14-ai-details.png');
    await run(`document.querySelector('#ai-close').click(); document.querySelector('#btn-settings').click(); document.querySelector('[data-settings-tab=ai]').click()`);
    await wait(`document.querySelectorAll('.provider-card').length===1`); await shot('15-model-providers.png');
    await run(`document.querySelector('.provider-edit').click(); document.querySelector('#ai-custom-settings').open=true; document.querySelector('#ai-config').scrollIntoView({block:'start'})`);
    await shot('16-provider-editor.png');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
