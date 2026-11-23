// On-device storage for working offline: the product list, draft bills and quotations waiting to be sent,
// and what is needed to sign in without a connection. It uses IndexedDB, which the desktop app and the
// web app both have and which survives closing the app and refreshing the page.
// Where IndexedDB is missing (tests, very old browsers) everything is kept in memory instead.

const DB_NAME = 'rm-pos-offline';
const VERSION = 1;
const KV = 'kv';
const OUTBOX = 'outbox';

let opening = null;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  opening ||= new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    // Private windows and blocked storage fall back to memory, so the app still works this session.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

const memory = { [KV]: new Map(), [OUTBOX]: new Map() };

async function run(storeName, mode, action) {
  const db = await openDb();
  if (!db) return action(null, memory[storeName]);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    const request = action(store, null);
    if (request) request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function getValue(key) {
  return run(KV, 'readonly', (store, map) => (store ? store.get(key) : map.get(key)));
}

export function setValue(key, value) {
  return run(KV, 'readwrite', (store, map) => { if (store) return store.put(value, key); map.set(key, value); return undefined; });
}

export function deleteValue(key) {
  return run(KV, 'readwrite', (store, map) => { if (store) return store.delete(key); map.delete(key); return undefined; });
}

export async function allEntries() {
  const rows = await run(OUTBOX, 'readonly', (store, map) => (store ? store.getAll() : [...map.values()].map((entry) => structuredClone(entry))));
  return (rows ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function putEntry(entry) {
  return run(OUTBOX, 'readwrite', (store, map) => { if (store) return store.put(entry); map.set(entry.id, structuredClone(entry)); return undefined; });
}

export function deleteEntry(id) {
  return run(OUTBOX, 'readwrite', (store, map) => { if (store) return store.delete(id); map.delete(id); return undefined; });
}

// For tests only: forget everything kept in memory.
export function resetMemoryStore() {
  memory[KV].clear();
  memory[OUTBOX].clear();
}
