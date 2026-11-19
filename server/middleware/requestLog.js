// Monitoring: one JSON line per API request (method, path, status, time in ms) for the hosting
// logs, plus running counts for the System status screen. Only the path is logged: query strings
// and headers can carry codes or sign-in tokens.
export const SLOW_MS = 2000;

export function createRequestLog({ log = console.log, now = () => performance.now(), clock = () => new Date() } = {}) {
  const stats = { startedAt: clock().toISOString(), requests: 0, serverErrors: 0, slowRequests: 0, lastError: null };
  const middleware = (req, res, next) => {
    const started = now();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (path.startsWith('/api/health')) return; // uptime checks would drown out everything else
      const ms = Math.round(now() - started);
      stats.requests += 1;
      if (ms >= SLOW_MS) stats.slowRequests += 1;
      if (res.statusCode >= 500) {
        stats.serverErrors += 1;
        stats.lastError = { at: clock().toISOString(), method: req.method, path, status: res.statusCode };
      }
      log(JSON.stringify({ level: res.statusCode >= 500 ? 'error' : 'info', event: 'request', method: req.method, path, status: res.statusCode, ms }));
    });
    next();
  };
  return { middleware, stats };
}
