import { Router } from 'express';
import { allowRoles } from '../middleware/auth.js';
import * as reports from '../services/reports.js';

export function reportRoutes(clients) {
  const router = Router();
  router.get('/sales', allowRoles('Owner', 'Manager'), async (req, res) => {
    res.json({ sales: await reports.listSales(clients, req.query) });
  });
  router.get('/products', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
    res.json({ products: await reports.listProducts(clients) });
  });
  router.get('/stock-movements', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
    res.json({ movements: await reports.listMovements(clients, req.query) });
  });
  return router;
}
