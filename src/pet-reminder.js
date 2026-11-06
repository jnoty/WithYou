'use strict';

// 650ms 奔跑 + 1700ms 放大提醒 + 650ms 跳跃返回，共 3 秒。
function createPetReminder({ getWindow, getWorkArea, send, now = Date.now,
  schedule = setInterval, unschedule = clearInterval }) {
  let trip = null;
  let timer = null;
  const place = (pos) => getWindow().setPosition(Math.round(pos.x), Math.round(pos.y), false);
  const motion = (phase, from, to) => send('pet:motion', {
    phase, direction: to.x < from.x ? 'left' : 'right', scale: phase === 'center' ? 1.5 : 1,
  });
  function cancel(restore = true) {
    if (timer !== null) unschedule(timer);
    timer = null;
    if (!trip) return;
    const origin = trip.origin;
    trip = null;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      const pos = restore ? origin : {
        x: bounds.x + (bounds.width - origin.width) / 2,
        y: bounds.y + (bounds.height - origin.height) / 2,
      };
      const area = getWorkArea(pos, origin);
      win.setBounds({
        x: Math.round(Math.min(Math.max(pos.x, area.x), area.x + Math.max(0, area.width - origin.width))),
        y: Math.round(Math.min(Math.max(pos.y, area.y), area.y + Math.max(0, area.height - origin.height))),
        width: origin.width, height: origin.height,
      });
    }
    send('pet:motion', { phase: 'idle' });
  }
  function tick() {
    const win = getWindow();
    if (!trip || !win || win.isDestroyed()) { cancel(false); return; }
    const elapsed = now() - trip.startedAt;
    if (elapsed >= 3000) { cancel(); return; }
    const phase = elapsed < 650 ? 'outbound' : (elapsed < 2350 ? 'center' : 'return');
    if (trip.phase !== phase) {
      trip.phase = phase;
      motion(phase, phase === 'return' ? trip.center : trip.home,
        phase === 'return' ? trip.home : trip.center);
      if (phase === 'center') send('pet:event', { ...trip.payload, reminderMs: 1700 });
    }
    if (phase === 'center') { place(trip.center); return; }
    const from = phase === 'outbound' ? trip.home : trip.center;
    const to = phase === 'outbound' ? trip.center : trip.home;
    const progress = Math.max(0, Math.min(1, (elapsed - (phase === 'return' ? 2350 : 0)) / 650));
    const eased = progress * progress * (3 - 2 * progress);
    const jump = phase === 'return' ? Math.sin(Math.PI * progress) * Math.min(100, trip.origin.height * 0.5) : 0;
    place({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased - jump });
  }
  return {
    start(payload) {
      const win = getWindow();
      if (!win || win.isDestroyed()) return false;
      if (trip) {
        // 同时到期的提醒共用一次行程，不累加往返时间。
        trip.payload = payload;
        if (trip.phase === 'center') send('pet:event', { ...payload, reminderMs: Math.max(0, 2350 - (now() - trip.startedAt)) });
        return true;
      }
      const origin = win.getBounds();
      const area = getWorkArea(origin, origin);
      // 预留 1.5 倍画布，缩放和起跳时图片不会被原来的小窗口裁切。
      const size = { width: Math.round(origin.width * 1.5), height: Math.round(origin.height * 1.5) };
      const home = { x: Math.round(origin.x - (size.width - origin.width) / 2),
        y: Math.round(origin.y - (size.height - origin.height) / 2) };
      const center = { x: area.x + (area.width - size.width) / 2,
        y: area.y + (area.height - size.height) / 2 };
      trip = { origin, home, center, payload, startedAt: now(), phase: null };
      win.setBounds({ ...home, ...size });
      tick();
      timer = schedule(tick, 16);
      return true;
    },
    cancel,
    isActive: () => trip !== null,
  };
}

module.exports = { createPetReminder };
