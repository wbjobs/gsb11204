// IndexedDB 轻量封装：tenants / configs / versions 三个 store
export const DEFAULT_DB_NAME = 'config-center-db';
const DB_VERSION = 1;

export function openDB(name = DEFAULT_DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tenants')) {
        db.createObjectStore('tenants', { keyPath: 'tenantId' });
      }
      if (!db.objectStoreNames.contains('configs')) {
        db.createObjectStore('configs', { keyPath: 'tenantId' });
      }
      if (!db.objectStoreNames.contains('versions')) {
        const versions = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true });
        versions.createIndex('byTenant', 'tenantId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out._result !== undefined ? out._result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(db, store, key) {
  const t = db.transaction(store, 'readonly');
  return reqToPromise(t.objectStore(store).get(key));
}

export async function dbGetAll(db, store) {
  const t = db.transaction(store, 'readonly');
  return reqToPromise(t.objectStore(store).getAll());
}

export async function dbGetAllByIndex(db, store, index, key) {
  const t = db.transaction(store, 'readonly');
  return reqToPromise(t.objectStore(store).index(index).getAll(key));
}

export async function dbPut(db, store, value) {
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).put(value);
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

// 原子执行：读-改-写在同一个事务里，避免并发写互相覆盖
export async function dbTransaction(db, stores, fn) {
  const t = db.transaction(stores, 'readwrite');
  const result = await fn(t);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export { reqToPromise };
