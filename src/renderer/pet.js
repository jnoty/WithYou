'use strict';

/**
 * 桌宠渲染层
 * - 手势：单击抚摸 / 双击喂食 / 右键菜单 / 拖拽（<5px 视为点击）
 * - 气泡队列、心情动画、等级 HUD
 * - 状态机与文案由主进程（src/pet-behavior.js）统一计算
 */

const api = window.withyou;

const els = {
  stage: document.getElementById('stage'),
  pet: document.getElementById('pet'),
  wrap: document.getElementById('pet-wrap'),
  bubble: document.getElementById('bubble'),
  hudLevel: document.getElementById('hud-level'),
  hudMood: document.getElementById('hud-mood'),
  fx: document.getElementById('pet-fx'),
  treat: document.getElementById('treat'),
};

let bubblesEnabled = true;
let moodType = 'idle';
let petState = null;
let currentAnim = '';
let awakeUntil = 0; // 睡眠时段被互动唤醒的临时覆盖（5 分钟）
let motionPhase = 'idle';
let dockPhase = 'idle';

// ---------- 气泡队列 ----------
const bubbleQueue = [];
let bubbleTimer = null;

function say(text, ms = 4000) {
  if (!text || !bubblesEnabled) return;
  bubbleQueue.push({ text, ms });
  pumpBubble();
}

function pumpBubble() {
  if (bubbleTimer || !bubbleQueue.length) return;
  const { text, ms } = bubbleQueue.shift();
  els.bubble.textContent = text;
  els.bubble.title = text;
  els.bubble.hidden = false;
  bubbleTimer = setTimeout(() => {
    els.bubble.hidden = true;
    bubbleTimer = null;
    pumpBubble();
  }, ms);
}

// ---------- 心情 / 动画 / HUD ----------
function effectiveMood() {
  if (moodType === 'sleeping' && Date.now() < awakeUntil) return 'idle';
  return moodType;
}

function renderMood() {
  const dockAnim = { hide: 'anim-hide', peek: 'anim-peek', emerge: 'anim-emerge' }[dockPhase];
  const anim = motionPhase === 'outbound' ? 'anim-running' : (motionPhase === 'return' ? 'anim-leap' : (dockAnim || currentAnim));
  els.pet.className = 'pet mood-' + effectiveMood() + (anim ? ' ' + anim : '');
}

function playAnim(name, ms) {
  currentAnim = name;
  renderMood();
  setTimeout(() => {
    if (currentAnim === name) {
      currentAnim = '';
      renderMood();
    }
  }, ms);
}

function renderHud() {
  if (!petState) return;
  els.hudLevel.textContent = 'Lv.' + (petState.level || 1);
  els.hudMood.textContent = '♥ ' + Math.round(petState.mood == null ? 80 : petState.mood);
}

function spawnFx(cls, count) {
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = cls === 'fx-heart' ? '♥' : '✦';
    span.style.left = 30 + Math.random() * 60 + 'px';
    span.style.top = 20 + Math.random() * 30 + 'px';
    span.style.animationDelay = (i * 0.12) + 's';
    els.fx.appendChild(span);
    setTimeout(() => span.remove(), 1400);
  }
}

function showTreat() {
  els.treat.hidden = false;
  els.treat.style.animation = 'none';
  // 强制重排以重放动画
  void els.treat.offsetWidth;
  els.treat.style.animation = '';
  setTimeout(() => { els.treat.hidden = true; }, 1600);
}

function applyMood(payload) {
  if (payload && payload.moodType) moodType = payload.moodType;
  if (payload && payload.state) petState = payload.state;
  renderMood();
  renderHud();
}

// ---------- 互动 ----------
async function doInteract(action) {
  awakeUntil = Date.now() + 5 * 60 * 1000;
  const r = await api.pet.interact(action);
  if (!r) return;
  applyMood(r);
  if (action === 'feed') {
    if (r.accepted) {
      showTreat();
      playAnim('anim-eating', 1500);
    }
  } else if (action === 'pat' && r.accepted) {
    playAnim('anim-pat', 500);
    spawnFx('fx-heart', 2);
  }
  if (r.levelUp) {
    playAnim('anim-celebrate', 750);
    spawnFx('fx-star', 3);
  }
  if (r.message) say(r.message);
}

// ---------- 手势 ----------
let downPos = null;
let dragging = false;
let lastDragEndAt = 0;
let patTimer = null;

let dragPointerId = null;
function finishDrag() {
  const pointerId = dragPointerId;
  const wasDragging = dragging;
  downPos = null;
  dragging = false;
  dragPointerId = null;
  if (pointerId !== null && els.wrap.hasPointerCapture(pointerId)) els.wrap.releasePointerCapture(pointerId);
  if (wasDragging) {
    lastDragEndAt = Date.now();
    api.pet.dragEnd();
  }
}

els.wrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || dragPointerId !== null) return;
  downPos = { x: e.screenX, y: e.screenY };
  dragging = false;
  dragPointerId = e.pointerId;
  // Keep receiving release/cancel even outside this non-focusable native window.
  els.wrap.setPointerCapture(e.pointerId);
});

window.addEventListener('pointermove', (e) => {
  if (!downPos || e.pointerId !== dragPointerId) return;
  if (!(e.buttons & 1)) { finishDrag(); return; }
  const moved = Math.abs(e.screenX - downPos.x) > 5 || Math.abs(e.screenY - downPos.y) > 5;
  if (!dragging && moved) {
    dragging = true;
    api.pet.dragStart();
  }
});

for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  window.addEventListener(event, (e) => { if (e.pointerId === dragPointerId) finishDrag(); });
}
window.addEventListener('blur', finishDrag);
window.addEventListener('pagehide', finishDrag);

els.wrap.addEventListener('click', () => {
  if (dragging || Date.now() - lastDragEndAt < 150) return;
  if (patTimer) return; // 双击的第二下不再触发抚摸
  patTimer = setTimeout(() => {
    patTimer = null;
    doInteract('pat');
  }, 220);
});

els.wrap.addEventListener('dblclick', () => {
  if (dragging || Date.now() - lastDragEndAt < 150) return;
  if (patTimer) {
    clearTimeout(patTimer);
    patTimer = null;
  }
  doInteract('feed');
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.pet.contextMenu();
});

// ---------- 主进程事件 ----------
api.pet.onDock((p) => {
  dockPhase = p.phase;
  els.stage.dataset.dock = p.phase;
  const mirrored = (p.phase === 'emerge' && p.side === 'left') || (['hide', 'peek'].includes(p.phase) && p.side === 'left');
  els.wrap.classList.toggle('running-left', mirrored);
  if (['hide', 'peek', 'emerge'].includes(p.phase)) {
    clearTimeout(bubbleTimer); bubbleTimer = null; els.bubble.hidden = true;
    currentAnim = '';
  }
  renderMood();
});

function applyPetSettings(p) {
  if (p.bubbles !== undefined) bubblesEnabled = p.bubbles !== false;
  if (p.scale !== undefined) {
    const scale = Number(p.scale);
    if (Number.isFinite(scale)) els.stage.style.setProperty('--pet-scale', String(Math.min(1.5, Math.max(0.8, scale))));
  }
}

api.pet.onMotion((p) => {
  motionPhase = p.phase;
  els.stage.dataset.motion = p.phase;
  els.stage.style.setProperty('--reminder-scale', String(p.scale || 1));
  els.wrap.classList.toggle('running-left', p.direction === 'left' && p.phase !== 'idle');
  if (p.phase !== 'center') {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    els.bubble.hidden = true;
    if (p.phase === 'outbound') bubbleQueue.length = 0;
  }
  if (p.phase === 'idle') { currentAnim = ''; pumpBubble(); }
  renderMood();
});

api.pet.onEvent((p) => {
  if (!p) return;
  applyMood(p);
  if (p.type === 'done' || p.levelUp) {
    playAnim('anim-celebrate', 750);
    spawnFx('fx-star', 3);
  } else if (p.type === 'due' || p.type === 'overdue') {
    playAnim('anim-attention', 1500);
  } else if (p.type === 'created') {
    playAnim('anim-pat', 500);
  }
  const text = p.title ? `${p.message}（${p.title}）` : p.message;
  if (p.reminderMs != null) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    bubbleQueue.length = 0;
    say(text, p.reminderMs);
  } else {
    say(text);
  }
});

api.pet.onStats((p) => {
  if (!p) return;
  applyPetSettings(p);
  applyMood(p);
});

api.pet.onCommand((cmd) => {
  if (cmd === 'feed') {
    doInteract('feed');
  } else if (cmd === 'greet') {
    api.pet.message('idle-chat').then((r) => {
      if (r && r.message) say(r.message);
    });
  }
});

// ---------- 闲聊 ----------
function scheduleChatter() {
  const delay = (10 + Math.random() * 10) * 60 * 1000; // 10~20 分钟
  setTimeout(async () => {
    if (bubblesEnabled && effectiveMood() !== 'sleeping') {
      const r = await api.pet.message('idle-chat');
      if (r && r.message) say(r.message);
    }
    scheduleChatter();
  }, delay);
}

// ---------- 初始化 ----------
(async function init() {
  try {
    const snap = await api.pet.load();
    if (snap) {
      petState = snap.state || null;
      moodType = snap.moodType || 'idle';
      applyPetSettings(snap);
    }
  } catch (err) {
    console.error(tr('桌宠初始化失败:'), err);
  }
  renderMood();
  renderHud();
  scheduleChatter();
  setInterval(renderMood, 30000); // 随时间进出睡眠时段
})();
