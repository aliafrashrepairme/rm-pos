import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' });
const PERMS = {
  owner: ['reports.sales', 'reports.inventory', 'reports.export'],
  stock: ['reports.inventory'],
  cashier: ['pos.sell']
};
const PERIOD = { from: '2026-01-01', to: '2026-01-02', start: '2025-12-31T18:30:00Z', end: '2026-01-02T18:30:00Z', timeZone: 'Asia/Colombo' };
const BILL = { id: 'b', bill_no: 'RM-INV-1', status: 'Partially Refunded', customer_name: 'Ravi', grand_total: '118.00', created_at: 't', sale_items: [{ qty: '2.000' }, { qty: '1.000' }], payments: [{ method_code: 'Cash' }], refunds: [{ total: '18.00' }] };
const PAYMENT = { id: 'p', method_code: 'Card', amount: '50.00', reference: 'R', created_at: 't', sales: { bill_no: 'RM-INV-1', status: 'Paid', customer_name: 'Ravi' } };
const MOVE = { id: 1, product_id: 'x', movement_type: 'Sale', change_qty: '-2.000', new_qty: '8.000', reason: 'Sale', reference_no: 'RM-INV-1', created_at: 't', products: { name: 'Nail', sku: 'S' } };
const TABLES = { sales: BILL, payments: PAYMENT, inventory_ledger: MOVE };

function fakeDatabase() {
  const database = {
    rpcCalls: [],
    audits: [],
    calls: [],
    auth: { admin: {} },
    rpc: async (name, args) => {
      database.rpcCalls.push([name, args]);
      if (name === 'report_period') return { data: PERIOD, error: null };
      return { data: { name }, error: null };
    },
    from(table) {
      const call = { table, filters: [], selects: [], ors: [], orders: [], ranges: [] };
      database.calls.push(call);
      const chain = {
        select: (columns) => { call.selects.push(columns); return chain; },
        order: (column, options) => { call.orders.push([column, options?.ascending]); return chain; },
        range: (...args) => { call.ranges.push(args); return chain; },
        or: (text) => { call.ors.push(text); return chain; },
        ilike: (column, value) => { call.filters.push([column, value]); return chain; },
        gte: (column, value) => { call.filters.push([column, value]); return chain; },
        lt: (column, value) => { call.filters.push([column, value]); return chain; },
        insert: (row) => { if (table === 'audit_logs') database.audits.push(row); return chain; },
        eq: (column, value) => { call.filters.push([column, value]); return chain; },
        maybeSingle: () => { call.single = true; return chain; },
        then(resolve) {
          if (table === 'profiles') {
            const id = call.filters[0][1];
            return resolve({ data: { id, username: id, full_name: id, role_code: id, email: 'x', active: true, must_change_password: false, roles: { role_permissions: (PERMS[id] || []).map((permission_code) => ({ permission_code })) } }, error: null });
          }
          if (TABLES[table]) return resolve({ data: call.ranges[0]?.[0] > 0 ? [] : [TABLES[table]], count: 1, error: null });
          resolve({ data: [], error: null });
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

test('each role reaches only what it should', async () => {
  await withApi(async (as) => {
    const salesPaths = ['/api/reports/sales', '/api/reports/sales/bills', '/api/reports/payments', '/api/reports/payments/list'];
    const stockPaths = ['/api/reports/inventory', '/api/reports/products', '/api/reports/stock-movements'];
    for (const path of [...salesPaths, ...stockPaths, '/api/reports/filters']) {
      assert.equal((await as('owner', path)).status, 200, path);
      assert.equal((await as('cashier', path)).status, 403, path);
    }
    for (const path of salesPaths) assert.equal((await as('stock', path)).status, 403, path);
    for (const path of [...stockPaths, '/api/reports/filters']) assert.equal((await as('stock', path)).status, 200, path);
  });
});

test('full exports need export rights on the server', async () => {
  await withApi(async (as, database) => {
    assert.equal((await as('stock', '/api/reports/stock-movements?all=1')).status, 403);
    assert.equal((await as('owner', '/api/reports/stock-movements?all=1')).status, 200);
    const exported = { method: 'POST', body: JSON.stringify({ report: 'stock' }) };
    assert.equal((await as('stock', '/api/reports/exported', exported)).status, 403);
    assert.equal((await as('owner', '/api/reports/exported', exported)).status, 204);
    assert.equal((await as('owner', '/api/reports/exported', { method: 'POST', body: JSON.stringify({ report: 'nope' }) })).status, 400);
    assert.deepEqual(database.audits.map((row) => [row.action, row.description]), [['Report exported', 'stock']]);
  });
});

test('filters are checked and search cannot break out', async () => {
  await withApi(async (as, database) => {
    assert.equal((await as('owner', '/api/reports/sales?from=soon&preset=custom')).status, 400);
    assert.equal((await as('owner', '/api/reports/sales?product=bad')).status, 400);
    assert.equal((await as('owner', '/api/reports/sales?from=2026-13-40')).status, 400);
    const product = randomUUID();
    await as('owner', `/api/reports/sales?preset=last7&group=week&category=Paint&product=${product}`);
    const summary = database.rpcCalls.find(([name]) => name === 'report_sales')[1];
    assert.deepEqual([summary.p_group, summary.p_category, summary.p_product, summary.p_period], ['week', 'Paint', product, PERIOD]);
    await as('owner', '/api/reports/sales/bills?q=a%22,status.eq.x');
    const bills = database.calls.find((call) => call.table === 'sales');
    assert.ok(!bills.ors[0].includes('a"'), bills.ors[0]);
  });
});

test('bills use only allowed sort columns, within the period, and narrow by product', async () => {
  await withApi(async (as, database) => {
    await as('owner', '/api/reports/sales/bills?sort=password&dir=asc');
    const first = database.calls.find((call) => call.table === 'sales');
    assert.deepEqual(first.orders[0], ['created_at', true]);
    assert.deepEqual(first.filters.slice(0, 2), [['created_at', PERIOD.start], ['created_at', PERIOD.end]]);
    assert.ok(!first.selects[0].includes('matching'));
    database.calls.length = 0;
    await as('owner', '/api/reports/sales/bills?sort=total&category=Paint');
    const narrowed = database.calls.find((call) => call.table === 'sales');
    assert.deepEqual(narrowed.orders[0], ['grand_total', false]);
    assert.ok(narrowed.selects[0].includes('matching:sale_items!inner'));
    assert.ok(narrowed.filters.some(([column, value]) => column === 'matching.category_name' && value === 'Paint'));
  });
});

test('rows are readable, with real status and refunds', async () => {
  await withApi(async (as) => {
    const { bills, total } = await (await as('owner', '/api/reports/sales/bills')).json();
    assert.equal(total, 1);
    assert.deepEqual([bills[0].billNo, bills[0].status, bills[0].items, bills[0].payment, bills[0].total, bills[0].refunded], ['RM-INV-1', 'Partially Refunded', 3, 'Cash', 118, 18]);
    const { payments } = await (await as('owner', '/api/reports/payments/list?method=Card')).json();
    assert.deepEqual([payments[0].billNo, payments[0].method, payments[0].amount], ['RM-INV-1', 'Card', 50]);
    const { movements, totals } = await (await as('stock', '/api/reports/stock-movements?type=Sale')).json();
    assert.deepEqual([movements[0].name, movements[0].change, movements[0].balance], ['Nail', -2, 8]);
    assert.ok(totals);
  });
});
