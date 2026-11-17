import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as users from '../services/users.js';
import { newPassword } from '../validation/common.js';

const MANAGE = requirePermission('users.manage');

export function userRoutes(clients) {
  const router = Router();
  router.get('/', MANAGE, async (req, res) => res.json(await users.listUsers(clients)));
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ user: await users.createUser(clients, req.user, req.body, newPassword(req.body?.temporaryPassword)) });
  });
  router.get('/:id/activity', MANAGE, async (req, res) => res.json({ activity: await users.userActivity(clients, req.params.id) }));
  router.patch('/:id', MANAGE, async (req, res) => res.json({ user: await users.updateUser(clients, req.user, req.params.id, req.body) }));
  router.delete('/:id', MANAGE, async (req, res) => {
    await users.removeUser(clients, req.user, req.params.id);
    res.status(204).end();
  });
  router.post('/:id/reset-password', MANAGE, async (req, res) => {
    await users.resetStaffPassword(clients, req.user, req.params.id, newPassword(req.body?.temporaryPassword));
    res.status(204).end();
  });
  return router;
}
