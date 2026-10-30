import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { scanIntoCount } from '../services/barcode.js';
import * as inventory from '../services/inventory.js';

const VIEW = requirePermission('inventory.view');
const ADJUST = requirePermission('adjustments.manage');
const COUNT = requirePermission('counts.manage');
const APPROVE = requirePermission('counts.approve');

export function inventoryRoutes(clients) {
  const router = Router();

  router.get('/stock', VIEW, async (req, res) => res.json(await inventory.listStock(clients, req.query)));
  router.get('/summary', VIEW, async (req, res) => res.json({ summary: await inventory.stockSummary(clients) }));
  router.get('/movements', VIEW, async (req, res) => res.json(await inventory.listMovements(clients, req.query)));

  router.get('/adjustments', ADJUST, async (req, res) => res.json(await inventory.listAdjustments(clients, req.query)));
  router.get('/adjustments/products', ADJUST, async (req, res) => res.json({ products: await inventory.productPicker(clients, req.query) }));
  router.post('/adjustments', ADJUST, async (req, res) => {
    res.status(201).json({ adjustment: await inventory.createAdjustment(clients, req.user, req.body) });
  });

  router.get('/counts', COUNT, async (req, res) => res.json(await inventory.listCounts(clients, req.query)));
  router.post('/counts', COUNT, async (req, res) => {
    res.status(201).json({ count: await inventory.startCount(clients, req.user, req.body) });
  });
  router.get('/counts/:id', COUNT, async (req, res) => {
    res.json({ count: await inventory.getCount(clients, req.user, req.params.id) });
  });
  router.put('/counts/:id/lines/:productId', COUNT, async (req, res) => {
    await inventory.setCountLine(clients, req.params.id, req.params.productId, req.body?.counted);
    res.status(204).end();
  });
  router.post('/counts/:id/scan', COUNT, async (req, res) => {
    res.json(await scanIntoCount(clients, req.user, req.params.id, req.body?.code));
  });
  router.post('/counts/:id/submit', COUNT, async (req, res) => {
    res.json({ count: await inventory.submitCount(clients, req.user, req.params.id) });
  });
  router.post('/counts/:id/reopen', APPROVE, async (req, res) => {
    res.json({ count: await inventory.reopenCount(clients, req.user, req.params.id) });
  });
  router.post('/counts/:id/approve', APPROVE, async (req, res) => {
    res.json(await inventory.approveCount(clients, req.user, req.params.id));
  });

  return router;
}
