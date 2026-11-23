/* Cover thumbnails: every cover is normalised once, at import time, into a
   small 4:3 image so the library grid loads fast and crops consistently.
   Games without usable art get a generated plate in KERFINATOR's style. */
K.thumbs = (function () {
  var W = 640, H = 480;

  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return function () { seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function loadImage(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Image could not be decoded')); };
      img.src = url;
    });
  }

  function backdrop(g, seed) {
    var r = rng(seed);
    g.fillStyle = '#08090a'; g.fillRect(0, 0, W, H);
    // machined grid
    g.strokeStyle = 'rgba(255,255,255,0.035)'; g.lineWidth = 1;
    for (var x = 0.5; x < W; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (var y = 0.5; y < H; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    // circuit traces
    g.lineWidth = 2;
    for (var i = 0; i < 7; i++) {
      var px = Math.round(r() * 20) * 32, py = Math.round(r() * 15) * 32;
      g.strokeStyle = i === 0 ? 'rgba(200,16,46,0.55)' : 'rgba(150,160,175,' + (0.06 + r() * 0.08).toFixed(3) + ')';
      g.beginPath(); g.moveTo(px, py);
      for (var s = 0; s < 4; s++) {
        if (r() < 0.5) px += (r() < 0.5 ? -1 : 1) * Math.round(1 + r() * 5) * 32; else py += (r() < 0.5 ? -1 : 1) * Math.round(1 + r() * 4) * 32;
        g.lineTo(px, py);
      }
      g.stroke();
      g.fillStyle = g.strokeStyle; g.fillRect(px - 3, py - 3, 6, 6);
    }
    // vignette
    var v = g.createRadialGradient(W * 0.5, H * 0.45, 40, W * 0.5, H * 0.5, W * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.7)');
    g.fillStyle = v; g.fillRect(0, 0, W, H);
  }

  function wrapLines(g, text, maxW, maxLines) {
    var words = String(text).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] += '…'; }
    return lines;
  }

  async function generated(g, title) {
    backdrop(g, hash(title));
    try { await document.fonts.load('700 64px "Chakra Petch"'); } catch (e) {}
    var size = 64;
    g.font = '700 ' + size + 'px "Chakra Petch", "Segoe UI", sans-serif';
    var lines = wrapLines(g, String(title).toUpperCase(), W - 96, 3);
    while (lines.some(function (l) { return g.measureText(l).width > W - 96; }) && size > 34) {
      size -= 4; g.font = '700 ' + size + 'px "Chakra Petch", "Segoe UI", sans-serif'; lines = wrapLines(g, String(title).toUpperCase(), W - 96, 3);
    }
    var lh = size * 1.02, y0 = H - 64 - (lines.length - 1) * lh;
    g.fillStyle = '#c8102e'; g.fillRect(48, y0 - size - 22, 44, 4);
    g.fillStyle = '#e6e9ee'; g.textBaseline = 'alphabetic';
    lines.forEach(function (l, i) { g.fillText(l, 46, y0 + i * lh); });
  }

  async function make(blob, title) {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d');
    var done = false;
    if (blob) {
      try {
        var li = await loadImage(blob), img = li.img;
        var iw = img.naturalWidth || 512, ih = img.naturalHeight || 512;
        var ar = iw / ih;
        var iconLike = (iw <= 320 && ih <= 320) || (ar > 0.8 && ar < 1.25 && Math.max(iw, ih) <= 600) || K.ext(blob.name || '') === 'ico';
        if (iconLike) {
          backdrop(g, hash(title || 'x'));
          var glow = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, 220);
          glow.addColorStop(0, 'rgba(200,16,46,0.28)'); glow.addColorStop(1, 'rgba(200,16,46,0)');
          g.fillStyle = glow; g.fillRect(0, 0, W, H);
          var s = Math.min(240 / Math.max(iw, ih), 2.5), dw = iw * s, dh = ih * s;
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
        } else {
          var scale = Math.max(W / iw, H / ih), sw = W / scale, sh = H / scale;
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, W, H);
        }
        URL.revokeObjectURL(li.url);
        done = true;
      } catch (e) { done = false; }
    }
    if (!done) await generated(g, title || 'Untitled');
    return await new Promise(function (res) {
      c.toBlob(function (b) {
        if (b && b.type === 'image/webp') res(b); else c.toBlob(res, 'image/png');
      }, 'image/webp', 0.86);
    });
  }

  return { make: make };
})();
