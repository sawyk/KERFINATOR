/* Game analysis: turn a pile of files into one or more game packages and
   work out each game's start page, title and cover art. */
K.analyze = (function () {
  var JUNK = /(^|\/)(__MACOSX|\.git|\.svn|\.idea|\.vscode|node_modules)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^\/]*)$/i;
  var INFO_FILE = /^(readme|license|licence|credits|changelog|copying|authors)([.\-_].*)?$|\.(txt|md|url|nfo|pdf|rtf)$/i;

  function depthOf(p) { return p.split('/').length - 1; }
  function baseOf(p) { return p.split('/').pop(); }

  function clean(files) {
    return files.filter(function (f) { return f.path && !JUNK.test(f.path); })
      .map(function (f) { return { path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''), file: f.file, size: f.size != null ? f.size : f.file.size }; });
  }

  // If every path starts with the same folder, drop it and use it as the name.
  function stripCommonRoot(files, fallbackName) {
    var first = null, same = files.length > 0;
    for (var i = 0; i < files.length && same; i++) {
      var idx = files[i].path.indexOf('/');
      if (idx < 0) { same = false; break; }
      var seg = files[i].path.slice(0, idx);
      if (first === null) first = seg; else if (seg !== first) same = false;
    }
    if (!same) return { name: fallbackName, files: files };
    return stripCommonRoot(files.map(function (f) { return { path: f.path.slice(first.length + 1), file: f.file, size: f.size }; }), first);
  }

  /* Decide whether a folder is one game or a collection of games. A
     collection is a folder that contains no page of its own, only
     sub-folders that each contain a page (e.g. the USB "games" folder). */
  function split(files, name) {
    files = clean(files);
    var r = stripCommonRoot(files, name);
    files = r.files; name = r.name;
    var html = files.filter(function (f) { return K.isHTML(f.path); });
    if (!html.length) return [{ name: name, files: files }];
    if (html.some(function (f) { return f.path.indexOf('/') < 0; })) return [{ name: name, files: files }];
    var groups = Object.create(null), loose = [];
    files.forEach(function (f) {
      var i = f.path.indexOf('/');
      if (i < 0) { loose.push(f); return; }
      var s = f.path.slice(0, i);
      (groups[s] || (groups[s] = [])).push({ path: f.path.slice(i + 1), file: f.file, size: f.size });
    });
    var withHtml = Object.keys(groups).filter(function (k) { return groups[k].some(function (f) { return K.isHTML(f.path); }); });
    var meaningfulLoose = loose.filter(function (f) { return !INFO_FILE.test(baseOf(f.path)); });
    var withoutHtml = Object.keys(groups).filter(function (k) { return withHtml.indexOf(k) < 0; });
    if (withHtml.length > 1 && meaningfulLoose.length === 0 && withoutHtml.length === 0) {
      return withHtml.map(function (k) { return { name: k, files: groups[k] }; });
    }
    return [{ name: name, files: files }];
  }

  function scoreEntry(path, minDepth) {
    var base = baseOf(path).toLowerCase(), s = 100 - (depthOf(path) - minDepth) * 25;
    var names = { 'index.html': 60, 'index.htm': 55, 'game.html': 40, 'play.html': 35, 'main.html': 30, 'start.html': 25, 'launch.html': 20, 'default.html': 15 };
    s += names[base] || 0;
    if (/(test|debug|editor|readme|license|licence|credits|changelog|docs?\b|help|template|example|sample|404|offline|privacy|terms|instructions|manual)/.test(base)) s -= 45;
    if (/(^|\/)(docs?|examples?|samples?|tests?|editor|tools|vendor|libs?|templatedata|third[_\-]?party)\//i.test(path)) s -= 40;
    return s;
  }

  var GENERIC = /^(index|game|games|untitled|untitled game|html5 game|my game|document|webgl|phaser( game)?|godot( engine)?|construct( 2| 3)?|gdevelop( game)?|unity( webgl)?( player)?|loading\.*|home|main|start|play|new project|project)$/i;
  function cleanTitle(t) {
    if (!t) return null;
    t = K.runtimeHelpers.decodeEntities(t).replace(/\s+/g, ' ').trim()
      .replace(/^Unity (WebGL )?Player\s*[|\-–:]\s*/i, '')
      .replace(/\s*[|\-–]\s*(Unity WebGL Player|Made with GDevelop|Construct 3|Powered by .*)$/i, '').trim();
    if (t.length < 2 || GENERIC.test(t)) return null;
    return t.length > 80 ? t.slice(0, 80).trim() : t;
  }

  var COVER_RULES = [
    [/cover/, 100], [/capsule/, 90], [/key[\-_ ]?art/, 90], [/poster/, 80], [/box[\-_ ]?art/, 80], [/banner/, 70],
    [/thumb(nail)?/, 70], [/splash/, 60], [/preview/, 50], [/screen[\-_ ]?shot/, 45], [/title/, 45], [/header/, 40],
    [/(^|[\-_])icon[\-_]?(1024|512|256|192)/, 45], [/apple-touch-icon/, 30], [/icon/, 25], [/logo/, 22], [/favicon/, 8]
  ];
  var COVER_BAD = /unity-logo|webgl-logo|progress|loading|fullscreen|button|arrow|cursor|sprite|sheet|tiles?[\-_.]|atlas|font|particle|frame|mask/;
  function scoreCover(f) {
    if (!K.isImage(f.path)) return -999;
    var p = f.path.toLowerCase(), base = baseOf(p).replace(/\.[^.]+$/, ''), s = 0;
    for (var i = 0; i < COVER_RULES.length; i++) if (COVER_RULES[i][0].test(base)) { s = COVER_RULES[i][1]; break; }
    if (COVER_BAD.test(base)) s -= 60;
    var ext = K.ext(p);
    if (ext === 'ico') s -= 15;
    if (ext !== 'svg' && f.size < 2048) s -= 40;
    if (f.size > 6 * 1024 * 1024) s -= 20;
    s -= depthOf(p) * 6;
    return s;
  }

  function findRef(files, ref, fromDir) {
    var r = K.runtimeHelpers.staticRef(ref, fromDir);
    if (!r) return null;
    var map = {};
    files.forEach(function (f) { map[f.path] = 1; });
    return K.runtimeHelpers.lookupIn(map, r.path);
  }

  async function analyze(pkg) {
    var files = pkg.files, warnings = [];
    var size = files.reduce(function (a, f) { return a + (f.size || 0); }, 0);
    var info = { name: pkg.name, files: files, size: size, count: files.length, warnings: warnings, error: null };
    if (!files.length) { info.error = 'This folder is empty.'; return info; }

    var meta = {};
    var kj = files.find(function (f) { return f.path.toLowerCase() === 'kerf.json'; });
    if (kj) { try { meta = JSON.parse(await kj.file.text()) || {}; } catch (e) { warnings.push('kerf.json could not be read and was ignored.'); } }

    var htmls = files.filter(function (f) { return K.isHTML(f.path); });
    if (!htmls.length) {
      var exts = {};
      files.forEach(function (f) { exts[K.ext(f.path)] = 1; });
      if (exts.swf) info.error = 'This is a Flash game (.swf). Flash no longer runs in any modern browser.';
      else if (exts.exe || exts.msi || exts.bat) info.error = 'This is a Windows program, not a browser game. KERFINATOR can only run HTML5 games.';
      else if (exts.apk) info.error = 'This is an Android app, not a browser game.';
      else if (exts.rar || exts['7z']) info.error = 'This contains a .rar/.7z archive. Extract it first, then import the extracted folder.';
      else info.error = 'No web page (.html file) was found, so this is not an HTML5 game.';
      return info;
    }

    var minDepth = Math.min.apply(null, htmls.map(function (f) { return depthOf(f.path); }));
    var cands = htmls.map(function (f) { return { path: f.path, file: f.file, size: f.size, score: scoreEntry(f.path, minDepth), title: null }; });
    cands.sort(function (a, b) { return b.score - a.score || a.path.length - b.path.length; });

    // Look inside the most likely pages.
    var texts = {};
    for (var i = 0; i < cands.length && i < 8; i++) {
      var c = cands[i];
      if (c.size > 8 * 1024 * 1024) continue;
      var t = await K.readHTMLText(c.file);
      texts[c.path] = t;
      var tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(t);
      c.title = tm ? cleanTitle(tm[1]) : null;
      if (/<(canvas|script)\b/i.test(t)) c.score += 10;
      var dir = K.runtimeHelpers.dirOf(c.path);
      var redir = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'>\s]+)/i.exec(t) ||
        (t.length < 4000 ? /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+\.html?)["']/i.exec(t) : null);
      if (redir) {
        var target = findRef(files, redir[1], dir);
        var tc = target && cands.find(function (x) { return x.path === target; });
        if (tc) { tc.score += 45; c.score -= 30; }
      }
    }
    cands.sort(function (a, b) { return b.score - a.score || a.path.length - b.path.length; });

    var entry = cands[0].path;
    if (meta.entry) {
      var me = findRef(files, meta.entry, '');
      if (me && K.isHTML(me)) entry = me; else warnings.push('kerf.json names a start page that does not exist: ' + meta.entry);
    }
    info.entry = entry;
    info.candidates = cands.map(function (c) { return c.path; });
    info.candidateTitles = {};
    cands.forEach(function (c) { if (c.title) info.candidateTitles[c.path] = c.title; });
    info.needsEntryChoice = !meta.entry && cands.length > 1 && (cands[0].score - cands[1].score) < 15;

    var entryCand = cands.find(function (c) { return c.path === entry; });
    var entryText = texts[entry];
    if (entryText == null) entryText = await K.readHTMLText(entryCand.file);
    var entryDir = K.runtimeHelpers.dirOf(entry);

    info.title = (typeof meta.title === 'string' && meta.title.trim()) || entryCand.title || K.prettyName(pkg.name);

    // Cover art
    var images = files.filter(function (f) { return K.isImage(f.path); })
      .map(function (f) { return { path: f.path, file: f.file, size: f.size, score: scoreCover(f) }; })
      .sort(function (a, b) { return b.score - a.score || a.path.localeCompare(b.path); });
    info.images = images.slice(0, 48).map(function (f) { return f.path; });
    var cover = null;
    if (meta.cover) { cover = findRef(files, meta.cover, ''); if (!cover) warnings.push('kerf.json names a cover image that does not exist: ' + meta.cover); }
    if (!cover && images.length && images[0].score >= 15) cover = images[0].path;
    if (!cover) {
      var og = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*content\s*=\s*["']([^"']+)/i.exec(entryText) ||
        /<link[^>]+rel\s*=\s*["'][^"']*(?:apple-touch-icon|icon)[^"']*["'][^>]*href\s*=\s*["']([^"']+)/i.exec(entryText);
      if (og) cover = findRef(files, og[1], entryDir);
      if (cover && !K.isImage(cover)) cover = null;
    }
    info.cover = cover;

    // Things that will not work offline
    var hosts = {}, re = /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\/([^\/"'\s>]+)/gi, m;
    while ((m = re.exec(entryText))) hosts[m[1].toLowerCase()] = 1;
    info.external = Object.keys(hosts);
    if (info.external.length) warnings.push('This game loads code from the internet (' + info.external.slice(0, 2).join(', ') + '). Parts of it may not work offline.');
    if (/SharedArrayBuffer|crossOriginIsolated/.test(entryText)) warnings.push('This game may require cross-origin isolation, which browsers only allow on web servers.');

    // Fingerprint: identical games get identical ids on every computer, so
    // duplicates are caught and save backups match up after re-importing.
    var manifest = files.map(function (f) { return f.path + '\t' + f.size; }).sort().join('\n');
    info.fp = await K.sha256(manifest + '\n#' + entry + '\n' + (await K.sha256(entryText)));
    return info;
  }

  return { clean: clean, split: split, analyze: analyze, stripCommonRoot: stripCommonRoot, scoreCover: scoreCover };
})();
