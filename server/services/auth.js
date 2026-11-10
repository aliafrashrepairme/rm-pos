import { HttpError, unwrap } from '../errors.js';
import { loadActiveProfile } from '../middleware/auth.js';
import { writeAudit } from './audit.js';

const INVALID_LOGIN = 'Incorrect username, email or password.';
const INVALID_RESET = 'This reset code is not valid. Request a new one.';

// Accounts created without an email get an address under this domain, which can't receive mail.
export const NO_EMAIL_DOMAIN = 'staff.rm-pos.local';

function sessionResponse(user, session) {
  return {
    user,
    token: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: new Date(session.expires_at * 1000).toISOString()
  };
}

async function endSession(database, accessToken, scope = 'local') {
  const { error } = await database.auth.admin.signOut(accessToken, scope);
  if (error && error.name !== 'AuthSessionMissingError') console.error('Could not end session:', error);
}

const USERNAME = /^[a-z0-9._-]{3,40}$/;

async function emailFor(database, identifier) {
  if (identifier.includes('@')) return identifier.toLowerCase();
  // No account can have any other name, and Supabase's firewall rejects some of that text outright.
  if (!USERNAME.test(identifier.toLowerCase())) return null;
  const row = unwrap(await database.from('profiles').select('email').eq('username', identifier.toLowerCase()).maybeSingle());
  return row?.email ?? null;
}

export async function login({ authClient, database }, identifier, password) {
  const email = await emailFor(database, identifier);
  const { data, error } = email
    ? await authClient.auth.signInWithPassword({ email, password })
    : { data: {}, error: true };
  if (error || !data.session || !data.user) {
    await writeAudit(database, { userName: identifier.slice(0, 100), action: 'Login failed' });
    throw new HttpError(401, INVALID_LOGIN);
  }
  let user;
  try {
    user = await loadActiveProfile(database, data.user.id);
  } catch (failure) {
    await endSession(database, data.session.access_token);
    throw failure;
  }
  await writeAudit(database, { user, action: 'User login', entityType: 'user', entityId: user.id });
  return sessionResponse(user, data.session);
}

export async function refresh({ authClient, database }, refreshToken) {
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user) throw new HttpError(401, 'Session expired. Sign in again.');
  try {
    return sessionResponse(await loadActiveProfile(database, data.user.id), data.session);
  } catch (failure) {
    await endSession(database, data.session.access_token);
    throw failure;
  }
}

export async function logout({ database }, user, token) {
  await endSession(database, token);
  await writeAudit(database, { user, action: 'User logout', entityType: 'user', entityId: user.id });
}

async function savePassword(database, userId, password) {
  const { error } = await database.auth.admin.updateUserById(userId, { password });
  if (error) {
    if (error.status === 422) throw new HttpError(400, error.message);
    console.error('Password update failed:', error);
    throw new HttpError(500, 'The password could not be changed.');
  }
}

export async function changePassword({ authClient, database }, user, token, currentPassword, password) {
  const { data, error } = await authClient.auth.signInWithPassword({ email: user.email, password: currentPassword });
  if (error || !data.session) throw new HttpError(400, 'Your current password is not correct.');
  await endSession(database, data.session.access_token);
  if (password === currentPassword) throw new HttpError(400, 'Choose a password different from your current one.');

  await savePassword(database, user.id, password);
  unwrap(await database.from('profiles').update({ must_change_password: false }).eq('id', user.id));
  await writeAudit(database, { user, action: 'Password changed', entityType: 'user', entityId: user.id });
  await endSession(database, token, 'global');
}

// Always succeeds from the caller's view, so it can't reveal which addresses have accounts.
export async function requestPasswordReset({ authClient, database }, email) {
  const address = email.toLowerCase();
  if (address.endsWith(`@${NO_EMAIL_DOMAIN}`)) return;
  const row = unwrap(await database.from('profiles').select('active').eq('email', address).maybeSingle());
  if (!row?.active) return;
  const { error } = await authClient.auth.resetPasswordForEmail(address);
  if (error) console.error('Password reset email failed:', error);
}

export async function resetPasswordWithCode({ authClient, database }, email, code, password) {
  const { data, error } = await authClient.auth.verifyOtp({ email: email.toLowerCase(), token: code, type: 'recovery' });
  if (error || !data.session || !data.user) throw new HttpError(400, INVALID_RESET);
  try {
    const user = await loadActiveProfile(database, data.user.id);
    await savePassword(database, user.id, password);
    unwrap(await database.from('profiles').update({ must_change_password: false }).eq('id', user.id));
    await writeAudit(database, { user, action: 'Password reset by email', entityType: 'user', entityId: user.id });
  } finally {
    await endSession(database, data.session.access_token, 'global');
  }
}
