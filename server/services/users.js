import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

export async function resetStaffPassword({ database }, actor, targetId, temporaryPassword) {
  const target = unwrap(await database.from('profiles')
    .select('id, full_name, role_code, email')
    .eq('id', targetId)
    .maybeSingle());
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.id === actor.id) throw new HttpError(400, 'Use Change password for your own account.');
  if (target.role_code === 'Owner') throw new HttpError(403, 'Owner accounts cannot be changed here.');

  const { error } = await database.auth.admin.updateUserById(target.id, { password: temporaryPassword });
  if (error) {
    if (error.status === 422) throw new HttpError(400, error.message);
    console.error('Password reset failed:', error);
    throw new HttpError(500, 'The password could not be reset.');
  }
  unwrap(await database.from('profiles').update({ must_change_password: true }).eq('id', target.id));
  await writeAudit(database, {
    user: actor,
    action: 'Password reset',
    description: `Temporary password set for ${target.email}`,
    entityType: 'user',
    entityId: target.id
  });
}
