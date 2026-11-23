/* Builds test games that exercise the hard parts of running HTML5 games
   from browser storage: relative paths of every kind, workers, wasm,
   ES modules, compressed builds, save systems, odd folder layouts. */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function w(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function makePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + x * 4 + i] = v; });
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_1PX_RED = makePng(8, 8, [220, 20, 40, 255]);
const WASM_ADD = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);
function wav() {
  const n = 2205, d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
}

// Minimal zip writer (deflate) for the zip-import fixture.
function zip(entries) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = []; let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name), comp = zlib.deflateRawSync(data), c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(c, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(c, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

module.exports = function make(root) {
  fs.rmSync(root, { recursive: true, force: true });

  /* 1. Kitchen sink: classic multi-file game touching every loading path */
  const K = path.join(root, 'kitchen-sink');
  w(path.join(K, 'index.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Kitchen Sink Test</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<link rel="stylesheet" href="css/style.css" integrity="sha256-bogus">
</head><body>
<img id="logo" src="img/logo.png" alt="">
<img id="svgcover" src="./cover.svg" alt="">
<div id="probe-import"></div><div id="probe-bg"></div>
<script>window.__PROTO = location.protocol;</script>
<script src="js/boot.js"></script>
</body></html>`);
  w(path.join(K, 'css/style.css'), `@import url("extra.css");\nbody { background-image: url('../img/logo.png'); }\n#probe-bg { width: 4px; height: 4px; background: url("../IMG/Logo.PNG"); }`);
  w(path.join(K, 'css/extra.css'), '#probe-import { width: 7px; height: 1px; }');
  w(path.join(K, 'img/logo.png'), PNG_1PX_RED);
  w(path.join(K, 'cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#c8102e"/></svg>');
  w(path.join(K, 'data/info.json'), JSON.stringify({ ok: true, name: 'kitchen' }));
  w(path.join(K, 'data/blob.bin'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  w(path.join(K, 'sfx/beep.wav'), wav());
  w(path.join(K, 'wasm/add.wasm'), WASM_ADD);
  w(path.join(K, 'build/game.data.gz'), zlib.gzipSync(Buffer.from('UNCOMPRESSED-PAYLOAD')));
  w(path.join(K, 'js/helper.js'), 'self.HELPER = 42;');
  w(path.join(K, 'js/worker.js'), `importScripts('helper.js');
fetch('../data/info.json').then(r => r.json()).then(j => postMessage({ helper: self.HELPER, ok: j.ok })).catch(e => postMessage({ err: String(e) }));`);
  w(path.join(K, 'js/dyn.js'), 'window.__DYN = 1;');

  w(path.join(K, 'js/boot.js'), `(function () {
  var T = window.__T = {};
  var pending = 0;
  function check(name, fn) {
    pending++;
    Promise.resolve().then(fn).then(function (v) { T[name] = v === true ? 'ok' : 'FAIL: ' + JSON.stringify(v); }, function (e) { T[name] = 'FAIL: ' + (e && e.message || e); })
      .then(function () { if (--pending === 0) window.__DONE = true; });
  }
  var scriptDir = document.currentScript.src.replace(/[^/]*$/, '');
  function loaded(el) { return new Promise(function (res, rej) { if (el.complete && el.naturalWidth) return res(); el.onload = res; el.onerror = function () { rej(new Error('load error ' + el.src)); }; }); }
  check('fetch', function () { return fetch('data/info.json').then(function (r) { return r.json(); }).then(function (j) { return j.ok === true; }); });
  check('fetchCaseInsensitive', function () { return fetch('DATA/Info.JSON').then(function (r) { return r.ok; }); });
  check('xhrMissing404', function () { return new Promise(function (res) { var x = new XMLHttpRequest(); x.open('GET', 'saves/slot1.ini'); x.onload = function () { res(x.status === 404 || x.status); }; x.onerror = function () { res('xhr error instead of 404'); }; x.send(); }); });
  check('fetchMissing404', function () { return fetch('data/missing.json').then(function (r) { return r.status === 404 || r.status; }); });
  check('fetchLocationRelative', function () { return fetch(new URL('data/info.json', location.href)).then(function (r) { return r.ok; }); });
  check('fetchFromScriptDir', function () { return fetch(scriptDir + '../data/info.json').then(function (r) { return r.ok || scriptDir; }); });
  check('xhrArrayBuffer', function () { return new Promise(function (res) { var x = new XMLHttpRequest(); x.open('GET', 'data/blob.bin'); x.responseType = 'arraybuffer'; x.onload = function () { res(x.status === 200 && x.response.byteLength === 10 || [x.status, x.response && x.response.byteLength]); }; x.onerror = function () { res('xhr error'); }; x.send(); }); });
  check('staticImg', function () { return loaded(document.getElementById('logo')).then(function () { return true; }); });
  check('svgImg', function () { return loaded(document.getElementById('svgcover')).then(function () { return document.getElementById('svgcover').naturalWidth === 64; }); });
  check('imageCanvasWebGL', function () {
    var img = new Image(); img.src = 'img/logo.png';
    return loaded(img).then(function () {
      var c = document.createElement('canvas'), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      var px = g.getImageData(1, 1, 1, 1).data;
      var gl = document.createElement('canvas').getContext('webgl');
      if (gl) { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); if (gl.getError()) return 'webgl error'; }
      return px[0] > 200 || Array.from(px);
    });
  });
  check('audio', function () { return new Promise(function (res) { var a = new Audio('sfx/beep.wav'); a.onloadeddata = function () { res(true); }; a.onerror = function () { res('audio error'); }; }); });
  check('webAudioDecode', function () { return fetch('sfx/beep.wav').then(function (r) { return r.arrayBuffer(); }).then(function (b) { return new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(b); }).then(function (buf) { return buf.duration > 0.05; }); });
  check('worker', function () { return new Promise(function (res) { var wk = new Worker('js/worker.js'); wk.onmessage = function (e) { res(e.data.helper === 42 && e.data.ok === true || e.data); }; wk.onerror = function (e) { res('worker error ' + e.message); }; }); });
  check('dynamicScript', function () { return new Promise(function (res) { var s = document.createElement('script'); s.src = 'js/dyn.js'; s.onload = function () { res(window.__DYN === 1); }; s.onerror = function () { res('script error'); }; document.head.appendChild(s); }); });
  check('innerHTML', function () { var d = document.createElement('div'); d.innerHTML = '<img id="ih" src="img/logo.png">'; document.body.appendChild(d); return new Promise(function (r) { setTimeout(r, 50); }).then(function () { return loaded(document.getElementById('ih')); }).then(function () { return true; }); });
  check('styleProperty', function () { var d = document.createElement('div'); document.body.appendChild(d); d.style.backgroundImage = 'url(img/logo.png)'; return new Promise(function (r) { setTimeout(r, 50); }).then(function () { return /blob:/.test(getComputedStyle(d).backgroundImage) || getComputedStyle(d).backgroundImage; }); });
  check('cssImportAndUrl', function () { return getComputedStyle(document.getElementById('probe-import')).width === '7px' && /blob:/.test(getComputedStyle(document.body).backgroundImage) && /blob:/.test(getComputedStyle(document.getElementById('probe-bg')).backgroundImage) || [getComputedStyle(document.getElementById('probe-import')).width, getComputedStyle(document.body).backgroundImage]; });
  check('protocolShim', function () { return window.__PROTO === 'https:' || window.__PROTO; });
  check('wasmStreaming', function () { return WebAssembly.instantiateStreaming(fetch('wasm/add.wasm')).then(function (m) { return m.instance.exports.add(2, 3) === 5; }); });
  check('gzipBuild', function () { return fetch('build/game.data.gz').then(function (r) { return r.text(); }).then(function (t) { return t === 'UNCOMPRESSED-PAYLOAD' || t.slice(0, 20); }); });
  check('localStorageSave', function () { var n = Number(localStorage.getItem('runs') || 0) + 1; localStorage.setItem('runs', String(n)); localStorage.bracket = 'yes'; window.__RUNS = n; return localStorage.getItem('runs') === String(n) && localStorage.bracket === 'yes' && Object.keys(localStorage).indexOf('runs') >= 0; });
  check('indexedDBSave', function () {
    return new Promise(function (res) {
      var r = indexedDB.open('sinkdb', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('s'); };
      r.onsuccess = function () {
        var db = r.result, tx = db.transaction('s', 'readwrite'), st = tx.objectStore('s');
        var g = st.get('n');
        g.onsuccess = function () { var v = (g.result || 0) + 1; st.put(v, 'n'); window.__IDB = v; st.put({ when: new Date(0), bytes: new Uint8Array([9, 8, 7]) }, 'blobby'); };
        tx.oncomplete = function () { res(db.name === 'sinkdb' || db.name); };
      };
      r.onerror = function () { res('idb error'); };
    });
  });
  check('cookie', function () { document.cookie = 'kc=yum; max-age=3600'; return /kc=yum/.test(document.cookie) || document.cookie; });
})();`);

  /* 2. ES modules + game-supplied import map */
  const M = path.join(root, 'module-game');
  w(path.join(M, 'index.html'), `<!DOCTYPE html><html><head><title>Module Test</title>
<script type="importmap">{"imports":{"util":"./lib/util.js"}}</script></head><body>
<script type="module">import { tag } from './lib/util.js'; window.__INLINE = tag;</script>
<script type="module" src="main.mjs"></script></body></html>`);
  w(path.join(M, 'main.mjs'), `import { add } from './lib/math.js';
import util from 'util';
const T = window.__T = {};
T.staticImport = add(2, 2) === 4 ? 'ok' : 'FAIL';
T.bareImportMap = util.name === 'util' ? 'ok' : 'FAIL';
const late = await import('./lib/late.js');
T.dynamicImport = late.value === 'late' ? 'ok' : 'FAIL';
const r = await fetch(new URL('./assets/x.json', import.meta.url));
T.importMetaUrl = (await r.json()).x === 1 ? 'ok' : 'FAIL';
T.inlineModule = window.__INLINE === 'util-tag' ? 'ok' : 'FAIL ' + window.__INLINE;
window.__DONE = true;`);
  w(path.join(M, 'lib/math.js'), 'export const add = (a, b) => a + b;');
  w(path.join(M, 'lib/util.js'), "export default { name: 'util' }; export const tag = 'util-tag';");
  w(path.join(M, 'lib/late.js'), "import { add } from '../lib/math.js'; export const value = add(1, 1) === 2 ? 'late' : 'bad';");
  w(path.join(M, 'assets/x.json'), '{"x":1}');

  /* 3. Zip with a wrapper folder, readme, nested start page */
  w(path.join(root, 'nested-game.zip'), zip([
    ['Nested Game v1.2/readme.txt', Buffer.from('read me')],
    ['Nested Game v1.2/game/index.html', Buffer.from('<!DOCTYPE html><meta charset="utf-8"><title>Nested Zip Game</title><img id="u" src="img/my%20logo%20%C3%BC.png"><script src="js/a.js"></script>')],
    ['Nested Game v1.2/game/js/a.js', Buffer.from(`window.__T = { zipScript: "ok" };
var im = document.getElementById("u");
Promise.all([new Promise(function (r) { if (im.complete) r(im.naturalWidth > 0); else { im.onload = function () { r(true); }; im.onerror = function () { r(false); }; } }),
  fetch("data/naïve file.json").then(function (r) { return r.json(); }).then(function (j) { return j.u === 1; }, function () { return false; })])
  .then(function (v) { window.__T.unicodeNames = v[0] && v[1] ? "ok" : "FAIL " + v; window.__DONE = true; });`)],
    ['Nested Game v1.2/game/img/my logo ü.png', PNG_1PX_RED],
    ['Nested Game v1.2/game/data/naïve file.json', Buffer.from('{"u":1}')],
    ['Nested Game v1.2/game/thumbnail.png', PNG_1PX_RED],
    ['__MACOSX/._junk', Buffer.from('x')]
  ]));

  /* 4. Two equally plausible start pages */
  w(path.join(root, 'ambiguous/alpha.html'), '<!DOCTYPE html><title>Alpha</title><script>window.__DONE=true;window.__T={page:"alpha"}</script>');
  w(path.join(root, 'ambiguous/beta.html'), '<!DOCTYPE html><title>Beta</title><script>window.__DONE=true;window.__T={page:"beta"}</script>');

  /* 5. Not a game */
  w(path.join(root, 'not-a-game/photo.png'), PNG_1PX_RED);
  w(path.join(root, 'not-a-game/notes.txt'), 'hello');

  /* 6. Single self-contained HTML file */
  w(path.join(root, 'tiny-game.html'), '<!DOCTYPE html><html><head><title>Tiny Single File</title></head><body><canvas></canvas><script>window.__T={single:"ok"};window.__DONE=true;</script></body></html>');

  /* 6a. Single files that rebuild themselves with document.write (like Ruffle/JSZip
     packs): the page has no <head> of its own, only one inside a JS string. */
  w(path.join(root, 'singles/self-writer.html'), `<html>
<script>
var page = "<html lang=\\"en\\">\\r\\n<head>\\r\\n<title>inner</title>\\r\\n</head>\\r\\n<body><div id=\\"inner\\">ok</div><script>window.__DONE=true;window.__T={selfWriter:document.getElementById('inner')?'ok':'FAIL'};<\\/script></body></html>";
setTimeout(function () { document.open(); document.write(page); document.close(); }, 10);
</script>
</html>`);
  // A big single-file game (> 8 MB of embedded data) whose title must still be found.
  w(path.join(root, 'singles/big-single.html'), '<!DOCTYPE html><html><head><title>Big Single File</title></head><body><script>window.__T={big:"ok"};window.__DONE=true;</script><!--' + 'x'.repeat(9 * 1024 * 1024) + '--></body></html>');

  /* 6b. A newer version of the single-file game (same title, different content) */
  w(path.join(root, 'tiny-v2/tiny-game.html'), '<!DOCTYPE html><html><head><title>Tiny Single File</title></head><body><script>window.__T={single:"ok",version:2};window.__DONE=true;</script></body></html>');

  /* 7. Collection: a folder of game folders */
  w(path.join(root, 'collection/game-one/index.html'), '<!DOCTYPE html><title>Collection One</title><script>window.__DONE=true;window.__T={c:"one"}</script>');
  w(path.join(root, 'collection/game-two/index.html'), '<!DOCTYPE html><title>Collection Two</title><script>window.__DONE=true;window.__T={c:"two"}</script>');

  /* 8. Multi-page + a missing asset + online dependency */
  w(path.join(root, 'multipage/index.html'), '<!DOCTYPE html><title>Multi Page</title><body><a id="next" href="level2.html">Next</a><img src="img/not-there.png"><script src="https://cdn.example.invalid/lib.js"></script><script>window.__DONE=true</script></body>');
  w(path.join(root, 'multipage/level2.html'), '<!DOCTYPE html><title>Level Two</title><script>window.__LEVEL2 = localStorage.getItem("shared") || "none"; window.__DONE=true;</script>');
  /* 9. A real engine: Phaser 3 (WebGL renderer, XHR loader, Web Audio) */
  let phaser = null;
  try { phaser = require.resolve('phaser/dist/phaser.min.js'); } catch (e) {}
  if (phaser) {
    const P = path.join(root, 'phaser-game');
    w(path.join(P, 'lib/phaser.min.js'), fs.readFileSync(phaser));
    w(path.join(P, 'assets/sprites/ship.png'), makePng(32, 16, [200, 210, 220, 255]));
    w(path.join(P, 'assets/sprites/sheet.png'), makePng(64, 16, [255, 43, 63, 255]));
    w(path.join(P, 'assets/audio/beep.wav'), wav());
    w(path.join(P, 'assets/data/config.json'), JSON.stringify({ speed: 3, title: 'phaser' }));
    w(path.join(P, 'index.html'), '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Phaser Engine Test</title></head><body style="margin:0;background:#000"><script src="lib/phaser.min.js"></script><script src="game.js"></script></body></html>');
    w(path.join(P, 'game.js'), `new Phaser.Game({
  type: Phaser.WEBGL, width: 320, height: 240, backgroundColor: '#050506', audio: { disableWebAudio: false },
  scene: {
    preload() {
      this.load.on('loaderror', (f) => { (window.__ERR = window.__ERR || []).push(f.key + ':' + f.url); });
      this.load.image('ship', 'assets/sprites/ship.png');
      this.load.spritesheet('sheet', 'assets/sprites/sheet.png', { frameWidth: 16, frameHeight: 16 });
      this.load.json('config', 'assets/data/config.json');
      this.load.audio('beep', ['assets/audio/beep.wav']);
    },
    create() {
      this.add.image(160, 120, 'ship');
      const cfg = this.cache.json.get('config');
      const s = this.sound.add('beep');
      window.__T = {
        renderer: this.game.renderer.type === Phaser.WEBGL ? 'ok' : 'FAIL canvas fallback',
        image: this.textures.exists('ship') && this.textures.get('ship').getSourceImage().width === 32 ? 'ok' : 'FAIL',
        spritesheet: this.textures.get('sheet').frameTotal >= 4 ? 'ok' : 'FAIL ' + this.textures.get('sheet').frameTotal,
        json: cfg && cfg.speed === 3 ? 'ok' : 'FAIL',
        audio: this.cache.audio.exists('beep') && s ? 'ok' : 'FAIL',
        loaderErrors: window.__ERR ? 'FAIL ' + window.__ERR.join() : 'ok'
      };
      window.__DONE = true;
    }
  }
});`);
  }
  return root;
};
