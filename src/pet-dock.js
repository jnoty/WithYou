'use strict';

// Screen-corner docking is separate from reminder trips and never persists transient positions.
function createPetDock({ getWindow, getWorkArea, getCursor, send, now = Date.now,
  schedule = setInterval, unschedule = clearInterval }) {
  let state = null, timer = null;
  const place = (p) => getWindow().setPosition(Math.round(p.x), Math.round(p.y), false);
  const phase = (name) => {
    state.phase = name; state.since = now();
    send('pet:dock', { phase: name, side: state.side });
  };
  const glide = (from, to, progress) => {
    const p = Math.max(0, Math.min(1, progress));
    const t = p * p * (3 - 2 * p);
    place({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  };
  function hide() {
    state.from = getWindow().getBounds();
    state.leaveAt = null;
    phase('hide');
  }
  function hover(value) {
    if (!state || state.paused) return;
    state.hovered = Boolean(value);
    if (state.phase === 'peek' && value) {
      state.from = getWindow().getBounds(); phase('emerge');
    }
    if (state.phase === 'sit') {
      if (value) state.leaveAt = null;
      else if (state.leaveAt === null) state.leaveAt = now();
    }
  }
  function cancel(restore = false) {
    if (timer !== null) unschedule(timer);
    timer = null;
    if (!state) return;
    const previous = state; state = null;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      if (restore) place(previous.expanded);
      send('pet:dock', { phase: 'idle' });
    }
  }
  function tick() {
    const win = getWindow();
    if (!win || win.isDestroyed()) { cancel(); return; }
    if (!state || state.paused) return;
    const elapsed = now() - state.since;
    if (state.phase === 'hide') {
      glide(state.from, state.home, elapsed / 640);
      if (elapsed >= 640) phase('peek');
    } else if (state.phase === 'emerge') {
      glide(state.from, state.expanded, elapsed / 800);
      if (elapsed >= 800) { phase('sit'); state.leaveAt = state.hovered ? null : now(); }
    }
    const b = win.getBounds(), cursor = getCursor();
    if (cursor.x < b.x || cursor.x >= b.x + b.width || cursor.y < b.y || cursor.y >= b.y + b.height) hover(false);
    if (state.phase === 'sit' && state.leaveAt !== null && now() - state.leaveAt >= 1200) hide();
  }
  return {
    dock(force = false) {
      const win = getWindow();
      if (!win || win.isDestroyed()) return null;
      cancel();
      const b = win.getBounds(), area = getWorkArea(b);
      const right = area.x + area.width - b.width, bottom = area.y + area.height - b.height;
      if (!force && Math.min(Math.abs(b.x - area.x), Math.abs(b.x - right), Math.abs(b.y - area.y), Math.abs(b.y - bottom)) > 12) return null;
      const side = b.x + b.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
      const home = { x: side === 'left' ? area.x : right, y: bottom };
      const expanded = {
        x: Math.min(right, Math.max(area.x, home.x + (side === 'left' ? 48 : -48) * b.width / 160)),
        y: Math.max(area.y, bottom - 18 * b.height / 180),
      };
      state = { home, expanded, side, hovered: false, paused: false, leaveAt: null };
      hide(); timer = schedule(tick, 16);
      return home;
    },
    hover,
    cancel,
    suspend() {
      if (!state) return;
      state.paused = true; place(state.expanded);
      send('pet:dock', { phase: 'idle' });
    },
    resume() {
      if (!state || !state.paused) return;
      state.paused = false; state.hovered = false; state.leaveAt = now(); phase('sit');
    },
    isDocked: () => state !== null,
  };
}

module.exports = { createPetDock };
