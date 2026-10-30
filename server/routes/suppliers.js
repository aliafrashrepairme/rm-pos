import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as suppliers from '../services/suppliers.js';

const VIEW = requirePermission('suppliers.view');
const MANAGE = requirePermission('suppliers.manage');

export function supplierRoutes(clients) {
  const router = Router();
  router.get('/', VIEW, async (req, res) => res.json(await suppliers.listSuppliers(clients, req.query)));
  router.get('/:id', VIEW, async (req, res) => res.json({ supplier: await suppliers.getSupplier(clients, req.params.id) }));
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ supplier: await suppliers.createSupplier(clients, req.user, req.body) });
  });
  router.patch('/:id', MANAGE, async (req, res) => {
    res.json({ supplier: await suppliers.updateSupplier(clients, req.user, req.params.id, req.body) });
  });
  return router;
}
