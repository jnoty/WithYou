'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const events = new Map();
const listen = (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); };
const emit = (name, data = {}) => { for (const handler of events.get(name) || []) handler(data); };
const captures = new Set();
const wrap = { addEventListener: listen,
  setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
  releasePointerCapture: id => { captures.delete(id); emit('lostpointercapture', { pointerId: id }); },
  classList: { toggle() {} } };
const nodes = {};
let starts = 0, ends = 0;
const noop = () => {};
const pet = { dragStart: () => starts++, dragEnd: () => ends++, load: async () => null };
for (const name of ['onDock', 'onMotion', 'onEvent', 'onStats', 'onCommand']) pet[name] = noop;
vm.runInNewContext(fs.readFileSync(require.resolve('../src/renderer/pet.js'), 'utf8'), {
  window: { withyou: { pet }, addEventListener: listen },
  document: { getElementById: id => id === 'pet-wrap' ? wrap : (nodes[id] ||= { style: { setProperty() {} }, classList: { toggle() {} } }) },
  setTimeout: noop, setInterval: noop, clearTimeout: noop, Date, console,
});
const down = () => emit('pointerdown', { button: 0, pointerId: 1, screenX: 100, screenY: 100 });
const move = (buttons = 1) => emit('pointermove', { pointerId: 1, buttons, screenX: 110, screenY: 100 });
// Captured release outside the window must stop native movement exactly once.
down(); assert.equal(captures.has(1), true); move(); assert.equal(starts, 1);
emit('pointerup', { pointerId: 1 }); assert.equal(ends, 1); assert.equal(captures.size, 0);
move(); assert.equal(starts, 1);
// Cancellation and capture loss must both clean up, with no duplicate IPC.
for (const event of ['pointercancel', 'lostpointercapture', 'blur', 'pagehide']) {
  down(); move(); const before = ends;
  emit(event, { pointerId: 1 }); emit('pointerup', { pointerId: 1 });
  assert.equal(ends, before + 1, event);
}
// A release that never delivered pointerup is detected on the next pointer move.
down(); move(); const before = ends; move(0); assert.equal(ends, before + 1);
// Losing focus after a click must clear the old press so future movement cannot start a drag.
down(); const startCount = starts; emit('blur'); move(); assert.equal(starts, startCount);
console.log('Pet gestures: pointer capture, outside release, cancellation, capture loss, blur, unload and missing release passed.');
