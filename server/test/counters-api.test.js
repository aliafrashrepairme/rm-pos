import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  owner: ['counters.manage', 'printers.manage', 'reports.sales'],
  manager: ['shifts.manage', 'settings.manage', 'users.manage'],
  cashier: ['shifts.own', 'pos.sell']
};
const ID = randomUUID();

function fakeDatabase() {
  const database = {
    rpcCalls: [],
    audits: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'save_counter') {
        return { data: { id: args.p_id ?? ID, name: args.p_name, oldName: 'Counter 01', wasActive: true, active: args.p_active ?? true, created: !args.p_id }, error: null };
      }
      return { data: null, error: null };
    },
    from(table) {
      const call = { filters: [] };
      const chain = {
        select: () => chain, order: () => chain, limit: () => chain,
        insert: (value) => { if (table === 'audit_logs') database.audits.push(value); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (table === 'counters') return resolve({ data: call.single ? { name: 'Counter 01' } : [{ id: ID, name: 'Counter 01', active: true }], error: null });
          if (table === 'shifts' && call.filters.length) {
            return resolve({ data: [{ counter_id: ID, shift_no: 'SH-9', opened_at: 't', cashier: { full_name: 'Cash' } }], error: null });
          }
          resolve({ data: [{ counter_id: ID, opened_at: 'last' }], error: null });
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

test('only the Owner manages counters and printers', async () => {
  await withApi(async (as) => {
    for (const user of ['manager', 'cashier']) {
      assert.equal((await as(user, '/api/counters')).status, 403, user);
      assert.equal((await as(user, '/api/counters', send('POST', { name: 'Counter 03' }))).status, 403, user);
      assert.equal((await as(user, '/api/printers/changed', send('POST', { changes: [{ role: 'receipt', printer: 'X' }] }))).status, 403, user);
    }
    const { counters } = await (await as('owner', '/api/counters')).json();
    assert.deepEqual(counters[0].openShift, { shiftNo: 'SH-9', cashier: 'Cash', openedAt: 't' });
    assert.equal(counters[0].lastUsed, 'last');
  });
});

test('counters are validated and every change is audited', async () => {
  await withApi(async (as, database) => {
    assert.equal((await as('owner', '/api/counters', send('POST', { name: '  ' }))).status, 400);
    assert.equal((await as('owner', '/api/counters', send('POST', { name: 'x'.repeat(41) }))).status, 400);
    assert.equal((await as('owner', '/api/counters', send('POST', { name: 'Counter 03' }))).status, 201);
    assert.equal((await as('owner', `/api/counters/${ID}`, send('PATCH', { active: 'no' }))).status, 400);
    assert.equal((await as('owner', '/api/counters/nope', send('PATCH', { active: false }))).status, 404);
    assert.equal((await as('owner', `/api/counters/${ID}`, send('PATCH', { active: false }))).status, 200);
    assert.deepEqual(database.rpcCalls.at(-1)[1], { p_id: ID, p_name: 'Counter 01', p_active: false }, 'switching off keeps the name');
    assert.deepEqual(database.audits.map((row) => [row.action, row.description]), [
      ['Counter added', 'Counter 03'],
      ['Counter changed', 'Counter 01 · switched off']
    ]);
  });
});

test('printer changes made on a computer are recorded', async () => {
  await withApi(async (as, database) => {
    assert.equal((await as('owner', '/api/printers/changed', send('POST', { changes: [{ role: 'toaster' }] }))).status, 400);
    const ok = await as('owner', '/api/printers/changed', send('POST', { computer: 'TILL-1', changes: [{ role: 'receipt', printer: 'XP-80C', silent: true }] }));
    assert.equal(ok.status, 204);
    assert.equal(database.audits[0].description, 'TILL-1 · receipt: XP-80C (no dialog)');
  });
});
