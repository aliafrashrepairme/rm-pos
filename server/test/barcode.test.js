import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before, describe } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { cleanCode } from '../services/barcode.js';

test('codes are validated before any lookup', () => {
  assert.throws(() => cleanCode(''), /Enter or scan/);
  assert.throws(() => cleanCode(undefined), /Enter or scan/);
  assert.throws(() => cleanCode('a"),id.eq.1'), /not a valid barcode/);
  assert.throws(() => cleanCode('has space'), /not a valid barcode/);
  assert.throws(() => cleanCode('4006381333932'), /check digit/);
  assert.equal(cleanCode(' 4006381333931 '), '4006381333931');
  assert.equal(cleanCode('RM-000001'), 'RM-000001');
});

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['barcode.scan', 'barcode.labels', 'products.view', 'counts.manage'],
  stock: ['barcode.scan', 'products.view', 'counts.manage'],
  cashier: ['barcode.scan', 'pos.sell'],
  owner: ['reports.sales']
};
const ROW = { id: 'p1', sku: 'RM-1', barcode: '4006381333931', name: 'Hammer', cost_price: '980.00', selling_price: '1450.00', stock_qty: '4.000', min_stock: '1.000', active: true, categories: { name: 'Tools' }, tax_rates: { name: 'VAT', rate: '18' }, suppliers: null, image_path: null };

function fakeDatabase({ rows = [ROW] } = {}) {
  const database = {
    orFilters: [],
    rpcCalls: [],
    auth: { admin: {} },
    rpc: async (name, args) => { database.rpcCalls.push([name, args]); return { data: 3, error: null }; },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        insert: () => chain,
        order: () => chain,
        limit: () => chain,
        or: (text) => { database.orFilters.push(text); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'products') return resolve({ data: call.single ? rows[0] ?? null : rows, error: null });
          resolve({ data: null, error: null });
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

const lookup = '/api/barcode/lookup?code=4006381333931';

test('scanning follows the role, and cashiers never receive cost prices', async () => {
  await withApi({}, async (as) => {
    assert.equal((await as('owner', lookup)).status, 403);
    const cashier = await as('cashier', lookup);
    assert.equal(cashier.status, 200);
    const text = await cashier.text();
    const { product } = JSON.parse(text);
    assert.equal(product.sellingPrice, 1450);
    assert.equal(product.costPrice, undefined);
    assert.ok(!text.includes('980'));
    assert.equal((await (await as('stock', lookup)).json()).product.costPrice, 980);
  });
});

test('an unknown code is a clear 404, and a bad one a 400', async () => {
  await withApi({ rows: [] }, async (as) => {
    const unknown = await as('cashier', '/api/barcode/lookup?code=12345678');
    assert.equal(unknown.status, 404);
    const body = await unknown.json();
    assert.equal(body.code, 'UNKNOWN_BARCODE');
    assert.match(body.error, /12345678/);
    assert.equal((await as('cashier', '/api/barcode/lookup?code=4006381333932')).status, 400);
    assert.equal((await as('cashier', '/api/barcode/lookup')).status, 400);
  });
});

test('12-digit and 13-digit forms of a code find each other', async () => {
  await withApi({}, async (as, database) => {
    await as('cashier', '/api/barcode/lookup?code=036000291452');
    assert.match(database.orFilters[0], /barcode\.eq\."0036000291452"/);
    await as('cashier', '/api/barcode/lookup?code=0036000291452');
    assert.match(database.orFilters[1], /barcode\.eq\."036000291452"/);
    await as('cashier', '/api/barcode/lookup?code=rm-000001');
    assert.match(database.orFilters[2], /sku\.eq\."RM-000001"/);
  });
});

test('count scans need the count permission and refuse inactive products', async () => {
  const body = { method: 'POST', body: JSON.stringify({ code: '4006381333931' }) };
  await withApi({}, async (as, database) => {
    assert.equal((await as('cashier', '/api/inventory/counts/c1/scan', body)).status, 403);
    const response = await as('stock', '/api/inventory/counts/c1/scan', body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).counted, 3);
    assert.deepEqual(database.rpcCalls[0], ['scan_stock_count', { p_count_id: 'c1', p_product_id: 'p1' }]);
  });
  await withApi({ rows: [{ ...ROW, active: false }] }, async (as, database) => {
    assert.equal((await as('stock', '/api/inventory/counts/c1/scan', body)).status, 409);
    assert.equal(database.rpcCalls.length, 0);
  });
});

test('only label permission can record printed labels', async () => {
  const body = { method: 'POST', body: JSON.stringify({ labels: 4 }) };
  await withApi({}, async (as) => {
    assert.equal((await as('stock', '/api/barcode/labels-printed', body)).status, 403);
    assert.equal((await as('manager', '/api/barcode/labels-printed', body)).status, 204);
    assert.equal((await as('manager', '/api/barcode/labels-printed', { method: 'POST', body: '{"labels":0}' })).status, 400);
  });
});

describe('scan_stock_count', () => {
  let db;
  let userId;
  let count;
  let product;
  let extra;

  const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const scan = async (countId, productId) => Number((await db.query('select public.scan_stock_count($1, $2) as n', [countId, productId])).rows[0].n);

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema extensions;
      create table auth.users (id uuid primary key);
    `);
    for (const file of ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql']) await db.exec(await read(file));
    userId = randomUUID();
    await db.query('insert into auth.users (id) values ($1)', [userId]);
    await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test', 't@example.com', 'Manager')`, [userId]);
    const tools = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
    const other = (await db.query(`insert into public.categories (name) values ('Other') returning id`)).rows[0].id;
    const taxRateId = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
    const make = async (name, categoryId) => (await db.query('select public.create_product($1, $2) as id', [{ name, categoryId, unitCode: 'Piece', taxRateId, sellingPrice: 10, openingStock: 7 }, userId])).rows[0].id;
    product = await make('In count', tools);
    extra = await make('Elsewhere', other);
    count = (await db.query('select public.start_stock_count($1, $2, $3, $4, $5) as id', ['Scan', tools, false, true, userId])).rows[0].id;
  });

  test('each scan adds one, starting from an uncounted line', async () => {
    assert.equal(await scan(count, product), 1);
    assert.equal(await scan(count, product), 2);
    const line = (await db.query('select counted_qty, system_qty from public.stock_count_lines where stock_count_id = $1 and product_id = $2', [count, product])).rows[0];
    assert.equal(Number(line.counted_qty), 2);
    assert.equal(Number(line.system_qty), 7);
  });

  test('a product outside the count joins it with its current stock', async () => {
    assert.equal(await scan(count, extra), 1);
    const line = (await db.query('select system_qty from public.stock_count_lines where stock_count_id = $1 and product_id = $2', [count, extra])).rows[0];
    assert.equal(Number(line.system_qty), 7);
  });

  test('scans change no stock and stop after submission', async () => {
    assert.equal(Number((await db.query('select stock_qty from public.products where id = $1', [product])).rows[0].stock_qty), 7);
    await db.query('select public.submit_stock_count($1)', [count]);
    await assert.rejects(() => scan(count, product), /already been submitted/);
    await assert.rejects(() => scan(randomUUID(), product), /Stock count not found/);
  });

  test('the public API roles cannot run it', async () => {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.scan_stock_count(uuid, uuid)', 'execute') as anon,
      has_function_privilege('service_role', 'public.scan_stock_count(uuid, uuid)', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true });
  });
});
