export class Loop {
  constructor(step) { this.step = step; this.last = 0; this.running = false; }
  start() { this.running = true; requestAnimationFrame((t) => this.tick(t)); }
  tick(t) {
    const dt = Math.min(0.033, (t - this.last) / 1000 || 0);
    this.last = t;
    this.step(dt);
    if (this.running) requestAnimationFrame((n) => this.tick(n));
  }
}
