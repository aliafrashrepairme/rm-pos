import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['credit.view', 'credit.collect', 'credit.manage', 'purchases.view'],
  cashier: ['credit.view', 'credit.collect', 'pos.sell'],
  owner: ['credit.view'],
  stock: ['products.view']
};
const ID = randomUUID();
const CUSTOMER = { id: ID, code: 'CUS-1', name: 'Nimal', phone: '077', loyalty_points: 120, purchase_count: 3, credit_limit: '5000.00', credit_balance: '1200.00' };

function fakeDatabase() {
  const database = {
    rpcCalls: [],
    audits: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'record_credit_payment') return { data: { customer: 'Nimal', amount: args.p_payment.amount, balance: 700, inShift: true }, error: null };
      if (name === 'set_credit_limit') return { data: { customer: 'Nimal', from: 5000, to: args.p_limit }, error: null };
      if (name === 'supplier_payables') return { data: [{ id: 'p', poNo: 'PO-1', balance: '300.00', total: '500.00', paid: '200.00', daysOverdue: 4 }], error: null };
      if (name === 'points_cap') return { data: 150, error: null };
      return { data: null, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain, order: () => chain, range: () => chain, limit: () => chain, or: () => chain,
        gt: () => chain, neq: () => chain,
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'customers') return resolve({ data: call.single ? CUSTOMER : [CUSTOMER], count: 1, error: null });
          resolve({ data: [], count: 0, error: null });
        }
      };
      return chain;
    }
  };
  return database;
}

const authClient = { auth: { getUser: async (token) => ({ data: { user: { id: token } }, error: null }) } };

async function withApi(run) {
  const database = fakeDatabase();
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

const send = (method, body) => ({ method, body: JSON.stringify(body) });

test('each role reaches only its part of credit management', async () => {
  await withApi(async (as) => {
    assert.equal((await as('stock', '/api/credit/customers')).status, 403);
    const list = await (await as('owner', '/api/credit/customers')).json();
    assert.equal(list.customers[0].creditAvailable, 3800);
    assert.equal((await as('owner', `/api/credit/customers/${ID}/payments`, send('POST', { amount: 1, method: 'Cash' }))).status, 403);
    assert.equal((await as('cashier', `/api/credit/customers/${ID}/limit`, send('PUT', { limit: 1 }))).status, 403, 'only a Manager changes limits');
    assert.equal((await as('cashier', '/api/credit/suppliers')).status, 403, 'supplier balances need purchase rights');
    const suppliers = await (await as('manager', '/api/credit/suppliers')).json();
    assert.deepEqual(suppliers.summary, { totalOwed: 300, overdue: 300, overdueCount: 1 });
  });
});

test('repayments and limits are validated and audited', async () => {
  await withApi(async (as, database) => {
    assert.equal((await as('cashier', `/api/credit/customers/${ID}/payments`, send('POST', { amount: 0, method: 'Cash' }))).status, 400);
    assert.equal((await as('cashier', '/api/credit/customers/nope/payments', send('POST', { amount: 1, method: 'Cash' }))).status, 404);
    const paid = await as('cashier', `/api/credit/customers/${ID}/payments`, send('POST', { amount: 500, method: 'Cash' }));
    assert.equal(paid.status, 201);
    assert.equal((await paid.json()).inShift, true);
    assert.equal(database.rpcCalls.find(([name]) => name === 'record_credit_payment')[1].p_user, 'cashier');

    assert.equal((await as('manager', `/api/credit/customers/${ID}/limit`, send('PUT', { limit: -5 }))).status, 400);
    assert.equal((await as('manager', `/api/credit/customers/${ID}/limit`, send('PUT', { limit: 20000 }))).status, 200);
    assert.deepEqual(database.audits.map((row) => row.action), ['Credit payment received', 'Credit limit changed']);
  });
});

test('POS asks the database for the points limit of a cart', async () => {
  await withApi(async (as, database) => {
    const response = await as('cashier', '/api/pos/points-cap', send('POST', { items: [{ productId: ID, qty: 1 }], discountRate: 0.03 }));
    assert.deepEqual(await response.json(), { cap: 150 });
    assert.equal(database.rpcCalls[0][1].p_rate, 0.03);
    assert.equal((await as('cashier', '/api/pos/points-cap', send('POST', { items: [{ productId: ID, qty: 1 }], discountRate: 5 }))).status, 400);
    assert.equal((await as('owner', '/api/pos/points-cap', send('POST', { items: [] }))).status, 403);
  });
});
