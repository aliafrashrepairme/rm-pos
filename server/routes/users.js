import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { resetStaffPassword } from '../services/users.js';
import { newPassword } from '../validation/common.js';

export function userRoutes(clients) {
  const router = Router();
  router.post('/:id/reset-password', requirePermission('users.manage'), async (req, res) => {
    await resetStaffPassword(clients, req.user, req.params.id, newPassword(req.body?.temporaryPassword));
    res.status(204).end();
  });
  return router;
}
