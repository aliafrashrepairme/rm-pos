import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['customers.view', 'customers.manage', 'customers.points'],
  cashier: ['customers.view', 'customers.manage'],
  stock: ['products.view'],
  owner: ['reports.sales']
};
const ID = randomUUID();
const ROW = { id: ID, code: 'CUS-1', name: 'Ravi', phone: '0771234567', email: '', address: '', loyalty_points: 10, purchase_count: 1, active: true };
const BILL = { id: 'b1', bill_no: 'RM-INV-1', status: 'Paid', grand_total: '100.00', points_earned: 1, created_at: 't' };
const REFUND = { refund_no: 'RF-1', total: '20.00', reason: 'x', created_at: 't', sales: { id: 'b1', bill_no: 'RM-INV-1', customer_id: ID } };

function fakeDatabase({ held = 0, existing = null } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    updates: [],
    ors: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'customer_stats') return { data: { bills: 1, purchased: 100, refunded: 20, spent: 80, lastPurchaseAt: 't' }, error: null };
      return { data: ID, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        range: () => chain,
        or: (text) => { database.ors.push(text); return chain; },
        insert: (row) => { if (table === 'audit_logs') database.audits.push(row); return chain; },
        update: (change) => { call.update = change; database.updates.push(change); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'customers') {
            if (call.filters.some(([column]) => column === 'phone')) return resolve({ data: existing, error: null });
            return resolve({ data: call.update ? { ...ROW, ...call.update } : (call.single ? ROW : [ROW]), count: 1, error: null });
          }
          if (table === 'sales') return resolve({ data: [BILL], count: 1, error: null });
          if (table === 'refunds') return resolve({ data: [REFUND], error: null });
          if (table === 'held_orders') return resolve({ data: [], count: held, error: null });
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
    for (const user of ['stock', 'owner']) {
      assert.equal((await as(user, '/api/customers')).status, 403, user);
      assert.equal((await as(user, `/api/customers/${ID}`)).status, 403, user);
      assert.equal((await as(user, '/api/customers', post({ name: 'A' }))).status, 403, user);
      assert.equal((await as(user, `/api/customers/${ID}`, patch({ name: 'A' }))).status, 403, user);
    }
    for (const user of ['manager', 'cashier']) {
      assert.equal((await as(user, '/api/customers')).status, 200, user);
      assert.equal((await as(user, '/api/customers', post({ name: 'A' }))).status, 201, user);
      assert.equal((await as(user, `/api/customers/${ID}`, patch({ name: 'B' }))).status, 200, user);
    }
  });
});

test('only a Manager can set opening points, and the audit log records them', async () => {
  await withApi({}, async (as, database) => {
    const refused = await as('cashier', '/api/customers', post({ name: 'A', loyaltyPoints: 1000 }));
    assert.equal(refused.status, 403);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await as('manager', '/api/customers', post({ name: 'A', loyaltyPoints: 1000 }))).status, 201);
    assert.equal(database.rpcCalls[0][1].p_customer.loyaltyPoints, 1000);
    assert.match(database.audits[0].description, /1000 opening points/);
  });
});

test('points and counts cannot be changed by editing', async () => {
  await withApi({}, async (as, database) => {
    await as('manager', `/api/customers/${ID}`, patch({ loyalty_points: 9999, loyaltyPoints: 9999, purchase_count: 0, code: 'X', name: 'New' }));
    assert.deepEqual(database.updates[0], { name: 'New' });
  });
});

test('details are validated', async () => {
  await withApi({}, async (as, database) => {
    const add = (body) => as('manager', '/api/customers', post(body));
    assert.equal((await add({})).status, 400);
    assert.equal((await add({ name: 'A', phone: 'abc' })).status, 400);
    assert.equal((await add({ name: 'A', email: 'bad' })).status, 400);
    assert.equal((await add({ name: 'A', loyaltyPoints: -1 })).status, 400);
    assert.equal((await add({ name: 'A', loyaltyPoints: 1.5 })).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await as('manager', `/api/customers/${ID}`, patch({}))).status, 400);
    assert.equal((await as('manager', `/api/customers/${ID}`, patch({ active: 'no' }))).status, 400);
    assert.equal((await as('manager', '/api/customers/not-an-id')).status, 404);
  });
});

test('a repeated phone is refused, and the till still needs a phone', async () => {
  await withApi({ existing: { id: 'c9' } }, async (as) => {
    assert.equal((await as('manager', '/api/customers', post({ name: 'A', phone: '0771234567' }))).status, 409);
  });
  await withApi({}, async (as) => {
    assert.equal((await as('manager', '/api/customers', post({ name: 'A' }))).status, 201);
    assert.equal((await as('manager', '/api/pos/customers', post({ name: 'A' }))).status, 400);
  });
});

test('search text cannot break out of the filter', async () => {
  await withApi({}, async (as, database) => {
    await as('cashier', '/api/customers?q=a%22,active.eq.false');
    assert.ok(!database.ors[0].includes('a"'), database.ors[0]);
  });
});

test('the profile shows figures, bills and refunds', async () => {
  await withApi({}, async (as) => {
    const { customer } = await (await as('cashier', `/api/customers/${ID}`)).json();
    assert.equal(customer.stats.spent, 80);
    assert.equal(customer.bills[0].billNo, 'RM-INV-1');
    assert.equal(customer.bills[0].total, 100);
    assert.equal(customer.refunds[0].refundNo, 'RF-1');
    assert.equal(customer.refunds[0].billNo, 'RM-INV-1');
  });
});

test('a customer on a held order cannot be deactivated', async () => {
  await withApi({ held: 1 }, async (as, database) => {
    const response = await as('manager', `/api/customers/${ID}`, patch({ active: false }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /1 held order/);
    assert.equal(database.updates.length, 0);
  });
  await withApi({}, async (as, database) => {
    assert.equal((await as('manager', `/api/customers/${ID}`, patch({ active: false }))).status, 200);
    assert.deepEqual(database.audits.map((row) => row.action), ['Customer deactivated']);
  });
});
