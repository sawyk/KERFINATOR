import { Loop } from 'engine/loop.js';
import { Input } from './engine/input.js';
import { loadLevels } from './levels.js';
import * as store from './save.js';

const cv = document.getElementById('c'), g = cv.getContext('2d');
const W = cv.width, H = cv.height;
const msg = document.getElementById('msg'), lvlEl = document.getElementById('lvl'), scEl = document.getElementById('sc');
const atlas = new Image();
atlas.src = new URL('../assets/atlas.png', import.meta.url).href;
const input = new Input(cv);
let fx = null;
const SPR = { brick: [[0, 0], [32, 0], [64, 0], [96, 0]], core: [0, 16, 32, 12], ball: [32, 16, 8, 8], paddle: [48, 16, 64, 10] };

let levels = [], progress = { level: 0, best: 0 };
let li = 0, bricks = [], ball, pad, lives = 3, score = 0, stuck = true, done = false;

function build(i) {
  const L = levels[i % levels.length];
  bricks = [];
  const bw = 56, bh = 21, ox = (W - L.rows[0].length * bw) / 2;
  L.rows.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '.') return;
    const core = ch === 'C';
    bricks.push({ x: ox + c * bw, y: 60 + r * bh, w: bw - 4, h: bh - 4, hp: core ? 3 : Number(ch) || 1, core, kind: core ? 0 : (Number(ch) - 1) % 4 });
  }));
  pad = { x: W / 2, w: 110, y: H - 40 };
  ball = { x: W / 2, y: pad.y - 12, vx: 0, vy: 0, r: 6, speed: 330 + i * 25 };
  stuck = true; msg.textContent = L.name + ' — click or Space to launch';
}
function launch() { const a = -Math.PI / 2 + (Math.random() - 0.5) * 0.8; ball.vx = Math.cos(a) * ball.speed; ball.vy = Math.sin(a) * ball.speed; stuck = false; msg.textContent = ''; }
async function hit(b) {
  b.hp--;
  if (!fx) { const mod = await import('./fx.js'); fx = new mod.Sparks(); }
  fx.burst(b.x + b.w / 2, b.y + b.h / 2, b.core ? '#ff2b3f' : '#c8ccd3', b.hp > 0 ? 6 : 20);
  if (b.hp > 0) return;
  bricks.splice(bricks.indexOf(b), 1);
  score += b.core ? 500 : 50;
  if (b.core) {
    li++; progress.level = Math.max(progress.level, li); progress.best = Math.max(progress.best, score);
    await store.save(progress);
    if (li >= levels.length) { done = true; msg.textContent = 'All cores breached. Score ' + score; return; }
    build(li);
  }
}
function step(dt) {
  if (!levels.length) return;
  if (input.x != null) pad.x = input.x;
  if (input.left) pad.x -= 520 * dt;
  if (input.right) pad.x += 520 * dt;
  pad.x = Math.max(pad.w / 2, Math.min(W - pad.w / 2, pad.x));
  if (stuck) { ball.x = pad.x; ball.y = pad.y - 12; if (input.consumeFire() && !done) launch(); }
  else {
    input.consumeFire();
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.x < ball.r || ball.x > W - ball.r) { ball.vx *= -1; ball.x = Math.max(ball.r, Math.min(W - ball.r, ball.x)); }
    if (ball.y < ball.r) { ball.vy = Math.abs(ball.vy); }
    if (ball.vy > 0 && ball.y + ball.r >= pad.y && ball.y < pad.y + 10 && Math.abs(ball.x - pad.x) < pad.w / 2 + ball.r) {
      const off = (ball.x - pad.x) / (pad.w / 2), a = -Math.PI / 2 + off * 1.05;
      ball.vx = Math.cos(a) * ball.speed; ball.vy = Math.sin(a) * ball.speed;
    }
    for (const b of bricks) {
      if (ball.x + ball.r > b.x && ball.x - ball.r < b.x + b.w && ball.y + ball.r > b.y && ball.y - ball.r < b.y + b.h) {
        const ox = Math.min(ball.x + ball.r - b.x, b.x + b.w - (ball.x - ball.r)), oy = Math.min(ball.y + ball.r - b.y, b.y + b.h - (ball.y - ball.r));
        if (ox < oy) ball.vx *= -1; else ball.vy *= -1;
        hit(b); break;
      }
    }
    if (ball.y > H + 20) { lives--; if (lives <= 0) { lives = 3; score = 0; li = progress.level; build(li); msg.textContent = 'Reboot. ' + msg.textContent; } else { stuck = true; } }
  }
  if (fx) fx.update(dt);
  draw();
}
function draw() {
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.04)';
  for (let x = 0; x <= W; x += 40) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); }
  for (const b of bricks) {
    const [sx, sy, sw, sh] = b.core ? SPR.core : [...SPR.brick[b.kind], 32, 12];
    if (b.core) { g.shadowColor = '#ff2b3f'; g.shadowBlur = 12 + Math.sin(performance.now() / 150) * 6; }
    g.globalAlpha = b.core ? 1 : 0.55 + 0.45 * Math.min(1, b.hp / 2);
    g.drawImage(atlas, sx, sy, sw, sh, b.x, b.y, b.w, b.h);
    g.globalAlpha = 1; g.shadowBlur = 0;
  }
  const [px, py, pw, ph] = SPR.paddle; g.drawImage(atlas, px, py, pw, ph, pad.x - pad.w / 2, pad.y, pad.w, 12);
  const [bx, by, bw, bh] = SPR.ball; g.shadowColor = '#fff'; g.shadowBlur = 10; g.drawImage(atlas, bx, by, bw, bh, ball.x - 6, ball.y - 6, 12, 12); g.shadowBlur = 0;
  if (fx) fx.draw(g);
  lvlEl.textContent = 'Core ' + (li % levels.length + 1) + ' / ' + levels.length + '   Lives ' + lives;
  scEl.textContent = 'Score ' + score + '   Best ' + Math.max(progress.best, score);
}

(async () => {
  [levels, progress] = await Promise.all([loadLevels(), store.load()]);
  await atlas.decode().catch(() => {});
  li = Math.min(progress.level, levels.length - 1);
  build(li);
  window.__CB_READY = { levels: levels.length, atlas: atlas.naturalWidth, progress };
  new Loop(step).start();
})().catch((e) => { msg.textContent = 'Failed to start: ' + e.message; });
