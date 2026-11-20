import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../errors.js';

const scrypt = promisify(scryptCallback);
const PIN_FORMAT = /^\d{4,6}$/;
export const MAX_FAILURES = 5;
export const LOCK_MS = 5 * 60 * 1000;

export function cleanPin(value) {
  const pin = typeof value === 'string' ? value.trim() : '';
  if (!PIN_FORMAT.test(pin)) throw new HttpError(400, 'A counter PIN is 4 to 6 digits.');
  return pin;
}

// Stored as scrypt$<salt>$<hash>, so a copy of the database never reveals a PIN.
export async function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function pinMatches(pin, stored) {
  const [kind, saltHex, hashHex] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(String(pin ?? ''), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// A 4-digit PIN is easy to guess, so after MAX_FAILURES wrong tries the counter locks for LOCK_MS.
export function createPinGuard({ now = Date.now } = {}) {
  const failures = new Map();
  return {
    assertOpen(counterId) {
      const entry = failures.get(counterId);
      if (entry && entry.lockedUntil > now()) {
        const minutes = Math.ceil((entry.lockedUntil - now()) / 60000);
        throw new HttpError(429, `Too many wrong PINs. Try again in ${minutes} minute(s), or ask the Owner.`);
      }
    },
    failed(counterId) {
      const entry = failures.get(counterId) ?? { count: 0, lockedUntil: 0 };
      if (entry.lockedUntil && entry.lockedUntil <= now()) entry.count = 0;
      entry.count += 1;
      entry.lockedUntil = entry.count >= MAX_FAILURES ? now() + LOCK_MS : 0;
      failures.set(counterId, entry);
    },
    succeeded(counterId) { failures.delete(counterId); }
  };
}
