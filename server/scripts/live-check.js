// Tests login and permissions against the real Supabase project, using four dedicated smoke accounts.
// They get a new random password on each run and are disabled again afterwards.
// Their rows stay, because the audit log they appear in can't be edited.
// Usage: npm --prefix server run test:live
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../app.js';
import { loadEnvFile, readConfig } from '../config.js';
import { createClients } from '../db.js';
import { NO_EMAIL_DOMAIN } from '../services/auth.js';

const ACCOUNTS = { Owner: 'smoke.owner', Manager: 'smoke.manager', Cashier: 'smoke.cashier', 'Inventory Staff': 'smoke.stock' };
// Route, then the roles allowed to use it. Everyone else must get 403.
const ACCESS = [
  ['/api/reports/sales', ['Owner', 'Manager']],
  ['/api/reports/products', ['Owner', 'Manager', 'Inventory Staff']],
  ['/api/reports/stock-movements', ['Owner', 'Manager', 'Inventory Staff']]
];

loadEnvFile();
const config = readConfig();
const clients = createClients(config);
const { database } = clients;
const password = () => `Smoke-${randomBytes(12).toString('hex')}`;
const accounts = {};
let passed = 0;

async function check(name, run) {
  await run();
  passed += 1;
  console.log(`ok   ${name}`);
}

async function ensureAccount(role, username) {
  const email = `${username}@${NO_EMAIL_DOMAIN}`;
  const secret = password();
  const existing = await database.from('profiles').select('id').eq('username', username).maybeSingle();
  let id = existing.data?.id;
  if (id) {
    const updated = await database.auth.admin.updateUserById(id, { password: secret });
    if (updated.error) throw updated.error;
  } else {
    const created = await database.auth.admin.createUser({ email, password: secret, email_confirm: true });
    if (created.error) throw created.error;
    id = created.data.user.id;
  }
  const saved = await database.from('profiles').upsert({
    id, username, full_name: `Smoke ${role}`, email, role_code: role, active: true, must_change_password: false
  });
  if (saved.error) throw saved.error;
  accounts[role] = { id, username, email, password: secret };
}

async function disableAccounts() {
  for (const account of Object.values(accounts)) {
    await database.from('profiles').update({ active: false, must_change_password: false }).eq('id', account.id);
    await database.auth.admin.updateUserById(account.id, { password: password() });
  }
}

const server = createApp({ config, ...clients }).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function request(path, { token, body, method } = {}) {
  return fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });
}

async function signIn(identifier, secret) {
  const response = await request('/api/auth/login', { body: { identifier, password: secret } });
  assert.equal(response.status, 200, `login for ${identifier}`);
  return response.json();
}

try {
  for (const [role, username] of Object.entries(ACCOUNTS)) await ensureAccount(role, username);
  const sessions = {};

  for (const role of Object.keys(ACCOUNTS)) {
    await check(`${role} signs in by username and gets the role's permissions`, async () => {
      sessions[role] = await signIn(accounts[role].username, accounts[role].password);
      assert.equal(sessions[role].user.role, role);
      const expected = await database.from('role_permissions').select('permission_code').eq('role_code', role);
      assert.deepEqual([...sessions[role].user.permissions].sort(), expected.data.map((row) => row.permission_code).sort());
    });
  }

  for (const [path, allowed] of ACCESS) {
    for (const role of Object.keys(ACCOUNTS)) {
      const expected = allowed.includes(role) ? 200 : 403;
      await check(`${role} on ${path} gets ${expected}`, async () => {
        assert.equal((await request(path, { token: sessions[role].token })).status, expected);
      });
    }
  }

  await check('preferences save one field at a time, even when changed quickly', async () => {
    const { token } = sessions.Manager;
    const save = (body) => request('/api/auth/preferences', { token, body, method: 'PUT' });
    const responses = await Promise.all([save({ language: 'ta' }), save({ theme: 'light' })]);
    for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
    const read = await request('/api/auth/preferences', { token });
    assert.deepEqual((await read.json()).preferences, { language: 'ta', theme: 'light' });
    await save({ language: 'en', theme: 'dark' });
  });
  await check('login by email works', async () => {
    const session = await signIn(accounts.Owner.email, accounts.Owner.password);
    sessions.Owner2 = session;
  });
  await check('wrong password and unknown username get the same refusal', async () => {
    const wrong = await request('/api/auth/login', { body: { identifier: accounts.Owner.username, password: 'wrong-password' } });
    const unknown = await request('/api/auth/login', { body: { identifier: 'nobody.here', password: 'wrong-password' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
  });
  await check('requests without a real token are refused', async () => {
    assert.equal((await request('/api/auth/me')).status, 401);
    assert.equal((await request('/api/auth/me', { token: 'forged.token.value' })).status, 401);
  });
  await check('the refresh token gives a working new session', async () => {
    const response = await request('/api/auth/refresh', { body: { refreshToken: sessions.Owner2.refreshToken } });
    assert.equal(response.status, 200);
    sessions.Owner2 = await response.json();
    assert.equal((await request('/api/auth/me', { token: sessions.Owner2.token })).status, 200);
  });
  await check('logout ends the session on the server', async () => {
    assert.equal((await request('/api/auth/logout', { token: sessions.Owner2.token, method: 'POST' })).status, 204);
    assert.equal((await request('/api/auth/me', { token: sessions.Owner2.token })).status, 401);
    assert.equal((await request('/api/auth/refresh', { body: { refreshToken: sessions.Owner2.refreshToken } })).status, 401);
  });

  const cashier = accounts.Cashier;
  const temporary = password();
  await check('a Cashier cannot reset passwords', async () => {
    const response = await request(`/api/users/${accounts['Inventory Staff'].id}/reset-password`, {
      token: sessions.Cashier.token, body: { temporaryPassword: temporary }
    });
    assert.equal(response.status, 403);
  });
  await check('a Manager cannot reset an Owner password', async () => {
    const response = await request(`/api/users/${accounts.Owner.id}/reset-password`, {
      token: sessions.Manager.token, body: { temporaryPassword: temporary }
    });
    assert.equal(response.status, 403);
    await signIn(accounts.Owner.username, accounts.Owner.password);
  });
  await check('a Manager reset forces the Cashier to choose a new password', async () => {
    const reset = await request(`/api/users/${cashier.id}/reset-password`, {
      token: sessions.Manager.token, body: { temporaryPassword: temporary }
    });
    assert.equal(reset.status, 204);
    const session = await signIn(cashier.username, temporary);
    assert.equal(session.user.mustChangePassword, true);
    const blocked = await request('/api/reports/sales', { token: session.token });
    assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED');

    cashier.password = password();
    const wrong = await request('/api/auth/change-password', {
      token: session.token, body: { currentPassword: 'not-the-password', newPassword: cashier.password }
    });
    assert.equal(wrong.status, 400);
    const changed = await request('/api/auth/change-password', {
      token: session.token, body: { currentPassword: temporary, newPassword: cashier.password }
    });
    assert.equal(changed.status, 204);
    assert.equal((await request('/api/auth/me', { token: session.token })).status, 401, 'old session ends');
    const after = await signIn(cashier.username, cashier.password);
    assert.equal(after.user.mustChangePassword, false);
  });

  await check('disabling an account blocks its open session, login and refresh', async () => {
    const stock = accounts['Inventory Staff'];
    await database.from('profiles').update({ active: false }).eq('id', stock.id);
    assert.equal((await request('/api/auth/me', { token: sessions['Inventory Staff'].token })).status, 403);
    assert.equal((await request('/api/auth/refresh', { body: { refreshToken: sessions['Inventory Staff'].refreshToken } })).status, 403);
    const response = await request('/api/auth/login', { body: { identifier: stock.username, password: stock.password } });
    assert.equal(response.status, 403);
  });

  await check('login, logout and failures reached the audit log', async () => {
    const { data } = await database.from('audit_logs').select('action').order('id', { ascending: false }).limit(60);
    const actions = data.map((row) => row.action);
    for (const action of ['User login', 'User logout', 'Login failed', 'Password reset', 'Password changed']) {
      assert.ok(actions.includes(action), `${action} is missing`);
    }
  });

  console.log(`\nAll ${passed} live checks passed.`);
} catch (error) {
  console.error(`\nFAILED after ${passed} passing checks:`, error.message);
  process.exitCode = 1;
} finally {
  await disableAccounts();
  server.close();
  server.closeAllConnections();
}
