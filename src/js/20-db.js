/* KERFINATOR storage (IndexedDB).
   Every page opened from file:// in a Chromium browser shares one storage
   area per browser profile, so this database is visible to every copy of
   KERFINATOR.html on this computer — the copy on the USB and any copy saved
   to the laptop. That is what lets games keep working after the USB is gone.

   Stores
     games  {id, title, entry, cover, thumb, files, size, fp, source, usbKey, added, updated, external, installing}
     files  {g, p, b: Blob, t}             key [gameId, path]
     user   {id, fav, last, play, launches, title?, thumb?, entry?}   — survives game removal / re-import
     kv     arbitrary settings
*/
K.db = (function () {
  var NAME = 'kerfinator', VERSION = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var req;
      try { req = indexedDB.open(NAME, VERSION); } catch (e) { rej(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: ['g', 'p'] });
        if (!db.objectStoreNames.contains('user')) db.createObjectStore('user', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbp = null; };
        res(db);
      };
      req.onerror = function () {
        dbp = null;
        var e = req.error;
        if (e && e.name === 'VersionError') e = new Error('A newer version of KERFINATOR has been used in this browser. Open the newest copy of KERFINATOR.html.');
        rej(e || new Error('Browser storage is unavailable.'));
      };
      req.onblocked = function () { /* another tab holds an old version open; it will close itself */ };
    });
    return dbp;
  }
  function wrap(req) {
    return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; });
  }
  function done(tx) {
    return new Promise(function (res, rej) {
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error || new Error('Storage transaction aborted')); };
    });
  }
  async function store(name, mode) { var db = await open(); return db.transaction(name, mode || 'readonly').objectStore(name); }

  var api = {
    open: open,
    get: async function (s, key) { return wrap((await store(s)).get(key)); },
    getAll: async function (s, query) { return wrap((await store(s)).getAll(query)); },
    getAllKeys: async function (s, query) { return wrap((await store(s)).getAllKeys(query)); },
    put: async function (s, val, key) {
      var db = await open(), tx = db.transaction(s, 'readwrite');
      key === undefined ? tx.objectStore(s).put(val) : tx.objectStore(s).put(val, key);
      return done(tx);
    },
    del: async function (s, key) {
      var db = await open(), tx = db.transaction(s, 'readwrite');
      tx.objectStore(s).delete(key);
      return done(tx);
    },
    // Run fn(tx) inside one transaction and wait for it to commit.
    tx: async function (stores, mode, fn) {
      var db = await open(), tx = db.transaction(stores, mode);
      var r = fn(tx);
      await done(tx);
      return r;
    },
    gameRange: function (id) { return IDBKeyRange.bound([id], [id, []]); },
    filesOf: async function (id) { return api.getAll('files', api.gameRange(id)); },
    deleteFiles: async function (id) {
      var db = await open(), tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(api.gameRange(id));
      return done(tx);
    },
    kvGet: async function (k, dflt) { var v = await api.get('kv', k); return v === undefined ? dflt : v; },
    kvSet: function (k, v) { return api.put('kv', v, k); },

    user: async function (id) {
      return (await api.get('user', id)) || { id: id, fav: false, last: 0, play: 0, launches: 0 };
    },
    updateUser: async function (id, fn) {
      var db = await open(), tx = db.transaction('user', 'readwrite'), st = tx.objectStore('user');
      var out;
      st.get(id).onsuccess = function (e) {
        var u = e.target.result || { id: id, fav: false, last: 0, play: 0, launches: 0 };
        fn(u); out = u; st.put(u);
      };
      await done(tx);
      return out;
    }
  };
  return api;
})();
