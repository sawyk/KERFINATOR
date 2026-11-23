export class Input {
  constructor(canvas) {
    this.x = null; this.left = false; this.right = false; this.fire = false;
    canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); this.x = (e.clientX - r.left) * (canvas.width / r.width); });
    canvas.addEventListener('mousedown', () => { this.fire = true; });
    addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'a') this.left = true; if (e.key === 'ArrowRight' || e.key === 'd') this.right = true; if (e.key === ' ') { this.fire = true; e.preventDefault(); } });
    addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'a') this.left = false; if (e.key === 'ArrowRight' || e.key === 'd') this.right = false; });
  }
  consumeFire() { const f = this.fire; this.fire = false; return f; }
}
