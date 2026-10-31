import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as customers from '../services/customers.js';

const VIEW = requirePermission('customers.view');
const MANAGE = requirePermission('customers.manage');

export function customerRoutes(clients) {
  const router = Router();
  router.get('/', VIEW, async (req, res) => res.json(await customers.listCustomers(clients, req.query)));
  router.get('/:id', VIEW, async (req, res) => res.json({ customer: await customers.getCustomer(clients, req.params.id) }));
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ customer: await customers.createCustomer(clients, req.user, req.body) });
  });
  router.patch('/:id', MANAGE, async (req, res) => {
    res.json({ customer: await customers.updateCustomer(clients, req.user, req.params.id, req.body) });
  });
  return router;
}
