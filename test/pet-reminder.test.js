'use strict';
const assert = require('node:assert/strict');
const { createPetReminder } = require('../src/pet-reminder');
let time = 0;
let tick;
let destroyed = false;
let stopped = 0;
let bounds = { x: -300, y: 650, width: 160, height: 180 };
const original = { ...bounds };
const area = { x: -1920, y: 0, width: 1920, height: 1040 };
const messages = [];
const window = {
  isDestroyed: () => destroyed,
  getBounds: () => ({ ...bounds }),
  setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
  setBounds: (next) => { bounds = { ...next }; },
};
const reminder = createPetReminder({
  getWindow: () => window,
  getWorkArea: () => area,
  send: (channel, payload) => messages.push({ channel, payload }),
  now: () => time,
  schedule: (fn) => { tick = fn; return 1; },
  unschedule: () => { stopped++; },
});
const advance = (ms) => { time = ms; tick(); };
const events = () => messages.filter((m) => m.channel === 'pet:event');
assert.equal(reminder.start({ type: 'due', title: '会议' }), true);
advance(325);
assert.ok(bounds.x < original.x && bounds.x > -1040, '平滑移动，尚未抵达中央');
assert.equal(events().length, 0, '抵达前不弹提醒');
advance(650);
assert.equal(bounds.x, -1080, '扩大画布后居中于当前副屏');
assert.equal(bounds.y, 385);
assert.equal(bounds.width, 240);
assert.equal(bounds.height, 270);
assert.equal(messages.find((m) => m.payload.phase === 'center').payload.scale, 1.5);
assert.equal(events().length, 1);
assert.equal(events()[0].payload.reminderMs, 1700);
advance(1000);
reminder.start({ type: 'due', title: '第二个会议' });
assert.equal(events()[1].payload.reminderMs, 1350, '新提醒不延长总行程');
advance(2350);
assert.equal(messages.at(-1).payload.phase, 'return');
advance(2675);
assert.equal(bounds.y, 405, '跳回中点比直线路径高 90 像素');
advance(3000);
assert.deepEqual(bounds, original, '3 秒后准确返回原位置');
assert.equal(reminder.isActive(), false);
assert.equal(stopped, 1);

reminder.start({ type: 'due' });
advance(3650);
const manualPosition = { ...bounds };
reminder.cancel(false);
assert.equal(bounds.x + bounds.width / 2, manualPosition.x + manualPosition.width / 2, '拖拽接管保持中心位置');
assert.equal(bounds.width, original.width, '拖拽接管恢复正常窗口尺寸');
const restoredPosition = { ...bounds };
assert.equal(reminder.isActive(), false);
reminder.start({ type: 'due' });
advance(4300);
reminder.cancel();
assert.deepEqual(bounds, restoredPosition, '设置变化取消时返回起点');
reminder.start({ type: 'due' });
destroyed = true;
advance(4400);
assert.equal(reminder.isActive(), false, '窗口销毁时停止计时');
assert.equal(reminder.start({ type: 'due' }), false);
console.log('桌宠提醒动画：3 秒往返、1.5 倍画布与缩放、弧线跳跃、多屏、重复提醒、拖拽接管、取消恢复通过');
