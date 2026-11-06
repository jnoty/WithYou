'use strict';

/** 预览校验：渲染生成的使用说明并截图（docs/preview-*.png）。 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'docs', 'WithYou使用说明.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360, height: 950, show: true, alwaysOnTop: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(HTML);
  await sleep(1200);
  const shot = async (name, scrollY) => {
    await win.webContents.executeJavaScript(`window.scrollTo({top: ${scrollY}, behavior: 'instant'}); true`, true);
    await win.webContents.executeJavaScript(
      `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`, true).catch(() => {});
    await sleep(500);
    for (let i = 0; i < 12; i++) {
      const img = await win.webContents.capturePage();
      const size = img.getSize();
      if (size.width > 0 && size.height > 0) {
        fs.writeFileSync(path.join(ROOT, 'docs', name), img.toPNG());
        console.log('[preview]', name, JSON.stringify(size));
        return;
      }
      await sleep(500);
    }
    throw new Error('截图为空: ' + name);
  };
  await shot('preview-top.png', 0);
  await shot('preview-mid.png', 2600);
  for (const id of ['ai-tasks', 'ai-models', 'project-resources']) {
    const offset = await win.webContents.executeJavaScript(`document.getElementById('${id}').offsetTop - 20`);
    await shot('preview-' + id + '.png', offset);
  }
  const issues = await win.webContents.executeJavaScript(`({
    images: [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.alt),
    anchors: [...document.querySelectorAll('a[href^="#"]')].filter(a => !document.getElementById(a.hash.slice(1))).map(a => a.hash),
    overflow: document.documentElement.scrollWidth > innerWidth
  })`);
  if (issues.images.length || issues.anchors.length || issues.overflow) throw new Error(JSON.stringify(issues));
  win.setSize(800, 900);
  await shot('preview-narrow.png', 0);
  if (await win.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth')) throw new Error('窄窗口横向溢出');
  console.log('[verified] all images, anchors and desktop/narrow layouts');
  app.exit(0);
});
