import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['suppliers.view', 'suppliers.manage'],
  stock: ['suppliers.view', 'suppliers.manage'],
  cashier: ['pos.sell'],
  owner: ['reports.sales']
};
const ID = randomUUID();
const ROW = { id: ID, code: 'SUP-0001', name: 'Lanka', contact_person: 'M', phone: '077', email: '', address: '', city: '', payment_terms: 'Cash', lead_time_days: 3, rating: '4.5', active: true };
const STATS = { orders: 1, openOrders: 0, purchased: 100, paid: 40, balance: 60, judged: 1, onTimePercent: 100, products: 2 };

function fakeDatabase({ openOrders = 0, owed = 0 } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    updates: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'supplier_list') return { data: { rows: [{ ...ROW, stats: STATS }], total: 1 }, error: null };
      if (name === 'supplier_stats') return { data: { ...STATS, balance: owed }, error: null };
      return { data: ID, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        range: () => chain,
        insert: (row) => { if (table === 'audit_logs') database.audits.push(row); return chain; },
        update: (change) => { call.update = change; database.updates.push(change); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        in: () => chain,
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'suppliers') return resolve({ data: call.update ? { ...ROW, ...call.update } : ROW, error: null });
          if (table === 'purchases' && !call.single) return resolve({ data: [], count: openOrders, error: null });
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

test('each role reaches only what it should', async () => {
  await withApi({}, async (as) => {
    for (const user of ['cashier', 'owner']) {
      assert.equal((await as(user, '/api/suppliers')).status, 403, user);
      assert.equal((await as(user, `/api/suppliers/${ID}`)).status, 403, user);
      assert.equal((await as(user, '/api/suppliers', post({ name: 'S' }))).status, 403, user);
      assert.equal((await as(user, `/api/suppliers/${ID}`, patch({ name: 'S' }))).status, 403, user);
    }
    for (const user of ['manager', 'stock']) {
      assert.equal((await as(user, '/api/suppliers')).status, 200, user);
      assert.equal((await as(user, `/api/suppliers/${ID}`)).status, 200, user);
      assert.equal((await as(user, `/api/suppliers/${ID}`, patch({ name: 'New' }))).status, 200, user);
    }
  });
});

test('the list passes clean filters and returns readable fields', async () => {
  await withApi({}, async (as, database) => {
    const body = await (await as('stock', '/api/suppliers?q=a%25_b&status=nonsense&pageSize=9999&page=2')).json();
    const [, args] = database.rpcCalls[0];
    assert.equal(args.p_search, 'a  b');
    assert.equal(args.p_status, 'active');
    assert.equal(args.p_limit, 100);
    assert.equal(args.p_offset, 100);
    assert.equal(body.suppliers[0].contactPerson, 'M');
    assert.equal(body.suppliers[0].rating, 4.5);
    assert.equal(body.suppliers[0].stats.balance, 60);
  });
});

test('supplier details are validated', async () => {
  await withApi({}, async (as, database) => {
    const add = (body) => as('manager', '/api/suppliers', post(body));
    assert.equal((await add({})).status, 400);
    assert.equal((await add({ name: ' ' })).status, 400);
    assert.equal((await add({ name: 'S', email: 'not-an-email' })).status, 400);
    assert.equal((await add({ name: 'S', leadTimeDays: 2.5 })).status, 400);
    assert.equal((await add({ name: 'S', phone: 5 })).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    const change = (body) => as('manager', `/api/suppliers/${ID}`, patch(body));
    assert.equal((await change({})).status, 400);
    assert.equal((await change({ rating: 6 })).status, 400);
    assert.equal((await change({ rating: 'great' })).status, 400);
    assert.equal((await change({ active: 'no' })).status, 400);
    assert.equal((await change({ email: 'bad' })).status, 400);
    assert.equal(database.updates.length, 0);
    assert.equal((await as('manager', '/api/suppliers/not-an-id')).status, 404);
  });
});

test('only allowed fields change, and the rating can be cleared', async () => {
  await withApi({}, async (as, database) => {
    await as('manager', `/api/suppliers/${ID}`, patch({ code: 'HACK', id: 'x', created_at: 'y', name: 'Lanka 2', rating: '' }));
    assert.deepEqual(database.updates[0], { name: 'Lanka 2', rating: null });
    assert.deepEqual(database.audits.map((row) => row.action), ['Supplier updated']);
  });
});

test('a supplier with open orders cannot be deactivated', async () => {
  await withApi({ openOrders: 2 }, async (as, database) => {
    const response = await as('manager', `/api/suppliers/${ID}`, patch({ active: false }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /2 open order/);
    assert.equal(database.updates.length, 0);
  });
  await withApi({ owed: 60 }, async (as, database) => {
    const response = await as('manager', `/api/suppliers/${ID}`, patch({ active: false }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /still owed/);
    assert.equal(database.updates.length, 0);
  });
  await withApi({}, async (as, database) => {
    assert.equal((await as('manager', `/api/suppliers/${ID}`, patch({ active: false }))).status, 200);
    assert.deepEqual(database.audits.map((row) => row.action), ['Supplier deactivated']);
  });
});
