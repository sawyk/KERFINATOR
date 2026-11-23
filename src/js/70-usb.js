/* USB library.

   A page opened from file:// is not allowed to read neighbouring files
   (fetch/XHR of file:// is blocked) — but it IS allowed to run neighbouring
   script files. So the USB carries its games pre-packed as scripts:

     library/catalog.js          KERFINATOR_CATALOG({...list of games...})
     library/<game>/<n>.js       KERFINATOR_CHUNK("<game>", n, [[path, part, parts, base64], …])

   On first launch these load with zero clicks and are copied into browser
   storage, after which the USB can be removed. The packs are produced by
   the "Build USB library" tool (System tab) from plain game folders that
   the maintainer drops into games/. */
K.usb = (function () {
  var CHUNK_BYTES = 8 * 1024 * 1024;
  var state = { catalog: null, checked: false, installing: false, current: null, progress: 0, queue: [], errors: [] };
  var listeners = [];
  function emit() { listeners.forEach(function (fn) { try { fn(state); } catch (e) {} }); }

  async function detect() {
    if (state.checked) return state.catalog;
    state.checked = true;
    var got = null;
    window.KERFINATOR_CATALOG = function (c) { got = c; };
    try { await K.loadScript('library/catalog.js'); } catch (e) { got = null; }
    delete window.KERFINATOR_CATALOG;
    if (got && Array.isArray(got.games)) state.catalog = got;
    emit();
    return state.catalog;
  }

  function idFor(key) { return 'u-' + key; }

  async function pending() {
    if (!state.catalog) return [];
    var games = await K.db.getAll('games'), byId = {};
    games.forEach(function (g) { byId[g.id] = g; });
    return state.catalog.games.filter(function (c) {
      var g = byId[idFor(c.key)];
      if (g) return g.installing || g.fp !== c.fp;
      // the same game was already imported by hand: don't store it twice
      return !games.some(function (x) { return x.fp === c.fp; });
    });
  }

  function loadChunk(key, dir, n) {
    return new Promise(function (res, rej) {
      window.KERFINATOR_CHUNK = function (k, i, list) { if (k === key && i === n) res(list); };
      K.loadScript('library/' + encodeURIComponent(dir) + '/' + n + '.js').then(function () {
        setTimeout(function () { rej(new Error('Pack ' + key + '/' + n + '.js is damaged.')); }, 0);
      }, function () { rej(new Error('The USB drive was removed, or pack ' + key + '/' + n + '.js is missing.')); });
    });
  }

  async function installOne(c, onProgress) {
    var id = idFor(c.key);
    await K.importer.ensureSpace(c.size);
    var prev = await K.db.get('games', id);
    var now = Date.now();
    var record = {
      id: id, title: c.title, entry: c.entry, cover: c.cover || null, thumb: prev ? prev.thumb : null,
      files: c.files, size: c.size, fp: c.fp, source: 'usb', usbKey: c.key, added: prev ? prev.added : now, updated: now,
      external: c.external || [], images: c.images || [], candidates: c.candidates || [c.entry], installing: true
    };
    await K.db.put('games', record);
    await K.db.deleteFiles(id);
    var partial = {}, coverBlob = null;
    for (var n = 0; n < c.chunks; n++) {
      var list = await loadChunk(c.key, c.dir || c.key, n), puts = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i], path = item[0], part = item[1], parts = item[2];
        var bytes = K.b64decode(item[3]), t = K.mimeOf(path);
        var blob;
        if (parts === 1) blob = new Blob([bytes], { type: t });
        else {
          var acc = partial[path] || (partial[path] = []);
          acc[part] = new Blob([bytes]);
          if (acc.filter(Boolean).length < parts) continue;
          blob = new Blob(acc, { type: t }); delete partial[path];
        }
        puts.push({ g: id, p: path, b: blob, t: t });
        if (path === c.cover) coverBlob = blob;
      }
      list = null;
      if (puts.length) await K.db.tx('files', 'readwrite', function (tx) { var st = tx.objectStore('files'); puts.forEach(function (r) { st.put(r); }); });
      onProgress((n + 1) / c.chunks);
    }
    if (Object.keys(partial).length) throw new Error('Pack for "' + c.title + '" is incomplete. Rebuild the USB library.');
    record.thumb = await K.thumbs.make(coverBlob, c.title);
    record.installing = false;
    await K.db.put('games', record);
    K.lib.requestPersistence();
  }

  async function installAll() {
    if (state.installing) return;
    var list = await pending();
    if (!list.length) return;
    state.installing = true; state.queue = list.map(function (c) { return c.title; }); state.errors = []; emit();
    for (var i = 0; i < list.length; i++) {
      state.current = { title: list[i].title, index: i + 1, total: list.length }; state.progress = 0; emit();
      try {
        await installOne(list[i], function (p) { state.progress = p; emit(); });
        K.lib.changed();
      } catch (e) {
        state.errors.push(list[i].title + ': ' + (e.message || e));
        if (/storage/i.test(String(e.message))) break;
      }
    }
    state.installing = false; state.current = null; emit();
    K.lib.changed();
  }

  /* ---------------- builder (maintainer tool) ---------------- */
  async function readCatalogFrom(libDir) {
    try {
      var fh = await libDir.getFileHandle('catalog.js');
      var txt = await (await fh.getFile()).text();
      var s = txt.indexOf('KERFINATOR_CATALOG('), e = txt.lastIndexOf(')');
      return JSON.parse(txt.slice(s + 'KERFINATOR_CATALOG('.length, e));
    } catch (err) { return null; }
  }
  async function exists(dir, name, kind) {
    try { if (kind === 'dir') await dir.getDirectoryHandle(name); else await dir.getFileHandle(name); return true; } catch (e) { return false; }
  }

  async function pack(key, files, dir, onProgress, check) {
    var n = 0, cur = [], curBytes = 0, done = 0, total = files.reduce(function (a, f) { return a + f.size; }, 0) || 1;
    async function flush() {
      if (!cur.length) return;
      check();
      var fh = await dir.getFileHandle(n + '.js', { create: true }), w = await fh.createWritable();
      await w.write('KERFINATOR_CHUNK(' + JSON.stringify(key) + ',' + n + ',[\n');
      for (var i = 0; i < cur.length; i++) {
        var b64 = await K.blobToBase64(cur[i].blob);
        await w.write((i ? ',\n' : '') + '[' + JSON.stringify(cur[i].path) + ',' + cur[i].part + ',' + cur[i].parts + ',"' + b64 + '"]');
        done += cur[i].blob.size; onProgress(done / total);
      }
      await w.write('\n]);\n');
      onProgress(done / total, 'saving');   // closing is when the browser really writes to the drive
      await w.close();
      n++; cur = []; curBytes = 0;
    }
    for (var i = 0; i < files.length; i++) {
      var f = files[i], parts = Math.max(1, Math.ceil(f.size / CHUNK_BYTES));
      for (var p = 0; p < parts; p++) {
        var slice = f.file.slice(p * CHUNK_BYTES, Math.min(f.size, (p + 1) * CHUNK_BYTES));
        if (cur.length && curBytes + slice.size > CHUNK_BYTES) await flush();
        cur.push({ path: f.path, part: p, parts: parts, blob: slice }); curBytes += slice.size;
      }
    }
    await flush();
    return n;
  }

  /* root: FileSystemDirectoryHandle for the folder holding KERFINATOR.html.
     ctl.stopped = true stops the build at the next safe point.

     Safe to interrupt: a changed game is packed into a NEW folder
     (<game>-<fingerprint>), the catalog is written last, and old packs are
     removed only after that. If the build stops, fails or the drive is
     unplugged halfway, the previous catalog and its packs are untouched,
     so the USB library keeps working exactly as before. */
  async function build(root, log, ctl) {
    function check() {
      if (ctl && ctl.stopped) { var e = new Error('Stopped. The USB library still works exactly as it did before.'); e.stopped = true; throw e; }
    }
    var gamesDir;
    try { gamesDir = await root.getDirectoryHandle('games'); }
    catch (e) { throw new Error('The folder "' + root.name + '" has no "games" folder. Choose the folder that contains KERFINATOR.html and games.'); }
    var libDir = await root.getDirectoryHandle('library', { create: true });
    var prev = await readCatalogFrom(libDir), prevByKey = {};
    if (prev && prev.games) prev.games.forEach(function (g) { prevByKey[g.key] = g; });
    var out = [], used = {}, names = [];
    for await (var pair of gamesDir.entries()) if (pair[1].kind === 'directory' && pair[0][0] !== '.') names.push(pair);
    names.sort(function (a, b) { return a[0].localeCompare(b[0]); });
    if (!names.length) log({ type: 'warn', text: 'The games folder is empty. Put each game in its own folder inside it.' });
    for (var i = 0; i < names.length; i++) {
      check();
      var name = names[i][0], h = names[i][1];
      log({ type: 'step', text: 'Reading ' + name + '…' });
      var files = await K.importer.walkHandle(h, '', []);
      var pkgs = K.analyze.split(files, name);
      if (pkgs.length > 1) { log({ type: 'warn', text: name + ': contains several games. Put each game in its own folder inside games/.' }); continue; }
      var info = await K.analyze.analyze(pkgs[0]);
      if (info.error) { log({ type: 'error', text: name + ': skipped — ' + info.error }); continue; }
      if (info.needsEntryChoice) log({ type: 'warn', text: name + ': several possible start pages; using ' + info.entry + '. Add a kerf.json to choose another.' });
      var key = K.slugify(name), base = key, k = 2;
      while (used[key]) key = base + '-' + (k++);
      used[key] = 1;
      var entry = {
        key: key, dir: key, title: info.title, entry: info.entry, cover: info.cover, fp: info.fp, size: info.size, files: info.count,
        chunks: 0, external: info.external, images: info.images.slice(0, 24), candidates: info.candidates.slice(0, 12)
      };
      var old = prevByKey[key], oldDir = old && (old.dir || old.key);
      if (old && old.fp === info.fp && await exists(libDir, oldDir, 'dir')) {
        entry.chunks = old.chunks; entry.dir = oldDir;
        log({ type: 'ok', text: info.title + ' — unchanged' });
      } else {
        entry.dir = key + '-' + info.fp.slice(0, 8);
        if (await exists(libDir, entry.dir, 'dir')) await libDir.removeEntry(entry.dir, { recursive: true });   // left over from an interrupted build
        var dir = await libDir.getDirectoryHandle(entry.dir, { create: true });
        var title = info.title;
        entry.chunks = await pack(key, info.files, dir, function (p, phase) {
          log({ type: 'progress', text: (phase === 'saving' ? 'Saving ' : 'Packing ') + title + ' to the drive — ' + Math.round(p * 100) + '%' });
        }, check);
        log({ type: 'ok', text: info.title + ' — packed (' + K.formatBytes(info.size) + ')' });
      }
      out.push(entry);
    }
    check();
    log({ type: 'progress', text: 'Saving the game list…' });
    var cat = { format: 1, generated: new Date().toISOString(), games: out };
    var fh = await libDir.getFileHandle('catalog.js', { create: true }), w = await fh.createWritable();
    await w.write('/* KERFINATOR USB library catalog. Generated by KERFINATOR — do not edit by hand.\n   To change the games, edit the games folder and run "Build USB library" again. */\nKERFINATOR_CATALOG(' + JSON.stringify(cat, null, 1) + ');\n');
    await w.close();
    // Only now that the new list is saved: remove packs nothing refers to any more.
    var keep = {}; out.forEach(function (e) { keep[e.dir] = 1; });
    var stale = [];
    for await (var p of libDir.entries()) if (p[1].kind === 'directory' && !keep[p[0]]) stale.push(p[0]);
    for (var j = 0; j < stale.length; j++) { try { await libDir.removeEntry(stale[j], { recursive: true }); } catch (e) {} }
    if (stale.length) log({ type: 'ok', text: 'Cleaned up ' + stale.length + ' old pack' + (stale.length === 1 ? '' : 's') + '.' });
    return out;
  }

  return {
    state: state, detect: detect, pending: pending, installAll: installAll, build: build,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
