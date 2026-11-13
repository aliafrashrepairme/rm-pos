import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  cashier: ['pos.sell', 'held.manage', 'customers.view', 'customers.manage', 'barcode.scan'],
  manager: ['products.view', 'inventory.view', 'customers.view', 'customers.manage'],
  stock: ['products.view'],
  owner: ['reports.sales']
};
const SALE_ROW = {
  id: 's1', bill_no: 'RM-INV-000001', status: 'Paid', customer_name: 'Walk-in Customer', created_at: 't', subtotal: '100.00', discount_total: '0.00',
  discount_label: '', tax_total: '18.00', grand_total: '118.00', points_earned: 0,
  payments: [{ method_code: 'Cash', amount: '118.00', amount_tendered: '200.00', change_given: '82.00', reference: '' }],
  sale_items: [{ line_no: 1, name: 'Hammer', sku: 'RM-1', qty: '1.000', unit_price: '100.00', line_total: '118.00' }]
};
const PRODUCT = { id: 'p1', sku: 'RM-1', barcode: 'B', name: 'Hammer', unit_code: 'Piece', selling_price: '100.00', cost_price: '60.00', stock_qty: '4.000', min_stock: '1.000', image_path: null, categories: { name: 'Tools' }, tax_rates: { rate: '18.00' } };

function fakeDatabase({ replayed = false, held = { id: 'h1', hold_no: 'H-1', customer_id: null, coupon_code: null, held_order_items: [{ product_id: 'p1', qty: '2.000' }] }, existingCustomer = null } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    selects: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'create_sale') return { data: { id: 's1', billNo: 'RM-INV-000001', replayed }, error: null };
      return { data: 'id-1', error: null };
    },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: (columns) => { database.selects.push([table, columns]); return chain; },
        order: () => chain,
        limit: () => chain,
        or: () => chain,
        in: () => chain,
        range: () => chain,
        insert: (row) => { if (table === 'audit_logs') database.audits.push(row); return chain; },
        update: (change) => { call.update = change; return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'sales') return resolve({ data: SALE_ROW, error: null });
          if (table === 'products') return resolve({ data: [PRODUCT], count: 1, error: null });
          if (table === 'held_orders') return resolve({ data: call.single ? held : [], error: null });
          if (table === 'customers') return resolve({ data: call.single ? (call.filters.some(([column]) => column === 'phone') ? existingCustomer : { id: 'id-1', code: 'CUS-1', name: 'New', phone: '0771234567', loyalty_points: 0, purchase_count: 0 }) : [], error: null });
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

const post = (body = {}) => ({ method: 'POST', body: JSON.stringify(body) });
const validSale = () => ({
  clientRequestId: randomUUID(),
  items: [{ productId: randomUUID(), qty: 1 }],
  expectedTotal: 118,
  payment: { method: 'Cash', amountTendered: 200 }
});

test('only roles with the permission reach POS routes', async () => {
  await withApi({}, async (as) => {
    for (const user of ['manager', 'stock', 'owner']) {
      assert.equal((await as(user, '/api/pos/catalog')).status, 403, user);
      assert.equal((await as(user, '/api/pos/options')).status, 403, user);
      assert.equal((await as(user, '/api/pos/sales', post(validSale()))).status, 403, user);
      assert.equal((await as(user, '/api/pos/held')).status, 403, user);
      assert.equal((await as(user, '/api/pos/held/h1/resume', post())).status, 403, user);
    }
    assert.equal((await as('stock', '/api/pos/customers')).status, 403);
    assert.equal((await as('cashier', '/api/pos/catalog')).status, 200);
    assert.equal((await as('cashier', '/api/pos/held')).status, 200);
  });
});

test('the catalogue never asks for or returns cost prices', async () => {
  await withApi({}, async (as, database) => {
    const text = await (await as('cashier', '/api/pos/catalog?q=ham')).text();
    assert.ok(!/cost|60\.00/.test(text), text);
    assert.equal(JSON.parse(text).products[0].price, 100);
    const [, columns] = database.selects.find(([table]) => table === 'products');
    assert.ok(!columns.includes('cost'), columns);
  });
});

test('a sale uses the signed-in cashier and ignores anything else the client sends', async () => {
  await withApi({}, async (as, database) => {
    const body = { ...validSale(), cashierId: 'someone', grandTotal: 1, unitPrice: 1, status: 'Refunded' };
    body.items[0].price = 0.01;
    const response = await as('cashier', '/api/pos/sales', post(body));
    assert.equal(response.status, 201);
    const [name, args] = database.rpcCalls[0];
    assert.equal(name, 'create_sale');
    assert.equal(args.p_cashier, 'cashier');
    assert.deepEqual(Object.keys(args.p_sale.items[0]).sort(), ['productId', 'qty']);
    assert.equal(args.p_sale.cashierId, undefined);
    assert.equal(args.p_sale.status, undefined);
    const { sale } = await response.json();
    assert.equal(sale.billNo, 'RM-INV-000001');
    assert.equal(sale.payment.change, 82);
    assert.equal(sale.lines[0].name, 'Hammer');
  });
});

test('a sale is audited once, and a replay is not audited again', async () => {
  await withApi({}, async (as, database) => {
    await as('cashier', '/api/pos/sales', post(validSale()));
    assert.deepEqual(database.audits.map((row) => row.action), ['Sale completed']);
  });
  await withApi({ replayed: true }, async (as, database) => {
    const response = await as('cashier', '/api/pos/sales', post(validSale()));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).replayed, true);
    assert.deepEqual(database.audits, []);
  });
});

test('bad sale requests are refused before reaching the database', async () => {
  await withApi({}, async (as, database) => {
    const send = (change) => as('cashier', '/api/pos/sales', post({ ...validSale(), ...change }));
    assert.equal((await send({ clientRequestId: 'nope' })).status, 400);
    assert.equal((await send({ items: [] })).status, 400);
    assert.equal((await send({ items: [{ productId: 'x', qty: 1 }] })).status, 400);
    assert.equal((await send({ items: [{ productId: randomUUID(), qty: -1 }] })).status, 400);
    assert.equal((await send({ items: [{ productId: randomUUID(), qty: 'a' }] })).status, 400);
    assert.equal((await send({ expectedTotal: undefined })).status, 400);
    assert.equal((await send({ payment: { method: 'Cash', amountTendered: 'lots' } })).status, 400);
    assert.equal(database.rpcCalls.length, 0);
  });
});

test('customers need a name and valid phone, and a repeated phone is refused', async () => {
  await withApi({}, async (as) => {
    const add = (body) => as('cashier', '/api/pos/customers', post(body));
    assert.equal((await add({ phone: '0771234567' })).status, 400);
    assert.equal((await add({ name: 'A', phone: 'abc' })).status, 400);
    assert.equal((await add({ name: 'A', phone: '0771234567' })).status, 201);
  });
  await withApi({ existingCustomer: { id: 'c9' } }, async (as) => {
    assert.equal((await as('cashier', '/api/pos/customers', post({ name: 'A', phone: '0771234567' }))).status, 409);
  });
});

test('a held order can only be claimed once', async () => {
  await withApi({ held: null }, async (as) => {
    assert.equal((await as('cashier', '/api/pos/held/h1/resume', post())).status, 409);
    assert.equal((await as('cashier', '/api/pos/held/h1/cancel', post())).status, 409);
  });
  await withApi({}, async (as) => {
    const body = await (await as('cashier', '/api/pos/held/h1/resume', post())).json();
    assert.deepEqual(body.items, [{ productId: 'p1', qty: 2 }]);
    assert.equal((await as('cashier', '/api/pos/held/h1/cancel', post())).status, 204);
  });
});
