import { Router } from 'express';
import { unwrap } from '../errors.js';
import { requirePermission } from '../middleware/auth.js';

export function dashboardRoutes({ database }) {
  const router = Router();
  router.get('/', requirePermission('dashboard.view'), async (req, res) => {
    res.json({ dashboard: unwrap(await database.rpc('dashboard_summary')) });
  });
  return router;
}
