import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as credit from '../services/credit.js';

const VIEW = requirePermission('credit.view');
const COLLECT = requirePermission('credit.collect');
const MANAGE = requirePermission('credit.manage');
// Supplier balances show purchase figures, so they need the purchases permission too.
const SUPPLIERS = requirePermission('purchases.view', 'supplier_payments.manage');

export function creditRoutes(clients) {
  const router = Router();
  router.get('/customers', VIEW, async (req, res) => res.json(await credit.creditCustomers(clients, req.query)));
  router.get('/customers/:id', VIEW, async (req, res) => res.json(await credit.creditLedger(clients, req.params.id)));
  router.post('/customers/:id/payments', COLLECT, async (req, res) => res.status(201).json(await credit.recordPayment(clients, req.user, req.params.id, req.body)));
  router.put('/customers/:id/limit', MANAGE, async (req, res) => res.json(await credit.setLimit(clients, req.user, req.params.id, req.body)));
  router.get('/suppliers', VIEW, SUPPLIERS, async (req, res) => res.json(await credit.supplierCredit(clients)));
  router.get('/points', VIEW, async (req, res) => res.json(await credit.loyalty(clients, req.query)));
  return router;
}
