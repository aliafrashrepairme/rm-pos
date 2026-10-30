import { HttpError } from '../errors.js';
import { loadActiveProfile } from '../middleware/auth.js';

async function sessionResponse(database, data) {
  const user = await loadActiveProfile(database, data.user.id);
  return {
    user,
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: new Date(data.session.expires_at * 1000).toISOString()
  };
}

export async function login({ authClient, database }, email, password) {
  const { data, error } = await authClient.auth.signInWithPassword({ email: email.toLowerCase(), password });
  if (error || !data.session || !data.user) throw new HttpError(401, 'Incorrect email or password.');
  return sessionResponse(database, data);
}

export async function refresh({ authClient, database }, refreshToken) {
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user) throw new HttpError(401, 'Session expired. Sign in again.');
  return sessionResponse(database, data);
}
