import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  manager: ['inventory.view', 'adjustments.manage', 'counts.manage', 'counts.approve'],
  stock: ['inventory.view', 'counts.manage'],
  cashier: ['pos.sell'],
  owner: ['reports.inventory']
};

function fakeDatabase({ count = {}, lines = [], rpcError } = {}) {
  const database = {
    rpcCalls: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (rpcError) return { data: null, error: rpcError };
      return { data: name === 'inventory_list' ? { rows: [], total: 0 } : 'id-1', error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        insert: () => chain,
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        or: () => chain,
        gte: () => chain,
        lte: () => chain,
        limit: () => chain,
        range: () => chain,
        maybeSingle: () => { call.single = true; return chain; },
        single: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'stock_counts') return resolve({ data: call.single ? { id: 'c1', count_no: 'SC-1', name: 'n', scope: 's', status: 'In Progress', blind: false, ...count } : [], error: null, count: 0 });
          if (table === 'stock_count_lines') return resolve({ data: lines, error: null });
          if (table === 'stock_adjustments') return resolve({ data: call.single ? { id: 'id-1', adjustment_no: 'ADJ-1' } : [], error: null, count: 0 });
          resolve({ data: call.single ? null : [], error: null, count: 0 });
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
const validAdjustment = { reason: 'Damaged', lines: [{ productId: 'p1', change: -1 }] };

test('each role only reaches the inventory routes it should', async () => {
  await withApi({}, async (as) => {
    const expect = async (user, path, status, init) => assert.equal((await as(user, path, init)).status, status, `${user} ${path}`);
    for (const path of ['/api/inventory/stock', '/api/inventory/summary', '/api/inventory/movements']) {
      await expect('manager', path, 200);
      await expect('stock', path, 200);
      await expect('cashier', path, 403);
      await expect('owner', path, 403);
    }
    await expect('stock', '/api/inventory/adjustments', 403);
    await expect('stock', '/api/inventory/adjustments', 403, post(validAdjustment));
    await expect('cashier', '/api/inventory/adjustments', 403, post(validAdjustment));
    await expect('owner', '/api/inventory/adjustments', 403, post(validAdjustment));
    await expect('manager', '/api/inventory/adjustments', 201, post(validAdjustment));

    await expect('stock', '/api/inventory/counts', 200);
    await expect('cashier', '/api/inventory/counts', 403);
    await expect('owner', '/api/inventory/counts', 403);
    await expect('stock', '/api/inventory/counts/c1/submit', 200, post());
    await expect('stock', '/api/inventory/counts/c1/approve', 403, post());
    await expect('stock', '/api/inventory/counts/c1/reopen', 403, post());
    await expect('manager', '/api/inventory/counts/c1/approve', 200, post());
  });
});

test('adjustments are validated and recorded under the signed-in user', async () => {
  await withApi({}, async (as, database) => {
    const send = (body) => as('manager', '/api/inventory/adjustments', post(body));
    assert.equal((await send({ ...validAdjustment, reason: 'Because' })).status, 400);
    assert.equal((await send({ reason: 'Damaged', lines: [] })).status, 400);
    assert.equal((await send({ reason: 'Damaged', lines: [{ productId: 'p1', change: 0 }] })).status, 400);
    assert.equal((await send({ reason: 'Damaged', lines: [{ productId: 'p1', change: 'x' }] })).status, 400);
    assert.equal((await send({ reason: 'Damaged', lines: [{ productId: 'p1', change: 1 }, { productId: 'p1', change: 2 }] })).status, 400);
    assert.equal(database.rpcCalls.length, 0);

    assert.equal((await send({ ...validAdjustment, created_by: 'someone-else' })).status, 201);
    assert.equal(database.rpcCalls[0][1].p_created_by, 'manager');
  });
});

test('a stock shortage is a 409 with a readable message', async () => {
  const rpcError = { code: 'P0001', message: 'INSUFFICIENT_STOCK:Only 1 of Hammer in stock.' };
  await withApi({ rpcError }, async (as) => {
    const response = await as('manager', '/api/inventory/adjustments', post(validAdjustment));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Only 1 of Hammer in stock.' });
  });
});

test('approving twice is a 409, not a server error', async () => {
  const rpcError = { code: 'P0001', message: 'CONFLICT:Only a submitted count can be approved.' };
  await withApi({ rpcError }, async (as) => {
    assert.equal((await as('manager', '/api/inventory/counts/c1/approve', post())).status, 409);
  });
});

const LINE = { product_id: 'p1', system_qty: '10.000', counted_qty: '8.000', products: { name: 'Hammer', cost_price: '5.00', unit_code: 'Piece' } };

test('a blind count never sends expected quantities while counting', async () => {
  await withApi({ count: { blind: true }, lines: [LINE] }, async (as) => {
    for (const user of ['stock', 'manager']) {
      const text = await (await as(user, '/api/inventory/counts/c1')).text();
      const line = JSON.parse(text).count.lines[0];
      assert.equal(line.expected, undefined, user);
      assert.equal(line.variance, undefined, user);
      assert.equal(line.counted, 8);
      assert.ok(!text.includes('system_qty'));
    }
  });
});

test('after submission only an approver sees expected quantities', async () => {
  await withApi({ count: { blind: true, status: 'Submitted' }, lines: [LINE] }, async (as) => {
    const manager = (await (await as('manager', '/api/inventory/counts/c1')).json()).count.lines[0];
    assert.equal(manager.expected, 10);
    assert.equal(manager.variance, -2);
    assert.equal(manager.varianceValue, -10);
    const stock = (await (await as('stock', '/api/inventory/counts/c1')).json()).count.lines[0];
    assert.equal(stock.expected, undefined);
  });
});

test('count entries must be valid numbers, and blank clears them', async () => {
  await withApi({}, async (as, database) => {
    const put = (counted) => as('stock', '/api/inventory/counts/c1/lines/p1', { method: 'PUT', body: JSON.stringify({ counted }) });
    assert.equal((await put(-1)).status, 400);
    assert.equal((await put('abc')).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await put(5)).status, 204);
    assert.equal(database.rpcCalls[0][1].p_counted, 5);
    assert.equal((await put('')).status, 204);
    assert.equal(database.rpcCalls[1][1].p_counted, null);
  });
});

test('stock filters are checked before reaching the database', async () => {
  await withApi({}, async (as, database) => {
    await as('stock', '/api/inventory/stock?state=nonsense&pageSize=99999&page=2&q=a%25b');
    const args = database.rpcCalls[0][1];
    assert.equal(args.p_state, 'all');
    assert.equal(args.p_limit, 100);
    assert.equal(args.p_offset, 100);
    assert.equal(args.p_search, 'a b');
  });
});
