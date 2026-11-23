/* DEUTSCH DESTROYER — type the falling words before they reach the firewall. */
(function () {
  'use strict';
  var cv = document.getElementById('screen'), g = cv.getContext('2d');
  var W = 960, H = 600, FLOOR = 540;
  var panel = document.getElementById('panel'), bestEl = document.getElementById('best');
  var WORDS = [];
  var state = 'title', words = [], typed = '', target = null, score = 0, shields = 5, level = 1, cleared = 0;
  var spawnT = 0, beams = [], parts = [], shake = 0, combo = 0, last = 0;
  var best = Number(localStorage.getItem('dd-best') || 0);

  function norm(s) { return s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss'); }
  function showBest() { bestEl.textContent = best ? 'Best score: ' + best : ''; }
  showBest();

  // Word list arrives over fetch (relative path)
  fetch('data/words.json').then(function (r) { return r.json(); }).then(function (list) {
    WORDS = list; window.__DD_READY = true;
  }).catch(function (e) { bestEl.textContent = 'Could not load words: ' + e.message; });

  function start() {
    if (!WORDS.length) return;
    words = []; typed = ''; target = null; score = 0; shields = 5; level = 1; cleared = 0; combo = 0; spawnT = 0.5;
    beams = []; parts = []; state = 'play'; panel.classList.add('hidden');
  }
  function gameOver() {
    state = 'over';
    if (score > best) { best = score; localStorage.setItem('dd-best', String(best)); }
    panel.querySelector('h1').innerHTML = 'FIREWALL<br>BREACHED';
    panel.querySelector('p').textContent = 'Score ' + score + ' — level ' + level + '. Deutsch wins this round.';
    document.getElementById('start').textContent = 'Press Enter to try again';
    showBest();
    panel.classList.remove('hidden');
  }
  function spawn() {
    var pool = WORDS.filter(function (w) { var n = norm(w[0]).length; return n <= 4 + level * 2; });
    var w = pool[Math.floor(Math.random() * pool.length)] || WORDS[0];
    g.font = '600 26px system-ui, sans-serif';
    var width = g.measureText(w[0]).width;
    words.push({ de: w[0], en: w[1], key: norm(w[0]), x: 40 + Math.random() * (W - 80 - width), y: -10, w: width, v: 22 + level * 6 + Math.random() * 10 });
  }
  function explode(x, y, n, col) {
    for (var i = 0; i < n; i++) { var a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 260; parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.5 + Math.random() * 0.6, c: col }); }
  }
  function onKey(e) {
    if (state !== 'play') { if (e.key === 'Enter') start(); return; }
    if (e.key === 'Backspace') { typed = typed.slice(0, -1); e.preventDefault(); return; }
    if (e.key === 'Escape') { typed = ''; target = null; return; }
    if (e.key.length !== 1) return;
    var ch = norm(e.key);
    var next = typed + ch;
    var cand = target && target.key.indexOf(next) === 0 ? target : null;
    if (!cand) cand = words.filter(function (w) { return w.key.indexOf(next) === 0; }).sort(function (a, b) { return b.y - a.y; })[0] || null;
    if (!cand) { combo = 0; shake = 4; return; }
    target = cand; typed = next;
    if (typed === target.key) destroy(target);
  }
  function destroy(w) {
    beams.push({ x: w.x + w.w / 2, y: w.y, t: 0.18 });
    explode(w.x + w.w / 2, w.y - 8, 26, '#ff2b3f');
    SFX.play('laser', 0.35); SFX.play('boom', 0.25);
    combo++; score += w.key.length * 10 * Math.min(combo, 8); cleared++;
    if (cleared % 8 === 0) level++;
    words.splice(words.indexOf(w), 1); typed = ''; target = null;
  }
  function update(dt) {
    if (state === 'play') {
      spawnT -= dt;
      if (spawnT <= 0) { spawn(); spawnT = Math.max(0.9, 3 - level * 0.22) * (0.7 + Math.random() * 0.6); }
      for (var i = words.length - 1; i >= 0; i--) {
        var w = words[i]; w.y += w.v * dt;
        if (w.y >= FLOOR) {
          words.splice(i, 1); if (w === target) { target = null; typed = ''; }
          shields--; combo = 0; shake = 14; explode(w.x + w.w / 2, FLOOR, 40, '#c8d0da'); SFX.play('alarm', 0.4);
          if (shields <= 0) gameOver();
        }
      }
    }
    parts.forEach(function (p) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.t -= dt; });
    parts = parts.filter(function (p) { return p.t > 0; });
    beams.forEach(function (b) { b.t -= dt; }); beams = beams.filter(function (b) { return b.t > 0; });
    shake = Math.max(0, shake - dt * 40);
  }
  function draw() {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#060607'; g.fillRect(0, 0, W, H);
    if (shake) g.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    g.strokeStyle = '#121419'; g.lineWidth = 1;
    for (var x = 0; x < W; x += 40) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
    // firewall
    for (var s = 0; s < 5; s++) {
      g.fillStyle = s < shields ? '#c8102e' : '#24272c';
      g.fillRect(40 + s * ((W - 80) / 5) + 4, FLOOR + 8, (W - 80) / 5 - 8, 6);
    }
    g.fillStyle = '#1b1d21'; g.fillRect(W / 2 - 22, H - 36, 44, 36);
    g.fillStyle = '#ff2b3f'; g.fillRect(W / 2 - 4, H - 44, 8, 10);
    beams.forEach(function (b) {
      g.strokeStyle = 'rgba(255,43,63,' + (b.t / 0.18) + ')'; g.lineWidth = 4; g.shadowColor = '#ff2b3f'; g.shadowBlur = 16;
      g.beginPath(); g.moveTo(W / 2, H - 44); g.lineTo(b.x, b.y - 8); g.stroke(); g.shadowBlur = 0;
    });
    words.forEach(function (w) {
      var isT = w === target;
      g.font = '600 26px system-ui, sans-serif';
      if (isT) {
        var done = 0, n = 0;
        for (var i = 0; i < w.de.length && n < typed.length; i++) { n += norm(w.de[i]).length; done = i + 1; }
        var a = w.de.slice(0, done), aw = g.measureText(a).width;
        g.fillStyle = '#ff2b3f'; g.fillText(a, w.x, w.y);
        g.fillStyle = '#ffffff'; g.fillText(w.de.slice(done), w.x + aw, w.y);
        g.strokeStyle = '#ff2b3f'; g.lineWidth = 1; g.strokeRect(w.x - 8, w.y - 28, w.w + 16, 50);
      } else { g.fillStyle = '#dfe3e8'; g.fillText(w.de, w.x, w.y); }
      g.font = '13px system-ui, sans-serif'; g.fillStyle = '#6b717a'; g.fillText(w.en, w.x, w.y + 16);
    });
    parts.forEach(function (p) { g.globalAlpha = Math.max(0, Math.min(1, p.t * 2)); g.fillStyle = p.c; g.fillRect(p.x, p.y, 3, 3); });
    g.globalAlpha = 1;
    g.font = '600 18px system-ui, sans-serif'; g.fillStyle = '#dfe3e8';
    g.fillText('SCORE ' + score, 24, 34); g.fillText('LEVEL ' + level, W - 120, 34);
    if (combo > 1) { g.fillStyle = '#ff5a66'; g.fillText('x' + Math.min(combo, 8), 24, 60); }
    if (typed) { g.fillStyle = '#ff2b3f'; g.font = '600 20px system-ui, sans-serif'; g.fillText('> ' + typed, W / 2 - 60, H - 52); }
  }
  function frame(t) {
    var dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    update(dt); draw(); requestAnimationFrame(frame);
  }
  window.addEventListener('keydown', onKey);
  document.getElementById('start').addEventListener('click', start);
  requestAnimationFrame(frame);
})();
