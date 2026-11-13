import express, { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as auditLog from '../services/audit-log.js';
import { exportData } from '../services/exports.js';
import * as imports from '../services/imports.js';
import * as lists from '../services/lists.js';

const DATA = requirePermission('import_export.use');
const LISTS = requirePermission('lists.manage');
const AUDIT = requirePermission('audit.view');
const csvBody = express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' });

function sendCsv(res, name, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(csv);
}

export function dataRoutes(clients) {
  const router = Router();
  router.get('/import/:type/template', DATA, (req, res) => sendCsv(res, `rm-${req.params.type}-template.csv`, imports.template(req.params.type)));
  router.post('/import/:type/validate', DATA, csvBody, async (req, res) => res.json(await imports.validateImport(clients, req.params.type, req.body)));
  router.post('/import/:type', DATA, csvBody, async (req, res) => res.json(await imports.runImport(clients, req.user, req.params.type, req.body)));
  router.get('/export/:kind', DATA, async (req, res) => sendCsv(res, `rm-${req.params.kind}.csv`, await exportData(clients, req.user, req.params.kind, req.query)));
  return router;
}

export function listRoutes(clients) {
  const router = Router();
  router.get('/', LISTS, async (req, res) => res.json(await lists.getLists(clients)));
  router.post('/units', LISTS, async (req, res) => res.status(201).json(await lists.addUnit(clients, req.user, req.body)));
  router.patch('/units/:code', LISTS, async (req, res) => res.json(await lists.updateUnit(clients, req.user, req.params.code, req.body)));
  router.post('/tax-rates', LISTS, async (req, res) => res.status(201).json(await lists.addTaxRate(clients, req.user, req.body)));
  router.patch('/tax-rates/:id', LISTS, async (req, res) => res.json(await lists.setTaxRateActive(clients, req.user, req.params.id, req.body)));
  return router;
}

export function auditRoutes(clients) {
  const router = Router();
  router.get('/', AUDIT, async (req, res) => res.json(await auditLog.listAudit(clients, req.query)));
  router.get('/actions', AUDIT, async (req, res) => res.json({ actions: await auditLog.auditActions(clients) }));
  router.get('/export', AUDIT, async (req, res) => sendCsv(res, 'rm-audit-log.csv', await auditLog.exportAudit(clients, req.user, req.query)));
  return router;
}
