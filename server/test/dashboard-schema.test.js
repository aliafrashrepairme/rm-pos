import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

let db;
let userId;
let categoryId;
let taxRateId;

// 09:30 on 15 March 2026 in Sri Lanka (UTC+5:30).
const NOW = '2026-03-15T04:00:00Z';

async function sale(createdAt, total, { status = 'Paid', customer = 'Walk-in Customer' } = {}) {
  const { rows } = await db.query(
    `insert into public.sales (bill_no, client_request_id, cashier_id, customer_name, subtotal, grand_total, status, voided_at, created_at)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8) returning id`,
    [`B-${randomUUID()}`, randomUUID(), userId, customer, total, status, status === 'Voided' ? createdAt : null, createdAt]
  );
  return rows[0].id;
}

async function refund(saleId, createdAt, total) {
  await db.query(
    `insert into public.refunds (refund_no, client_request_id, sale_id, method_code, reason, total, created_by, created_at)
     values ($1, $2, $3, 'Cash', 'test', $4, $5, $6)`,
    [`R-${randomUUID()}`, randomUUID(), saleId, total, userId, createdAt]
  );
}

async function product(sku, stock, min, active = true) {
  const { rows } = await db.query(
    `insert into public.products (sku, name, category_id, unit_code, selling_price, tax_rate_id, min_stock, active)
     values ($1, $2, $3, 'Piece', 100, $4, $5, $6) returning id`,
    [sku, `Product ${sku}`, categoryId, taxRateId, min, active]
  );
  if (stock) {
    await db.query(`select public.post_stock_movement($1, 'Opening', $2, 'test', '', '', '', $3)`, [rows[0].id, stock, userId]);
  }
}

const summary = async (now = NOW) => (await db.query('select public.dashboard_summary($1) as s', [now])).rows[0].s;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  await db.exec(await read('0001_core_schema.sql'));
  await db.exec(await read('0002_dashboard.sql'));
  userId = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [userId]);
  await db.query(
    `insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test Cashier', 'c@example.com', 'Manager')`,
    [userId]
  );
  categoryId = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  taxRateId = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
});

test('an empty store gets zeros and empty lists, not errors', async () => {
  const s = await summary();
  assert.equal(s.today.net, 0);
  assert.equal(s.month.orders, 0);
  assert.equal(s.products.total, 0);
  assert.deepEqual(s.lowStock, []);
  assert.deepEqual(s.recentSales, []);
  assert.equal(s.dailySales.length, 14);
  assert.equal(s.dailySales[13].date, '2026-03-15');
  assert.equal(s.dailySales[0].date, '2026-03-02');
  assert.ok(s.dailySales.every((day) => day.total === 0));
});

test('the public API roles cannot run the dashboard functions', async () => {
  const { rows } = await db.query(`
    select has_function_privilege('anon', 'public.dashboard_summary(timestamptz)', 'execute') as anon,
           has_function_privilege('authenticated', 'public.sales_totals(timestamptz, timestamptz)', 'execute') as signed_in,
           has_function_privilege('service_role', 'public.dashboard_summary(timestamptz)', 'execute') as api
  `);
  assert.deepEqual(rows[0], { anon: false, signed_in: false, api: true });
});

test('sales totals follow the Sri Lankan day, net of refunds and voids', async () => {
  // 00:10 on the 15th in Sri Lanka, though still the 14th in UTC.
  const justAfterMidnight = await sale('2026-03-14T18:40:00Z', 1000);
  // 23:50 on the 14th in Sri Lanka, which is earlier the same UTC evening.
  await sale('2026-03-14T18:20:00Z', 200);
  await sale('2026-03-15T02:00:00Z', 500);
  await sale('2026-03-15T03:00:00Z', 900, { status: 'Voided' });
  // A later sale than "now" must not count yet.
  await sale('2026-03-15T05:00:00Z', 7000);
  await refund(justAfterMidnight, '2026-03-15T03:30:00Z', 300);
  // Refunded today against a sale from last month.
  const old = await sale('2026-02-10T06:00:00Z', 400);
  await refund(old, '2026-03-15T03:40:00Z', 50);

  const s = await summary();
  assert.deepEqual(s.today, { gross: 1500, refunds: 350, net: 1150, orders: 2 });
  assert.equal(s.dailySales[13].total, 1150);
  assert.equal(s.dailySales[12].total, 200);
  assert.deepEqual(s.month, { gross: 1700, refunds: 350, net: 1350, orders: 3 });
});

test('comparisons stop at the same moment yesterday and last month', async () => {
  await sale('2026-03-14T02:00:00Z', 60);
  await sale('2026-03-14T10:00:00Z', 5000);
  await sale('2026-02-12T03:00:00Z', 70);
  await sale('2026-02-20T03:00:00Z', 8000);

  const s = await summary();
  assert.equal(s.yesterday.gross, 60, 'the later sale yesterday is left out');
  assert.equal(s.lastMonth.gross, 400 + 70, 'sales after 15 February are left out');
});

test('stock counts and the watchlist separate low, out, healthy and inactive items', async () => {
  await product('OK', 50, 10);
  await product('LOW', 5, 10);
  await product('EDGE', 10, 10);
  await product('OUT', 0, 10);
  await product('ZEROMIN', 0, 0);
  await product('OFF', 0, 10, false);

  const s = await summary();
  assert.deepEqual(s.products, { total: 5, low: 2, out: 2 });
  assert.deepEqual(s.lowStock.map((item) => item.name), [
    'Product ZEROMIN', 'Product OUT', 'Product LOW', 'Product EDGE'
  ]);
});

test('recent sales are newest first, and activity leaves out sign-ins', async () => {
  await db.query(`insert into public.audit_logs (user_name, action, description) values
    ('Test Cashier', 'User login', ''), ('Test Cashier', 'Login failed', ''), ('Test Cashier', 'Product created', 'RM-1')`);
  const s = await summary('2026-03-20T00:00:00Z');
  assert.equal(s.recentSales.length, 8);
  const dates = s.recentSales.map((row) => row.createdAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.equal(s.recentSales[0].cashier, 'Test Cashier');
  assert.deepEqual(s.activity.map((row) => row.action), ['Product created']);
});

test('task counts reflect open work', async () => {
  const supplier = (await db.query(`insert into public.suppliers (code, name) values ('S1', 'S') returning id`)).rows[0].id;
  await db.query(`insert into public.purchases (po_no, supplier_id, status, created_by) values
    ('P1', $1, 'Ordered', $2), ('P2', $1, 'Partially Received', $2), ('P3', $1, 'Received', $2), ('P4', $1, 'Draft', $2)`, [supplier, userId]);
  await db.query(`insert into public.stock_adjustments (adjustment_no, reason, status, created_by) values
    ('A1', 'Damaged', 'Pending', $1), ('A2', 'Damaged', 'Approved', $1)`, [userId]);
  await db.query(`insert into public.stock_counts (count_no, name, scope, status, created_by) values
    ('C1', 'n', 's', 'In Progress', $1), ('C2', 'n', 's', 'Submitted', $1)`, [userId]);
  assert.deepEqual((await summary()).tasks, { toReceive: 2, pendingAdjustments: 1, openCounts: 1, submittedCounts: 1 });
});
