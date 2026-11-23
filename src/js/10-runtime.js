/* =====================================================================
   KERFINATOR GAME RUNTIME
   ---------------------------------------------------------------------
   This function is serialised (Function.prototype.toString) and injected
   as the very first script of every game page, and into every Worker a
   game starts. It must therefore be completely self-contained: no
   references to anything outside its own body.

   Modes:
     'helpers' – returns pure path / rewriting helpers (used by the player
                 before the game document exists). No patching.
     'window'  – installs the full compatibility layer in a game tab.
     'worker'  – installs the subset that makes sense inside a Worker.

   Why this exists: a page opened from file:// cannot use a Service
   Worker or a local server, and fetch()/XHR of file:// URLs are blocked.
   Every game file therefore lives in IndexedDB and is exposed as a blob:
   URL. Blob URLs are not hierarchical, so relative paths used by the game
   ("img/hero.png", "../data/level1.json") are resolved here against a
   virtual directory tree and swapped for the matching blob URL.
   ===================================================================== */
function KERF_RUNTIME(C, MODE) {
  'use strict';
  var VROOT = 'kerf://g/';
  C = C || {};
  var FILES = C.files || {};              // game path -> blob URL (final, rewritten)
  var ENTRY_DIR = C.entryDir || '';       // directory of the page being played
  var LDIR = C.launcherDir || '';         // file:///…/ directory of KERFINATOR.html
  var hasOwn = Object.prototype.hasOwnProperty;

  /* ---------------- path helpers ---------------- */
  function normPath(p) {
    var out = [];
    String(p).replace(/\\/g, '/').split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') out.pop(); else out.push(seg);
    });
    return out.join('/');
  }
  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function vurl(path) {
    var enc = String(path).split('/').map(encodeURIComponent).join('/');
    try { return new URL(VROOT + enc).href; } catch (e) { return VROOT + enc; }
  }
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|#39);/gi, function (m, e) {
      var l = e.toLowerCase();
      if (l === 'amp') return '&'; if (l === 'quot') return '"'; if (l === 'apos' || l === '#39') return "'";
      if (l === 'lt') return '<'; if (l === 'gt') return '>';
      var code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      return isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }
  function attrEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  /* Resolve a reference written inside a game file, relative to fromDir.
     Returns {path, hash} for a reference into the game, or null when the
     reference points somewhere else (data:, http:, fragment-only, …). */
  function staticRef(ref, fromDir) {
    if (ref == null) return null;
    var s = String(ref).trim();
    if (!s || s[0] === '#') return null;
    var vm = /^kerf:\/\/g\/([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
    if (vm) return { path: normPath(safeDecode(vm[1])), hash: vm[3] || '' };
    if (/^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(s)) return null; // other scheme / protocol-relative
    var m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
    if (!m || !m[1]) return null;
    var p = safeDecode(m[1]);
    var path = p[0] === '/' ? normPath(p) : normPath((fromDir || '') + p);
    return { path: path, hash: m[3] || '' };
  }

  /* Tolerant lookup: exact → case-insensitive (Windows-authored games are
     often sloppy about case) → unique path-suffix match. */
  var LOWER = null, BYNAME = null;
  function buildIndex() {
    LOWER = Object.create(null); BYNAME = Object.create(null);
    for (var k in FILES) {
      if (!hasOwn.call(FILES, k)) continue;
      var lk = k.toLowerCase();
      if (!(lk in LOWER)) LOWER[lk] = k;
      var b = lk.slice(lk.lastIndexOf('/') + 1);
      (BYNAME[b] || (BYNAME[b] = [])).push(k);
    }
  }
  function lookup(path) {
    if (hasOwn.call(FILES, path)) return path;
    if (!LOWER) buildIndex();
    var lp = path.toLowerCase();
    if (lp in LOWER) return LOWER[lp];
    var b = lp.slice(lp.lastIndexOf('/') + 1), list = BYNAME[b], best = null;
    if (list) for (var i = 0; i < list.length; i++) {
      var lk = list[i].toLowerCase();
      if (lk === lp || lk.slice(-(lp.length + 1)) === '/' + lp || lp.slice(-(lk.length + 1)) === '/' + lk) {
        if (best === null || list[i].length < best.length) best = list[i];
      }
    }
    return best;
  }

  /* ---------------- text rewriters ---------------- */
  // mapFn(ref, fromDir) -> replacement URL string, or null to leave untouched
  function rewriteCSS(css, fromDir, mapFn) {
    return String(css)
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi, function (m, a, b, c) {
        var ref = a != null ? a : (b != null ? b : c);
        var u = mapFn(ref, fromDir);
        return u == null ? m : 'url("' + u + '")';
      })
      .replace(/@import\s+(["'])([^"']+)\1/gi, function (m, q, ref) {
        var u = mapFn(ref, fromDir);
        return u == null ? m : '@import url("' + u + '")';
      });
  }
  function rewriteSrcset(v, fromDir, mapFn) {
    return String(v).split(',').map(function (part) {
      var m = /^(\s*)(\S+)(.*)$/.exec(part);
      if (!m) return part;
      var u = mapFn(m[2], fromDir);
      return u == null ? part : m[1] + u + m[3];
    }).join(',');
  }

  // Which attributes of which elements carry resource URLs.
  function urlAttrKind(tag, name) {
    if (name === 'src' || name === 'poster' || name === 'background') return 'url';
    if (name === 'data' && tag === 'object') return 'url';
    if (name === 'srcset') return 'srcset';
    if (name === 'style') return 'style';
    if ((name === 'href' || name === 'xlink:href') &&
        (tag === 'link' || tag === 'image' || tag === 'use' || tag === 'feimage')) return 'url';
    return null;
  }

  /* Lossless, tolerant HTML rewriter. It walks the markup as text (no
     DOM re-serialisation, so odd-but-working markup survives intact) and
     only touches resource attributes and raw-text element contents.
     hooks.tag(tag, attrs) may return false to drop a tag, or mutate attrs.
     hooks.raw(tag, attrs, content) returns replacement raw-text content.
     hooks.after(tag, outLength) reports where each real tag ends in the
     output (tags inside scripts, styles and comments are never seen). */
  function rewriteHTML(html, fromDir, mapFn, hooks) {
    hooks = hooks || {};
    var out = '', pos = 0, n = html.length;
    var tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:\-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    var attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    while (pos < n) {
      var lt = html.indexOf('<', pos);
      if (lt < 0) { out += html.slice(pos); break; }
      out += html.slice(pos, lt);
      if (html.startsWith('<!' + '--', lt)) {
        var ce = html.indexOf('-->', lt + 4);
        var cend = ce < 0 ? n : ce + 3;
        out += html.slice(lt, cend); pos = cend; continue;
      }
      tagRe.lastIndex = lt;
      var m = tagRe.exec(html);
      if (!m || m.index !== lt) { out += '<'; pos = lt + 1; continue; }
      pos = tagRe.lastIndex;
      var closing = m[1], tag = m[2].toLowerCase(), attrText = m[3];
      if (closing) { out += m[0]; continue; }
      var attrs = [];
      attrRe.lastIndex = 0;
      var am, selfClose = /\/\s*$/.test(attrText);
      while ((am = attrRe.exec(attrText))) {
        if (am[1] === '/') continue;
        var val = am[2] != null ? am[2] : (am[3] != null ? am[3] : am[4]);
        attrs.push({ name: am[1], lname: am[1].toLowerCase(), value: val == null ? null : decodeEntities(val), raw: am[0], changed: false });
      }
      for (var i = 0; i < attrs.length; i++) {
        var a = attrs[i];
        if (a.value == null) continue;
        var kind = urlAttrKind(tag, a.lname);
        if (!kind) continue;
        var nv = null;
        if (kind === 'url') { if (a.value[0] !== '#') nv = mapFn(a.value, fromDir); }
        else if (kind === 'srcset') nv = rewriteSrcset(a.value, fromDir, mapFn);
        else if (kind === 'style' && /url\(/i.test(a.value)) nv = rewriteCSS(a.value, fromDir, mapFn);
        if (nv != null && nv !== a.value) { a.value = nv; a.changed = true; }
      }
      var keep = hooks.tag ? hooks.tag(tag, attrs) : true;
      var rawText = (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title' || tag === 'xmp');
      var content = null, afterClose = pos;
      if (rawText && !selfClose) {
        var closeRe = new RegExp('</' + tag + '\\s*>', 'ig');
        closeRe.lastIndex = pos;
        var cm = closeRe.exec(html);
        var cEnd = cm ? cm.index : n;
        content = html.slice(pos, cEnd);
        afterClose = cm ? closeRe.lastIndex : n;
        if (hooks.raw && keep !== false) { var r = hooks.raw(tag, attrs, content); if (r != null) content = r; }
        else if (tag === 'style' && /url\(|@import/i.test(content)) content = rewriteCSS(content, fromDir, mapFn);
      }
      if (keep === false) { pos = afterClose; continue; }
      var rebuilt = '<' + m[2];
      for (var j = 0; j < attrs.length; j++) {
        var at = attrs[j];
        if (at.removed) continue;
        if (!at.changed) rebuilt += ' ' + at.raw;
        else rebuilt += ' ' + at.name + '="' + attrEscape(at.value) + '"';
      }
      rebuilt += (selfClose ? ' />' : '>');
      out += rebuilt;
      if (hooks.after) hooks.after(tag, out.length, attrs);
      if (content !== null) { out += content + '</' + m[2] + '>'; pos = afterClose; }
    }
    return out;
  }

  // ES module specifiers → absolute virtual URLs (resolved by an import map)
  function rewriteModule(code, fromPath) {
    var dir = dirOf(fromPath);
    function fix(spec) {
      if (!/^(?:\.{1,2}\/|\/)/.test(spec)) return null; // bare specifiers & URLs left alone
      var r = staticRef(spec, dir);
      return r ? vurl(r.path) : null;
    }
    code = String(code)
      .replace(/(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:[\w$*{}\s,]+?\s*)from\s*)(["'])([^"'\r\n]+)\2/g,
        function (m, pre, q, spec) { var f = fix(spec); return f ? pre + q + f + q : m; })
      .replace(/\bimport\s*\(\s*(["'])([^"'\r\n]+)\1\s*([,)])/g,
        function (m, q, spec, end) { var f = fix(spec); return f ? 'import(' + q + f + q + end : m; })
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(vurl(fromPath)));
    return code;
  }

  // Some engines refuse to start on file:// after a protocol check. The game
  // tab really runs from file://, but its files are served like a web server
  // would serve them, so it reports the protocol a web host would.
  function patchProtocol(code) {
    code = String(code);
    if (code.indexOf('location.protocol') < 0) return code;
    return code.replace(/\blocation\.protocol\b(?!\s*=(?!=))/g, '__kerfLoc.protocol');
  }

  var helpers = {
    VROOT: VROOT, normPath: normPath, dirOf: dirOf, vurl: vurl, staticRef: staticRef,
    rewriteCSS: rewriteCSS, rewriteHTML: rewriteHTML, rewriteSrcset: rewriteSrcset,
    rewriteModule: rewriteModule, patchProtocol: patchProtocol, decodeEntities: decodeEntities,
    lookup: function (path) { return lookup(path); },
    lookupIn: function (files, path) { FILES = files; LOWER = null; return lookup(path); }
  };
  if (MODE === 'helpers') return helpers;

  /* =================== live patching (window / worker) =================== */
  var G = self;
  var BLOB2PATH = Object.create(null);
  for (var fk in FILES) if (hasOwn.call(FILES, fk)) BLOB2PATH[FILES[fk]] = fk;
  var UUID_BLOB = /^blob:.*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:#.*)?$/i;
  /* Missing files come in two kinds. A page, stylesheet or element that
     references a file that isn't there is a real breakage (critical). A
     fetch/XHR for a file that doesn't exist is usually deliberate: engines
     probe for save files and optional configs, and wrappers point dead
     analytics at dummy URLs. Those get a normal 404 and no warning. */
  var missing = [], probed = [], missingSeen = Object.create(null);
  var onMissing = null;
  function noteMissing(p, probe) {
    var key = (probe ? 'p:' : 'c:') + p;
    if (missingSeen[key]) return;
    missingSeen[key] = 1;
    if (probe) { probed.push(p); return; }
    missing.push(p);
    try { console.warn('[KERFINATOR] Missing game file: ' + p); } catch (e) {}
    if (onMissing) onMissing(p);
  }

  function gamePathOf(url, baseDir) {
    var s = String(url);
    if (BLOB2PATH[s.split('#')[0]]) return null;            // already one of ours
    var bd = baseDir == null ? ENTRY_DIR : baseDir;
    if (/^blob:/i.test(s)) {
      if (UUID_BLOB.test(s)) return null;                   // a blob the game made itself
      // e.g. "blob:null/game.wasm" — built from a script's blob: URL
      return staticRef(s.replace(/^blob:(?:[a-z]+:\/*[^\/]*|null)?\/?/i, ''), bd);
    }
    if (/^file:/i.test(s)) {
      if (LDIR && s.toLowerCase().indexOf(LDIR.toLowerCase()) === 0) {
        var rest = s.slice(LDIR.length);
        if (/^[^\/?#]+\.html?(?:[?#]|$)/i.test(rest) && C.launcherFile && rest.indexOf(C.launcherFile) === 0) return null;
        return staticRef(rest, ENTRY_DIR);
      }
      return null;
    }
    return staticRef(s, bd);
  }
  function resolveUrl(url, baseDir, probe) {
    if (url == null) return null;
    var r = gamePathOf(url, baseDir);
    if (!r) return null;
    var real = lookup(r.path);
    if (real == null) { noteMissing(r.path, probe); return { missing: r.path }; }
    return { url: FILES[real] + (r.hash || ''), path: real };
  }
  function mapUrl(url, baseDir) {
    try { var r = resolveUrl(url, baseDir); return r && r.url ? r.url : url; } catch (e) { return url; }
  }
  function mapRef(ref, fromDir) {
    var r = resolveUrl(ref, fromDir);
    return r && r.url ? r.url : null;
  }

  /* ---- fetch ---- */
  var oFetch = G.fetch;
  if (oFetch) {
    G.fetch = function (input, init) {
      try {
        var isReq = typeof Request !== 'undefined' && input instanceof Request;
        var r = resolveUrl(isReq ? input.url : (input && input.href) || input, undefined, true);
        if (r) {
          if (r.missing) return Promise.resolve(new Response('Not found: ' + r.missing, { status: 404, statusText: 'Not Found' }));
          var method = (init && init.method) || (isReq ? input.method : 'GET');
          var sig = (init && init.signal) || (isReq ? input.signal : undefined);
          if (/^head$/i.test(method)) {
            return oFetch.call(G, r.url, { signal: sig }).then(function (res) {
              return new Response(null, { status: 200, statusText: 'OK', headers: res.headers });
            });
          }
          return oFetch.call(G, r.url, sig ? { signal: sig } : undefined);
        }
      } catch (e) {}
      return oFetch.apply(G, arguments);
    };
  }

  /* ---- XMLHttpRequest ---- */
  if (G.XMLHttpRequest) {
    var oXOpen = XMLHttpRequest.prototype.open;
    var XP = XMLHttpRequest.prototype, oXSend = XP.send, emptyUrl = null;
    XP.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      this.__kerf404 = false;
      try {
        var r = resolveUrl(url && url.href ? url.href : url, undefined, true);
        if (r && r.url) { args[1] = r.url; if (/^head$/i.test(method)) args[0] = 'GET'; }
        else if (r && r.missing) {
          // A file the game asks for that isn't part of it: answer like a web
          // server would (404), instead of a blocked file:// request.
          if (!emptyUrl) emptyUrl = URL.createObjectURL(new Blob([]));
          args[0] = 'GET'; args[1] = emptyUrl; this.__kerf404 = true;
        }
      } catch (e) {}
      return oXOpen.apply(this, args);
    };
    XP.send = function () {
      if (this.__kerf404) {
        Object.defineProperty(this, 'status', { configurable: true, get: function () { return this.readyState >= 2 ? 404 : 0; } });
        Object.defineProperty(this, 'statusText', { configurable: true, get: function () { return this.readyState >= 2 ? 'Not Found' : ''; } });
      }
      return oXSend.apply(this, arguments);
    };
  }

  /* ---- per-game storage namespaces ----
     Every page opened from file:// shares ONE storage area in Chromium.
     Each game therefore gets its own key/database prefix so games cannot
     overwrite each other's saves (or KERFINATOR's own data) by accident. */
  var NS = 'kfg:' + (C.gameId || 'unknown') + ':';
  if (G.IDBFactory) {
    var IDBF = IDBFactory.prototype;
    var oIdbOpen = IDBF.open, oIdbDel = IDBF.deleteDatabase, oIdbList = IDBF.databases;
    IDBF.open = function (name) { var a = Array.prototype.slice.call(arguments); a[0] = NS + String(name); return oIdbOpen.apply(this, a); };
    IDBF.deleteDatabase = function (name) { var a = Array.prototype.slice.call(arguments); a[0] = NS + String(name); return oIdbDel.apply(this, a); };
    if (oIdbList) IDBF.databases = function () {
      return oIdbList.call(this).then(function (list) {
        return list.filter(function (d) { return d.name.indexOf(NS) === 0; })
          .map(function (d) { return { name: d.name.slice(NS.length), version: d.version }; });
      });
    };
    var dn = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
    if (dn && dn.get) Object.defineProperty(IDBDatabase.prototype, 'name', {
      configurable: true, enumerable: dn.enumerable,
      get: function () { var v = dn.get.call(this); return v.indexOf(NS) === 0 ? v.slice(NS.length) : v; }
    });
  }

  if (MODE === 'worker') {
    if (typeof importScripts === 'function') {
      var oImport = importScripts;
      G.importScripts = function () {
        return oImport.apply(G, Array.prototype.map.call(arguments, function (u) { return mapUrl(u); }));
      };
    }
    G.__kerfLoc = { protocol: 'https:' };
    return;
  }

  /* =================== window-only below =================== */
  var D = document;
  var realLS = null;
  try { realLS = G.localStorage; } catch (e) {}
  G.__kerfLoc = { protocol: 'https:' };
  try { D.__kerfLoc = G.__kerfLoc; } catch (e) {}

  if (realLS) {
    var keyCache = null;
    var nsKeys = function () {
      if (keyCache) return keyCache;
      keyCache = [];
      for (var i = 0; i < realLS.length; i++) { var k = realLS.key(i); if (k && k.indexOf(NS) === 0) keyCache.push(k.slice(NS.length)); }
      return keyCache;
    };
    G.addEventListener('storage', function () { keyCache = null; });
    var api = {
      getItem: function (k) { return realLS.getItem(NS + k); },
      setItem: function (k, v) { realLS.setItem(NS + k, String(v)); keyCache = null; },
      removeItem: function (k) { realLS.removeItem(NS + k); keyCache = null; },
      clear: function () { nsKeys().slice().forEach(function (k) { realLS.removeItem(NS + k); }); keyCache = null; },
      key: function (i) { var ks = nsKeys(); return i >= 0 && i < ks.length ? ks[i] : null; }
    };
    var target = Object.create(Storage.prototype);
    var proxy = new Proxy(target, {
      get: function (t, p) {
        if (p === 'length') return nsKeys().length;
        if (hasOwn.call(api, p)) return api[p];
        if (typeof p === 'symbol') return t[p];
        if (p in Object.prototype) return Object.prototype[p];
        var v = realLS.getItem(NS + p); return v === null ? undefined : v;
      },
      set: function (t, p, v) { if (typeof p !== 'symbol') api.setItem(p, v); return true; },
      deleteProperty: function (t, p) { api.removeItem(p); return true; },
      has: function (t, p) { return p === 'length' || hasOwn.call(api, p) || realLS.getItem(NS + String(p)) !== null; },
      ownKeys: function () { return nsKeys().slice(); },
      getOwnPropertyDescriptor: function (t, p) {
        var v = typeof p === 'symbol' ? null : realLS.getItem(NS + p);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      }
    });
    try { Object.defineProperty(G, 'localStorage', { configurable: true, enumerable: true, get: function () { return proxy; } }); } catch (e) {}

    // Chromium has no cookies on file:// — emulate them so cookie-based saves work.
    var CK = 'kfc:' + (C.gameId || 'unknown');
    var readJar = function () {
      var jar = {}; try { jar = JSON.parse(realLS.getItem(CK) || '{}') || {}; } catch (e) {}
      var now = Date.now(), dirty = false;
      for (var k in jar) if (jar[k].e && jar[k].e < now) { delete jar[k]; dirty = true; }
      if (dirty) realLS.setItem(CK, JSON.stringify(jar));
      return jar;
    };
    try {
      Object.defineProperty(D, 'cookie', {
        configurable: true,
        get: function () { var jar = readJar(); return Object.keys(jar).map(function (k) { return k + '=' + jar[k].v; }).join('; '); },
        set: function (str) {
          var parts = String(str).split(';'), first = parts.shift(), eq = first.indexOf('=');
          var name = (eq < 0 ? '' : first.slice(0, eq)).trim(), value = (eq < 0 ? first : first.slice(eq + 1)).trim();
          var exp = 0;
          parts.forEach(function (p) {
            var kv = p.split('='), key = kv[0].trim().toLowerCase(), v = (kv.slice(1).join('=') || '').trim();
            if (key === 'max-age') exp = Date.now() + Number(v) * 1000;
            if (key === 'expires') { var t = Date.parse(v); if (!isNaN(t)) exp = t; }
          });
          var jar = readJar();
          if (exp && exp <= Date.now()) delete jar[name]; else jar[name] = { v: value, e: exp || 0 };
          try { realLS.setItem(CK, JSON.stringify(jar)); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  /* ---- DOM resource properties ---- */
  function hookProp(proto, prop, kind, virtualGetter) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get: virtualGetter ? function () { var v = d.get.call(this); var p = BLOB2PATH[v]; return p ? vurl(p) : v; } : d.get,
      set: function (v) { d.set.call(this, kind === 'srcset' ? rewriteSrcset(v, ENTRY_DIR, mapRef) : mapUrl(v)); }
    });
  }
  function P(name) { return G[name] && G[name].prototype; }
  hookProp(P('HTMLImageElement'), 'src');
  hookProp(P('HTMLImageElement'), 'srcset', 'srcset');
  // script.src reads back as a virtual URL so engines that derive their base
  // path from document.currentScript.src (Emscripten, Unity, Godot…) work.
  hookProp(P('HTMLScriptElement'), 'src', null, true);
  hookProp(P('HTMLLinkElement'), 'href');
  hookProp(P('HTMLMediaElement'), 'src');
  hookProp(P('HTMLSourceElement'), 'src');
  hookProp(P('HTMLSourceElement'), 'srcset', 'srcset');
  hookProp(P('HTMLVideoElement'), 'poster');
  hookProp(P('HTMLIFrameElement'), 'src');
  hookProp(P('HTMLEmbedElement'), 'src');
  hookProp(P('HTMLObjectElement'), 'data');
  hookProp(P('HTMLInputElement'), 'src');
  hookProp(P('HTMLTrackElement'), 'src');

  var oSetAttr = Element.prototype.setAttribute, oSetAttrNS = Element.prototype.setAttributeNS;
  function mapAttr(el, lname, value) {
    var kind = urlAttrKind(el.localName, lname);
    if (!kind || value == null) return undefined;
    var v = String(value);
    if (kind === 'url') return v[0] === '#' ? undefined : mapUrl(v);
    if (kind === 'srcset') return rewriteSrcset(v, ENTRY_DIR, mapRef);
    if (kind === 'style') return /url\(/i.test(v) ? rewriteCSS(v, ENTRY_DIR, mapRef) : undefined;
    return undefined;
  }
  Element.prototype.setAttribute = function (name, value) {
    try { var nv = mapAttr(this, String(name).toLowerCase(), value); if (nv !== undefined) return oSetAttr.call(this, name, nv); } catch (e) {}
    return oSetAttr.apply(this, arguments);
  };
  Element.prototype.setAttributeNS = function (ns, name, value) {
    try {
      var local = String(name).toLowerCase().replace(/^.*:/, '');
      var nv = mapAttr(this, local === 'href' ? 'href' : local, value);
      if (nv !== undefined) return oSetAttrNS.call(this, ns, name, nv);
    } catch (e) {}
    return oSetAttrNS.apply(this, arguments);
  };

  // element.style.backgroundImage = 'url(img/x.png)' and friends: remap at
  // once, because a layout read right after would otherwise load the wrong path.
  if (G.CSSStyleDeclaration) {
    var CSD = CSSStyleDeclaration.prototype, oSetProp = CSD.setProperty;
    var styleMap = function (v) { v = v == null ? v : String(v); return v && /url\(/i.test(v) ? rewriteCSS(v, ENTRY_DIR, mapRef) : v; };
    CSD.setProperty = function (name, value, prio) { return oSetProp.call(this, name, styleMap(value), prio === undefined ? '' : prio); };
    var ct = Object.getOwnPropertyDescriptor(CSD, 'cssText');
    if (ct && ct.set) Object.defineProperty(CSD, 'cssText', { configurable: true, enumerable: ct.enumerable, get: ct.get, set: function (v) { ct.set.call(this, styleMap(v)); } });
    ['background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage', 'content', 'cursor',
      'mask', 'maskImage', 'webkitMask', 'webkitMaskImage', 'webkitBorderImage', 'shapeOutside'].forEach(function (prop) {
      var dashed = prop.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }).replace(/^webkit-/, '-webkit-');
      try {
        Object.defineProperty(CSD, prop, {
          configurable: true, enumerable: true,
          get: function () { return this.getPropertyValue(dashed); },
          set: function (v) { oSetProp.call(this, dashed, styleMap(v)); }
        });
      } catch (e) {}
    });
  }

  // Catch-all for markup inserted via innerHTML / insertAdjacentHTML and
  // style changes made through element.style.
  function fixEl(el) {
    var at = el.attributes;
    if (at) for (var i = 0; i < at.length; i++) {
      var a = at[i], ln = a.localName.toLowerCase();
      var nv = mapAttr(el, ln, a.value);
      if (nv !== undefined && nv !== a.value) {
        if (a.namespaceURI) oSetAttrNS.call(el, a.namespaceURI, a.name, nv); else oSetAttr.call(el, a.name, nv);
      }
    }
    if (el.localName === 'style' && /url\(|@import/i.test(el.textContent)) {
      var t = rewriteCSS(el.textContent, ENTRY_DIR, mapRef);
      if (t !== el.textContent) el.textContent = t;
    }
  }
  var mo = new MutationObserver(function (recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      try {
        if (r.type === 'attributes') { fixEl(r.target); continue; }
        for (var j = 0; j < r.addedNodes.length; j++) {
          var nd = r.addedNodes[j];
          if (nd.nodeType !== 1) { if (nd.parentNode && nd.parentNode.localName === 'style') fixEl(nd.parentNode); continue; }
          fixEl(nd);
          if (nd.querySelectorAll) {
            var list = nd.querySelectorAll('[src],[srcset],[href],[poster],[style],[data],[background],style');
            for (var k = 0; k < list.length; k++) fixEl(list[k]);
          }
        }
      } catch (e) {}
    }
  });
  mo.observe(D, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'href', 'poster', 'style', 'data', 'background'] });

  /* ---- constructors that take URLs ---- */
  if (G.Audio) {
    var OAudio = G.Audio;
    var A = function Audio(src) { return arguments.length ? new OAudio(mapUrl(src)) : new OAudio(); };
    A.prototype = OAudio.prototype;
    G.Audio = A;
  }
  if (G.FontFace) {
    var OFF = G.FontFace;
    var FF = function FontFace(family, source, desc) {
      if (typeof source === 'string') source = rewriteCSS(source, ENTRY_DIR, mapRef);
      return new OFF(family, source, desc);
    };
    FF.prototype = OFF.prototype;
    G.FontFace = FF;
  }
  /* Workers. A worker started from a file:// page gets its own opaque
     origin and cannot read blob: URLs created by the page. So the game's
     files are handed to the worker as Blob objects in a first message; the
     worker makes its own blob: URLs, installs this runtime, then runs the
     game's worker script. Messages the game posts right after creating the
     worker queue up behind that first message, so none are lost. */
  var BLOBS = C.blobs || null;
  function workerBoot() {
    return 'var KERF_RUNTIME=' + KERF_RUNTIME.toString() + ';' +
      'self.addEventListener("message",function kb(e){if(!e.data||!e.data.__kerfBoot)return;e.stopImmediatePropagation();self.removeEventListener("message",kb);' +
      'var c=e.data.__kerfBoot,f={};for(var p in c.blobs)f[p]=URL.createObjectURL(c.blobs[p]);c.files=f;KERF_RUNTIME(c,"worker");importScripts(f[c.main]);});';
  }
  var bootUrl = null;
  if (G.Worker) {
    var OW = G.Worker;
    var WW = function Worker(url, opts) {
      var r = null;
      try { r = resolveUrl(url && url.href ? url.href : url); } catch (e) {}
      if (r && r.url && BLOBS && !(opts && opts.type === 'module')) {
        if (!bootUrl) bootUrl = URL.createObjectURL(new Blob([workerBoot()], { type: 'text/javascript' }));
        var w = new OW(bootUrl, opts);
        w.postMessage({ __kerfBoot: { blobs: BLOBS, main: r.path, entryDir: dirOf(r.path), launcherDir: LDIR, gameId: C.gameId } });
        return w;
      }
      return new OW(r && r.url ? r.url : url, opts);
    };
    WW.prototype = OW.prototype;
    G.Worker = WW;
  }
  if (G.SharedWorker) {
    var OSW = G.SharedWorker;
    var SW = function SharedWorker(url, opts) {
      var r = null;
      try { r = resolveUrl(url && url.href ? url.href : url); } catch (e) {}
      return new OSW(r && r.url ? r.url : url, opts);
    };
    SW.prototype = OSW.prototype;
    G.SharedWorker = SW;
  }

  /* ---- HTML strings inserted by the game (rewritten before the browser
     sees them, so it never requests a wrong path first) ---- */
  var oWrite = D.write, oWriteln = D.writeln;
  function dynHTML(s) {
    s = String(s);
    if (!/\b(src|srcset|href|poster|data|background|style)\s*=|<style/i.test(s)) return s;
    try { return rewriteHTML(s, ENTRY_DIR, mapRef); } catch (e) { return s; }
  }
  [['Element', 'innerHTML'], ['Element', 'outerHTML'], ['ShadowRoot', 'innerHTML']].forEach(function (pp) {
    var proto = P(pp[0]); if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, pp[1]);
    if (!d || !d.set) return;
    Object.defineProperty(proto, pp[1], {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) {
        // text set via innerHTML on script/style elements is code, not markup
        var tag = this.localName;
        d.set.call(this, (tag === 'script' || tag === 'style' || tag === 'textarea') && pp[1] === 'innerHTML' ? v : dynHTML(v));
      }
    });
  });
  var oIAH = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, html) { return oIAH.call(this, pos, dynHTML(html)); };
  if (G.Range) {
    var oCCF = Range.prototype.createContextualFragment;
    Range.prototype.createContextualFragment = function (html) { return oCCF.call(this, dynHTML(html)); };
  }
  D.write = function () { return oWrite.call(D, dynHTML(Array.prototype.join.call(arguments, ''))); };
  D.writeln = function () { return oWriteln.call(D, dynHTML(Array.prototype.join.call(arguments, ''))); };

  /* ---- navigation between pages of the same game ---- */
  function playUrl(path) {
    return C.launcherUrl + '?play=' + encodeURIComponent(C.gameId) + '&page=' + encodeURIComponent(path);
  }
  var oWinOpen = G.open;
  G.open = function (url, target, features) {
    try {
      if (url) {
        var r = resolveUrl(url);
        if (r && r.path && /\.html?$/i.test(r.path)) return oWinOpen.call(G, playUrl(r.path), target || '_blank', features);
        if (r && r.url) url = r.url;
      }
    } catch (e) {}
    return oWinOpen.call(G, url, target, features);
  };
  G.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href],area[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href[0] === '#') return;
    var r = resolveUrl(href);
    if (!r) return;
    e.preventDefault();
    if (r.missing) return;
    var html = /\.html?$/i.test(r.path);
    if (a.hasAttribute('download')) {
      var t = D.createElement('a'); t.href = r.url; t.download = a.getAttribute('download') || r.path.split('/').pop(); t.click();
      return;
    }
    var dest = html ? playUrl(r.path) : r.url;
    if (a.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey) oWinOpen.call(G, dest, '_blank'); else location.href = dest;
  });
  if (G.navigation && G.navigation.addEventListener) {
    G.navigation.addEventListener('navigate', function (e) {
      try {
        if (!e.cancelable || e.hashChange || e.downloadRequest) return;
        var u = e.destination.url;
        if (u.indexOf(C.launcherUrl) === 0) return;
        var r = resolveUrl(u);
        if (r && r.path && /\.html?$/i.test(r.path)) { e.preventDefault(); location.href = playUrl(r.path); }
      } catch (err) {}
    });
  }
  // Keep ?play=… in the address bar so reloading the tab reloads the game.
  ['pushState', 'replaceState'].forEach(function (m) {
    var o = history[m];
    history[m] = function (state, title, url) {
      if (url == null) return o.call(history, state, title);
      var keep = location.href.split('#')[0], hash = '';
      try { hash = new URL(String(url), location.href).hash; } catch (e) {}
      return o.call(history, state, title, keep + hash);
    };
  });

  /* ---- playtime tracking ----
     Only time while the tab is actually visible counts. The running total
     for this session is written to a session record; KERFINATOR folds it
     into the library and deletes the record once the session ends. */
  var setI = G.setInterval.bind(G);
  if (realLS && C.sessionId) {
    var sKey = 'kerf:pt:' + C.sessionId, acc = 0, last = Date.now(), vis = D.visibilityState === 'visible';
    var tick = function (end) {
      var now = Date.now();
      if (vis) acc += Math.max(0, Math.min(now - last, 15000));
      last = now; vis = D.visibilityState === 'visible';
      try { realLS.setItem(sKey, JSON.stringify({ g: C.gameId, ms: acc, t: now, end: !!end })); } catch (e) {}
    };
    tick(false);
    setI(function () { tick(false); }, 5000);
    D.addEventListener('visibilitychange', function () { tick(false); });
    G.addEventListener('pagehide', function () { tick(true); });
    G.addEventListener('pageshow', function (e) { if (e.persisted) { last = Date.now(); vis = D.visibilityState === 'visible'; tick(false); } });
  }

  /* ---- diagnostics: tell the player clearly when something can't load ---- */
  var errors = [], external = [], fatal = null, noteTimer = null;
  function saveDiag() {
    if (!realLS) return;
    try {
      realLS.setItem('kerf:diag:' + C.gameId, JSON.stringify({
        t: Date.now(), missing: missing.slice(0, 20), probed: probed.slice(0, 20), errors: errors.slice(0, 5), external: external.slice(0, 5), fatal: fatal
      }));
    } catch (e) {}
  }
  function scheduleNotice() {
    saveDiag();
    if (noteTimer) return;
    noteTimer = setTimeout(function () { noteTimer = null; showNotice(); }, 1200);
  }
  onMissing = scheduleNotice;
  (C.missing || []).forEach(noteMissing);
  G.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== G && t.nodeType === 1) {
      var src = t.src || t.href || '';
      if (/^https?:/i.test(src)) { if (external.indexOf(src) < 0) external.push(src); scheduleNotice(); }
      return;
    }
    var msg = String((e && e.message) || '');
    if (errors.length < 5) errors.push(msg.slice(0, 300));
    if (/SharedArrayBuffer|crossOriginIsolated|cross-origin isolat/i.test(msg)) { fatal = 'isolation'; scheduleNotice(); }
    else saveDiag();
  }, true);
  G.addEventListener('unhandledrejection', function (e) {
    var msg = String((e && e.reason && (e.reason.message || e.reason)) || '');
    if (errors.length < 5) errors.push(msg.slice(0, 300));
    if (/SharedArrayBuffer|crossOriginIsolated|cross-origin isolat/i.test(msg)) { fatal = 'isolation'; scheduleNotice(); }
    else saveDiag();
  });
  // Start each session with a clean report.
  if (realLS && !C.subPage) { try { realLS.removeItem('kerf:diag:' + C.gameId); } catch (e) {} }

  var noticeHost = null;
  function showNotice() {
    if (!missing.length && !external.length && !fatal) return;
    var lines = [];
    if (fatal === 'isolation') lines.push('This game needs a browser feature (cross-origin isolation) that is only available on web servers, so it cannot run from KERFINATOR.');
    if (missing.length) lines.push(missing.length + ' file' + (missing.length > 1 ? 's' : '') + ' could not be found in this game: ' + missing.slice(0, 4).join(', ') + (missing.length > 4 ? ', …' : ''));
    if (external.length) lines.push('This game tries to load files from the internet, which KERFINATOR never does: ' + external.slice(0, 2).map(function (u) { try { return new URL(u).host; } catch (e) { return u; } }).join(', '));
    if (!noticeHost) {
      noticeHost = D.createElement('kerf-notice');
      var root = noticeHost.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>:host{all:initial;position:fixed;z-index:2147483647;top:12px;right:12px;max-width:min(420px,calc(100vw - 24px));font:13px/1.45 system-ui,"Segoe UI",sans-serif}' +
        '.b{background:#0e0f11;color:#dfe3e8;border:1px solid #3a1016;border-left:3px solid #c8102e;padding:10px 34px 10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.6);clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,0 100%)}' +
        'strong{display:block;color:#ff5a66;font-weight:600;margin-bottom:2px}p{margin:4px 0 0}button{position:absolute;top:6px;right:6px;background:none;border:0;color:#8b929c;font-size:18px;cursor:pointer;line-height:1;padding:4px}button:hover{color:#fff}</style>' +
        '<div class="b" role="status"><strong>KERFINATOR</strong><div class="m"></div><button aria-label="Dismiss">×</button></div>';
      root.querySelector('button').onclick = function () { noticeHost.remove(); };
      noticeHost._m = root.querySelector('.m');
      (D.documentElement || D).appendChild(noticeHost);
      setTimeout(function () { if (noticeHost) noticeHost.style.display = 'none'; }, 15000);
    }
    noticeHost.style.display = '';
    noticeHost._m.textContent = '';
    lines.forEach(function (l) { var p = D.createElement('p'); p.textContent = l; noticeHost._m.appendChild(p); });
  }

  G.addEventListener('DOMContentLoaded', function () {
    if (!D.title && C.title) D.title = C.title;
  });
  return helpers;
}

// Pure helpers for the launcher side (no patching happens in this mode).
K.runtimeHelpers = KERF_RUNTIME({}, 'helpers');
