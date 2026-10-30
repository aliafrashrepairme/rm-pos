import { HttpError, unwrap } from '../errors.js';

export async function loadActiveProfile(database, userId) {
  const profile = unwrap(await database.from('profiles')
    .select('id, full_name, role_code, email, active')
    .eq('id', userId)
    .maybeSingle());
  if (!profile || !profile.active) throw new HttpError(403, 'This account is not enabled for RM POS.');
  return { id: profile.id, name: profile.full_name, role: profile.role_code, email: profile.email };
}

export function createRequireAuth({ authClient, database }) {
  return async function requireAuth(req, res, next) {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new HttpError(401, 'Sign in is required.');
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'Session expired. Sign in again.');
    req.user = await loadActiveProfile(database, data.user.id);
    next();
  };
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'You do not have permission to perform this action.');
    next();
  };
}
