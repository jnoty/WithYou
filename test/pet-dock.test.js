'use strict';
const assert = require('node:assert/strict');
const { createPetDock } = require('../src/pet-dock');
let time = 0, tick, destroyed = false, stopped = 0;
let bounds = { x: -1920, y: 300, width: 160, height: 180 };
let cursor = { x: 100, y: 100 };
const area = { x: -1920, y: 0, width: 1920, height: 1040 };
const messages = [];
const dock = createPetDock({
  getWindow: () => ({ isDestroyed: () => destroyed, getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; } }),
  getWorkArea: () => area, getCursor: () => cursor,
  send: (channel, payload) => messages.push({ channel, payload }),
  now: () => time, schedule: (fn) => { tick = fn; return 1; }, unschedule: () => stopped++,
});
const at = (ms) => { time = ms; tick(); };
const phase = () => messages.at(-1).payload.phase;
assert.deepEqual(dock.dock(), { x: -1920, y: 860 });
assert.equal(phase(), 'hide');
at(320); assert.ok(bounds.y > 300 && bounds.y < 860, '躲藏时平滑移动');
at(640); assert.equal(phase(), 'peek'); assert.equal(bounds.y, 860);
dock.hover(false); cursor = { x: -1840, y: 1010 }; dock.hover(true);
assert.equal(phase(), 'emerge');
at(1440); assert.equal(phase(), 'sit'); assert.equal(bounds.x, -1872); assert.equal(bounds.y, 842);
// Leaving the cat has a grace period, so a brief pointer slip does not collapse it.
dock.hover(false); cursor = { x: 100, y: 100 };
at(2500); assert.equal(phase(), 'sit');
at(2640); assert.equal(phase(), 'hide');
at(3280); assert.equal(phase(), 'peek');
dock.suspend(); assert.equal(phase(), 'idle'); assert.equal(bounds.x, -1872);
at(8000); assert.equal(phase(), 'idle', '提醒期间不会再次自动躲藏');
dock.resume(); assert.equal(phase(), 'sit');
at(9200); assert.equal(phase(), 'hide');
dock.cancel(true); assert.equal(phase(), 'idle'); assert.equal(dock.isDocked(), false);
assert.equal(bounds.x, -1872);
assert.equal(stopped, 1);
// Right corner and 150% size stay on the correct monitor and use the scaled inset.
bounds = { x: -240, y: 200, width: 240, height: 270 };
assert.deepEqual(dock.dock(), { x: -240, y: 770 });
at(9840); assert.equal(phase(), 'peek');
dock.hover(false); cursor = { x: -100, y: 900 }; dock.hover(true);
at(10640); assert.equal(bounds.x, -312); assert.equal(bounds.y, 743);
dock.cancel();
bounds = { x: -1100, y: 300, width: 160, height: 180 };
assert.equal(dock.dock(), null, '未贴边时不触发');
assert.equal(dock.dock(true).x, -1920, '强制恢复已有桌角状态');
destroyed = true; at(10700); assert.equal(dock.isDocked(), false);
destroyed = false;
bounds = { x: -1920, y: 860, width: 160, height: 180 };
cursor = { x: -1840, y: 1010 };
dock.dock(); at(11340);
assert.equal(phase(), 'peek');
dock.hover(true);
assert.equal(phase(), 'emerge', '第一次悬停就应展开，无须先触发一次移出');
for (let round = 1; round <= 20; round++) {
  const seatedAt = 12140 + (round - 1) * 2640;
  at(seatedAt);
  assert.equal(phase(), 'sit');
  dock.hover(false);
  at(seatedAt + 1200);
  at(seatedAt + 1840);
  assert.equal(phase(), 'peek');
  dock.hover(true); // The returning silhouette now covers the stationary pointer.
  assert.equal(phase(), 'peek', `第 ${round} 轮：静止鼠标不应再次触发展开`);
  assert.deepEqual({ x: bounds.x, y: bounds.y }, { x: -1920, y: 860 }, `第 ${round} 轮：桌角坐标应保持一致`);
  if (round < 20) {
    cursor = { ...cursor, x: cursor.x + 1 };
    dock.hover(true);
    assert.equal(phase(), 'emerge');
  }
}
console.log('连续 20 轮悬停与收回：每轮均回到 (-1920, 860)，静止鼠标未再次触发展开');
cursor = { ...cursor, x: cursor.x + 1 };
dock.hover(true);
const lastSeatedAt = time + 800;
at(lastSeatedAt);
assert.equal(phase(), 'sit');
dock.hover(false);
at(lastSeatedAt + 1200);
assert.equal(phase(), 'hide');
cursor = { ...cursor, x: cursor.x + 1 };
dock.hover(true);
at(lastSeatedAt + 1840);
dock.hover(true);
assert.equal(phase(), 'emerge', '收回途中移回猫身并停住，收回结束后也应响应');
const seatedAgainAt = time + 800;
at(seatedAgainAt);
assert.equal(phase(), 'sit');
cursor = { x: 100, y: 100 };
at(seatedAgainAt + 16);
for (let elapsed = 75; elapsed <= 1200; elapsed += 75) {
  dock.hover(true); // A stale renderer hit test still reports the cat under the pointer.
  at(seatedAgainAt + 16 + elapsed);
}
assert.equal(phase(), 'hide', '窗口外的过期悬停消息不应重置收回计时');
at(seatedAgainAt + 1856);
assert.equal(phase(), 'peek');
dock.cancel();
console.log('桌角躲藏：左 / 右副屏、躲藏→探头→悬停跑出坐下、延迟收起、提醒暂停 / 恢复、150% 大小、取消 / 销毁通过');
