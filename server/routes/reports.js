import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as reports from '../services/reports.js';

export function reportRoutes(clients) {
  const router = Router();
  router.get('/sales', requirePermission('reports.sales'), async (req, res) => {
    res.json({ sales: await reports.listSales(clients, req.query) });
  });
  router.get('/products', requirePermission('reports.inventory'), async (req, res) => {
    res.json({ products: await reports.listProducts(clients) });
  });
  router.get('/stock-movements', requirePermission('reports.inventory'), async (req, res) => {
    res.json({ movements: await reports.listMovements(clients, req.query) });
  });
  return router;
}
