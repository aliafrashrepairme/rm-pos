import express, { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as logo from '../services/logo.js';

// The sign-in screen shows the logo before anyone signs in, so reading it needs no sign-in.
export function publicLogoRoutes(clients) {
  const router = Router();
  router.get('/', async (req, res) => {
    const image = await logo.getLogo(clients);
    if (!image) return res.status(204).end();
    res.set('Content-Type', image.contentType).send(image.bytes);
  });
  return router;
}

export function logoRoutes(clients) {
  const router = Router();
  const CHANGE = requirePermission('settings.logo');
  const imageBody = express.raw({ type: logo.ACCEPTED_LOGO_TYPES, limit: logo.LOGO_BODY_LIMIT });
  router.put('/', CHANGE, imageBody, async (req, res) => {
    await logo.setLogo(clients, req.user, req.get('content-type'), req.body);
    res.status(204).end();
  });
  router.delete('/', CHANGE, async (req, res) => {
    await logo.removeLogo(clients, req.user);
    res.status(204).end();
  });
  return router;
}
