// On-device storage for working offline: the product list, draft bills and quotations waiting to be sent,
// the bill on the till, and what is needed to sign in without a connection. It uses IndexedDB, which the
// desktop app and the web app both have and which survives closing the app and refreshing the page.
// Where IndexedDB is missing (tests, very old browsers) everything is kept in memory instead.
//
// Everything is encrypted (AES-256-GCM) before it is saved:
// - desktop app: the key comes from the app, which keeps it protected by Windows for this Windows user
//   (DPAPI), so the saved files can't be read on another PC or by another Windows user;
// - web app: browsers have nothing like DPAPI, so the key is a non-exportable browser key kept in the same
//   storage. Page scripts can't read it, but someone with the computer's files and skill could.

const DB_NAME = 'rm-pos-offline';
const VERSION = 2;
const KV = 'kv';
const OUTBOX = 'outbox';
const KEYS = 'keys';

let opening = null;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  opening ||= new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
    };
    request.onsuccess = () => resolve(request.result);
    // Private windows and blocked storage fall back to memory, so the app still works this session.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

const memory = { [KV]: new Map(), [OUTBOX]: new Map(), [KEYS]: new Map() };

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

const rawGet = (storeName, key) => run(storeName, 'readonly', (store, map) => (store ? store.get(key) : structuredClone(map.get(key))));
const rawPut = (storeName, key, value) => run(storeName, 'readwrite', (store, map) => {
  if (store) return storeName === OUTBOX ? store.put(value) : store.put(value, key);
  map.set(key, structuredClone(value));
  return undefined;
});
const rawDelete = (storeName, key) => run(storeName, 'readwrite', (store, map) => { if (store) return store.delete(key); map.delete(key); return undefined; });
const rawAll = (storeName) => run(storeName, 'readonly', (store, map) => (store ? store.getAll() : [...map.values()].map((value) => structuredClone(value))));

// ---- Encryption ------------------------------------------------------------------------------------------

const ALGORITHM = { name: 'AES-GCM', length: 256 };
let keyPromise = null;

async function loadKey() {
  if (!globalThis.crypto?.subtle) return null;
  const fromDesktop = await globalThis.window?.rmpos?.getStorageKey?.().catch(() => null);
  if (fromDesktop) {
    const bytes = Uint8Array.from(atob(fromDesktop), (char) => char.charCodeAt(0));
    return crypto.subtle.importKey('raw', bytes, ALGORITHM, false, ['encrypt', 'decrypt']);
  }
  const saved = await rawGet(KEYS, 'device').catch(() => null);
  if (saved) return saved;
  const key = await crypto.subtle.generateKey(ALGORITHM, false, ['encrypt', 'decrypt']);
  await rawPut(KEYS, 'device', key).catch(() => {});
  return key;
}

function deviceKey() {
  keyPromise ||= loadKey().catch(() => null);
  return keyPromise;
}

export class UnreadableError extends Error {}

async function seal(value) {
  const key = await deviceKey();
  if (!key) return value;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { sealed: 1, iv, data };
}

async function unseal(record) {
  // Saved before encryption was added: read as it is; it is encrypted the next time it is saved.
  if (record?.sealed !== 1) return record;
  const key = await deviceKey();
  if (!key) throw new UnreadableError('No device key.');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new UnreadableError('Saved with a key this device no longer has.');
  }
}

// ---- Values (product list, options, sign-in records, the bill on the till) --------------------------------

// A value that can't be read any more (a different device key) counts as not saved.
export async function getValue(key) {
  try {
    return await unseal(await rawGet(KV, key));
  } catch (error) {
    if (error instanceof UnreadableError) return undefined;
    throw error;
  }
}

export async function setValue(key, value) {
  await rawPut(KV, key, await seal(value));
}

export function deleteValue(key) {
  return rawDelete(KV, key);
}

// ---- Drafts waiting to be sent ----------------------------------------------------------------------------

// The ID and time stay readable (they hold nothing private) so a draft that can't be decrypted can still be
// listed and removed; everything else is encrypted.
export async function allEntries() {
  const rows = (await rawAll(OUTBOX)) ?? [];
  const entries = await Promise.all(rows.map(async (row) => {
    if (!row.box) return row;
    try {
      return await unseal(row.box);
    } catch {
      return {
        id: row.id,
        kind: 'unreadable',
        status: 'failed',
        error: 'This draft was saved with a key this device no longer has (for example, after Windows was reset), so it cannot be read or sent.',
        summary: {},
        userId: row.userId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.createdAt
      };
    }
  }));
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function putEntry(entry) {
  await rawPut(OUTBOX, entry.id, { id: entry.id, createdAt: entry.createdAt, userId: entry.userId, box: await seal(entry) });
}

export function deleteEntry(id) {
  return rawDelete(OUTBOX, id);
}

// For tests only: forget everything kept in memory, including the key.
export function resetMemoryStore() {
  for (const map of Object.values(memory)) map.clear();
  keyPromise = null;
}

// For tests only: as if this device's key changed (Windows reset), keeping what was saved.
export function replaceDeviceKeyForTests() {
  memory[KEYS].clear();
  keyPromise = null;
}

// For tests only: the raw saved form of a value or a draft.
export const rawSaved = { value: (key) => rawGet(KV, key), entry: (id) => rawGet(OUTBOX, id) };
