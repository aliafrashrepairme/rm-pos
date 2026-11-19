import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as quotations from '../services/quotations.js';

const VIEW = requirePermission('quotations.view');
const MANAGE = requirePermission('quotations.manage');
// Linking a bill happens straight after a sale, so it needs the right to sell.
const CONVERT = requirePermission('pos.sell');

export function quotationRoutes(clients) {
  const router = Router();
  router.get('/', VIEW, async (req, res) => res.json(await quotations.listQuotations(clients, req.query)));
  router.get('/products', MANAGE, async (req, res) => res.json({ products: await quotations.productPicker(clients, req.query) }));
  router.post('/', MANAGE, async (req, res) => res.status(201).json({ quotation: await quotations.createQuotation(clients, req.user, req.body) }));
  router.get('/:id', VIEW, async (req, res) => res.json({ quotation: await quotations.getQuotation(clients, req.params.id) }));
  router.put('/:id', MANAGE, async (req, res) => res.json({ quotation: await quotations.updateQuotation(clients, req.user, req.params.id, req.body) }));
  router.post('/:id/convert', CONVERT, async (req, res) => res.json({ quotation: await quotations.convertQuotation(clients, req.user, req.params.id, req.body) }));
  router.post('/:id/:move', MANAGE, async (req, res) => res.json({ quotation: await quotations.moveQuotation(clients, req.user, req.params.id, req.params.move) }));
  return router;
}
