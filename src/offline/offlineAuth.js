import { deleteValue, getValue, setValue } from './store.js';

// Signing in without a connection, for staff who signed in on this device recently.
// After an online sign-in, a one-way PBKDF2 hash of the password is kept (never the password), with the
// account's name, role and permissions. Offline, the same password must give the same hash.
// An offline session has no server token: it can only save drafts, and the server checks the person
// and every draft again when they are sent.

const ITERATIONS = 310000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PREFIX = 'signin:';

const keyFor = (identifier) => `${PREFIX}${String(identifier).trim().toLowerCase()}`;
const toHex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function derive(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((pair) => Number.parseInt(pair, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

// Called after every successful online sign-in. Saved under what was typed, the username and the email.
export async function rememberSignIn(identifier, password, user) {
  if (!globalThis.crypto?.subtle) return;
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const record = { salt, hash: await derive(password, salt), user, savedAt: Date.now() };
  const names = new Set([identifier, user.username, user.email].filter(Boolean).map((name) => keyFor(name)));
  for (const name of names) await setValue(name, record);
}

// Returns the saved account when the password matches a recent online sign-in on this device, else null.
export async function offlineSignIn(identifier, password, now = Date.now()) {
  if (!globalThis.crypto?.subtle) return null;
  const record = await getValue(keyFor(identifier));
  if (!record || now - record.savedAt > MAX_AGE_MS) return null;
  const hash = await derive(password, record.salt);
  return sameText(hash, record.hash) ? record.user : null;
}

// A changed or reset password makes the old offline sign-in useless; this removes it straight away.
export async function forgetSignIn(user) {
  for (const name of [user?.username, user?.email].filter(Boolean)) await deleteValue(keyFor(name));
}
