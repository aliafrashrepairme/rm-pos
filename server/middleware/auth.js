import { HttpError, unwrap } from '../errors.js';

const PROFILE_COLUMNS = 'id, username, full_name, role_code, email, active, must_change_password, roles(role_permissions(permission_code))';

// Reads the role's permissions on every request, so a change applies immediately.
export async function loadActiveProfile(database, userId) {
  const profile = unwrap(await database.from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle());
  if (!profile || !profile.active) throw new HttpError(403, 'This account is not enabled for RM POS.');
  return {
    id: profile.id,
    username: profile.username,
    name: profile.full_name,
    role: profile.role_code,
    email: profile.email,
    mustChangePassword: profile.must_change_password,
    permissions: (profile.roles?.role_permissions || []).map((row) => row.permission_code)
  };
}

export function bearerToken(req) {
  return req.get('authorization')?.replace(/^Bearer\s+/i, '');
}

export function createRequireAuth({ authClient, database }) {
  return async function requireAuth(req, res, next) {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Sign in is required.');
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'Session expired. Sign in again.');
    req.user = await loadActiveProfile(database, data.user.id);
    req.token = token;
    next();
  };
}

// Someone on a temporary password can only reach the account routes until they replace it.
export function requirePasswordCurrent(req, res, next) {
  if (req.user.mustChangePassword && !req.path.startsWith('/auth/')) {
    throw new HttpError(403, 'Change your temporary password to continue.', 'PASSWORD_CHANGE_REQUIRED');
  }
  next();
}

export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!permissions.some((permission) => req.user.permissions.includes(permission))) {
      throw new HttpError(403, 'You do not have permission to perform this action.');
    }
    next();
  };
}
