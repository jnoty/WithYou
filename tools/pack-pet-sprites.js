'use strict';
// Mechanical sprite-sheet packaging: crop grid cells, preserve alpha and register a shared baseline.
// node node_modules/electron/cli.js tools/pack-pet-sprites.js
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'assets');
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const tag = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); tag.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8);
  return result;
};
function animatedPreview(frames, delay) {
  const parts = [frames[0].subarray(0, 8), frames[0].subarray(8, 33)];
  const control = Buffer.alloc(8); control.writeUInt32BE(frames.length);
  parts.push(chunk('acTL', control));
  let sequence = 0;
  frames.forEach((png, i) => {
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(sequence++); frame.writeUInt32BE(384, 4); frame.writeUInt32BE(384, 8);
    frame.writeUInt16BE(delay, 20); frame.writeUInt16BE(1000, 22);
    // SOURCE blending makes each transparent frame replace its predecessor completely.
    parts.push(chunk('fcTL', frame));
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        const data = png.subarray(offset + 8, offset + 8 + length);
        if (i === 0) parts.push(chunk('IDAT', data));
        else {
          const seq = Buffer.alloc(4); seq.writeUInt32BE(sequence++);
          parts.push(chunk('fdAT', Buffer.concat([seq, data])));
        }
      }
      offset += length + 12;
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const clips = new Map();
for (const action of ['run', 'jump', 'hide', 'peek', 'emerge', 'idle']) {
  const source = nativeImage.createFromPath(path.join(root, action === 'idle' ? 'pet-cat.png' : `pet-${action}-source.png`));
  const size = source.getSize();
  const frames = [];
  for (let i = 0; i < (action === 'idle' ? 1 : 8); i++) {
    const left = Math.round((i % 4) * size.width / 4);
    const top = Math.round(Math.floor(i / 4) * size.height / 2);
    const cell = nativeImage.createFromBuffer((action === 'idle' ? source : source.crop({ x: left, y: top,
      width: Math.round(((i % 4) + 1) * size.width / 4) - left,
      height: Math.round(size.height / 2) })).toPNG());
    const { width, height } = cell.getSize();
    const bitmap = cell.getBitmap();
    if (bitmap.length !== width * height * 4) throw new Error('Expected packed pixel rows');
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    // Register the main actor, excluding isolated fragments from a neighboring grid cell.
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let largest = 0;
    for (let seed = 0; seed < width * height; seed++) {
      if (visited[seed] || bitmap[seed * 4 + 3] < 128) continue;
      let head = 0, tail = 1, bx0 = width, by0 = height, bx1 = 0, by1 = 0;
      queue[0] = seed; visited[seed] = 1;
      while (head < tail) {
        const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
        for (const neighbor of [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1,
          y > 0 ? pixel - width : -1, y < height - 1 ? pixel + width : -1]) {
          if (neighbor >= 0 && !visited[neighbor] && bitmap[neighbor * 4 + 3] >= 128) {
            visited[neighbor] = 1; queue[tail++] = neighbor;
          }
        }
      }
      if (tail > largest) { largest = tail; x0 = bx0; y0 = by0; x1 = bx1; y1 = by1; }
    }
    if (!largest) throw new Error(`Missing actor in ${action} frame ${i + 1}`);
    x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2);
    x1 = Math.min(width - 1, x1 + 2); y1 = Math.min(height - 1, y1 + 2);
    frames.push(cell.crop({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }));
  }
  if (action === 'idle') {
    fs.writeFileSync(path.join(root, 'pet-cat-trimmed.png'), frames[0].toPNG());
  } else clips.set(action, frames);
}
const scaleFor = (actions) => {
  const allFrames = actions.flatMap((action) => clips.get(action));
  return Math.min(352 / Math.max(...allFrames.map((f) => f.getSize().width)), 340 / Math.max(...allFrames.map((f) => f.getSize().height)));
};
const movementScale = scaleFor(['run', 'jump']);
const cornerScale = scaleFor(['hide', 'emerge']);
for (const [action, frames] of clips) {
  const factor = ['run', 'jump'].includes(action) ? movementScale : cornerScale * (action === 'peek' ? 0.72 : 1);
  const stripWidth = 384 * 8;
  const strip = Buffer.alloc(stripWidth * 384 * 4);
  const dir = path.join(root, `pet-${action}`);
  const previewFrames = [];
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((frame, i) => {
    const original = frame.getSize();
    const scaled = nativeImage.createFromBuffer(frame.resize({ width: Math.round(original.width * factor), height: Math.round(original.height * factor), quality: 'best' }).toPNG());
    const { width, height } = scaled.getSize();
    const pixels = scaled.getBitmap();
    const x = Math.round((384 - width) / 2), y = 366 - height;
    const single = Buffer.alloc(384 * 384 * 4);
    for (let row = 0; row < height; row++) {
      pixels.copy(strip, ((y + row) * stripWidth + i * 384 + x) * 4, row * width * 4, (row + 1) * width * 4);
      pixels.copy(single, ((y + row) * 384 + x) * 4, row * width * 4, (row + 1) * width * 4);
    }
    const png = nativeImage.createFromBitmap(single, { width: 384, height: 384 }).toPNG();
    previewFrames.push(png);
    fs.writeFileSync(path.join(dir, `${i + 1}.png`), png);
  });
  fs.writeFileSync(path.join(root, `pet-${action}-strip.png`), nativeImage.createFromBitmap(strip, { width: stripWidth, height: 384 }).toPNG());
  fs.writeFileSync(path.join(root, `pet-${action}-preview.png`), animatedPreview(previewFrames, action === 'run' ? 60 : (action === 'peek' ? 240 : 120)));
  console.log(`${action}: 8 frames, 384px/frame, transparent strip packaged`);
}
app.exit(0);
