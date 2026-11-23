#!/usr/bin/env node
/* Generates the small binary assets used by the bundled demo games
   (synthesised WAV sound effects and a PNG sprite atlas). Developer tool. */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const D = path.resolve(__dirname, '..', 'demo-games');

function wav(file, seconds, fn) {
  const rate = 22050, n = Math.floor(rate * seconds), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, fn(i / rate, i / n))); data.writeInt16LE(Math.round(v * 32767 * 0.6), i * 2); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
wav(path.join(D, 'deutsch-destroyer/assets/sfx/laser.wav'), 0.18, (t, p) => Math.sign(Math.sin(2 * Math.PI * (1400 - 1100 * p) * t)) * (1 - p) * 0.7);
wav(path.join(D, 'deutsch-destroyer/assets/sfx/boom.wav'), 0.5, (t, p) => rnd() * Math.pow(1 - p, 2.2) + Math.sin(2 * Math.PI * 60 * t) * (1 - p) * 0.5);
wav(path.join(D, 'deutsch-destroyer/assets/sfx/alarm.wav'), 0.45, (t, p) => Math.sin(2 * Math.PI * (p < 0.5 ? 440 : 330) * t) * 0.8 * (1 - p * 0.6));

// PNG atlas for Core Breach: 128x32 RGBA
function png(file, w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const c = px(x, y); c.forEach((v, i) => raw[y * (w * 4 + 1) + 1 + x * 4 + i] = v); } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// Layout: bricks 4 x (32x12) at y=0 (x=0,32,64,96); core 32x12 at (0,16); ball 8x8 at (32,16); paddle 64x10 at (48,16)
const brickCols = [[200, 16, 46], [150, 156, 166], [90, 96, 108], [255, 80, 96]];
png(path.join(D, 'core-breach/assets/atlas.png'), 128, 32, (x, y) => {
  if (y < 12) {
    const b = Math.floor(x / 32), lx = x % 32, c = brickCols[b];
    const edge = lx === 0 || lx === 31 || y === 0 || y === 11;
    const hi = y === 1 || lx === 1;
    const k = edge ? 0.45 : hi ? 1.25 : 1 - y * 0.025;
    return [...c.map((v) => Math.min(255, Math.round(v * k))), 255];
  }
  if (y >= 16 && y < 28 && x < 32) { // core
    const lx = x, ly = y - 16, d = Math.hypot(lx - 15.5, (ly - 5.5) * 2.4);
    if (lx === 0 || lx === 31 || ly === 0 || ly === 11) return [60, 10, 18, 255];
    return d < 5 ? [255, 220, 225, 255] : d < 9 ? [255, 43, 63, 255] : [110, 8, 24, 255];
  }
  if (y >= 16 && y < 24 && x >= 32 && x < 40) { const d = Math.hypot(x - 35.5, y - 19.5); return d < 3.6 ? [255, 255, 255, Math.round(255 * Math.min(1, 3.8 - d))] : [0, 0, 0, 0]; }
  if (y >= 16 && y < 26 && x >= 48 && x < 112) { const ly = y - 16, lx = x - 48; if (lx < 2 || lx > 61) return [200, 16, 46, 255]; return ly < 2 ? [230, 234, 240, 255] : ly > 7 ? [70, 76, 86, 255] : [170, 176, 186, 255]; }
  return [0, 0, 0, 0];
});
console.log('demo assets generated');
