import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as shifts from '../services/shifts.js';

const ANY = requirePermission('shifts.own', 'shifts.manage');
const OWN = requirePermission('shifts.own');

export function shiftRoutes(clients) {
  const router = Router();
  router.get('/', ANY, async (req, res) => res.json(await shifts.listShifts(clients, req.user, req.query)));
  router.get('/options', ANY, async (req, res) => res.json(await shifts.options(clients, req.user)));
  router.get('/expenses', ANY, async (req, res) => res.json(await shifts.listExpenses(clients, req.user, req.query)));
  router.post('/expenses', ANY, async (req, res) => res.status(201).json(await shifts.addExpense(clients, req.user, req.body)));
  router.post('/', OWN, async (req, res) => res.status(201).json(await shifts.openShift(clients, req.user, req.body)));
  router.get('/:id', ANY, async (req, res) => res.json({ shift: await shifts.getShift(clients, req.user, req.params.id) }));
  router.post('/:id/close', ANY, async (req, res) => res.json(await shifts.closeShift(clients, req.user, req.params.id, req.body)));
  return router;
}
