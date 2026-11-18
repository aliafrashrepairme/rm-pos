import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as backups from '../services/backups.js';

export function backupRoutes(clients) {
  const router = Router();
  const MANAGE = requirePermission('backups.manage');
  router.get('/', MANAGE, async (req, res) => {
    const list = await backups.listBackups(clients);
    res.json({ backups: list, keep: backups.KEEP });
  });
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ backup: await backups.createBackup(clients, { user: req.user, reason: 'Made by hand' }) });
  });
  router.get('/:name/download', MANAGE, async (req, res) => {
    const body = await backups.downloadBackup(clients, req.user, req.params.name);
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.send(body);
  });
  return router;
}

// Monitoring summary for the Manager: is the database reachable, how old is the newest backup,
// and how the server has done since it started.
export function systemRoutes(clients, requestStats) {
  const router = Router();
  router.get('/status', requirePermission('backups.manage'), async (req, res) => {
    const { error } = await clients.database.from('store_settings').select('id').limit(1);
    let lastBackupAt = null;
    try {
      lastBackupAt = (await backups.listBackups(clients))[0]?.createdAt ?? null;
    } catch (failure) {
      console.error('Could not list backups for the status check:', failure);
    }
    const backupOverdue = !lastBackupAt || Date.now() - Date.parse(lastBackupAt) > backups.DAY_MS + 2 * 60 * 60 * 1000;
    res.json({
      database: error ? 'unavailable' : 'connected',
      lastBackupAt,
      backupOverdue,
      startedAt: requestStats.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      requests: requestStats.requests,
      serverErrors: requestStats.serverErrors,
      slowRequests: requestStats.slowRequests,
      lastError: requestStats.lastError
    });
  });
  return router;
}
