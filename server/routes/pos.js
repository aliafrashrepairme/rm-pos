import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as pos from '../services/pos.js';

const SELL = requirePermission('pos.sell');
const HELD = requirePermission('held.manage');

export function posRoutes(clients) {
  const router = Router();

  router.get('/options', SELL, async (req, res) => res.json(await pos.options(clients)));
  router.get('/catalog', SELL, async (req, res) => res.json(await pos.catalog(clients, req.query)));
  router.post('/sales', SELL, async (req, res) => {
    const result = await pos.createSale(clients, req.user, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.get('/customers', requirePermission('customers.view'), async (req, res) => {
    res.json({ customers: await pos.searchCustomers(clients, req.query) });
  });
  router.post('/customers', requirePermission('customers.manage'), async (req, res) => {
    res.status(201).json({ customer: await pos.createCustomer(clients, req.user, req.body) });
  });

  router.get('/held', HELD, async (req, res) => res.json({ orders: await pos.listHeld(clients) }));
  router.post('/held', HELD, async (req, res) => {
    res.status(201).json({ order: await pos.holdOrder(clients, req.user, req.body) });
  });
  router.post('/held/:id/resume', HELD, async (req, res) => res.json(await pos.resumeHeld(clients, req.user, req.params.id)));
  router.post('/held/:id/cancel', HELD, async (req, res) => {
    await pos.cancelHeld(clients, req.user, req.params.id);
    res.status(204).end();
  });
  return router;
}
