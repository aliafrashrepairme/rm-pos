// Whether the RM POS server can be reached right now.
// Any request that cannot reach the server marks the app offline; while offline the server is checked
// every few seconds, and the app is online again as soon as it answers.

const PROBE_MS = 10000;
const listeners = new Set();
let online = true;
let probeUrl = '';
let timer = null;

function notify() {
  for (const listener of listeners) listener(online);
}

function set(next) {
  if (next === online) return;
  online = next;
  if (online) {
    clearTimeout(timer);
    timer = null;
  } else {
    scheduleProbe();
  }
  notify();
}

function scheduleProbe() {
  clearTimeout(timer);
  timer = setTimeout(probe, PROBE_MS);
}

export async function probe() {
  if (!probeUrl || typeof fetch === 'undefined') return online;
  try {
    const response = await fetch(probeUrl, { cache: 'no-store' });
    set(response.ok);
  } catch {
    set(false);
  }
  if (!online) scheduleProbe();
  return online;
}

export function configureConnection(apiUrl) {
  probeUrl = `${apiUrl}/api/health`;
  if (typeof window === 'undefined') return;
  window.addEventListener('offline', () => set(false));
  window.addEventListener('online', () => { probe(); });
}

export const isOnline = () => online;
export const reportNetworkFailure = () => set(false);
export const reportReachable = () => set(true);

export function subscribeConnection(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
