import { Router } from 'express';

export function healthRoutes({ database }) {
  const router = Router();
  router.get('/health', (req, res) => res.json({ ok: true, service: 'rm-pos-server', storage: 'supabase' }));
  router.get('/health/ready', async (req, res) => {
    const { error } = await database.from('store_settings').select('id').limit(1);
    if (error) {
      console.error('Database readiness check failed:', error);
      return res.status(503).json({ ok: false, database: 'unavailable' });
    }
    res.json({ ok: true, database: 'connected' });
  });
  return router;
}
