import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { newProduct, productChanges, productListQuery, barcode } from '../validation/products.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['products.view', 'products.manage'],
  stock: ['products.view', 'products.manage'],
  cashier: ['pos.sell'],
  owner: ['reports.sales']
};

const ROW = {
  id: 'p1', sku: 'RM-000001', barcode: '2000000000015', name: 'Hammer', description: '', category_id: 'c1', categories: { name: 'Tools' },
  unit_code: 'Piece', cost_price: '980.00', selling_price: '1450.00', tax_rate_id: 't1', tax_rates: { name: 'VAT', rate: '18.00' },
  stock_qty: '4.000', min_stock: '10.000', location: 'D3', preferred_supplier_id: null, suppliers: null, active: true, image_path: null, updated_at: 't'
};

function fakeDatabase({ rows = [ROW], failWith } = {}) {
  const calls = [];
  const database = {
    calls,
    rpcCalls: [],
    uploads: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      return failWith ? { data: null, error: failWith } : { data: 'p1', error: null };
    },
    storage: {
      createBucket: async () => ({ error: { message: 'The resource already exists' } }),
      from: () => ({
        upload: async (path, bytes, options) => { database.uploads.push({ path, bytes, options }); return { error: null }; },
        remove: async () => ({ error: null }),
        createSignedUrls: async (paths) => ({ data: paths.map((path) => ({ path, signedUrl: `https://signed/${path}` })), error: null })
      })
    },
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        order: (column, options) => { (call.order ||= []).push([column, options?.ascending]); return chain; },
        limit: () => chain,
        or: (text) => { call.or = text; return chain; },
        insert: (row) => { call.insert = row; return chain; },
        update: (change) => { call.update = change; return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        range: (from, to) => { call.range = [from, to]; return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters.find(([column]) => column === 'id')?.[1];
            return resolve({
              data: { id, username: id, full_name: id, role_code: id, email: `${id}@x`, active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } },
              error: null
            });
          }
          if (table === 'audit_logs') return resolve({ data: null, error: null });
          if (table === 'products') return resolve({ data: call.single ? rows[0] ?? null : rows, count: rows.length, error: null });
          resolve({ data: [], error: null });
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
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user, path, init = {}) => fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user}`, ...init.headers }
  });
  try {
    await run(as, database);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID = { name: 'Hammer', categoryId: 'c1', unitCode: 'Piece', taxRateId: 't1', sellingPrice: 1450, costPrice: 980 };
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body) => ({ method: 'PATCH', body: JSON.stringify(body) });

test('cashiers and owners can neither see nor change the product register', async () => {
  await withApi({}, async (as) => {
    for (const user of ['cashier', 'owner']) {
      assert.equal((await as(user, '/api/products')).status, 403);
      assert.equal((await as(user, '/api/products/options')).status, 403);
      assert.equal((await as(user, '/api/products', post(VALID))).status, 403);
      assert.equal((await as(user, '/api/products/p1', patch({ name: 'x' }))).status, 403);
      assert.equal((await as(user, '/api/categories', post({ name: 'x' }))).status, 403);
    }
  });
});

test('the list returns a page, a total and readable values', async () => {
  await withApi({}, async (as, database) => {
    const body = await (await as('stock', '/api/products?page=3&pageSize=10&q=ham&categoryId=c1&sort=price&direction=desc')).json();
    assert.equal(body.total, 1);
    assert.equal(body.page, 3);
    assert.equal(body.products[0].sellingPrice, 1450);
    assert.equal(body.products[0].stock, 4);
    assert.equal(body.products[0].category, 'Tools');
    assert.equal(body.products[0].taxRate, 18);
    const call = database.calls.find((item) => item.table === 'products');
    assert.deepEqual(call.range, [20, 29]);
    assert.match(call.or, /name\.ilike\."\*ham\*"/);
    assert.deepEqual(call.order[0], ['selling_price', false]);
    assert.ok(call.filters.some(([column, value]) => column === 'active' && value === true));
    assert.ok(call.filters.some(([column, value]) => column === 'category_id' && value === 'c1'));
  });
});

test('search text cannot inject filter syntax, and page size is capped', () => {
  const query = productListQuery({ q: 'a"),id.eq.1,(b*%_\\', pageSize: '100000', page: '-4', sort: 'password', status: 'nonsense' });
  assert.ok(!/["*%_\\]/.test(query.search));
  assert.equal(query.pageSize, 100);
  assert.equal(query.page, 1);
  assert.equal(query.sort, 'name');
  assert.equal(query.status, 'active');
});

test('creating a product sends clean values and the session user, not client ones', async () => {
  await withApi({}, async (as, database) => {
    const response = await as('manager', '/api/products', post({ ...VALID, stock_qty: 500, created_by: 'someone', openingStock: 3 }));
    assert.equal(response.status, 201);
    const [name, args] = database.rpcCalls[0];
    assert.equal(name, 'create_product');
    assert.equal(args.p_created_by, 'manager');
    assert.equal(args.p_product.openingStock, 3);
    assert.equal(args.p_product.stock_qty, undefined);
    assert.equal(args.p_product.created_by, undefined);
  });
});

test('duplicate SKU and barcode get a specific message', async () => {
  const duplicate = (constraint) => ({ code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` });
  await withApi({ failWith: duplicate('products_sku_key') }, async (as) => {
    const response = await as('manager', '/api/products', post({ ...VALID, sku: 'DUP-1' }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /SKU is already used/);
  });
  await withApi({ failWith: duplicate('products_barcode_key') }, async (as) => {
    assert.match((await (await as('manager', '/api/products', post({ ...VALID, barcode: '12345' }))).json()).error, /barcode is already used/);
  });
});

test('stock cannot be changed by editing a product', async () => {
  assert.throws(() => productChanges({ stock_qty: 5 }), /Nothing to change/);
  assert.throws(() => productChanges({ stock: 5 }), /Nothing to change/);
  assert.deepEqual(productChanges({ stock: 5, name: 'New' }), { name: 'New' });
});

test('product input is validated', () => {
  assert.throws(() => newProduct({ ...VALID, name: ' ' }), /Product name is required/);
  assert.throws(() => newProduct({ ...VALID, sellingPrice: -1 }), /Selling price/);
  assert.throws(() => newProduct({ ...VALID, sellingPrice: '' }), /Selling price/);
  assert.throws(() => newProduct({ ...VALID, sellingPrice: 'abc' }), /Selling price/);
  assert.throws(() => newProduct({ ...VALID, openingStock: -2 }), /Opening stock/);
  assert.throws(() => newProduct({ ...VALID, sku: 'has space' }), /SKU can only/);
  assert.equal(newProduct({ ...VALID, sellingPrice: 10.005 }).sellingPrice, 10.01);
  assert.equal(newProduct({ ...VALID, openingStock: 1.23456 }).openingStock, 1.235);
});

test('a mistyped EAN-13 barcode is caught; other formats are allowed', () => {
  assert.equal(barcode('4006381333931'), '4006381333931');
  assert.throws(() => barcode('4006381333932'), /check digit/);
  assert.equal(barcode('ABC-123'), 'ABC-123');
  assert.throws(() => barcode('a b'), /4 to 32/);
});

test('a missing product is a 404', async () => {
  await withApi({ rows: [] }, async (as) => {
    assert.equal((await as('manager', '/api/products/none')).status, 404);
    assert.equal((await as('manager', '/api/products/none', patch({ name: 'x' }))).status, 404);
  });
});

test('photos must be real images of an allowed type and are stored privately', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await withApi({}, async (as, database) => {
    const send = (type, body, user = 'manager') => as(user, '/api/products/p1/image', { method: 'PUT', headers: { 'Content-Type': type }, body });
    assert.equal((await send('image/jpeg', jpeg, 'cashier')).status, 403);
    assert.equal((await send('image/gif', Buffer.from('GIF89a'))).status, 415);
    assert.equal((await send('image/png', jpeg)).status, 415, 'contents must match the type');
    assert.equal((await send('image/jpeg', Buffer.from('<script>alert(1)</script>'))).status, 415);
    assert.equal(database.uploads.length, 0);

    assert.equal((await send('image/jpeg', jpeg)).status, 200);
    assert.match(database.uploads[0].path, /^products\/p1\/[0-9a-f-]+\.jpg$/);
    assert.equal((await send('image/jpeg', Buffer.alloc(3 * 1024 * 1024, 0xff))).status, 413);
  });
});
