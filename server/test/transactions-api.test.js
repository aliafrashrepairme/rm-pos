import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  owner: ['transactions.view', 'reports.sales', 'reports.export'],
  manager: ['transactions.view', 'bills.view', 'refunds.process'],
  cashier: ['bills.view', 'bills.print', 'pos.sell'],
  stock: ['products.view']
};
const BILL_ID = randomUUID();
const SALE = {
  id: BILL_ID, bill_no: 'RM-INV-1', status: 'Paid', customer_name: 'Walk-in Customer', created_at: 't', grand_total: '118.00', subtotal: '100.00', discount_total: '0', discount_label: '', tax_total: '18.00', points_earned: 0, void_reason: null,
  cashier: { full_name: 'N. Perera' },
  sale_items: [{ id: 'i1', line_no: 1, name: 'Hammer', sku: 'RM-1', qty: '2.000', refunded_qty: '0.000', unit_price: '50.00', tax_rate: '18', discount_amount: '0', tax_amount: '18', line_total: '118.00' }],
  payments: [{ method_code: 'Cash', amount: '118.00', amount_tendered: '200.00', change_given: '82.00', reference: '' }],
  refunds: []
};

function fakeDatabase() {
  const database = {
    rpcCalls: [],
    audits: [],
    filters: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'store_day_bounds') return { data: { start: `${args.p_date}-start`, end: `${args.p_date}-end` }, error: null };
      if (name === 'refund_sale') return { data: { id: 'r1', refundNo: 'RF-1', total: 59, replayed: false }, error: null };
      return { data: { ok: name }, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        insert: (row) => { if (table === 'audit_logs') database.audits.push(row); return chain; },
        or: (text) => { database.filters.push(['or', text]); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); database.filters.push(['eq', column, value]); return chain; },
        gte: (column, value) => { database.filters.push(['gte', column, value]); return chain; },
        lt: (column, value) => { database.filters.push(['lt', column, value]); return chain; },
        range: () => chain,
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'sales') return resolve({ data: call.single ? SALE : [SALE], count: 1, error: null });
          if (table === 'store_settings') return resolve({ data: { store_name: 'RM', address: 'Jaffna', phone: '021', vat_registration: 'V', time_zone: 'Asia/Colombo' }, error: null });
          resolve({ data: null, error: null });
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

const post = (body = {}) => ({ method: 'POST', body: JSON.stringify(body) });
const refundBody = () => ({ clientRequestId: randomUUID(), reason: 'Faulty', method: 'Cash', lines: [{ saleItemId: randomUUID(), qty: 1 }] });

test('each role reaches only what it should', async () => {
  await withApi(async (as) => {
    const expect = async (user, path, status, init) => assert.equal((await as(user, path, init)).status, status, `${user} ${path}`);
    for (const path of ['/api/transactions/daily', '/api/transactions/monthly']) {
      await expect('owner', path, 200);
      await expect('manager', path, 200);
      await expect('cashier', path, 403);
      await expect('stock', path, 403);
    }
    for (const user of ['owner', 'manager', 'cashier']) await expect(user, '/api/transactions/bills', 200);
    await expect('stock', '/api/transactions/bills', 403);
    await expect('stock', `/api/transactions/bills/${BILL_ID}`, 403);

    for (const user of ['owner', 'cashier', 'stock']) {
      await expect(user, `/api/transactions/bills/${BILL_ID}/void`, 403, post({ reason: 'x' }));
      await expect(user, `/api/transactions/bills/${BILL_ID}/refund`, 403, post(refundBody()));
    }
    await expect('manager', `/api/transactions/bills/${BILL_ID}/void`, 200, post({ reason: 'x' }));
    await expect('manager', `/api/transactions/bills/${BILL_ID}/refund`, 201, post(refundBody()));

    await expect('cashier', `/api/transactions/bills/${BILL_ID}/printed`, 204, post({ kind: 'print' }));
    await expect('manager', `/api/transactions/bills/${BILL_ID}/printed`, 403, post({ kind: 'print' }));
    await expect('owner', `/api/transactions/bills/${BILL_ID}/printed`, 403, post({ kind: 'print' }));
  });
});

test('bills filter by whole store days, status and search, safely', async () => {
  await withApi(async (as, database) => {
    await as('manager', '/api/transactions/bills?start=2026-01-01&end=2026-01-31&status=Refunded&q=a"),id.eq.1%25&page=2&pageSize=999');
    assert.ok(database.filters.some(([kind, column, value]) => kind === 'gte' && column === 'created_at' && value === '2026-01-01-start'));
    assert.ok(database.filters.some(([kind, column, value]) => kind === 'lt' && column === 'created_at' && value === '2026-01-31-end'));
    assert.ok(database.filters.some(([kind, column, value]) => kind === 'eq' && column === 'status' && value === 'Refunded'));
    const [, search] = database.filters.find(([kind]) => kind === 'or');
    assert.ok(!search.includes('a"'), search);
    assert.equal((await as('manager', '/api/transactions/bills?start=yesterday')).status, 400);
    assert.equal((await as('manager', '/api/transactions/bills?end=2026-13-99')).status, 400);
  });
});

test('date and month parameters are checked', async () => {
  await withApi(async (as) => {
    assert.equal((await as('owner', '/api/transactions/daily?date=nonsense')).status, 400);
    assert.equal((await as('owner', '/api/transactions/monthly?year=2026')).status, 400);
    assert.equal((await as('owner', '/api/transactions/monthly?year=2026&month=13')).status, 400);
    assert.equal((await as('owner', '/api/transactions/monthly?year=abc&month=1')).status, 400);
    assert.equal((await as('owner', '/api/transactions/monthly?year=2026&month=3')).status, 200);
  });
});

test('void and refund need a reason, use the session user, and are audited', async () => {
  await withApi(async (as, database) => {
    const path = `/api/transactions/bills/${BILL_ID}`;
    assert.equal((await as('manager', `${path}/void`, post({ reason: ' ' }))).status, 400);
    assert.equal((await as('manager', `${path}/refund`, post({ ...refundBody(), reason: '' }))).status, 400);
    assert.equal((await as('manager', `${path}/refund`, post({ ...refundBody(), lines: [] }))).status, 400);
    assert.equal((await as('manager', `${path}/refund`, post({ ...refundBody(), clientRequestId: 'x' }))).status, 400);
    assert.equal((await as('manager', `${path}/refund`, post({ ...refundBody(), lines: [{ saleItemId: 'x', qty: 1 }] }))).status, 400);
    assert.equal(database.rpcCalls.length, 0);

    await as('manager', `${path}/void`, post({ reason: 'Mistake', userId: 'someone' }));
    assert.deepEqual(database.rpcCalls[0], ['void_sale', { p_sale_id: BILL_ID, p_reason: 'Mistake', p_user: 'manager' }]);
    await as('manager', `${path}/refund`, post({ ...refundBody(), amount: 999999 }));
    const [, args] = database.rpcCalls[1];
    assert.equal(args.p_user, 'manager');
    assert.equal(args.p_refund.amount, undefined, 'the client cannot set the refund amount');
    assert.equal(args.p_refund.lines[0].restock, true);
    assert.deepEqual(database.audits.map((row) => row.action), ['Sale voided', 'Refund processed']);
  });
});

test('a bill detail has what a receipt needs and no cost prices', async () => {
  await withApi(async (as) => {
    const text = await (await as('cashier', `/api/transactions/bills/${BILL_ID}`)).text();
    const { bill } = JSON.parse(text);
    assert.equal(bill.billNo, 'RM-INV-1');
    assert.equal(bill.cashier, 'N. Perera');
    assert.equal(bill.payment.change, 82);
    assert.equal(bill.store.address, 'Jaffna');
    assert.equal(bill.lines[0].qty, 2);
    assert.ok(!/unit_cost|cost/.test(text), text);
    assert.equal((await as('cashier', '/api/transactions/bills/not-an-id')).status, 404);
  });
});
