import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as barcode from '../services/barcode.js';

export function barcodeRoutes(clients) {
  const router = Router();
  router.get('/lookup', requirePermission('barcode.scan'), async (req, res) => {
    res.json(await barcode.lookup(clients, req.user, req.query.code));
  });
  router.post('/labels-printed', requirePermission('barcode.labels'), async (req, res) => {
    await barcode.recordLabelsPrinted(clients, req.user, req.body?.labels);
    res.status(204).end();
  });
  return router;
}
