import express, { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as scans from '../services/invoiceScans.js';

const USE = requirePermission('ai_scan.use');

export function invoiceScanRoutes(clients) {
  const router = Router();
  const fileBody = express.raw({ type: scans.ACCEPTED_FILE_TYPES, limit: scans.FILE_BODY_LIMIT });
  router.get('/status', USE, (req, res) => res.json(scans.status(clients)));
  router.get('/options', USE, async (req, res) => res.json(await scans.options(clients)));
  router.get('/', USE, async (req, res) => res.json({ scans: await scans.listScans(clients) }));
  router.post('/', USE, fileBody, async (req, res) => {
    res.status(201).json({ scan: await scans.uploadScan(clients, req.user, req.get('content-type'), req.query.name, req.body) });
  });
  router.get('/:id', USE, async (req, res) => res.json({ scan: await scans.getScan(clients, req.params.id) }));
  router.get('/:id/file', USE, async (req, res) => {
    const { bytes, mimeType } = await scans.scanFile(clients, req.params.id);
    res.set('Content-Type', mimeType).set('X-Content-Type-Options', 'nosniff').send(bytes);
  });
  router.post('/:id/retry', USE, async (req, res) => res.json({ scan: await scans.retryScan(clients, req.user, req.params.id) }));
  router.put('/:id/review', USE, async (req, res) => res.json({ scan: await scans.saveReview(clients, req.user, req.params.id, req.body) }));
  router.post('/:id/approve', USE, async (req, res) => res.json(await scans.approveScan(clients, req.user, req.params.id, req.body)));
  router.post('/:id/reject', USE, async (req, res) => res.json({ scan: await scans.rejectScan(clients, req.user, req.params.id) }));
  return router;
}
