import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as purchases from '../services/purchases.js';

const VIEW = requirePermission('purchases.view');
const MANAGE = requirePermission('purchases.manage');
const PAY = requirePermission('supplier_payments.manage');

export function purchaseRoutes(clients) {
  const router = Router();
  router.get('/', VIEW, async (req, res) => res.json(await purchases.listPurchases(clients, req.query)));
  router.get('/summary', VIEW, async (req, res) => res.json({ summary: await purchases.summary(clients) }));
  router.get('/options', VIEW, async (req, res) => res.json(await purchases.options(clients)));
  router.get('/products', MANAGE, async (req, res) => res.json({ products: await purchases.productPicker(clients, req.query) }));
  router.get('/suggestions', MANAGE, async (req, res) => res.json({ suggestions: await purchases.suggestions(clients, req.query.supplierId) }));
  router.post('/auto-reorder', MANAGE, async (req, res) => res.json(await purchases.autoReorder(clients, req.user)));
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ purchase: await purchases.createPurchase(clients, req.user, req.body) });
  });
  router.get('/:id', VIEW, async (req, res) => res.json({ purchase: await purchases.getPurchase(clients, req.params.id) }));
  router.post('/:id/send', MANAGE, async (req, res) => res.json({ purchase: await purchases.sendPurchase(clients, req.user, req.params.id) }));
  router.post('/:id/cancel', MANAGE, async (req, res) => res.json({ purchase: await purchases.cancelPurchase(clients, req.user, req.params.id) }));
  router.post('/:id/receive', MANAGE, async (req, res) => {
    const result = await purchases.receivePurchase(clients, req.user, req.params.id, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post('/:id/pay', PAY, async (req, res) => res.json({ purchase: await purchases.paySupplier(clients, req.user, req.params.id, req.body) }));
  router.post('/:id/printed', VIEW, async (req, res) => {
    await purchases.recordPrinted(clients, req.user, req.params.id, req.body?.kind);
    res.status(204).end();
  });
  return router;
}

export function supplierRoutes(clients) {
  const router = Router();
  router.post('/', requirePermission('suppliers.manage'), async (req, res) => {
    res.status(201).json({ supplier: await purchases.createSupplier(clients, req.user, req.body) });
  });
  return router;
}
