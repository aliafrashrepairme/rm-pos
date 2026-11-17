import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as settings from '../services/settings.js';

const MANAGE = requirePermission('settings.manage');

export function settingsRoutes(clients) {
  const router = Router();
  router.get('/', MANAGE, async (req, res) => res.json({ settings: await settings.getSettings(clients) }));
  router.patch('/', MANAGE, async (req, res) => res.json({ settings: await settings.updateSettings(clients, req.user, req.body) }));
  router.patch('/tax-rates/:id', MANAGE, async (req, res) => res.json({ settings: await settings.updateTaxRate(clients, req.user, req.params.id, req.body) }));
  router.post('/tax-rates/:id/default', MANAGE, async (req, res) => res.json({ settings: await settings.setDefaultTaxRate(clients, req.user, req.params.id) }));
  router.patch('/payment-methods/:code', MANAGE, async (req, res) => res.json({ settings: await settings.updatePaymentMethod(clients, req.user, req.params.code, req.body) }));
  return router;
}
