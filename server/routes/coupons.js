import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as coupons from '../services/coupons.js';

const MANAGE = requirePermission('coupons.manage');

export function couponRoutes(clients) {
  const router = Router();
  router.get('/', MANAGE, async (req, res) => res.json({ coupons: await coupons.listCoupons(clients) }));
  router.post('/', MANAGE, async (req, res) => res.status(201).json({ coupons: await coupons.createCoupon(clients, req.user, req.body) }));
  router.patch('/:code', MANAGE, async (req, res) => res.json({ coupons: await coupons.updateCoupon(clients, req.user, req.params.code, req.body) }));
  return router;
}
