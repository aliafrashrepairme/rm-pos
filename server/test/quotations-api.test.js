import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['quotations.view', 'quotations.manage', 'customers.view'],
  cashier: ['quotations.view', 'quotations.manage', 'pos.sell'],
  owner: ['reports.sales'],
  stock: ['products.view']
};
const ID = randomUUID();
const PRODUCT = randomUUID();
const ROW = {
  id: ID, quote_no: 'QT-000001', status: 'Draft', customer_id: null, customer_name: 'Nimal', customer_phone: '077', valid_until: '2099-01-01',
  note: '', subtotal: '100.00', tax_total: '18.00', grand_total: '118.00', sent_at: null, decided_at: null, created_at: 't',
  creator: { full_name: 'M' }, sales: null,
  quotation_items: [{ line_no: 1, product_id: PRODUCT, qty: '1.000', unit_price: '100.00', tax_rate: '18.00', products: { name: 'Hammer', sku: 'RM-1', unit_code: 'Piece', selling_price: '120.00', stock_qty: '5', active: true, tax_rates: { rate: '18.00' } } }]
};

function fakeDatabase() {
  const database = {
    rpcCalls: [],
    audits: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'save_quotation') return { data: ID, error: null };
      if (name === 'set_quotation_status') return { data: { quoteNo: 'QT-000001', from: 'Draft', to: args.p_status }, error: null };
      if (name === 'convert_quotation') return { data: { quoteNo: 'QT-000001', billNo: 'RM-INV-1', replayed: false }, error: null };
      if (name === 'quotation_counts') return { data: { Draft: 1 }, error: null };
      return { data: 0, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        range: () => chain,
        limit: () => chain,
        or: () => chain,
        single: () => { call.single = true; return chain; },
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'quotations') return resolve({ data: call.single ? ROW : [ROW], count: 1, error: null });
          if (table === 'store_settings') return resolve({ data: { store_name: 'RM', address: '', phone: '' }, error: null });
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

const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const good = { customerName: 'Nimal', validUntil: '2099-01-01', items: [{ productId: PRODUCT, qty: 2 }] };

test('only quotation roles reach quotations, and only sellers convert', async () => {
  await withApi(async (as, database) => {
    for (const user of ['owner', 'stock']) {
      assert.equal((await as(user, '/api/quotations')).status, 403, user);
      assert.equal((await as(user, '/api/quotations', post(good))).status, 403, user);
    }
    const list = await as('manager', '/api/quotations?status=Draft');
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.quotations[0].quoteNo, 'QT-000001');
    assert.deepEqual(body.counts, { Draft: 1 });
    assert.equal(database.rpcCalls[0][0], 'expire_quotations', 'old quotes expire before listing');

    assert.equal((await as('manager', `/api/quotations/${ID}/convert`, post({ saleId: randomUUID() }))).status, 403, 'managers do not sell');
    const converted = await as('cashier', `/api/quotations/${ID}/convert`, post({ saleId: randomUUID() }));
    assert.equal(converted.status, 200);
    assert.deepEqual(database.audits.map((row) => row.action), ['Quotation converted']);
  });
});

test('quotes are validated before reaching the database', async () => {
  await withApi(async (as, database) => {
    const bad = async (body) => (await as('manager', '/api/quotations', post({ ...good, ...body }))).status;
    assert.equal(await bad({ items: [] }), 400);
    assert.equal(await bad({ items: [{ productId: 'x', qty: 1 }] }), 400);
    assert.equal(await bad({ items: [{ productId: PRODUCT, qty: 0 }] }), 400);
    assert.equal(await bad({ validUntil: 'soon' }), 400);
    assert.equal(await bad({ customerId: 'x' }), 400);
    assert.equal(database.rpcCalls.filter(([name]) => name === 'save_quotation').length, 0);

    const created = await as('manager', '/api/quotations', post(good));
    assert.equal(created.status, 201);
    const { quotation } = await created.json();
    assert.equal(quotation.total, 118);
    assert.equal(quotation.lines[0].currentPrice, 120, 'today\'s price is returned for converting');
    assert.equal(database.rpcCalls.find(([name]) => name === 'save_quotation')[1].p_user, 'manager');
  });
});

test('status moves are limited to the named actions', async () => {
  await withApi(async (as, database) => {
    assert.equal((await as('manager', `/api/quotations/${ID}/send`, post({}))).status, 200);
    assert.equal(database.rpcCalls.find(([name]) => name === 'set_quotation_status')[1].p_status, 'Sent');
    assert.equal((await as('manager', `/api/quotations/${ID}/convert-free`, post({}))).status, 404);
    assert.equal((await as('manager', '/api/quotations/not-an-id/send', post({}))).status, 404);
    assert.deepEqual(database.audits.map((row) => row.action), ['Quotation sent']);
  });
});
