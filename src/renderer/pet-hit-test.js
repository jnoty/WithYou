'use strict';

// Match native mouse capture to the visible alpha of the current cat pose.
(() => {
  const masks = {};
  let pointer = null;
  let pressed = false;
  let interactive = false;
  const setInteractive = (value) => {
    if (value === interactive && !['hide', 'peek', 'emerge', 'sit'].includes(document.getElementById('stage').dataset.dock)) return;
    interactive = value;
    window.withyou.pet.setInteractive(value);
  };
  const load = async (name, src) => {
    const image = new Image(); image.src = src; await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    masks[name] = { width: canvas.width, height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const inside = (rect, x, y) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  function contains(x, y) {
    for (const element of document.querySelectorAll('#bubble:not([hidden]), #hud, #treat:not([hidden])')) {
      if (getComputedStyle(element).visibility === 'hidden') continue;
      if (inside(element.getBoundingClientRect(), x, y)) return true;
    }
    const pet = document.getElementById('pet');
    const action = ['run', 'jump', 'hide', 'peek', 'emerge'].find((name) => pet.classList.contains({ run: 'anim-running', jump: 'anim-leap' }[name] || 'anim-' + name)) || 'idle';
    const mask = masks[action];
    if (!mask) return false;
    const element = document.querySelector(action === 'idle' ? '#pet-img' : '.pet-sprite');
    const rect = element.getBoundingClientRect();
    let width = rect.width, height = rect.height, left = rect.left, top = rect.top, frame = 0;
    if (action === 'idle') {
      const ratio = Math.min(width / mask.width, height / mask.height);
      width = mask.width * ratio; height = mask.height * ratio;
      left += (rect.width - width) / 2; top += (rect.height - height) / 2;
    } else {
      frame = Math.max(0, Math.min(7, Math.round(parseFloat(getComputedStyle(element).backgroundPositionX) * 7 / 100)));
    }
    let u = (x - left) / width;
    const v = (y - top) / height;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
    if (document.getElementById('pet-wrap').classList.contains('running-left')) u = 1 - u;
    const frameWidth = mask.width / (action === 'idle' ? 1 : 8);
    const px = frame * frameWidth + Math.min(frameWidth - 1, Math.floor(u * frameWidth));
    const py = Math.min(mask.height - 1, Math.floor(v * mask.height));
    return mask.data[(py * mask.width + px) * 4 + 3] >= 32;
  }
  const refresh = () => {
    if (pressed) { setInteractive(true); return; }
    if (pointer) setInteractive(contains(pointer.x - window.screenX, pointer.y - window.screenY));
  };
  window.addEventListener('mousemove', (event) => {
    pointer = { x: event.screenX, y: event.screenY };
    setInteractive(pressed || contains(event.clientX, event.clientY));
  });
  window.addEventListener('pointermove', (event) => {
    if (pressed && !(event.buttons & 1)) { pressed = false; refresh(); }
  });
  window.addEventListener('pointerdown', () => { pressed = true; setInteractive(true); });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(event, () => { pressed = false; refresh(); });
  }
  window.addEventListener('blur', () => { pressed = false; pointer = null; setInteractive(false); });
  document.addEventListener('mouseleave', () => { if (!pressed) { pointer = null; setInteractive(false); } });
  // Recheck when the window, cat pose or reminder scale changes below a stationary pointer.
  setInterval(refresh, 75);
  Promise.all([
    load('idle', '../../assets/pet-cat-trimmed.png'),
    load('run', '../../assets/pet-run-strip.png'),
    load('jump', '../../assets/pet-jump-strip.png'),
    load('hide', '../../assets/pet-hide-strip.png'),
    load('peek', '../../assets/pet-peek-strip.png'),
    load('emerge', '../../assets/pet-emerge-strip.png'),
  ]).then(refresh).catch((error) => console.error('桌宠轮廓加载失败:', error));
})();
