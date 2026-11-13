import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as transactions from '../services/transactions.js';

const READ_BILLS = requirePermission('bills.view', 'transactions.view');
const FIGURES = requirePermission('transactions.view');
const REFUND = requirePermission('refunds.process');
const PRINT = requirePermission('bills.print');

export function transactionRoutes(clients) {
  const router = Router();
  router.get('/daily', FIGURES, async (req, res) => res.json({ daily: await transactions.daily(clients, req.query) }));
  router.get('/monthly', FIGURES, async (req, res) => res.json({ monthly: await transactions.monthly(clients, req.query) }));
  router.get('/bills', READ_BILLS, async (req, res) => res.json(await transactions.listBills(clients, req.query)));
  router.get('/bills/:id', READ_BILLS, async (req, res) => res.json({ bill: await transactions.getBill(clients, req.params.id) }));
  router.post('/bills/:id/void', REFUND, async (req, res) => {
    res.json({ bill: await transactions.voidBill(clients, req.user, req.params.id, req.body) });
  });
  router.post('/bills/:id/refund', REFUND, async (req, res) => {
    const result = await transactions.refundBill(clients, req.user, req.params.id, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post('/bills/:id/printed', PRINT, async (req, res) => {
    await transactions.recordPrinted(clients, req.user, req.params.id, req.body?.kind);
    res.status(204).end();
  });
  return router;
}
