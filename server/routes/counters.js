import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as counters from '../services/counters.js';

const COUNTERS = requirePermission('counters.manage');
const PRINTERS = requirePermission('printers.manage');

export function counterRoutes(clients) {
  const router = Router();
  router.get('/', COUNTERS, async (req, res) => res.json({ counters: await counters.listCounters(clients) }));
  router.post('/', COUNTERS, async (req, res) => res.status(201).json({ counters: await counters.createCounter(clients, req.user, req.body) }));
  router.patch('/:id', COUNTERS, async (req, res) => res.json({ counters: await counters.updateCounter(clients, req.user, req.params.id, req.body) }));
  return router;
}

export function printerRoutes(clients) {
  const router = Router();
  router.post('/changed', PRINTERS, async (req, res) => {
    await counters.recordPrinterChange(clients, req.user, req.body);
    res.status(204).end();
  });
  return router;
}
