/* Library operations: listing, launching, playtime, removal, save data. */
K.lib = (function () {
  var listeners = [];
  function changed() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

  async function all() {
    var games = await K.db.getAll('games'), users = await K.db.getAll('user'), byId = {};
    users.forEach(function (u) { byId[u.id] = u; });
    return games.map(function (g) {
      var u = byId[g.id] || { id: g.id, fav: false, last: 0, play: 0, launches: 0 };
      // cover: chosen by the player > the game's own art > screenshot from play > generated
      var thumb = u.thumb || (!g.cover && u.shot) || g.thumb;
      return { id: g.id, game: g, user: u, title: u.title || g.title, thumb: thumb, entry: u.entry || g.entry };
    });
  }

  function playUrl(id, sessionId) {
    return K.launcherUrl() + '?play=' + encodeURIComponent(id) + '&s=' + encodeURIComponent(sessionId);
  }

  /* Is this game open in another tab right now? A tab reports a session
     record ('ended' when it closes) and holds a Web Lock while it lives. The
     lock list is refreshed often (it is asynchronous); the session record is
     read on the spot, so a just-closed game is never reported as open. */
  var liveSessions = null, justLaunched = {};
  async function refreshRunning() {
    if (!navigator.locks || !navigator.locks.query) return;
    try {
      var held = (await navigator.locks.query()).held, live = {};
      held.forEach(function (l) { var m = /^kerf:run:[^:]+:(.+)$/.exec(l.name || ''); if (m) live[m[1]] = 1; });
      liveSessions = live;
    } catch (e) {}
  }
  function isRunning(id) {
    var now = Date.now(), seen = false;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('kerf:pt:') !== 0) continue;
      var r = null;
      try { r = JSON.parse(localStorage.getItem(k)); } catch (e) {}
      if (!r || r.g !== id) continue;
      if (justLaunched[id] && r.t >= justLaunched[id]) seen = true;   // the new tab has reported in
      if (r.end || now - r.t > 75000) continue;
      if (liveSessions && !liveSessions[k.slice(8)] && now - r.t > 4000) continue;   // tab is gone (crashed or killed)
      return true;
    }
    if (seen) delete justLaunched[id];
    // opened moments ago and still loading
    return !!(justLaunched[id] && now - justLaunched[id] < 8000);
  }

  // Must run synchronously inside a click/keypress so the browser allows the tab.
  // Returns true, false (pop-up blocked) or 'running' (already open; pass force to open anyway).
  function launch(id, force) {
    if (!force && isRunning(id)) return 'running';
    var sid = K.uid('s');
    var w = window.open(playUrl(id, sid), '_blank');
    if (!w) return false;
    justLaunched[id] = Date.now();
    try { w.opener = null; } catch (e) {}
    K.db.updateUser(id, function (u) { u.last = Date.now(); u.launches = (u.launches || 0) + 1; }).then(changed);
    return true;
  }

  /* Playtime: each game tab writes kerf:pt:<session> = {g, ms, t, end}.
     We credit only the growth since the last fold, then delete finished or
     abandoned sessions. Time never accrues for a closed tab. */
  var folding = false;
  async function foldSessions() {
    if (folding) return; folding = true;
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('kerf:pt:') === 0) keys.push(k); }
      var credits = {}, now = Date.now(), touched = false;
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j], sid = key.slice(8), rec;
        try { rec = JSON.parse(localStorage.getItem(key)); } catch (e) { rec = null; }
        if (!rec || !rec.g) { localStorage.removeItem(key); continue; }
        var ck = 'kerf:ptc:' + sid, credited = Number(localStorage.getItem(ck) || 0), delta = Math.max(0, (rec.ms || 0) - credited);
        if (delta > 0) { credits[rec.g] = (credits[rec.g] || 0) + delta; localStorage.setItem(ck, String(rec.ms)); }
        var gone = liveSessions && !liveSessions[sid] && now - rec.t > 4000;
        if (rec.end || gone || now - rec.t > 90000) {
          localStorage.removeItem(key); localStorage.removeItem(ck);
          if (justLaunched[rec.g] && rec.t >= justLaunched[rec.g]) delete justLaunched[rec.g];   // that tab has come and gone
        }
      }
      for (var g in credits) { touched = true; await K.db.updateUser(g, function (u) { u.play = (u.play || 0) + credits[g]; }); }
      // orphaned credit markers
      for (var m = localStorage.length - 1; m >= 0; m--) {
        var ok = localStorage.key(m);
        if (ok && ok.indexOf('kerf:ptc:') === 0 && localStorage.getItem('kerf:pt:' + ok.slice(9)) === null) localStorage.removeItem(ok);
      }
      if (touched) changed();
    } finally { folding = false; }
  }

  function diagnostics(id) {
    try { return JSON.parse(localStorage.getItem('kerf:diag:' + id) || 'null'); } catch (e) { return null; }
  }

  async function wipeSaves(id) {
    var ns = 'kfg:' + id + ':';
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && (k.indexOf(ns) === 0 || k === 'kfc:' + id || k === 'kfa:' + id || k === 'kerf:diag:' + id || k === 'kerf:noticed:' + id)) localStorage.removeItem(k);
    }
    if (indexedDB.databases) {
      var dbs = await indexedDB.databases();
      for (var j = 0; j < dbs.length; j++) {
        if (dbs[j].name && dbs[j].name.indexOf(ns) === 0) {
          await new Promise(function (res) { var r = indexedDB.deleteDatabase(dbs[j].name); r.onsuccess = r.onerror = r.onblocked = function () { res(); }; });
        }
      }
    }
  }

  /* Progress this game has from being opened directly (outside KERFINATOR):
     the save names the game has used in KERFINATOR that also exist outside it
     with different contents. */
  function adoptRecord(id) { try { return JSON.parse(localStorage.getItem('kfa:' + id) || 'null') || { ls: {}, db: {} }; } catch (e) { return { ls: {}, db: {} }; } }
  async function outsideSaves(id) {
    var rec = adoptRecord(id), ns = 'kfg:' + id + ':', keys = [], dbs = [];
    Object.keys(rec.ls || {}).forEach(function (k) {
      var raw = localStorage.getItem(k);
      if (raw !== null && raw !== localStorage.getItem(ns + k)) keys.push(k);
    });
    var names = Object.keys(rec.db || {});
    if (names.length && indexedDB.databases) {
      var have = {}; (await indexedDB.databases()).forEach(function (d) { have[d.name] = 1; });
      names.forEach(function (n) { if (have[n]) dbs.push(n); });
    }
    return { keys: keys, dbs: dbs, count: keys.length + dbs.length };
  }
  async function useOutsideSaves(id) {
    var found = await outsideSaves(id), rec = adoptRecord(id), ns = 'kfg:' + id + ':';
    found.keys.forEach(function (k) { localStorage.setItem(ns + k, localStorage.getItem(k)); rec.ls[k] = 'a'; });
    for (var i = 0; i < found.dbs.length; i++) {
      var n = found.dbs[i];
      await new Promise(function (res) { var r = indexedDB.deleteDatabase(ns + n); r.onsuccess = r.onerror = r.onblocked = function () { res(); }; });
      await K.runtimeHelpers.copyDB(IDBFactory.prototype.open, n, ns + n);
      rec.db[n] = 'a';
    }
    localStorage.setItem('kfa:' + id, JSON.stringify(rec));
    return found;
  }

  async function saveSize(id) {
    var ns = 'kfg:' + id + ':', n = 0, dbs = 0;
    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(ns) === 0) n += k.length + (localStorage.getItem(k) || '').length; }
    if (indexedDB.databases) (await indexedDB.databases()).forEach(function (d) { if (d.name && d.name.indexOf(ns) === 0) dbs++; });
    return { localBytes: n * 2, databases: dbs };
  }

  async function remove(id, alsoSaves) {
    await K.db.deleteFiles(id);
    await K.db.del('games', id);
    if (alsoSaves) { await wipeSaves(id); await K.db.del('user', id); }
    changed();
  }

  var persistAsked = false;
  async function requestPersistence() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) {}
  }

  return {
    all: all, launch: launch, isRunning: isRunning, refreshRunning: refreshRunning, playUrl: playUrl, foldSessions: foldSessions, diagnostics: diagnostics,
    wipeSaves: wipeSaves, outsideSaves: outsideSaves, useOutsideSaves: useOutsideSaves, saveSize: saveSize, remove: remove, requestPersistence: requestPersistence,
    onChange: function (fn) { listeners.push(fn); }, changed: changed
  };
})();
