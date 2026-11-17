import { HttpError } from '../errors.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_ADDRESS = 30;

// Counts failures in memory, which suits the single hosted API server.
export function createLoginLimiter({ now = Date.now } = {}) {
  const failures = new Map();

  function active(key) {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now()) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  }

  function add(key) {
    const entry = active(key);
    if (entry) entry.count += 1;
    else failures.set(key, { count: 1, resetAt: now() + WINDOW_MS });
  }

  const accountKey = (ip, identifier) => `${ip}|${identifier.toLowerCase()}`;

  return {
    check(ip, identifier, res) {
      const blocked = [[accountKey(ip, identifier), MAX_PER_ACCOUNT], [`${ip}|*`, MAX_PER_ADDRESS]]
        .map(([key, limit]) => ({ entry: active(key), limit }))
        .find(({ entry, limit }) => entry && entry.count >= limit);
      if (blocked) {
        res.set('Retry-After', String(Math.ceil((blocked.entry.resetAt - now()) / 1000)));
        throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
      }
    },
    fail(ip, identifier) {
      add(accountKey(ip, identifier));
      add(`${ip}|*`);
    },
    reset(ip, identifier) {
      failures.delete(accountKey(ip, identifier));
    }
  };
}
