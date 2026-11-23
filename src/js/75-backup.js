/* Backup & restore of KERFINATOR's own data and game saves.
   A backup contains: favourites, playtime, last played, custom titles and
   covers, and each game's save data (its namespaced localStorage keys,
   emulated cookies and IndexedDB databases). Game files are NOT included —
   they can always be re-imported or re-installed from the USB, and because
   game ids are derived from the game's content, restored saves line up
   with re-imported games automatically. */
K.backup = (function () {
  // Tagged JSON encoding for structured-clone values found in game databases.
  async function enc(v) {
    if (v === undefined) return { $t: 'u' };
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return isFinite(v) ? v : { $t: 'n', d: String(v) };
    if (typeof v === 'bigint') return { $t: 'bi', d: v.toString() };
    if (v instanceof Date) return { $t: 'date', d: v.getTime() };
    if (v instanceof ArrayBuffer) return { $t: 'ab', d: K.b64encode(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { $t: 'ta', c: v.constructor.name, d: K.b64encode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Blob) return { $t: 'blob', type: v.type, name: v.name || null, d: K.b64encode(new Uint8Array(await v.arrayBuffer())) };
    if (v instanceof RegExp) return { $t: 're', s: v.source, f: v.flags };
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(await enc(v[i])); return a; }
    if (v instanceof Map) { var m = []; for (var e of v) m.push([await enc(e[0]), await enc(e[1])]); return { $t: 'map', d: m }; }
    if (v instanceof Set) { var s = []; for (var x of v) s.push(await enc(x)); return { $t: 'set', d: s }; }
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = await enc(v[k]);
    return Object.prototype.hasOwnProperty.call(v, '$t') ? { $t: 'obj', d: o } : o;
  }
  function dec(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    switch (v.$t) {
      case 'u': return undefined;
      case 'n': return Number(v.d);
      case 'bi': return BigInt(v.d);
      case 'date': return new Date(v.d);
      case 'ab': return K.b64decode(v.d).buffer;
      case 'ta': { var u = K.b64decode(v.d), C = window[v.c] || Uint8Array; return v.c === 'DataView' ? new DataView(u.buffer) : new C(u.buffer, 0, u.byteLength / (C.BYTES_PER_ELEMENT || 1)); }
      case 'blob': return v.name ? new File([K.b64decode(v.d)], v.name, { type: v.type }) : new Blob([K.b64decode(v.d)], { type: v.type });
      case 're': return new RegExp(v.s, v.f);
      case 'map': return new Map(v.d.map(function (p) { return [dec(p[0]), dec(p[1])]; }));
      case 'set': return new Set(v.d.map(dec));
      case 'obj': { var oo = {}; for (var kk in v.d) oo[kk] = dec(v.d[kk]); return oo; }
    }
    var o = {};
    for (var k in v) o[k] = dec(v[k]);
    return o;
  }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  // Engine caches hold re-downloadable game data, not saves.
  var SKIP_DB = /UnityCache$|\/cache$|^kfg:[^:]+:(?:keyval-store-cache|workbox)/i;

  async function dumpDB(name) {
    var db = await req(indexedDB.open(name));
    var out = { name: name, version: db.version, stores: [] };
    try {
      for (var i = 0; i < db.objectStoreNames.length; i++) {
        var sn = db.objectStoreNames[i], st = db.transaction(sn).objectStore(sn);
        var meta = {
          name: sn, keyPath: st.keyPath, autoIncrement: st.autoIncrement,
          indexes: Array.prototype.map.call(st.indexNames, function (n) { var ix = st.index(n); return { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; })
        };
        var both = await Promise.all([req(st.getAllKeys()), req(st.getAll())]), keys = both[0], vals = both[1];
        meta.keys = st.keyPath === null ? await enc(keys) : null;
        meta.values = await enc(vals);
        out.stores.push(meta);
      }
    } finally { db.close(); }
    return out;
  }

  async function restoreDB(d) {
    await new Promise(function (res) { var r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = function () { res(); }; });
    var open = indexedDB.open(d.name, d.version || 1);
    open.onupgradeneeded = function () {
      var db = open.result;
      d.stores.forEach(function (s) {
        var opt = {};
        if (s.keyPath !== null && s.keyPath !== undefined) opt.keyPath = s.keyPath;
        if (s.autoIncrement) opt.autoIncrement = true;
        var st = db.createObjectStore(s.name, opt);
        (s.indexes || []).forEach(function (ix) { st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry }); });
      });
    };
    var db = await req(open);
    try {
      for (var i = 0; i < d.stores.length; i++) {
        var s = d.stores[i], vals = dec(s.values) || [], keys = s.keys ? dec(s.keys) : null;
        await new Promise(function (res, rej) {
          var tx = db.transaction(s.name, 'readwrite'), st = tx.objectStore(s.name);
          vals.forEach(function (v, j) { if (keys) st.put(v, keys[j]); else st.put(v); });
          tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
        });
      }
    } finally { db.close(); }
  }

  async function create() {
    var games = await K.db.getAll('games'), users = await K.db.getAll('user');
    var local = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (k.indexOf('kfg:') === 0 || k.indexOf('kfc:') === 0 || k.indexOf('kfa:') === 0)) local[k] = localStorage.getItem(k);
    }
    var dbs = [];
    if (indexedDB.databases) {
      var list = await indexedDB.databases();
      for (var j = 0; j < list.length; j++) {
        var n = list[j].name;
        if (n && n.indexOf('kfg:') === 0 && !SKIP_DB.test(n)) {
          try { dbs.push(await dumpDB(n)); } catch (e) { console.warn('Backup skipped database', n, e); }
        }
      }
    }
    var data = {
      kerfinator: 'backup', format: 1, app: K.VERSION, created: new Date().toISOString(),
      library: games.map(function (g) { return { id: g.id, title: g.title, source: g.source, usbKey: g.usbKey, fp: g.fp, size: g.size }; }),
      user: await enc(users), local: local, idb: dbs
    };
    await K.db.kvSet('lastBackup', Date.now());
    return new Blob([JSON.stringify(data)], { type: 'application/json' });
  }

  async function restore(file) {
    var data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('This file is not a KERFINATOR backup (it could not be read as JSON).'); }
    if (!data || data.kerfinator !== 'backup') throw new Error('This file is not a KERFINATOR backup.');
    var users = dec(data.user) || [], n = 0;
    for (var i = 0; i < users.length; i++) {
      var cur = await K.db.get('user', users[i].id);
      var u = users[i];
      if (cur) u.play = Math.max(u.play || 0, cur.play || 0), u.launches = Math.max(u.launches || 0, cur.launches || 0), u.last = Math.max(u.last || 0, cur.last || 0);
      await K.db.put('user', u); n++;
    }
    var keys = 0, failed = 0;
    for (var k in data.local || {}) { try { localStorage.setItem(k, data.local[k]); keys++; } catch (e) { failed++; } }
    var dbs = 0;
    for (var j = 0; j < (data.idb || []).length; j++) { await restoreDB(data.idb[j]); dbs++; }
    K.lib.changed();
    return { games: n, keys: keys, databases: dbs, failed: failed, library: data.library || [] };
  }

  return { create: create, restore: restore, enc: enc, dec: dec };
})();
