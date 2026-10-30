import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';
import { createLoginLimiter } from '../middleware/loginLimiter.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });

function profile(id, role, permissions, extra = {}) {
  return {
    id,
    username: id,
    full_name: `${role} person`,
    role_code: role,
    email: `${id}@x.lk`,
    active: true,
    must_change_password: false,
    roles: { role_permissions: permissions.map((permission_code) => ({ permission_code })) },
    ...extra
  };
}

const makeProfiles = () => [
  profile('owner', 'Owner', ['reports.sales', 'reports.inventory']),
  profile('manager', 'Manager', ['reports.sales', 'reports.inventory', 'users.manage']),
  profile('cashier', 'Cashier', ['pos.sell']),
  profile('stock', 'Inventory Staff', ['reports.inventory']),
  profile('disabled', 'Manager', ['users.manage'], { active: false }),
  profile('temp', 'Cashier', ['reports.sales'], { must_change_password: true }),
  profile('dash', 'Manager', ['dashboard.view'])
];

// Records queries and answers them from `tables`, honouring range() like Supabase does.
function fakeDatabase(tables) {
  const calls = [];
  const admin = { signOuts: [], passwords: [] };
  return {
    calls,
    admin,
    auth: {
      admin: {
        signOut: async (token, scope) => { admin.signOuts.push([token, scope]); return { error: null }; },
        updateUserById: async (id, change) => { admin.passwords.push([id, change.password]); return { error: null }; }
      }
    },
    rpc: async (name) => name === 'dashboard_summary' ? { data: { today: { net: 5 } }, error: null } : { data: null, error: { message: 'unknown' } },
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (row) => { call.insert = row; return chain; },
        update: (change) => { call.update = change; return chain; },
        upsert: (row) => { (tables[table] ||= []).push(row); call.upserted = row; return chain; },
        single: () => { call.single = true; return chain; },
        eq: (column, value) => { call.filters.push(['eq', column, value]); return chain; },
        gte: (column, value) => { call.filters.push(['gte', column, value]); return chain; },
        lte: (column, value) => { call.filters.push(['lte', column, value]); return chain; },
        range: (from, to) => { call.range = [from, to]; return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          const source = tables[table];
          if (source?.error) return resolve({ data: null, error: source.error });
          let rows = call.upserted ? [call.upserted] : source || [];
          for (const [kind, column, value] of call.filters) if (kind === 'eq') rows = rows.filter((row) => row[column] === value);
          if (call.update) rows.forEach((row) => Object.assign(row, call.update));
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
          resolve({ data: call.single ? rows[0] || null : rows, error: null });
        }
      };
      return chain;
    }
  };
}

const session = { access_token: 'at', refresh_token: 'rt', expires_at: 1900000000 };

function fakeAuth(tables) {
  return {
    auth: {
      getUser: async (token) => tables.profiles.some((row) => row.id === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } },
      signInWithPassword: async ({ email, password }) => password === 'right'
        ? { data: { user: { id: email.split('@')[0] }, session }, error: null }
        : { data: {}, error: { message: 'invalid' } },
      refreshSession: async () => ({ data: {}, error: { message: 'expired' } }),
      resetPasswordForEmail: async (email) => { fakeAuth.emails.push(email); return { error: null }; },
      verifyOtp: async ({ email, token }) => token === '123456'
        ? { data: { user: { id: email.split('@')[0] }, session }, error: null }
        : { data: {}, error: { message: 'bad code' } }
    }
  };
}
fakeAuth.emails = [];

async function withApi(tableOverrides, run, options = {}) {
  const tables = { profiles: makeProfiles(), store_settings: [{ id: true }], audit_logs: [], ...tableOverrides };
  const database = fakeDatabase(tables);
  const server = createApp({ config, authClient: fakeAuth(tables), database, limiter: options.limiter }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(options.origin ? { Origin: options.origin } : {}), ...init.headers }
  });
  const as = (user, path, init = {}) => call(path, { ...init, headers: { Authorization: `Bearer ${user}` } });
  const audit = () => database.calls.filter((item) => item.table === 'audit_logs' && item.insert).map((item) => item.insert);
  try {
    await run({ call, as, database, tables, audit });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postJson = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const login = (identifier, password = 'right') => postJson({ identifier, password });

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

test('login works by username or email and returns permissions, not secrets', async () => {
  await withApi({}, async ({ call, audit }) => {
    const byUsername = await call('/api/auth/login', login('OWNER'));
    assert.equal(byUsername.status, 200);
    const body = await byUsername.json();
    assert.equal(body.user.role, 'Owner');
    assert.deepEqual(body.user.permissions, ['reports.sales', 'reports.inventory']);
    assert.equal(body.token, 'at');
    assert.equal((await call('/api/auth/login', login('owner@x.lk'))).status, 200);
    assert.equal(audit().at(-1).action, 'User login');
  });
});

test('failed logins are refused alike and audited without the password', async () => {
  await withApi({}, async ({ call, audit }) => {
    const wrong = await call('/api/auth/login', login('owner', 'wrong'));
    const unknown = await call('/api/auth/login', login('nobody', 'wrong'));
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    assert.equal(audit().at(-1).action, 'Login failed');
    assert.ok(!JSON.stringify(audit()).includes('wrong'));
    assert.equal((await call('/api/auth/login', postJson({ identifier: 'owner' }))).status, 400);
    assert.equal((await call('/api/auth/refresh', postJson({ refreshToken: 'old' }))).status, 401);
  });
});

test('a disabled account is refused and its new session is ended', async () => {
  await withApi({}, async ({ call, database }) => {
    assert.equal((await call('/api/auth/login', login('disabled'))).status, 403);
    assert.deepEqual(database.admin.signOuts, [['at', 'local']]);
  });
});

test('repeated failures lock that account from that address, and success clears the count', async () => {
  let time = 1000;
  const limiter = createLoginLimiter({ now: () => time });
  await withApi({}, async ({ call }) => {
    for (let attempt = 0; attempt < 4; attempt += 1) await call('/api/auth/login', login('owner', 'wrong'));
    assert.equal((await call('/api/auth/login', login('owner'))).status, 200, 'success clears the count');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await call('/api/auth/login', login('owner', 'wrong'))).status, 401);
    }
    const locked = await call('/api/auth/login', login('owner'));
    assert.equal(locked.status, 429, 'even the right password waits');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await call('/api/auth/login', login('manager'))).status, 200, 'other accounts still work');

    time += 15 * 60 * 1000 + 1;
    assert.equal((await call('/api/auth/login', login('owner'))).status, 200, 'the lock expires');
  }, { limiter });
});

test('protected routes need a valid session on an enabled account', async () => {
  await withApi({}, async ({ call, as }) => {
    assert.equal((await call('/api/auth/me')).status, 401);
    assert.equal((await as('nonsense', '/api/auth/me')).status, 401);
    assert.equal((await as('disabled', '/api/auth/me')).status, 403);
    assert.equal((await as('owner', '/api/auth/me')).status, 200);
  });
});

test('report access follows permissions', async () => {
  await withApi({ sales: [], products: [], inventory_ledger: [] }, async ({ as }) => {
    assert.equal((await as('cashier', '/api/reports/sales')).status, 403);
    assert.equal((await as('cashier', '/api/reports/products')).status, 403);
    assert.equal((await as('stock', '/api/reports/sales')).status, 403);
    assert.equal((await as('stock', '/api/reports/products')).status, 200);
    assert.equal((await as('owner', '/api/reports/sales')).status, 200);
  });
});

test('logout ends the session on the server and is audited', async () => {
  await withApi({}, async ({ as, database, audit }) => {
    assert.equal((await as('owner', '/api/auth/logout', { method: 'POST' })).status, 204);
    assert.deepEqual(database.admin.signOuts, [['owner', 'local']]);
    assert.equal(audit().at(-1).action, 'User logout');
  });
});

test('a temporary password only allows the account routes', async () => {
  await withApi({ sales: [] }, async ({ as }) => {
    const blocked = await as('temp', '/api/reports/sales');
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await as('temp', '/api/auth/me')).status, 200);
  });
});

test('change password checks the current one and the new rules, then ends sessions', async () => {
  await withApi({}, async ({ as, database, tables }) => {
    const change = (currentPassword, newPassword) => as('temp', '/api/auth/change-password', postJson({ currentPassword, newPassword }));
    assert.equal((await change('wrong', 'long-enough-1')).status, 400);
    assert.equal((await change('right', 'short')).status, 400);
    assert.equal((await change('right', 'right')).status, 400);
    assert.deepEqual(database.admin.passwords, []);

    assert.equal((await change('right', 'long-enough-1')).status, 204);
    assert.deepEqual(database.admin.passwords, [['temp', 'long-enough-1']]);
    assert.equal(tables.profiles.find((row) => row.id === 'temp').must_change_password, false);
    assert.deepEqual(database.admin.signOuts.at(-1), ['temp', 'global']);
  });
});

test('staff password reset needs permission and protects Owners and yourself', async () => {
  await withApi({}, async ({ as, database, tables, audit }) => {
    const reset = (actor, target, temporaryPassword = 'temporary-1') => as(actor, `/api/users/${target}/reset-password`, postJson({ temporaryPassword }));
    assert.equal((await reset('cashier', 'stock')).status, 403);
    assert.equal((await reset('owner', 'stock')).status, 403, 'the Owner is read-only');
    assert.equal((await reset('manager', 'owner')).status, 403);
    assert.equal((await reset('manager', 'manager')).status, 400);
    assert.equal((await reset('manager', 'missing')).status, 404);
    assert.equal((await reset('manager', 'stock', 'short')).status, 400);
    assert.deepEqual(database.admin.passwords, []);

    assert.equal((await reset('manager', 'stock')).status, 204);
    assert.deepEqual(database.admin.passwords, [['stock', 'temporary-1']]);
    assert.equal(tables.profiles.find((row) => row.id === 'stock').must_change_password, true);
    assert.equal(audit().at(-1).action, 'Password reset');
    assert.ok(!JSON.stringify(audit()).includes('temporary-1'));
  });
});

test('forgot password gives one answer and only emails active real addresses', async () => {
  fakeAuth.emails = [];
  await withApi({
    profiles: [...makeProfiles(), profile('nomail', 'Cashier', [], { email: 'nomail@staff.rm-pos.local' })]
  }, async ({ call }) => {
    const ask = (email) => call('/api/auth/forgot-password', postJson({ email }));
    const known = await ask('owner@x.lk');
    const unknown = await ask('nobody@x.lk');
    await ask('disabled@x.lk');
    await ask('nomail@staff.rm-pos.local');
    assert.equal(known.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
    assert.deepEqual(fakeAuth.emails, ['owner@x.lk']);
  });
});

test('a reset code sets the new password; a bad code does not', async () => {
  await withApi({}, async ({ call, database }) => {
    const reset = (code, password = 'long-enough-1') => call('/api/auth/reset-password', postJson({ email: 'owner@x.lk', code, password }));
    assert.equal((await reset('000000')).status, 400);
    assert.equal((await reset('123456', 'short')).status, 400);
    assert.deepEqual(database.admin.passwords, []);
    assert.equal((await reset('123456')).status, 204);
    assert.deepEqual(database.admin.passwords, [['owner', 'long-enough-1']]);
    assert.deepEqual(database.admin.signOuts.at(-1), ['at', 'global']);
  });
});

test('preferences are per user and validated', async () => {
  await withApi({ user_preferences: [] }, async ({ as, call, tables }) => {
    const save = (user, body) => as(user, '/api/auth/preferences', { method: 'PUT', body: JSON.stringify(body) });
    assert.equal((await call('/api/auth/preferences')).status, 401);
    assert.deepEqual((await (await as('owner', '/api/auth/preferences')).json()).preferences, null);
    assert.equal((await save('owner', { theme: 'pink' })).status, 400);
    assert.equal((await save('owner', { language: 'fr' })).status, 400);

    const saved = await save('owner', { language: 'ta', user_id: 'manager' });
    assert.equal((await saved.json()).preferences.language, 'ta');
    assert.deepEqual(tables.user_preferences[0], { user_id: 'owner', language: 'ta' }, 'cannot target another user, and leaves the theme alone');
    assert.equal((await save('owner', {})).status, 400);
    assert.equal((await save('temp', { theme: 'light' })).status, 200, 'works on a temporary password too');
  });
});

test('only the dashboard permission can open the dashboard', async () => {
  await withApi({}, async ({ as, call }) => {
    assert.equal((await call('/api/dashboard')).status, 401);
    assert.equal((await as('owner', '/api/dashboard')).status, 403);
    assert.equal((await as('cashier', '/api/dashboard')).status, 403);
    assert.equal((await as('stock', '/api/dashboard')).status, 403);
    const response = await as('dash', '/api/dashboard');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).dashboard, { today: { net: 5 } });
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
