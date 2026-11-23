/* Importing: collect files from drag-and-drop, folder/file pickers or .zip
   archives, analyse them, and store accepted games in the library. */
K.importer = (function () {
  var UNSUPPORTED = {
    swf: 'Flash games (.swf) no longer run in any modern browser.',
    exe: 'Windows programs (.exe) cannot run in a browser. KERFINATOR runs HTML5 games only.',
    msi: 'Installers (.msi) cannot run in a browser.',
    apk: 'Android apps (.apk) cannot run in a browser.',
    rar: '.rar archives cannot be opened by a browser. Extract it first, then import the folder.',
    '7z': '.7z archives cannot be opened by a browser. Extract it first, then import the folder.',
    dmg: 'Mac disk images (.dmg) cannot run in a browser.',
    jar: 'Java games (.jar) cannot run in a browser.'
  };

  /* ---------- gathering ---------- */
  function entryFile(entry) { return new Promise(function (res, rej) { entry.file(res, rej); }); }
  function readAll(reader) {
    return new Promise(function (res, rej) {
      var all = [];
      (function next() {
        reader.readEntries(function (batch) { if (!batch.length) res(all); else { all = all.concat(Array.prototype.slice.call(batch)); next(); } }, rej);
      })();
    });
  }
  async function walkEntry(dir, prefix, out) {
    var list = await readAll(dir.createReader());
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.isDirectory) await walkEntry(e, prefix + e.name + '/', out);
      else { var f = await entryFile(e); out.push({ path: prefix + e.name, file: f, size: f.size }); }
    }
    return out;
  }
  async function walkHandle(dir, prefix, out) {
    for await (var pair of dir.entries()) {
      var name = pair[0], h = pair[1];
      if (h.kind === 'directory') await walkHandle(h, prefix + name + '/', out);
      else { var f = await h.getFile(); out.push({ path: prefix + name, file: f, size: f.size }); }
    }
    return out;
  }

  // Must be called synchronously inside the drop handler (the browser
  // forgets dropped entries once the event handler returns).
  function grabDrop(dt) {
    var items = [];
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind !== 'file') continue;
        var en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (en) items.push({ entry: en });
        else { var f = it.getAsFile(); if (f) items.push({ file: f }); }
      }
    } else if (dt.files) {
      for (var j = 0; j < dt.files.length; j++) items.push({ file: dt.files[j] });
    }
    return items;
  }

  // → sources: {kind:'folder', name, files} | {kind:'zip', file} | {kind:'loose', files} | {kind:'bad', name, error}
  async function sourcesFromDrop(items) {
    var sources = [], loose = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.entry && it.entry.isDirectory) {
        sources.push({ kind: 'folder', name: it.entry.name, files: await walkEntry(it.entry, '', []) });
      } else {
        var f = it.file || await entryFile(it.entry);
        classifyFile(f, sources, loose);
      }
    }
    if (loose.length) sources.push({ kind: 'loose', files: loose });
    return sources;
  }
  function classifyFile(f, sources, loose) {
    var ext = K.ext(f.name);
    if (ext === 'zip') sources.push({ kind: 'zip', file: f });
    else if (UNSUPPORTED[ext]) sources.push({ kind: 'bad', name: f.name, error: UNSUPPORTED[ext] });
    else loose.push({ path: f.name, file: f, size: f.size });
  }
  // <input type=file webkitdirectory>
  function sourcesFromFolderInput(fileList) {
    var files = Array.prototype.map.call(fileList, function (f) { return { path: f.webkitRelativePath || f.name, file: f, size: f.size }; });
    if (!files.length) return [];
    var name = files[0].path.split('/')[0];
    return [{ kind: 'folder', name: name, files: files }];
  }
  // <input type=file multiple>
  function sourcesFromFileInput(fileList) {
    var sources = [], loose = [];
    Array.prototype.forEach.call(fileList, function (f) { classifyFile(f, sources, loose); });
    if (loose.length) sources.push({ kind: 'loose', files: loose });
    return sources;
  }

  /* ---------- analysis ---------- */
  async function prepare(sources, onStatus) {
    var items = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], pkgs = [];
      try {
        if (s.kind === 'bad') { items.push({ name: s.name, error: s.error }); continue; }
        if (s.kind === 'zip') {
          onStatus && onStatus('Unpacking ' + s.file.name + '…');
          var files = await K.zip.unpack(s.file, function (p) { onStatus && onStatus('Unpacking ' + s.file.name + ' — ' + Math.round(p * 100) + '%'); });
          pkgs = K.analyze.split(files, s.file.name.replace(/\.zip$/i, ''));
        } else if (s.kind === 'folder') {
          pkgs = K.analyze.split(s.files, s.name);
        } else if (s.kind === 'loose') {
          var htmls = s.files.filter(function (f) { return K.isHTML(f.path); });
          var assets = s.files.filter(function (f) { return !K.isHTML(f.path) && !/\.(txt|md|url|nfo)$/i.test(f.path); });
          if (htmls.length > 1 && !assets.length) {
            // Several self-contained .html files picked together: one game each.
            pkgs = htmls.map(function (f) { return { name: f.path.replace(/\.[^.]+$/, ''), files: K.analyze.clean([f]) }; });
          } else {
            var nm = htmls.length ? htmls[0].path.replace(/\.[^.]+$/, '') : (s.files[0] ? s.files[0].path : 'Imported game');
            pkgs = [{ name: nm, files: K.analyze.clean(s.files) }];
          }
        }
      } catch (e) {
        items.push({ name: s.name || (s.file && s.file.name) || 'Import', error: e.message || String(e) });
        continue;
      }
      for (var j = 0; j < pkgs.length; j++) {
        onStatus && onStatus('Checking ' + pkgs[j].name + '…');
        try { items.push(await K.analyze.analyze(pkgs[j])); }
        catch (e) { items.push({ name: pkgs[j].name, error: 'Could not read this game: ' + (e.message || e) }); }
      }
    }
    // Duplicates (against the library and within this batch)
    var games = await K.db.getAll('games'), seen = {};
    items.forEach(function (it) {
      if (it.error) return;
      var same = games.find(function (g) { return g.fp === it.fp; });
      if (same) it.duplicateOf = same;
      else if (seen[it.fp]) it.duplicateInBatch = true;
      seen[it.fp] = 1;
      var sameTitle = !same && games.find(function (g) { return g.title.toLowerCase() === String(it.title).toLowerCase(); });
      if (sameTitle) it.sameTitleAs = sameTitle;
    });
    return items;
  }

  /* ---------- storing ---------- */
  async function ensureSpace(bytes) {
    if (!navigator.storage || !navigator.storage.estimate) return;
    var est = await navigator.storage.estimate();
    var free = (est.quota || Infinity) - (est.usage || 0);
    if (bytes * 1.05 + 20 * 1024 * 1024 > free) {
      throw new Error('Not enough browser storage: this game needs ' + K.formatBytes(bytes) + ' but only ' + K.formatBytes(free) + ' is available. Free up disk space or remove games you no longer play.');
    }
  }

  // info: result of analyze(); opts: {title, entry, cover, coverFile, id, source, usbKey, onProgress}
  async function commit(info, opts) {
    opts = opts || {};
    var id = opts.id || ('g' + info.fp.slice(0, 12) + (opts.copy ? '-' + K.uid().slice(-5) : ''));
    await ensureSpace(info.size);
    var prev = await K.db.get('games', id);
    if (prev) await K.db.deleteFiles(id);
    var files = info.files, batch = [], bytes = 0, written = 0;
    async function flush() {
      if (!batch.length) return;
      var b = batch; batch = []; bytes = 0;
      await K.db.tx('files', 'readwrite', function (tx) { var st = tx.objectStore('files'); b.forEach(function (r) { st.put(r); }); });
      written += b.length;
      if (opts.onProgress) opts.onProgress(written / files.length);
    }
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i], t = K.mimeOf(f.path);
        batch.push({ g: id, p: f.path, b: f.file.slice(0, f.file.size, t), t: t });
        bytes += f.size;
        if (batch.length >= 300 || bytes > 48 * 1024 * 1024) await flush();
      }
      await flush();
      // Integrity check: a file that could not be read (USB unplugged, no
      // permission) is stored by the browser as an empty blob without error.
      var expected = {};
      files.forEach(function (f) { expected[f.path] = f.size; });
      var bad = (await K.db.filesOf(id)).filter(function (r) { return r.b.size !== expected[r.p]; });
      if (bad.length) {
        var err = new Error('Some files could not be read (' + bad.slice(0, 3).map(function (r) { return r.p; }).join(', ') + (bad.length > 3 ? ', …' : '') + ').');
        err.unreadable = true;
        throw err;
      }
    } catch (e) {
      try { await K.db.deleteFiles(id); } catch (x) {}
      if (e && e.name === 'QuotaExceededError') throw new Error('The browser ran out of storage space while importing. Free up disk space and try again.');
      throw new Error((e && e.unreadable ? e.message : 'Saving the game failed: ' + (e.message || e) + '.') + ' Nothing was added. If the game is on a USB drive, make sure it is still connected, then try again.');
    }
    var title = (opts.title || info.title || 'Untitled game').trim();
    var coverPath = opts.coverFile ? null : (opts.cover !== undefined ? opts.cover : info.cover);
    var coverBlob = opts.coverFile || null;
    if (!coverBlob && coverPath) {
      var cf = files.find(function (f) { return f.path === coverPath; });
      if (cf) coverBlob = cf.file;
    }
    var thumb = await K.thumbs.make(coverBlob, title);
    var now = Date.now();
    var game = {
      id: id, title: title, entry: opts.entry || info.entry, cover: coverPath || null, thumb: thumb,
      files: files.length, size: info.size, fp: info.fp, source: opts.source || 'import', usbKey: opts.usbKey || null,
      added: prev ? prev.added : now, updated: now, external: info.external || [], images: info.images || [],
      candidates: info.candidates || [info.entry], installing: false
    };
    await K.db.put('games', game);
    K.lib.requestPersistence();
    return game;
  }

  return {
    grabDrop: grabDrop, sourcesFromDrop: sourcesFromDrop, sourcesFromFolderInput: sourcesFromFolderInput,
    sourcesFromFileInput: sourcesFromFileInput, walkHandle: walkHandle, prepare: prepare, commit: commit, ensureSpace: ensureSpace
  };
})();
