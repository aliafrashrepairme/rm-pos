import { api, hasServerSession, isNetworkError } from '../api.js';
import { isOnline, subscribeConnection } from './connection.js';
import { allEntries, deleteEntry, putEntry } from './store.js';

// Draft bills and quotations made without a connection, waiting to be sent to the server.
// Each draft carries its own request ID. The server keeps one record per ID (sales.client_request_id,
// quotations.client_request_id), so sending a draft again after a lost reply never makes a copy.
//
// status: 'pending'  waiting for a connection
//         'sending'  being sent now
//         'sent'     saved on the server (result holds the bill or quotation number)
//         'failed'   the server refused it (error says why); it waits for a person to act

const KEEP_SENT_MS = 3 * 24 * 60 * 60 * 1000;
const AUTO_SYNC_MS = 30000;
const listeners = new Set();
let running = null;

const PATHS = { sale: '/api/pos/sales', quotation: '/api/quotations' };

async function changed() {
  const entries = await allEntries();
  for (const listener of listeners) listener(entries);
}

export function subscribeDrafts(listener) {
  listeners.add(listener);
  allEntries().then(listener).catch(() => {});
  return () => listeners.delete(listener);
}

export const listDrafts = () => allEntries();

// kind: 'sale' or 'quotation'. body is exactly what the online screen sends, including clientRequestId.
// summary is what the sync list shows (total, item count, customer, the bill lines to reopen it).
export async function addDraft({ kind, body, summary, userId, userName, after = null }) {
  if (!PATHS[kind]) throw new Error(`Unknown draft kind: ${kind}`);
  if (!body?.clientRequestId) throw new Error('A draft needs a request ID.');
  const now = new Date().toISOString();
  const entry = {
    id: body.clientRequestId,
    kind,
    body,
    summary,
    after,
    userId,
    userName,
    status: 'pending',
    error: '',
    result: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };
  await putEntry(entry);
  await changed();
  return entry;
}

// Errors that mean "try again later" rather than "the server said no".
function isTemporary(error) {
  return isNetworkError(error) || error?.status === 401 || error?.status === 408 || error?.status === 429 || error?.status >= 502;
}

async function save(entry, changes) {
  Object.assign(entry, changes, { updatedAt: new Date().toISOString() });
  await putEntry(entry);
  await changed();
}

async function sendOne(entry, send) {
  await save(entry, { status: 'sending', attempts: entry.attempts + 1 });
  let response;
  try {
    response = await send(PATHS[entry.kind], { method: 'POST', body: JSON.stringify(entry.body) });
  } catch (error) {
    // Two sends crossing each other: the next send gets the saved record back.
    if (error?.status === 409 && /already been recorded/i.test(error.message)) {
      try {
        response = await send(PATHS[entry.kind], { method: 'POST', body: JSON.stringify(entry.body) });
      } catch (again) {
        error = again;
      }
    }
    if (!response) {
      if (isTemporary(error)) {
        await save(entry, { status: 'pending', error: '' });
        return false;
      }
      await save(entry, { status: 'failed', error: error?.message || 'The server refused this draft.' });
      return true;
    }
  }
  const record = response.sale ?? response.quotation;
  const result = { id: record?.id ?? null, number: record?.billNo ?? record?.quoteNo ?? '' };
  let note = '';
  // A bill started from a quotation marks that quotation Converted, as it does online.
  if (entry.after?.convertQuotationId && result.id) {
    try {
      await send(`/api/quotations/${entry.after.convertQuotationId}/convert`, { method: 'POST', body: JSON.stringify({ saleId: result.id }) });
    } catch (error) {
      note = error?.message || '';
    }
  }
  await save(entry, { status: 'sent', error: '', result, note });
  return true;
}

// Sends every waiting draft made by this user, oldest first. Drafts made by someone else on this device
// wait for that person to sign in, so each bill is recorded under the cashier who made it.
// Stops at the first connection problem and tries again later.
export function sendDrafts({ userId, send = api } = {}) {
  running ||= (async () => {
    try {
      const entries = await allEntries();
      const now = Date.now();
      for (const entry of entries) {
        if (entry.status === 'sent' && now - Date.parse(entry.updatedAt) > KEEP_SENT_MS) await deleteEntry(entry.id);
      }
      for (const entry of entries) {
        if (entry.userId !== userId) continue;
        // 'sending' left over from a closed app: the server may or may not have it; sending again is safe.
        if (entry.status !== 'pending' && entry.status !== 'sending') continue;
        const carryOn = await sendOne(entry, send);
        if (!carryOn) break;
      }
    } finally {
      running = null;
      await changed();
    }
  })();
  return running;
}

export async function retryDraft(id, options) {
  const entry = (await allEntries()).find((item) => item.id === id);
  if (!entry || entry.status !== 'failed') return;
  await save(entry, { status: 'pending', error: '' });
  await sendDrafts(options);
}

// Only drafts that failed or were already sent can be removed: a waiting draft may be a paid bill.
export async function removeDraft(id) {
  const entry = (await allEntries()).find((item) => item.id === id);
  if (!entry || entry.status === 'pending' || entry.status === 'sending') return false;
  await deleteEntry(id);
  await changed();
  return true;
}

// Sends drafts whenever the connection returns and every half minute, while this user is signed in
// with the server. Returns a function that stops it.
export function startAutoSync(userId) {
  const attempt = () => {
    if (isOnline() && hasServerSession()) sendDrafts({ userId }).catch(() => {});
  };
  const stopListening = subscribeConnection((online) => { if (online) attempt(); });
  const timer = setInterval(attempt, AUTO_SYNC_MS);
  attempt();
  return () => {
    stopListening();
    clearInterval(timer);
  };
}
