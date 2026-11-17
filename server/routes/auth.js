import { Router } from 'express';
import { HttpError } from '../errors.js';
import * as auth from '../services/auth.js';
import { getPreferences, savePreferences } from '../services/preferences.js';
import { newPassword, requiredText } from '../validation/common.js';

function requiredPassword(value) {
  if (typeof value !== 'string' || !value.length) throw new HttpError(400, 'Password is required.');
  return value;
}

export function publicAuthRoutes(clients) {
  const { limiter } = clients;
  const router = Router();

  router.post('/login', async (req, res) => {
    const identifier = requiredText(req.body?.identifier, 'Username or email');
    const password = requiredPassword(req.body?.password);
    limiter.check(req.ip, identifier, res);
    try {
      const session = await auth.login(clients, identifier, password);
      limiter.reset(req.ip, identifier);
      res.json(session);
    } catch (error) {
      if (error.status === 401) limiter.fail(req.ip, identifier);
      throw error;
    }
  });

  router.post('/refresh', async (req, res) => {
    res.json(await auth.refresh(clients, requiredText(req.body?.refreshToken, 'Refresh token')));
  });

  // There is no emailed reset: a Manager resets staff passwords from User Management.
  return router;
}

export function sessionRoutes(clients) {
  const router = Router();
  router.get('/me', (req, res) => res.json({ user: req.user }));
  router.get('/preferences', async (req, res) => {
    res.json({ preferences: await getPreferences(clients, req.user.id) });
  });
  router.put('/preferences', async (req, res) => {
    res.json({ preferences: await savePreferences(clients, req.user.id, req.body) });
  });
  router.post('/logout', async (req, res) => {
    await auth.logout(clients, req.user, req.token);
    res.status(204).end();
  });
  router.post('/change-password', async (req, res) => {
    const current = requiredPassword(req.body?.currentPassword);
    const password = newPassword(req.body?.newPassword);
    clients.limiter.check(req.ip, req.user.email, res);
    try {
      await auth.changePassword(clients, req.user, req.token, current, password);
    } catch (error) {
      if (error.status === 400) clients.limiter.fail(req.ip, req.user.email);
      throw error;
    }
    res.status(204).end();
  });
  return router;
}
