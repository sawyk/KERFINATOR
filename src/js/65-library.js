/* Library operations: listing, launching, playtime, removal, save data. */
K.lib = (function () {
  var listeners = [];
  function changed() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

  async function all() {
    var games = await K.db.getAll('games'), users = await K.db.getAll('user'), byId = {};
    users.forEach(function (u) { byId[u.id] = u; });
    return games.map(function (g) {
      var u = byId[g.id] || { id: g.id, fav: false, last: 0, play: 0, launches: 0 };
      return { id: g.id, game: g, user: u, title: u.title || g.title, thumb: u.thumb || g.thumb, entry: u.entry || g.entry };
    });
  }

  function playUrl(id, sessionId) {
    return K.launcherUrl() + '?play=' + encodeURIComponent(id) + '&s=' + encodeURIComponent(sessionId);
  }

  // Must run synchronously inside a click/keypress so the browser allows the tab.
  function launch(id) {
    var sid = K.uid('s');
    var w = window.open(playUrl(id, sid), '_blank');
    if (!w) return false;
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
        if (rec.end || now - rec.t > 90000) { localStorage.removeItem(key); localStorage.removeItem(ck); }
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
      if (k && (k.indexOf(ns) === 0 || k === 'kfc:' + id || k === 'kerf:diag:' + id)) localStorage.removeItem(k);
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
    all: all, launch: launch, playUrl: playUrl, foldSessions: foldSessions, diagnostics: diagnostics,
    wipeSaves: wipeSaves, saveSize: saveSize, remove: remove, requestPersistence: requestPersistence,
    onChange: function (fn) { listeners.push(fn); }, changed: changed
  };
})();
