import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as barcode from '../services/barcode.js';

export function barcodeRoutes(clients) {
  const router = Router();
  router.get('/lookup', requirePermission('barcode.scan'), async (req, res) => {
    res.json(await barcode.lookup(clients, req.user, req.query.code, { productOnly: req.query.type === 'product' }));
  });
  // Store name and phone printed on labels. Anyone who can print a label can read them.
  router.get('/label-store', requirePermission('barcode.scan', 'barcode.labels'), async (req, res) => {
    res.json({ store: await barcode.labelStore(clients) });
  });
  router.get('/missing', requirePermission('barcode.labels'), async (req, res) => {
    res.json({ count: await barcode.missingBarcodeCount(clients) });
  });
  router.post('/generate-missing', requirePermission('barcode.labels'), async (req, res) => {
    res.json({ generated: await barcode.generateMissingBarcodes(clients, req.user) });
  });
  router.post('/labels-printed', requirePermission('barcode.labels'), async (req, res) => {
    await barcode.recordLabelsPrinted(clients, req.user, req.body?.labels);
    res.status(204).end();
  });
  return router;
}
