// Tiny IndexedDB wrapper for storing swing videos + their analysis data.
const DB_NAME = 'swinglab';
const STORE = 'videos';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('created', 'created');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  put: rec => tx('readwrite', s => wrap(s.put(rec))),
  get: id => tx('readonly', s => wrap(s.get(id))),
  delete: id => tx('readwrite', s => wrap(s.delete(id))),
  /** All records without the (large) blob, newest first. */
  async list() {
    const all = await tx('readonly', s => wrap(s.getAll()));
    return all
      .map(({ blob, ...meta }) => ({ ...meta, size: blob ? blob.size : 0 }))
      .sort((a, b) => b.created - a.created);
  },
};
