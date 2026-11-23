/* Player mode: KERFINATOR.html?play=<id> becomes the game itself.

   The tab loads the game's files from browser storage, turns each into a
   blob: URL, rewrites the start page so its resource references point at
   those blobs, injects the KERF_RUNTIME compatibility layer as the first
   script, and replaces this document with the game (document.open/write).
   The result is a plain browser tab containing only the game: it can go
   fullscreen on its own, and closing it never affects the launcher. */
K.player = (function () {
  var SCRIPT_OPEN = '<' + 'script', SCRIPT_CLOSE = '</' + 'script>';

  function screenEl() { return document.getElementById('player-screen'); }
  function status(text) { var s = document.getElementById('ps-status'); if (s) s.textContent = text; }
  function fail(title, detail) {
    var el = screenEl();
    el.classList.add('is-error');
    document.getElementById('ps-title').textContent = title;
    status(detail || '');
    var a = document.getElementById('ps-open');
    a.href = K.launcherUrl();
    a.hidden = false;
  }

  var SPEC_RE = [
    /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?(["'])([^"'\r\n]+)\1/g,
    /\bexport\s*(?:[\w$*{}\s,]+?\s*)from\s*(["'])([^"'\r\n]+)\1/g,
    /\bimport\s*\(\s*(["'])([^"'\r\n]+)\1\s*[,)]/g
  ];
  function specsOf(code) {
    var out = [];
    SPEC_RE.forEach(function (re) { re.lastIndex = 0; var m; while ((m = re.exec(code))) out.push(m[2]); });
    return out;
  }
  function attr(attrs, name) { var a = attrs.find(function (x) { return x.lname === name; }); return a ? a.value : null; }

  async function gunzip(blob, kind) {
    var head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (kind === 'gzip' && !(head[0] === 0x1f && head[1] === 0x8b)) return null;
    try { return await new Response(blob.stream().pipeThrough(new DecompressionStream(kind))).blob(); } catch (e) { return null; }
  }

  async function run(params) {
    var gid = params.get('play'), page = params.get('page'), sid = params.get('s') || K.uid('s');
    var game, user;
    try {
      await K.db.open();
      game = await K.db.get('games', gid);
      user = (await K.db.get('user', gid)) || {};
    } catch (e) { return fail('Browser storage is unavailable', (e && e.message) || String(e)); }
    if (!game) return fail('This game is not stored in this browser', 'Open KERFINATOR in this browser and import the game (or reconnect the KERFINATOR USB drive), then launch it from the library.');
    if (game.installing) return fail('This game is still being installed', 'Wait for the installation to finish in the KERFINATOR tab, then try again.');
    var title = user.title || game.title;
    document.title = title + ' — KERFINATOR';
    document.getElementById('ps-title').textContent = title;
    status('Loading files…');

    var recs = await K.db.filesOf(gid);
    if (!recs.length) return fail('This game’s files are missing', 'Remove it from the library and import it again.');

    var files = Object.create(null), rec = Object.create(null);
    recs.forEach(function (r) { files[r.p] = null; rec[r.p] = r; });
    var H = KERF_RUNTIME({ files: files }, 'helpers');
    var entry = (page && H.lookup(page)) || (user.entry && rec[user.entry] ? user.entry : null) || H.lookup(game.entry);
    if (!entry) return fail('The start page is missing', game.entry + ' is not in this game. Open the game’s details in KERFINATOR and choose another start page.');

    var blobs = Object.create(null);
    function track(path, blob) { blobs[path] = blob; return URL.createObjectURL(blob); }
    function typed(r, type) { return track(r.p, r.b.slice(0, r.b.size, type || K.mimeOf(r.p))); }
    function textURL(path, text, type) { return track(path, new Blob([text], { type: type })); }
    var staticMissing = [];
    function mapRef(ref, fromDir) {
      var r = H.staticRef(ref, fromDir);
      if (!r) return null;
      var real = H.lookup(r.path);
      if (!real) { if (staticMissing.indexOf(r.path) < 0) staticMissing.push(r.path); return null; }
      return files[real] ? files[real] + (r.hash || '') : null;
    }

    // 1. Plain assets (and transparent decompression of Unity-style *.gz builds)
    var cssPaths = [], jsPaths = [];
    var brotli = false;
    try { new DecompressionStream('brotli'); brotli = true; } catch (e) {}
    for (var p in rec) {
      var ext = K.ext(p);
      if (ext === 'css') { cssPaths.push(p); continue; }
      if (ext === 'js' || ext === 'mjs' || ext === 'cjs') { jsPaths.push(p); continue; }
      if (/\.(data|wasm|js|framework\.js|symbols\.json|mem|pck)\.(gz|br)$/i.test(p)) {
        var kind = /\.gz$/i.test(p) ? 'gzip' : 'brotli';
        if (kind === 'gzip' || brotli) {
          status('Unpacking ' + p.split('/').pop() + '…');
          var un = await gunzip(rec[p].b, kind);
          if (un) { files[p] = track(p, un.slice(0, un.size, K.mimeOf(p))); continue; }
        }
      }
      files[p] = typed(rec[p]);
    }

    // 2. Start page and the ES-module graph it uses
    status('Preparing game…');
    var html = await K.readHTMLText(rec[entry].b);
    var entryDir = H.dirOf(entry), docDir = entryDir;
    var modules = Object.create(null), queue = [], gameMap = null;
    function addModule(ref, fromDir, anyRelative) {
      if (!anyRelative && !/^(?:\.{1,2}\/|\/|kerf:)/.test(ref)) return;
      var r = H.staticRef(ref, fromDir), real = r && H.lookup(r.path);
      if (real && !(real in modules)) { modules[real] = null; queue.push(real); }
    }
    // Scan real tags only (never text inside scripts, which may contain HTML strings).
    var baseHref = null, moduleSrcs = [], inlineSpecs = [];
    H.rewriteHTML(html, docDir, function () { return null; }, {
      tag: function (tag, attrs) {
        if (tag === 'base' && baseHref === null && attr(attrs, 'href')) baseHref = attr(attrs, 'href');
        if (tag === 'script' && /^module$/i.test(attr(attrs, 'type') || '') && attr(attrs, 'src')) moduleSrcs.push(attr(attrs, 'src'));
        if (tag === 'link' && /modulepreload/i.test(attr(attrs, 'rel') || '') && attr(attrs, 'href')) moduleSrcs.push(attr(attrs, 'href'));
        return true;
      },
      raw: function (tag, attrs, content) {
        if (tag !== 'script') return null;
        var t = (attr(attrs, 'type') || '').toLowerCase();
        if (t === 'module') inlineSpecs = inlineSpecs.concat(specsOf(content));
        if (t === 'importmap') { try { gameMap = JSON.parse(content); } catch (e) {} }
        return null;
      }
    });
    // A relative <base href> moves where the page's own references point.
    // An absolute one (often a CDN) is dropped: the files are stored locally.
    if (baseHref && !/^[a-z][a-z0-9+.\-]*:|^\/\//i.test(baseHref)) {
      var br = H.staticRef(/\/$/.test(baseHref) ? baseHref + 'x' : baseHref, entryDir);
      if (br) docDir = H.dirOf(br.path);
    }
    moduleSrcs.forEach(function (s) { addModule(s, docDir, true); });
    inlineSpecs.forEach(function (s) { addModule(s, docDir); });
    if (gameMap && gameMap.imports) Object.keys(gameMap.imports).forEach(function (k) {
      var v = String(gameMap.imports[k]);
      if (/\/$/.test(v)) {
        // prefix mapping ("engine/": "./src/engine/"): every script below it may be imported
        var pr = H.staticRef(v + 'x', docDir), pre = pr ? H.dirOf(pr.path) : null;
        if (pre !== null) Object.keys(rec).forEach(function (fp) { if (fp.indexOf(pre) === 0 && /\.(m?js)$/i.test(fp)) addModule('/' + fp, ''); });
      } else addModule(v, docDir);
    });
    while (queue.length) {
      var mp = queue.shift();
      var code = await rec[mp].b.text();
      modules[mp] = code;
      specsOf(code).forEach(function (s) { addModule(s, H.dirOf(mp)); });
    }

    // 3. Scripts
    for (var j = 0; j < jsPaths.length; j++) {
      var jp = jsPaths[j];
      if (jp in modules) continue;
      var r = rec[jp];
      if (r.b.size < 48 * 1024 * 1024) {
        var src = await r.b.text();
        if (src.indexOf('location.protocol') >= 0) { files[jp] = textURL(jp, H.patchProtocol(src), 'text/javascript'); continue; }
      }
      files[jp] = typed(r, 'text/javascript');
    }
    var importMap = { imports: {} };
    for (var m in modules) {
      files[m] = textURL(m, H.patchProtocol(H.rewriteModule(modules[m], m)), 'text/javascript');
      importMap.imports[H.vurl(m)] = files[m];
    }
    if (gameMap && gameMap.imports) {
      Object.keys(gameMap.imports).forEach(function (k) {
        var v = String(gameMap.imports[k]), r = H.staticRef(v, docDir), real = r && H.lookup(r.path);
        var key = /^(?:\.{1,2}\/|\/)/.test(k) ? (function () { var kr = H.staticRef(k, docDir); return kr ? H.vurl(kr.path) : k; })() : k;
        if (/\/$/.test(v)) {
          // prefix mapping: expand to every module below that folder
          var pr2 = H.staticRef(v + 'x', docDir), prefix = pr2 ? H.dirOf(pr2.path) : '';
          Object.keys(modules).forEach(function (mp) { if (mp.indexOf(prefix) === 0) importMap.imports[key + mp.slice(prefix.length)] = files[mp]; });
        } else if (real && files[real]) importMap.imports[key] = files[real];
        else importMap.imports[key] = v;
      });
    }

    // 4. Stylesheets (resolving @import chains between them)
    var pendingCss = cssPaths.slice(), cssText = {};
    for (var c = 0; c < pendingCss.length; c++) cssText[pendingCss[c]] = await rec[pendingCss[c]].b.text();
    var guard = 0;
    while (pendingCss.length && guard++ < 50) {
      var progress = false;
      pendingCss = pendingCss.filter(function (cp) {
        var deps = [], re = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi, mm;
        while ((mm = re.exec(cssText[cp]))) { var dr = H.staticRef(mm[1], H.dirOf(cp)), dreal = dr && H.lookup(dr.path); if (dreal && dreal !== cp && pendingCss.indexOf(dreal) >= 0) deps.push(dreal); }
        if (deps.length && guard < 50) return true;
        files[cp] = textURL(cp, H.rewriteCSS(cssText[cp], H.dirOf(cp), mapRef), 'text/css');
        progress = true;
        return false;
      });
      if (!progress) guard = 50; // cycle: next pass resolves what it can
    }

    // 5. Remaining HTML pages (iframes, links) as plain blobs
    for (var hp in rec) if (!files[hp]) files[hp] = typed(rec[hp]);

    // 6. Rewrite the start page
    var inlineFrom = docDir + entry.split('/').pop();
    var headEnd = -1, htmlEnd = -1;
    var out = H.rewriteHTML(html, docDir, mapRef, {
      after: function (tag, pos) {
        if (tag === 'head' && headEnd < 0) headEnd = pos;
        if (tag === 'html' && htmlEnd < 0) htmlEnd = pos;
      },
      tag: function (tag, attrs) {
        if (tag === 'base') return false;
        if (tag === 'meta' && /content-security-policy/i.test(attr(attrs, 'http-equiv') || '')) return false;
        if (tag === 'script' && /^importmap$/i.test(attr(attrs, 'type') || '')) return false;
        if (tag === 'script' || tag === 'link') attrs.forEach(function (a) { if (a.lname === 'integrity') a.removed = true; });
        return true;
      },
      raw: function (tag, attrs, content) {
        if (tag === 'style') return H.rewriteCSS(content, docDir, mapRef);
        if (tag !== 'script' || attr(attrs, 'src')) return null;
        var t = (attr(attrs, 'type') || '').trim().toLowerCase();
        if (t === 'module') return H.patchProtocol(H.rewriteModule(content, inlineFrom));
        if (!t || /^(text|application)\/(x-)?(java|ecma)script$/.test(t)) return H.patchProtocol(content);
        return null;
      }
    });

    window.__KERF_BOOT = {
      files: files, entryDir: docDir, launcherDir: K.launcherDir(), launcherUrl: K.launcherUrl(), launcherFile: K.launcherFile(),
      gameId: gid, sessionId: sid, title: title, missing: staticMissing, blobs: blobs, subPage: !!page
    };
    var inject = SCRIPT_OPEN + '>(' + KERF_RUNTIME.toString() + ')(window.__KERF_BOOT,"window");try{delete window.__KERF_BOOT}catch(e){}' + SCRIPT_CLOSE;
    if (Object.keys(importMap.imports).length) {
      inject += SCRIPT_OPEN + ' type="importmap">' + JSON.stringify(importMap).replace(/</g, '\\u003c') + SCRIPT_CLOSE;
    }
    // Inject right after the real <head> (or <html>, or the doctype), so the
    // runtime runs before any of the game's own scripts.
    var at = headEnd >= 0 ? headEnd : htmlEnd;
    if (at < 0) { var dm = /^\s*<!doctype[^>]*>/i.exec(out); at = dm ? dm[0].length : 0; }
    out = out.slice(0, at) + inject + out.slice(at);

    status('Starting…');
    document.open();
    document.write(out);
    document.close();
  }

  return { run: run, fail: fail };
})();
