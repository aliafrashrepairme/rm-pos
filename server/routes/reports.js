import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as reports from '../services/reports.js';

const SALES = requirePermission('reports.sales');
const INVENTORY = requirePermission('reports.inventory');

export function reportRoutes(clients) {
  const router = Router();
  router.get('/filters', requirePermission('reports.sales', 'reports.inventory'), async (req, res) => res.json(await reports.filters(clients)));
  router.get('/sales', SALES, async (req, res) => res.json(await reports.salesSummary(clients, req.query)));
  router.get('/sales/bills', SALES, async (req, res) => res.json(await reports.salesBills(clients, req.user, req.query)));
  router.get('/payments', SALES, async (req, res) => res.json(await reports.paymentsSummary(clients, req.query)));
  router.get('/payments/list', SALES, async (req, res) => res.json(await reports.paymentsList(clients, req.user, req.query)));
  router.get('/inventory', INVENTORY, async (req, res) => res.json(await reports.inventorySummary(clients)));
  router.get('/products', INVENTORY, async (req, res) => res.json({ products: await reports.listProducts(clients) }));
  router.get('/stock-movements', INVENTORY, async (req, res) => res.json(await reports.stockMovements(clients, req.user, req.query)));
  router.post('/exported', requirePermission('reports.export'), async (req, res) => {
    await reports.recordExport(clients, req.user, req.body);
    res.status(204).end();
  });
  return router;
}
