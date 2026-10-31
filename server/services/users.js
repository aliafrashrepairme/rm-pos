import { HttpError, unwrap } from '../errors.js';
import { NO_EMAIL_DOMAIN } from './auth.js';
import { writeAudit } from './audit.js';

const STAFF_ROLES = ['Manager', 'Cashier', 'Inventory Staff'];
const COLUMNS = 'id, username, full_name, email, role_code, active, must_change_password, created_at';

function asUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.full_name,
    email: row.email.endsWith(`@${NO_EMAIL_DOMAIN}`) ? '' : row.email,
    role: row.role_code,
    active: row.active,
    mustChangePassword: row.must_change_password
  };
}

function fullName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'Enter the full name.');
  return name;
}

function typedEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 120 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function staffRole(value) {
  if (!STAFF_ROLES.includes(value)) throw new HttpError(400, 'Choose a valid role.');
  return value;
}

async function targetOf(database, id) {
  const target = unwrap(await database.from('profiles').select(COLUMNS).eq('id', id).maybeSingle());
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.role_code === 'Owner') throw new HttpError(403, 'Owner accounts cannot be changed here.');
  return target;
}

export async function listUsers({ database }) {
  const [users, roles] = await Promise.all([
    database.from('profiles').select(COLUMNS).neq('role_code', 'Owner').order('full_name').order('id'),
    database.from('roles').select('code, description').neq('code', 'Owner').order('code')
  ]);
  return {
    users: unwrap(users).map(asUser),
    roles: unwrap(roles).map((row) => ({ code: row.code, description: row.description }))
  };
}

export async function createUser({ database }, actor, body, temporaryPassword) {
  const name = fullName(body?.name);
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username must be 3 to 40 letters, numbers, dots, dashes or underscores.');
  const role = staffRole(body?.role);
  const email = typedEmail(body?.email) || `${username}@${NO_EMAIL_DOMAIN}`;

  const created = await database.auth.admin.createUser({ email, password: temporaryPassword, email_confirm: true });
  if (created.error) {
    if (created.error.status === 422) throw new HttpError(409, 'An account with this email already exists.');
    console.error('Account creation failed:', created.error);
    throw new HttpError(500, 'The account could not be created.');
  }
  const id = created.data.user.id;
  const saved = await database.from('profiles')
    .insert({ id, username, full_name: name, email, role_code: role, must_change_password: true, created_by: actor.id })
    .select(COLUMNS)
    .single();
  if (saved.error) {
    await database.auth.admin.deleteUser(id);
    unwrap(saved);
  }
  await writeAudit(database, { user: actor, action: 'User created', description: `${username} · ${role}`, entityType: 'user', entityId: id });
  return asUser(saved.data);
}

export async function updateUser({ database }, actor, id, body) {
  const target = await targetOf(database, id);
  const changes = {};
  if (body?.name !== undefined) changes.fullName = fullName(body.name);
  if (body?.role !== undefined) changes.role = staffRole(body.role);
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Active must be true or false.');
    changes.active = body.active;
  }
  let emailChanged = false;
  if (body?.email !== undefined) {
    changes.email = typedEmail(body.email) || `${target.username}@${NO_EMAIL_DOMAIN}`;
    emailChanged = changes.email !== target.email;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');

  // The login's email changes first, so a refusal here leaves the staff record as it was.
  if (emailChanged) {
    const { error } = await database.auth.admin.updateUserById(id, { email: changes.email, email_confirm: true });
    if (error) {
      if (error.status === 422) throw new HttpError(409, 'An account with this email already exists.');
      console.error('Email change failed:', error);
      throw new HttpError(500, 'The email could not be changed.');
    }
  }
  let row;
  try {
    row = unwrap(await database.rpc('update_staff', { p_actor: actor.id, p_target: id, p_changes: changes }));
  } catch (failure) {
    if (emailChanged) await database.auth.admin.updateUserById(id, { email: target.email, email_confirm: true });
    throw failure;
  }

  const details = [];
  if (changes.role && changes.role !== target.role_code) details.push(`${target.role_code} → ${changes.role}`);
  if (emailChanged) details.push('email changed');
  if (changes.fullName && changes.fullName !== target.full_name) details.push('name changed');
  const action = changes.active === false ? 'User disabled'
    : changes.active === true ? 'User enabled'
      : changes.role && changes.role !== target.role_code ? 'Role changed' : 'User updated';
  await writeAudit(database, { user: actor, action, description: [target.username, ...details].join(' · '), entityType: 'user', entityId: id });
  return asUser(row);
}

// Records must keep pointing at who made them, so only an unused account can go.
export async function removeUser({ database }, actor, id) {
  if (id === actor.id) throw new HttpError(409, 'You cannot remove your own account.');
  const target = await targetOf(database, id);
  const { error } = await database.from('profiles').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') throw new HttpError(409, 'This account has activity on record, so it can only be disabled.');
    unwrap({ error });
  }
  const removed = await database.auth.admin.deleteUser(id);
  if (removed.error) console.error('Login removal failed:', removed.error);
  await writeAudit(database, { user: actor, action: 'User removed', description: target.username, entityType: 'user', entityId: id });
}

export async function userActivity({ database }, id) {
  const target = unwrap(await database.from('profiles').select('id').eq('id', id).neq('role_code', 'Owner').maybeSingle());
  if (!target) throw new HttpError(404, 'User not found.');
  const rows = unwrap(await database.from('audit_logs')
    .select('id, action, description, created_at')
    .eq('user_id', id)
    .order('id', { ascending: false })
    .limit(50));
  return rows.map((row) => ({ id: row.id, action: row.action, description: row.description, createdAt: row.created_at }));
}

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
