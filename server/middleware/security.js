import { HttpError } from '../errors.js';

const WINDOW_MS = 60 * 1000;
// A busy shop puts several tills behind one address, so this only stops runaway clients.
const MAX_PER_ADDRESS = 600;

// The API only returns JSON and files, so nothing may frame, sniff or cache its replies.
export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
}

// Counts requests per address in memory, which suits the single hosted API server.
export function createRequestLimiter({ now = Date.now, limit = MAX_PER_ADDRESS } = {}) {
  let counts = new Map();
  let windowEnds = 0;

  return function limitRequests(req, res, next) {
    const time = now();
    if (time >= windowEnds) {
      counts = new Map();
      windowEnds = time + WINDOW_MS;
    }
    const count = (counts.get(req.ip) || 0) + 1;
    counts.set(req.ip, count);
    if (count > limit) {
      res.set('Retry-After', String(Math.ceil((windowEnds - time) / 1000)));
      throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
    }
    next();
  };
}
