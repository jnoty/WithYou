'use strict';
// node node_modules/electron/cli.js tools/pet-clips-smoke.js
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-cat-clips-'));
app.setPath('userData', path.join(temp, 'profile'));
app.whenReady().then(async () => {
  try {
    const trimmed = nativeImage.createFromPath(path.join(root, 'assets', 'pet-cat-trimmed.png'));
    assert.ok(trimmed.getSize().width < trimmed.getSize().height, '静态猫图已按可见轮廓裁切，不再保留正方形画布');
    for (const action of ['run', 'jump', 'hide', 'peek', 'emerge']) {
      const hashes = new Set();
      for (let i = 1; i <= 8; i++) {
        const frame = fs.readFileSync(path.join(root, 'assets', `pet-${action}`, `${i}.png`));
        hashes.add(crypto.createHash('sha256').update(frame).digest('hex'));
        const decoded = nativeImage.createFromBuffer(frame);
        assert.deepEqual(decoded.getSize(), { width: 384, height: 384 });
        const pixels = decoded.getBitmap();
        assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 200), 'Frame has visible artwork');
        assert.ok(pixels.some((value, index) => index % 4 === 3 && value === 0), 'Frame preserves transparency');
      }
      assert.equal(hashes.size, 8, 'Eight distinct poses: ' + action);
      const apng = fs.readFileSync(path.join(root, 'assets', `pet-${action}-preview.png`));
      assert.ok(apng.includes(Buffer.from('acTL')), 'Independent animated preview');
    }
    const win = new BrowserWindow({ width: 1100, height: 820, show: false, autoHideMenuBar: true,
      webPreferences: { backgroundThrottling: false } });
    await win.loadFile(path.join(root, 'src', 'renderer', 'pet-animation-preview.html'));
    win.showInactive();
    const run = (code) => win.webContents.executeJavaScript(code);
    const positions = () => run('[...document.querySelectorAll(".pet-sprite")].map(el => getComputedStyle(el).backgroundPositionX)');
    const first = await positions();
    await new Promise((resolve) => setTimeout(resolve, 290));
    const next = await positions();
    for (let i = 0; i < 5; i++) assert.notEqual(first[i], next[i], 'Clip frames are advancing: ' + i);
    assert.deepEqual(await run('[...document.images].map(img => img.complete && img.naturalWidth === 3072)'), [true, true, true, true, true]);
    fs.writeFileSync(path.join(temp, 'clips.png'), (await win.webContents.capturePage()).toPNG());
    await run('window.scrollTo(0, 650)');
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(path.join(temp, 'corner-clips.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: five separate eight-pose RGBA clips, APNG previews, sprite sheets and actual frame playback.');
    console.log('Artifacts: ' + temp);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
