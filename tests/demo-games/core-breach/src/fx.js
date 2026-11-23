// Particle effects, loaded on demand with a dynamic import.
export class Sparks {
  constructor() { this.list = []; }
  burst(x, y, color, n = 18) {
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 240; this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.4 + Math.random() * 0.5, color }); }
  }
  update(dt) { for (const p of this.list) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 420 * dt; p.t -= dt; } this.list = this.list.filter((p) => p.t > 0); }
  draw(g) { for (const p of this.list) { g.globalAlpha = Math.min(1, p.t * 2); g.fillStyle = p.color; g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); } g.globalAlpha = 1; }
}
