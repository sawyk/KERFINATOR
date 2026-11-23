#!/usr/bin/env node
/* KERFINATOR developer build (needs Node.js on the DEVELOPER's machine only).

   - Bundles src/ into one self-contained dist/KERFINATOR/KERFINATOR.html
     (CSS, JS and fonts inlined; nothing is fetched from anywhere).
   - Copies demo-games/* into dist/KERFINATOR/games/.
   - Packs those games into dist/KERFINATOR/library/ in exactly the format the
     in-app "Build USB library" tool writes, so the drive auto-installs them.

   End users and USB maintainers never need this: adding games is done with
   the launcher itself (Import tab, or System → Build USB library). */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist', 'KERFINATOR');
const CHUNK_BYTES = 8 * 1024 * 1024;

function bundle() {
  let css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  css = css.replace(/\/\*@FONT:([\w.\-]+)\*\//g, (m, f) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(SRC, 'fonts', f)).toString('base64'));
  const jsDir = path.join(SRC, 'js');
  const js = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort()
    .map((f) => '/* ---- ' + f + ' ---- */\n' + fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
  // An inline <script> must never contain these sequences, or the HTML parser ends/escapes it early.
  for (const bad of ['</script', '<!--', '<script']) {
    const i = js.toLowerCase().indexOf(bad);
    if (i >= 0) throw new Error('JS bundle contains "' + bad + '" near: ' + js.slice(Math.max(0, i - 60), i + 40));
  }
  if (css.toLowerCase().includes('</style')) throw new Error('CSS contains </style');
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  html = html.replace('/*@CSS*/', () => css).replace('/*@JS*/', () => js);
  return html;
}

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name), rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ path: rel, full, size: fs.statSync(full).size });
  }
  return out;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'game';

function packGame(name, dir, libDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'kerf.json'), 'utf8'));
  const files = walk(dir);
  const entry = meta.entry || 'index.html';
  let entryText = fs.readFileSync(path.join(dir, entry), 'utf8');
  if (entryText.charCodeAt(0) === 0xfeff) entryText = entryText.slice(1);
  // Same fingerprint as K.analyze in the browser: manifest + start page + its content.
  const manifest = files.map((f) => f.path + '\t' + f.size).sort().join('\n');
  const fp = sha(manifest + '\n#' + entry + '\n' + sha(entryText));
  const key = slug(name);
  const gdir = path.join(libDir, key);
  fs.mkdirSync(gdir, { recursive: true });
  let n = 0, cur = [], curBytes = 0;
  const flush = () => {
    if (!cur.length) return;
    const body = cur.map((c) => '[' + JSON.stringify(c.path) + ',' + c.part + ',' + c.parts + ',"' + c.buf.toString('base64') + '"]').join(',\n');
    fs.writeFileSync(path.join(gdir, n + '.js'), 'KERFINATOR_CHUNK(' + JSON.stringify(key) + ',' + n + ',[\n' + body + '\n]);\n');
    n++; cur = []; curBytes = 0;
  };
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const parts = Math.max(1, Math.ceil(buf.length / CHUNK_BYTES));
    for (let p = 0; p < parts; p++) {
      const slice = buf.subarray(p * CHUNK_BYTES, Math.min(buf.length, (p + 1) * CHUNK_BYTES));
      if (cur.length && curBytes + slice.length > CHUNK_BYTES) flush();
      cur.push({ path: f.path, part: p, parts, buf: slice }); curBytes += slice.length;
    }
  }
  flush();
  const images = files.filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f.path)).map((f) => f.path).slice(0, 24);
  return {
    key, title: meta.title, entry, cover: meta.cover || null, fp, size: files.reduce((a, f) => a + f.size, 0), files: files.length,
    chunks: n, external: [], images, candidates: [entry]
  };
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const html = bundle();
  fs.writeFileSync(path.join(OUT, 'KERFINATOR.html'), html);
  console.log('KERFINATOR.html', (html.length / 1024).toFixed(0) + ' KB');

  const demo = path.join(ROOT, 'demo-games');
  const gamesOut = path.join(OUT, 'games'), libOut = path.join(OUT, 'library');
  fs.mkdirSync(gamesOut, { recursive: true });
  fs.mkdirSync(libOut, { recursive: true });
  const catalog = [];
  if (fs.existsSync(demo)) {
    for (const name of fs.readdirSync(demo).sort()) {
      const dir = path.join(demo, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      fs.cpSync(dir, path.join(gamesOut, name), { recursive: true });
      const entry = packGame(name, dir, libOut);
      catalog.push(entry);
      console.log('packed', name, entry.files + ' files', entry.chunks + ' chunk(s)');
    }
  }
  fs.writeFileSync(path.join(libOut, 'catalog.js'),
    '/* KERFINATOR USB library catalog. Generated by KERFINATOR — do not edit by hand.\n   To change the games, edit the games folder and run "Build USB library" again. */\nKERFINATOR_CATALOG(' +
    JSON.stringify({ format: 1, generated: new Date().toISOString(), games: catalog }, null, 1) + ');\n');
  fs.copyFileSync(path.join(ROOT, 'docs', 'READ ME FIRST.txt'), path.join(OUT, 'READ ME FIRST.txt'));
  fs.copyFileSync(path.join(SRC, 'fonts', 'OFL-ChakraPetch.txt'), path.join(OUT, 'library', 'FONT-LICENSE.txt'));
  console.log('Output:', OUT);
}
if (require.main === module) main();
module.exports = { bundle, packGame };
