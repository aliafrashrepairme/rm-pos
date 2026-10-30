import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PROFILES = {
  owner: { id: 'owner', full_name: 'Store Owner', role_code: 'Owner', email: 'o@x.lk', active: true },
  cashier: { id: 'cashier', full_name: 'N. Perera', role_code: 'Cashier', email: 'c@x.lk', active: true },
  stock: { id: 'stock', full_name: 'K. Fernando', role_code: 'Inventory Staff', email: 'i@x.lk', active: true },
  disabled: { id: 'disabled', full_name: 'Gone', role_code: 'Manager', email: 'g@x.lk', active: false }
};

// Records queries and answers them from `tables`, honouring range() like Supabase does.
function fakeDatabase(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (column, value) => { call.filters.push(['eq', column, value]); return chain; },
        gte: (column, value) => { call.filters.push(['gte', column, value]); return chain; },
        lte: (column, value) => { call.filters.push(['lte', column, value]); return chain; },
        range: (from, to) => { call.range = [from, to]; return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          const source = tables[table];
          if (source?.error) return resolve({ data: null, error: source.error });
          let rows = source || [];
          for (const [kind, column, value] of call.filters) if (kind === 'eq') rows = rows.filter((row) => row[column] === value);
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
          resolve({ data: call.single ? rows[0] || null : rows, error: null });
        }
      };
      return chain;
    }
  };
}

const fakeAuth = {
  auth: {
    getUser: async (token) => PROFILES[token]
      ? { data: { user: { id: token } }, error: null }
      : { data: { user: null }, error: { message: 'bad token' } },
    signInWithPassword: async ({ email, password }) => password === 'right'
      ? { data: { user: { id: email.split('@')[0] }, session: { access_token: 'at', refresh_token: 'rt', expires_at: 1900000000 } }, error: null }
      : { data: {}, error: { message: 'invalid' } },
    refreshSession: async () => ({ data: {}, error: { message: 'expired' } })
  }
};

async function withApi(tables, run, options = {}) {
  const database = fakeDatabase({ profiles: Object.values(PROFILES), store_settings: [{ id: true }], ...tables });
  const server = createApp({ config, authClient: fakeAuth, database }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(options.origin ? { Origin: options.origin } : {}), ...init.headers }
  });
  const as = (user, path) => call(path, { headers: { Authorization: `Bearer ${user}` } });
  try {
    await run({ call, as, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postJson = (body) => ({ method: 'POST', body: JSON.stringify(body) });

test('config lists each missing setting', () => {
  assert.throws(() => readConfig({ SUPABASE_URL: 'x' }), /SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY/);
  assert.deepEqual(
    readConfig({ SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's', CORS_ORIGINS: 'app://rm-pos, http://a' }).corsOrigins,
    ['app://rm-pos', 'http://a']
  );
});

test('readiness reports the database state without leaking details', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withApi({}, async ({ call }) => {
    const response = await call('/api/health/ready');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, database: 'connected' });
  });
  await withApi({ store_settings: { error: { code: 'XX', message: 'secret host details' } } }, async ({ call }) => {
    const response = await call('/api/health/ready');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, database: 'unavailable' });
  });
});

test('login returns the user, and rejects wrong passwords and disabled accounts', async () => {
  await withApi({}, async ({ call }) => {
    const ok = await call('/api/auth/login', postJson({ email: 'OWNER@x.lk', password: 'right' }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.user, { id: 'owner', name: 'Store Owner', role: 'Owner', email: 'o@x.lk' });
    assert.equal(body.token, 'at');

    assert.equal((await call('/api/auth/login', postJson({ email: 'owner@x.lk', password: 'wrong' }))).status, 401);
    assert.equal((await call('/api/auth/login', postJson({ email: 'disabled@x.lk', password: 'right' }))).status, 403);
    assert.equal((await call('/api/auth/login', postJson({ email: 'owner@x.lk' }))).status, 400);
    assert.equal((await call('/api/auth/refresh', postJson({ refreshToken: 'old' }))).status, 401);
  });
});

test('protected routes need a valid session on an enabled account', async () => {
  await withApi({}, async ({ call, as }) => {
    assert.equal((await call('/api/auth/me')).status, 401);
    assert.equal((await as('nonsense', '/api/auth/me')).status, 401);
    assert.equal((await as('disabled', '/api/auth/me')).status, 403);
    assert.equal((await as('owner', '/api/auth/me')).status, 200);
  });
});

test('report access follows the role', async () => {
  await withApi({ sales: [], products: [], inventory_ledger: [] }, async ({ as }) => {
    assert.equal((await as('cashier', '/api/reports/sales')).status, 403);
    assert.equal((await as('cashier', '/api/reports/products')).status, 403);
    assert.equal((await as('stock', '/api/reports/sales')).status, 403);
    assert.equal((await as('stock', '/api/reports/products')).status, 200);
    assert.equal((await as('owner', '/api/reports/sales')).status, 200);
  });
});

test('reports read the new tables in the shape the screens expect', async () => {
  const tables = {
    products: [{ id: 'p1', name: 'Hammer', sku: 'RM-1', categories: { name: 'Tools' }, cost_price: '980.00', selling_price: '1450.00', stock_qty: '2.500', min_stock: '10.000', updated_at: 't' }],
    sales: [{ id: 's1', bill_no: 'RM-INV-000001', created_at: 't', grand_total: '1711.00', status: 'Paid', customer_name: 'Walk-in Customer',
      payments: [{ method_code: 'Bank transfer' }],
      sale_items: [{ product_id: 'p1', name: 'Hammer', category_name: 'Tools', qty: '1.000', unit_price: '1450.00', line_total: '1711.00' }] }],
    inventory_ledger: [{ id: 7, created_at: 't', product_id: 'p1', products: { name: 'Hammer' }, change_qty: '-3.000', reference_no: 'RM-INV-000001', reason: 'POS sale' }]
  };
  await withApi(tables, async ({ as }) => {
    const { products } = await (await as('owner', '/api/reports/products')).json();
    assert.deepEqual(products[0], { id: 'p1', name: 'Hammer', sku: 'RM-1', category: 'Tools', unitCost: 980, unitPrice: 1450, stock: 2.5, reorderLevel: 10, updatedAt: 't' });

    const { sales } = await (await as('owner', '/api/reports/sales')).json();
    assert.equal(sales[0].orderId, 'RM-INV-000001');
    assert.equal(sales[0].total, 1711);
    assert.equal(sales[0].status, 'Completed');
    assert.equal(sales[0].paymentMethod, 'Bank Transfer');
    assert.equal(sales[0].items[0].qty, 1);

    const { movements } = await (await as('owner', '/api/reports/stock-movements')).json();
    assert.deepEqual(movements[0], { id: 7, date: 't', productId: 'p1', name: 'Hammer', type: 'Stock Out', quantity: 3, referenceId: 'RM-INV-000001', note: 'POS sale' });
  });
});

test('reports return every row past the 1,000-row page limit', async () => {
  const sales = Array.from({ length: 2345 }, (_, index) => ({ id: `s${index}`, bill_no: `B${index}`, grand_total: '1', status: 'Paid' }));
  await withApi({ sales }, async ({ as }) => {
    const body = await (await as('owner', '/api/reports/sales')).json();
    assert.equal(body.sales.length, 2345);
  });
});

test('report date filters are validated and applied', async () => {
  await withApi({ sales: [] }, async ({ as, database }) => {
    assert.equal((await as('owner', '/api/reports/sales?start=nonsense')).status, 400);
    assert.equal((await as('owner', '/api/reports/sales?start=2026-02-01&end=2026-01-01')).status, 400);
    assert.equal((await as('owner', '/api/reports/sales?start=2026-01-01&end=2026-01-31')).status, 200);
    const call = database.calls.filter((item) => item.table === 'sales').at(-1);
    assert.deepEqual(call.filters, [
      ['gte', 'created_at', '2026-01-01T00:00:00.000Z'],
      ['lte', 'created_at', '2026-01-31T23:59:59.999Z']
    ]);
  });
});

test('database failures return a generic message', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withApi({ sales: { error: { code: 'XX000', message: 'connection to 10.0.0.1 failed' } } }, async ({ as }) => {
    const response = await as('owner', '/api/reports/sales');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'The storage service could not complete the request.' });
  });
});

test('bad JSON and unknown routes get clear JSON errors', async () => {
  await withApi({}, async ({ call, as }) => {
    const bad = await call('/api/auth/login', { method: 'POST', body: '{oops' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not valid JSON/);
    const missing = await as('owner', '/api/nothing-here');
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /does not exist/);
  });
});

test('only allowed origins get browser access', async () => {
  await withApi({}, async ({ call }) => {
    assert.equal((await call('/api/health')).headers.get('access-control-allow-origin'), 'http://localhost:5173');
  }, { origin: 'http://localhost:5173' });
  await withApi({}, async ({ call }) => {
    const response = await call('/api/health');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-powered-by'), null);
  }, { origin: 'http://evil.example' });
});
