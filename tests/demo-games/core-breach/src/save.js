// Progress is kept in IndexedDB.
const DB = 'core-breach';
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('progress');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function load() {
  const db = await open();
  return new Promise((res) => { const q = db.transaction('progress').objectStore('progress').get('main'); q.onsuccess = () => res(q.result || { level: 0, best: 0 }); q.onerror = () => res({ level: 0, best: 0 }); });
}
export async function save(data) {
  const db = await open();
  return new Promise((res) => { const tx = db.transaction('progress', 'readwrite'); tx.objectStore('progress').put(data, 'main'); tx.oncomplete = res; tx.onerror = res; });
}
