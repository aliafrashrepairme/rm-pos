import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = { manager: ['users.manage', 'settings.manage'], cashier: ['pos.sell'], owner: ['reports.sales'] };
const STAFF = randomUUID();
const OWNER = randomUUID();
const row = (id, role, username) => ({ id, username, full_name: username, email: `${username}@x.lk`, role_code: role, active: true, must_change_password: false });
const PROFILES = { [STAFF]: row(STAFF, 'Cashier', 'kumar'), [OWNER]: row(OWNER, 'Owner', 'boss') };
const STORE = { store_name: 'RM', address: 'A', phone: 'P', vat_registration: 'V', currency_code: 'LKR', time_zone: 'Asia/Colombo', receipt: { showTax: false } };

function fakeDatabase({ authError = null, deleteError = null, insertError = null, activeMethods = 2 } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    updates: [],
    inserts: [],
    adminCalls: [],
    auth: {
      admin: {
        createUser: async (args) => { database.adminCalls.push(['create', args]); return authError ? { error: authError } : { data: { user: { id: 'new-id' } }, error: null }; },
        updateUserById: async (id, args) => { database.adminCalls.push(['update', id, args]); return { error: authError }; },
        deleteUser: async (id) => { database.adminCalls.push(['delete', id]); return { error: null }; }
      }
    },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'update_staff') return { data: { ...PROFILES[args.p_target], role_code: args.p_changes.role ?? PROFILES[args.p_target].role_code }, error: null };
      return { data: null, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        neq: () => chain,
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); else { call.insert = value; database.inserts.push([table, value]); } return chain; },
        update: (value) => { call.update = value; database.updates.push([table, value]); return chain; },
        delete: () => { call.delete = true; return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          const id = call.filters.find(([column]) => column === 'id')?.[1];
          if (table === 'profiles') {
            if (call.delete) return resolve({ data: null, error: deleteError });
            if (call.insert) return resolve(insertError ? { data: null, error: insertError } : { data: { ...call.insert, active: true }, error: null });
            if (PERMS[id]) return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: PERMS[id].map((permission_code) => ({ permission_code })) } }, error: null });
            return resolve({ data: call.single ? PROFILES[id] ?? null : Object.values(PROFILES).filter((item) => item.role_code !== 'Owner'), error: null });
          }
          if (table === 'store_settings') return resolve({ data: call.update ? { id: true } : STORE, error: null });
          if (table === 'tax_rates') return resolve({ data: call.single ? { id: 'T', name: 'VAT', rate: '18.00' } : [{ id: 'T', name: 'VAT', rate: '18.00', is_default: true }], error: null });
          if (table === 'payment_methods') {
            if (call.update) return resolve({ data: { code: 'Cash' }, error: null });
            return resolve({ data: Array.from({ length: activeMethods - 1 }, () => ({ code: 'Card', is_cash: false, requires_reference: false, active: true })), error: null });
          }
          resolve({ data: call.single ? null : [], error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };

async function withApi(options, run) {
  const database = fakeDatabase(options);
  const server = createApp({ config, authClient, database }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user, path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user}` }
  });
  try {
    await run(as, database);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body) => ({ method: 'PATCH', body: JSON.stringify(body) });
const NEW_USER = { name: 'New', username: 'newone', role: 'Cashier', temporaryPassword: 'temporary-1' };

test('only a Manager reaches users and settings', async () => {
  await withApi({}, async (as) => {
    for (const user of ['cashier', 'owner']) {
      assert.equal((await as(user, '/api/users')).status, 403, user);
      assert.equal((await as(user, '/api/users', post(NEW_USER))).status, 403, user);
      assert.equal((await as(user, `/api/users/${STAFF}`, patch({ active: false }))).status, 403, user);
      assert.equal((await as(user, `/api/users/${STAFF}`, { method: 'DELETE' })).status, 403, user);
      assert.equal((await as(user, `/api/users/${STAFF}/activity`)).status, 403, user);
      assert.equal((await as(user, '/api/settings')).status, 403, user);
      assert.equal((await as(user, '/api/settings', patch({ phone: '1' }))).status, 403, user);
    }
    assert.equal((await as('manager', '/api/users')).status, 200);
    assert.equal((await as('manager', '/api/settings')).status, 200);
  });
});

test('Owners are hidden and cannot be changed or created', async () => {
  await withApi({}, async (as, database) => {
    const { users } = await (await as('manager', '/api/users')).json();
    assert.ok(users.every((user) => user.role !== 'Owner'));
    assert.equal((await as('manager', `/api/users/${OWNER}`, patch({ name: 'X' }))).status, 403);
    assert.equal((await as('manager', `/api/users/${OWNER}`, { method: 'DELETE' })).status, 403);
    assert.equal((await as('manager', '/api/users', post({ ...NEW_USER, role: 'Owner' }))).status, 400);
    assert.equal((await as('manager', `/api/users/${STAFF}`, patch({ role: 'Owner' }))).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal(database.adminCalls.length, 0);
  });
});

test('a new user gets a temporary password that is never logged', async () => {
  await withApi({}, async (as, database) => {
    const response = await as('manager', '/api/users', post({ ...NEW_USER, username: 'NewOne', email: '' }));
    assert.equal(response.status, 201);
    const [, created] = database.adminCalls[0];
    assert.equal(created.email, 'newone@staff.rm-pos.local');
    assert.equal(created.email_confirm, true);
    const [, profile] = database.inserts[0];
    assert.deepEqual([profile.username, profile.role_code, profile.must_change_password, profile.created_by], ['newone', 'Cashier', true, 'manager']);
    assert.equal((await response.json()).user.email, '', 'the internal address is not shown');
    assert.deepEqual(database.audits.map((row) => row.action), ['User created']);
    assert.ok(!JSON.stringify(database.audits).includes('temporary-1'));
  });
});

test('a failed profile removes the login it just created', async () => {
  await withApi({ insertError: { code: '23505', message: 'duplicate key profiles_username_key' } }, async (as, database) => {
    assert.equal((await as('manager', '/api/users', post(NEW_USER))).status, 409);
    assert.deepEqual(database.adminCalls.at(-1), ['delete', 'new-id']);
    assert.equal(database.audits.length, 0);
  });
});

test('new user details are validated', async () => {
  await withApi({}, async (as, database) => {
    const add = (change) => as('manager', '/api/users', post({ ...NEW_USER, ...change }));
    assert.equal((await add({ name: ' ' })).status, 400);
    assert.equal((await add({ username: 'a b' })).status, 400);
    assert.equal((await add({ email: 'bad' })).status, 400);
    assert.equal((await add({ temporaryPassword: 'short' })).status, 400);
    assert.equal(database.adminCalls.length, 0);
  });
});

test('an email already in use is refused', async () => {
  await withApi({ authError: { status: 422, message: 'exists' } }, async (as) => {
    assert.equal((await as('manager', '/api/users', post(NEW_USER))).status, 409);
    assert.equal((await as('manager', `/api/users/${STAFF}`, patch({ email: 'taken@x.lk' }))).status, 409);
  });
});

test('role changes and disabling reach the audit log with the actor', async () => {
  await withApi({}, async (as, database) => {
    await as('manager', `/api/users/${STAFF}`, patch({ role: 'Manager', username: 'hacked', id: 'x' }));
    const [name, args] = database.rpcCalls[0];
    assert.equal(name, 'update_staff');
    assert.equal(args.p_actor, 'manager');
    assert.deepEqual(args.p_changes, { role: 'Manager' });
    assert.equal(database.audits[0].action, 'Role changed');
    assert.match(database.audits[0].description, /Cashier → Manager/);
    await as('manager', `/api/users/${STAFF}`, patch({ active: false }));
    assert.equal(database.audits[1].action, 'User disabled');
  });
});

test('accounts with activity are kept', async () => {
  await withApi({ deleteError: { code: '23503', message: 'foreign key' } }, async (as, database) => {
    const response = await as('manager', `/api/users/${STAFF}`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /only be disabled/);
    assert.equal(database.adminCalls.length, 0);
  });
  await withApi({}, async (as, database) => {
    assert.equal((await as('manager', `/api/users/${STAFF}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(database.adminCalls, [['delete', STAFF]]);
    assert.equal(database.audits[0].action, 'User removed');
    assert.equal((await as('manager', '/api/users/manager', { method: 'DELETE' })).status, 409);
  });
});

test('settings are validated and merge with what is saved', async () => {
  await withApi({}, async (as, database) => {
    const change = (body) => as('manager', '/api/settings', patch(body));
    assert.equal((await change({})).status, 400);
    assert.equal((await change({ storeName: ' ' })).status, 400);
    assert.equal((await change({ receipt: { size: 'huge' } })).status, 400);
    assert.equal((await change({ receipt: { showTax: 'yes' } })).status, 400);
    assert.equal((await change({ receipt: { footer: 'x'.repeat(201) } })).status, 400);
    assert.equal(database.updates.length, 0);
    assert.equal((await change({ storeName: ' New ', receipt: { footer: ' Thanks ' }, currency_code: 'USD' })).status, 200);
    const [table, saved] = database.updates[0];
    assert.equal(table, 'store_settings');
    assert.equal(saved.store_name, 'New');
    assert.equal(saved.currency_code, undefined);
    assert.equal(saved.updated_by, 'manager');
    assert.equal(saved.receipt.footer, 'Thanks');
    assert.equal(saved.receipt.showTax, false, 'keeps what was saved');
    assert.equal(saved.receipt.size, '80mm');
  });
});

test('tax rates and payment methods are checked and audited', async () => {
  await withApi({}, async (as, database) => {
    const rate = (value) => as('manager', '/api/settings/tax-rates/T', patch({ rate: value }));
    for (const bad of [-1, 101, 'x', '']) assert.equal((await rate(bad)).status, 400, String(bad));
    assert.equal((await rate(15.5)).status, 200);
    assert.match(database.audits[0].description, /18% → 15.5%/);
    assert.equal((await as('manager', '/api/settings/payment-methods/Cash', patch({ active: 'no' }))).status, 400);
    assert.equal((await as('manager', '/api/settings/payment-methods/Cash', patch({ active: false }))).status, 200);
  });
  await withApi({ activeMethods: 1 }, async (as) => {
    const response = await as('manager', '/api/settings/payment-methods/Cash', patch({ active: false }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /at least one/);
  });
});
