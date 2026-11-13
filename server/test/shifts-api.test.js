import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = { manager: ['shifts.manage'], cashier: ['shifts.own'], other: ['shifts.own'], owner: ['reports.sales'], stock: ['products.view'] };
const ID = randomUUID();
const COUNTER = randomUUID();
const OPEN_ROW = { id: ID, shift_no: 'SH-1', status: 'Open', opening_cash: '1000.00', expected_cash: null, counted_cash: null, opened_at: 't', closed_at: null, cashier_id: 'cashier', counters: { name: 'Counter 01' }, cashier: { full_name: 'Cash' } };

function fakeDatabase({ ownShift = null } = {}) {
  const database = {
    rpcCalls: [],
    audits: [],
    filters: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'open_shift') return { data: ID, error: null };
      if (name === 'close_shift') return { data: { shiftNo: 'SH-1', expected: 1100, counted: args.p_counted, variance: args.p_counted - 1100 }, error: null };
      if (name === 'shift_figures') return { data: { expectedCash: 1100, bills: 1 }, error: null };
      if (name === 'add_expense') return { data: { expenseNo: 'EXP-1' }, error: null };
      return { data: null, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        range: () => chain,
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); database.filters.push([table, column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'shifts') {
            if (call.filters.some(([column]) => column === 'status')) return resolve({ data: call.single ? ownShift : [], error: null });
            return resolve({ data: call.single ? OPEN_ROW : [OPEN_ROW], count: 1, error: null });
          }
          if (table === 'counters') return resolve({ data: [{ id: COUNTER, name: 'Counter 01' }], error: null });
          resolve({ data: [], count: 0, error: null });
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
  const server = createApp({ config, authClient, database, extractor: null }).listen(0);
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

test('roles reach only what they should', async () => {
  await withApi({}, async (as) => {
    for (const user of ['owner', 'stock']) {
      assert.equal((await as(user, '/api/shifts')).status, 403, user);
      assert.equal((await as(user, '/api/shifts/expenses')).status, 403, user);
      assert.equal((await as(user, '/api/shifts', post({}))).status, 403, user);
      assert.equal((await as(user, `/api/shifts/${ID}/close`, post({ countedCash: 1 }))).status, 403, user);
    }
    assert.equal((await as('manager', '/api/shifts')).status, 200);
    assert.equal((await as('manager', '/api/shifts', post({ counterId: COUNTER, openingCash: 1 }))).status, 403, 'managers do not run a drawer');
  });
});

test('a cashier sees only their own shifts', async () => {
  await withApi({}, async (as, database) => {
    await as('cashier', '/api/shifts');
    assert.ok(database.filters.some(([table, column, value]) => table === 'shifts' && column === 'cashier_id' && value === 'cashier'));
    assert.equal((await as('cashier', `/api/shifts/${ID}`)).status, 200);
    assert.equal((await as('other', `/api/shifts/${ID}`)).status, 404);
    assert.equal((await as('other', `/api/shifts/${ID}/close`, post({ countedCash: 1 }))).status, 404);
    assert.equal(database.rpcCalls.filter(([name]) => name === 'close_shift').length, 0);
    assert.equal((await as('manager', `/api/shifts/${ID}`)).status, 200);
  });
});

test('opening uses the session user and is validated', async () => {
  await withApi({}, async (as, database) => {
    assert.equal((await as('cashier', '/api/shifts', post({ counterId: 'x', openingCash: 1 }))).status, 400);
    assert.equal((await as('cashier', '/api/shifts', post({ counterId: COUNTER, openingCash: -1 }))).status, 400);
    assert.equal((await as('cashier', '/api/shifts', post({ counterId: COUNTER }))).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await as('cashier', '/api/shifts', post({ counterId: COUNTER, openingCash: 500, cashierId: 'other' }))).status, 201);
    assert.equal(database.rpcCalls[0][1].p_user, 'cashier');
    assert.deepEqual(database.audits.map((row) => row.action), ['Shift opened']);
  });
});

test('closing records the variance in the audit log', async () => {
  await withApi({}, async (as, database) => {
    assert.equal((await as('cashier', `/api/shifts/${ID}/close`, post({}))).status, 400);
    const response = await as('cashier', `/api/shifts/${ID}/close`, post({ countedCash: 1090 }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).variance, -10);
    assert.match(database.audits[0].description, /variance -10\.00/);
  });
});

test('expenses are validated, and only a manager can name a shift', async () => {
  const shiftId = randomUUID();
  const good = { category: 'Other', description: 'Tea', amount: 50 };
  await withApi({ ownShift: { id: 'mine' } }, async (as, database) => {
    const add = (body) => as('cashier', '/api/shifts/expenses', post({ ...good, ...body }));
    assert.equal((await add({ category: 'Bribes' })).status, 400);
    assert.equal((await add({ description: ' ' })).status, 400);
    assert.equal((await add({ amount: 0 })).status, 400);
    assert.equal((await add({ amount: 'lots' })).status, 400);
    assert.equal(database.rpcCalls.length, 0);
    assert.equal((await add({ shiftId })).status, 201);
    assert.equal(database.rpcCalls[0][1].p_expense.shiftId, 'mine', 'a cashier cannot charge someone else\'s drawer');
    assert.equal(database.rpcCalls[0][1].p_user, 'cashier');
  });
  await withApi({}, async (as, database) => {
    assert.equal((await as('manager', '/api/shifts/expenses', post({ ...good, shiftId }))).status, 201);
    assert.equal(database.rpcCalls[0][1].p_expense.shiftId, shiftId);
    assert.deepEqual(database.audits.map((row) => row.action), ['Expense recorded']);
  });
});
