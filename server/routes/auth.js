import { Router } from 'express';
import { HttpError } from '../errors.js';
import * as auth from '../services/auth.js';
import { requiredText } from '../validation/common.js';

export function publicAuthRoutes(clients) {
  const router = Router();
  router.post('/login', async (req, res) => {
    const email = requiredText(req.body?.email, 'Email');
    const password = req.body?.password;
    if (typeof password !== 'string' || !password.length) throw new HttpError(400, 'Password is required.');
    res.json(await auth.login(clients, email, password));
  });
  router.post('/refresh', async (req, res) => {
    res.json(await auth.refresh(clients, requiredText(req.body?.refreshToken, 'Refresh token')));
  });
  return router;
}

export function sessionRoutes() {
  const router = Router();
  router.get('/me', (req, res) => res.json({ user: req.user }));
  router.post('/logout', (req, res) => res.status(204).end());
  return router;
}
