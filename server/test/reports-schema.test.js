import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql', '0010_customers.sql', '0011_reports.sql'];

let db;
let user;
let tools;
let paint;
let tax;

const product = async (name, categoryId, extra = {}) => (await db.query('select public.create_product($1, $2) as id', [{ name, categoryId, unitCode: 'Piece', taxRateId: tax, sellingPrice: 100, costPrice: 40, openingStock: 100, ...extra }, user])).rows[0].id;

async function sell(lines, method = 'Card') {
  const total = lines.reduce((sum, [, qty]) => sum + qty * 100, 0);
  const tax18 = Math.round(total * 18) / 100;
  const { rows: [{ r }] } = await db.query('select public.create_sale($1, $2) as r', [{
    clientRequestId: randomUUID(),
    items: lines.map(([productId, qty]) => ({ productId, qty })),
    expectedTotal: total + tax18,
    payment: method === 'Cash' ? { method, amountTendered: total + tax18 } : { method }
  }, user]);
  return r;
}

const periodFor = async (preset, from = null, to = null, now = null) => (await db.query(
  now ? 'select public.report_period($1, $2, $3, $4) as p' : 'select public.report_period($1, $2, $3) as p',
  now ? [preset, from, to, now] : [preset, from, to]
)).rows[0].p;
const today = async () => periodFor('today');
const sales = async (period, group = 'day', category = null, productId = null) => (await db.query('select public.report_sales($1, $2, $3, $4) as r', [period, group, category, productId])).rows[0].r;

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of MIGRATIONS) await db.exec(await read(file));
  user = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [user]);
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test', 't@example.com', 'Manager')`, [user]);
  tools = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  paint = (await db.query(`insert into public.categories (name) values ('Paint') returning id`)).rows[0].id;
  tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
});

test('periods follow the store day, not the UTC day', async () => {
  // 20:00 UTC on the 10th is already 01:30 on the 11th in Colombo.
  const period = await periodFor('today', null, null, '2026-03-10T20:00:00Z');
  assert.equal(period.from, '2026-03-11');
  assert.equal(period.to, '2026-03-11');
  assert.equal(new Date(period.start).toISOString(), '2026-03-10T18:30:00.000Z');
  assert.equal(new Date(period.end).toISOString(), '2026-03-11T18:30:00.000Z');
});

test('each preset gives the expected dates', async () => {
  const now = '2026-03-15T06:00:00Z';
  const dates = async (preset) => { const p = await periodFor(preset, null, null, now); return [p.from, p.to]; };
  assert.deepEqual(await dates('yesterday'), ['2026-03-14', '2026-03-14']);
  assert.deepEqual(await dates('last7'), ['2026-03-09', '2026-03-15']);
  assert.deepEqual(await dates('last30'), ['2026-02-14', '2026-03-15']);
  assert.deepEqual(await dates('thisMonth'), ['2026-03-01', '2026-03-15']);
  assert.deepEqual(await dates('lastMonth'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(await dates('thisYear'), ['2026-01-01', '2026-03-15']);
});

test('bad periods are refused', async () => {
  await assert.rejects(() => periodFor('nonsense'), /valid date range/);
  await assert.rejects(() => periodFor('custom'), /start and end/);
  await assert.rejects(() => periodFor('custom', '2026-03-02', '2026-03-01'), /must not be after/);
  await assert.rejects(() => periodFor('custom', '2000-01-01', '2026-03-01'), /ten years/);
});

test('totals match Daily, leave out voids, and take off partial refunds', async () => {
  const hammer = await product('Hammer', tools);
  const roller = await product('Roller', paint);
  const kept = await sell([[hammer, 2], [roller, 1]], 'Cash');
  await sell([[hammer, 1]], 'Card');
  const voided = await sell([[hammer, 5]], 'Card');
  await db.query('select public.void_sale($1, $2, $3)', [voided.id, 'mistake', user]);
  const { rows: lines } = await db.query('select id, qty, line_total, name from public.sale_items where sale_id = $1 order by line_no', [kept.id]);
  await db.query('select public.refund_sale($1, $2)', [{ clientRequestId: randomUUID(), saleId: kept.id, method: 'Cash', reason: 'damaged', lines: [{ saleItemId: lines[0].id, qty: 1, restock: true }] }, user]);

  const period = await today();
  const report = await sales(period);
  assert.equal(report.totals.orders, 2);
  assert.equal(report.totals.gross, 472);
  assert.equal(report.totals.refunds, 118);
  assert.equal(report.totals.net, 354);
  assert.equal(report.totals.items, 3);
  assert.equal(report.totals.average, 236);

  const { rows: [{ daily }] } = await db.query('select public.sales_totals($1, $2) as daily', [period.start, period.end]);
  assert.deepEqual([report.totals.gross, report.totals.refunds, report.totals.net, report.totals.orders], [daily.gross, daily.refunds, daily.net, daily.orders]);
  assert.equal(report.trend.at(-1).revenue, 354);

  const byName = Object.fromEntries(report.products.map((row) => [row.name, row]));
  assert.deepEqual([byName.Hammer.qty, byName.Hammer.revenue], [2, 236]);
  assert.deepEqual([byName.Roller.qty, byName.Roller.revenue], [1, 118]);
  assert.equal(report.categories.reduce((sum, row) => sum + row.revenue, 0), report.totals.net);

  assert.equal((await sales(period, 'day', 'Paint')).totals.net, 118);
  assert.equal((await sales(period, 'day', null, roller)).totals.items, 1);
  assert.equal((await sales(period, 'day', 'No Such')).totals.net, 0);

  const { rows: [{ pay }] } = await db.query('select public.report_payments($1) as pay', [period]);
  const method = (code) => pay.methods.find((row) => row.method === code);
  assert.deepEqual([method('Cash').collected, method('Cash').refunds], [354, 118]);
  assert.equal(method('Card').collected, 118);
  assert.equal(pay.totals.collected, 472);
  assert.equal(pay.totals.net, report.totals.net);
  assert.equal(pay.trend.at(-1).revenue, 354);
});

test('a refund counts in the period it was refunded, not when sold', async () => {
  const period = await today();
  const before = await sales(period);
  const item = await product('Old', tools);
  const old = await sell([[item, 1]]);
  await db.query(`update public.payments set created_at = now() - interval '3 days' where sale_id = $1`, [old.id]);
  await db.query(`update public.sales set created_at = now() - interval '3 days' where id = $1`, [old.id]);
  const after = await sales(period);
  assert.equal(after.totals.net, before.totals.net);
  const { rows: [line] } = await db.query('select id from public.sale_items where sale_id = $1', [old.id]);
  await db.query('select public.refund_sale($1, $2)', [{ clientRequestId: randomUUID(), saleId: old.id, method: 'Cash', reason: 'late', lines: [{ saleItemId: line.id, qty: 1, restock: false }] }, user]);
  const refunded = await sales(period);
  assert.equal(refunded.totals.net, before.totals.net - 118);
  assert.equal(refunded.totals.orders, before.totals.orders);
});

test('groups roll days up, and empty periods still appear', async () => {
  const days = await sales(await periodFor('custom', '2026-01-01', '2026-01-10'));
  assert.equal(days.trend.length, 10);
  assert.ok(days.trend.every((row) => row.revenue === 0));
  const weeks = await sales(await periodFor('custom', '2026-01-01', '2026-01-20'), 'week');
  assert.deepEqual(weeks.trend.map((row) => row.date), ['2025-12-29', '2026-01-05', '2026-01-12', '2026-01-19']);
  const months = await sales(await periodFor('custom', '2026-01-15', '2026-03-02'), 'month');
  assert.deepEqual(months.trend.map((row) => row.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
  const years = await sales(await periodFor('custom', '2025-06-01', '2026-02-01'), 'year');
  assert.deepEqual(years.trend.map((row) => row.date), ['2025-01-01', '2026-01-01']);
});

test('inventory figures cover active products only', async () => {
  const empty = await product('Empty', paint, { openingStock: 0, minStock: 2 });
  const low = await product('Low', paint, { openingStock: 2, minStock: 5 });
  const hidden = await product('Hidden', paint, { openingStock: 1000, costPrice: 1000 });
  await db.query('update public.products set active = false where id = $1', [hidden]);
  assert.ok(empty && low);
  const { rows: [{ r }] } = await db.query('select public.report_inventory() as r');
  const { rows: [{ count, value }] } = await db.query('select count(*)::int as count, sum(round(stock_qty * cost_price, 2))::numeric as value from public.products where active');
  assert.equal(r.products, count);
  assert.equal(r.value, Number(value));
  assert.ok(r.low >= 1);
  assert.ok(r.out >= 1);
  assert.ok(r.categories.some((row) => row.category === 'Paint'));
});

test('stock totals separate movements in and out', async () => {
  const item = await product('Mover', tools, { openingStock: 10 });
  await sell([[item, 3]]);
  const period = await today();
  const { rows: [{ r }] } = await db.query('select public.report_stock_totals($1, $2, null) as r', [period, item]);
  assert.deepEqual(r, { stockIn: 10, stockOut: 3 });
  const { rows: [{ s }] } = await db.query(`select public.report_stock_totals($1, $2, 'Sale') as s`, [period, item]);
  assert.deepEqual(s, { stockIn: 0, stockOut: 3 });
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['report_period(text, date, date, timestamptz)', 'report_sales(jsonb, text, text, uuid)', 'report_payments(jsonb)', 'report_inventory()', 'report_stock_totals(jsonb, uuid, text)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
