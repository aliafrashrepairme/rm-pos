import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql'];

let db;
let user;
let category;
let tax;
let zeroTax;

async function product(name, { price = 100, cost = 60, stock = 50, rate = tax, unit = 'Piece' } = {}) {
  return (await db.query('select public.create_product($1, $2) as id', [{ name, categoryId: category, unitCode: unit, taxRateId: rate, costPrice: cost, sellingPrice: price, openingStock: stock }, user])).rows[0].id;
}

async function sell(items, total, { customerId } = {}) {
  const { rows } = await db.query('select public.create_sale($1, $2) as r', [
    { clientRequestId: randomUUID(), items, expectedTotal: total, customerId, payment: { method: 'Card' } }, user
  ]);
  return rows[0].r.id;
}

const itemsOf = async (saleId) => (await db.query('select * from public.sale_items where sale_id = $1 order by line_no', [saleId])).rows;
const stock = async (id) => Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty);
const saleRow = async (id) => (await db.query('select * from public.sales where id = $1', [id])).rows[0];
const customerRow = async (id) => (await db.query('select loyalty_points, purchase_count from public.customers where id = $1', [id])).rows[0];

async function refund(saleId, lines, { requestId = randomUUID(), reason = 'Faulty', method = 'Cash' } = {}) {
  const { rows } = await db.query('select public.refund_sale($1, $2) as r', [{ clientRequestId: requestId, saleId, reason, method, lines }, user]);
  return rows[0].r;
}
const voidSale = (id, reason = 'Mistake') => db.query('select public.void_sale($1, $2, $3)', [id, reason, user]);

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
  category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  zeroTax = (await db.query('select id from public.tax_rates where rate = 0')).rows[0].id;
});

test('a void returns all stock, reverses points and is recorded', async () => {
  const item = await product('Void me', { stock: 10, rate: zeroTax, price: 1000 });
  const customerId = (await db.query(`select public.create_customer('C', '071') as id`)).rows[0].id;
  const id = await sell([{ productId: item, qty: 3 }], 3000, { customerId });
  assert.equal(await stock(item), 7);
  assert.deepEqual(await customerRow(customerId), { loyalty_points: 30, purchase_count: 1 });

  await voidSale(id, 'Wrong customer');
  assert.equal(await stock(item), 10);
  assert.deepEqual(await customerRow(customerId), { loyalty_points: 0, purchase_count: 0 });
  const sale = await saleRow(id);
  assert.equal(sale.status, 'Voided');
  assert.equal(sale.void_reason, 'Wrong customer');
  assert.equal(sale.voided_by, user);
  const ledger = (await db.query(`select * from public.inventory_ledger where product_id = $1 and movement_type = 'Void'`, [item])).rows;
  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].change_qty), 3);
  assert.equal(ledger[0].reason, 'Wrong customer');
});

test('a bill can only be voided once, needs a reason, and not after a refund', async () => {
  const item = await product('Void rules', { stock: 10, rate: zeroTax });
  const id = await sell([{ productId: item, qty: 1 }], 100);
  await assert.rejects(() => voidSale(id, '  '), /Enter a reason/);
  await voidSale(id);
  await assert.rejects(() => voidSale(id), /Only an unrefunded paid bill/);
  assert.equal(await stock(item), 10);

  const refunded = await sell([{ productId: item, qty: 2 }], 200);
  const [line] = await itemsOf(refunded);
  await refund(refunded, [{ saleItemId: line.id, qty: 1 }]);
  await assert.rejects(() => voidSale(refunded), /Only an unrefunded paid bill/);
  await assert.rejects(() => voidSale(randomUUID()), /Bill not found/);
});

test('a partial refund returns that quantity and money, then the rest', async () => {
  const item = await product('Partial', { price: 1000, stock: 10 });
  const id = await sell([{ productId: item, qty: 4 }], 4720);
  const [line] = await itemsOf(id);

  const first = await refund(id, [{ saleItemId: line.id, qty: 1 }]);
  assert.equal(first.total, 1180);
  assert.equal(first.status, 'Partially Refunded');
  assert.match(first.refundNo, /^RF-\d{6}$/);
  assert.equal(await stock(item), 7);
  assert.equal((await saleRow(id)).status, 'Partially Refunded');

  await assert.rejects(() => refund(id, [{ saleItemId: line.id, qty: 4 }]), /Only 3\.000 of Partial can still be refunded/);
  assert.equal(await stock(item), 7);

  const last = await refund(id, [{ saleItemId: line.id, qty: 3 }]);
  assert.equal(last.total, 3540);
  assert.equal(last.status, 'Refunded');
  assert.equal(await stock(item), 10);
  await assert.rejects(() => refund(id, [{ saleItemId: line.id, qty: 1 }]), /already been fully refunded/);
});

test('refunds in pieces always add up to exactly what was paid', async () => {
  // 3 units at a price that divides unevenly, with VAT.
  const item = await product('Uneven', { price: 33.33, stock: 10 });
  const paid = 117.99;
  const id = await sell([{ productId: item, qty: 3 }], paid);
  const [line] = await itemsOf(id);
  const totals = [];
  for (let unit = 0; unit < 3; unit += 1) totals.push((await refund(id, [{ saleItemId: line.id, qty: 1 }])).total);
  assert.equal(Math.round(totals.reduce((sum, value) => sum + value, 0) * 100) / 100, paid, totals.join());
});

test('damaged goods are refunded without returning to stock', async () => {
  const item = await product('Damaged', { stock: 10, rate: zeroTax });
  const id = await sell([{ productId: item, qty: 2 }], 200);
  const [line] = await itemsOf(id);
  await refund(id, [{ saleItemId: line.id, qty: 2, restock: false }], { reason: 'Broken' });
  assert.equal(await stock(item), 8);
  assert.equal((await db.query(`select count(*)::int as n from public.inventory_ledger where product_id = $1 and movement_type = 'Refund'`, [item])).rows[0].n, 0);
  assert.equal((await saleRow(id)).status, 'Refunded');
});

test('a repeated refund request changes nothing', async () => {
  const item = await product('Retry refund', { stock: 10, rate: zeroTax });
  const id = await sell([{ productId: item, qty: 2 }], 200);
  const [line] = await itemsOf(id);
  const requestId = randomUUID();
  const first = await refund(id, [{ saleItemId: line.id, qty: 1 }], { requestId });
  const second = await refund(id, [{ saleItemId: line.id, qty: 1 }], { requestId });
  assert.equal(second.replayed, true);
  assert.equal(second.refundNo, first.refundNo);
  assert.equal(await stock(item), 9);
  assert.equal(Number((await itemsOf(id))[0].refunded_qty), 1);
});

test('refunds reverse loyalty points in proportion, exactly once in total', async () => {
  const item = await product('Points', { price: 1000, stock: 20, rate: zeroTax });
  const customerId = (await db.query(`select public.create_customer('P', '072') as id`)).rows[0].id;
  const id = await sell([{ productId: item, qty: 4 }], 4000, { customerId });
  const [line] = await itemsOf(id);
  assert.equal((await customerRow(customerId)).loyalty_points, 40);
  await refund(id, [{ saleItemId: line.id, qty: 1 }]);
  assert.equal((await customerRow(customerId)).loyalty_points, 30);
  await refund(id, [{ saleItemId: line.id, qty: 3 }]);
  assert.equal((await customerRow(customerId)).loyalty_points, 0);
  assert.equal((await saleRow(id)).points_reversed, 40);
});

test('bad refunds are refused and leave nothing behind', async () => {
  const item = await product('Bad refund', { stock: 10, rate: zeroTax });
  const wire = await product('Wire refund', { stock: 10, rate: zeroTax, unit: 'Metre' });
  const id = await sell([{ productId: item, qty: 2 }, { productId: wire, qty: 2.5 }], 450);
  const other = await sell([{ productId: item, qty: 1 }], 100);
  const [line, wireLine] = await itemsOf(id);
  const [otherLine] = await itemsOf(other);
  const before = (await db.query('select count(*)::int as n from public.refunds')).rows[0].n;
  await assert.rejects(() => refund(id, []), /at least one item/);
  await assert.rejects(() => refund(id, [{ saleItemId: line.id, qty: 0 }]), /valid refund quantity/);
  await assert.rejects(() => refund(id, [{ saleItemId: line.id, qty: 1.5 }]), /whole units/);
  await assert.rejects(() => refund(id, [{ saleItemId: otherLine.id, qty: 1 }]), /not on the bill/);
  await assert.rejects(() => refund(id, [{ saleItemId: line.id, qty: 1 }], { reason: '' }), /Enter a reason/);
  await assert.rejects(() => refund(id, [{ saleItemId: line.id, qty: 1 }], { method: 'Crypto' }), /valid refund method/);
  await assert.rejects(() => refund(randomUUID(), [{ saleItemId: line.id, qty: 1 }]), /Bill not found/);
  assert.equal((await db.query('select count(*)::int as n from public.refunds')).rows[0].n, before);
  assert.equal((await refund(id, [{ saleItemId: wireLine.id, qty: 0.5 }])).total, 50);
});

// A separate, empty store, so the figures below come only from this test.
test('daily and monthly figures use the store day and count refunds when paid', async () => {
  const fresh = new PGlite({ extensions: { pg_trgm } });
  await fresh.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of MIGRATIONS) await fresh.exec(await read(file));
  const owner = randomUUID();
  await fresh.query('insert into auth.users (id) values ($1)', [owner]);
  await fresh.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'xx1', 'X', 'x@example.com', 'Manager')`, [owner]);
  const cat = (await fresh.query(`insert into public.categories (name) values ('T') returning id`)).rows[0].id;
  const zero = (await fresh.query('select id from public.tax_rates where rate = 0')).rows[0].id;
  const item = (await fresh.query('select public.create_product($1, $2) as id', [{ name: 'I', categoryId: cat, unitCode: 'Piece', taxRateId: zero, costPrice: 60, sellingPrice: 100, openingStock: 500 }, owner])).rows[0].id;
  const sale = async (qty, at, status = 'Paid') => {
    const { rows } = await fresh.query('select public.create_sale($1, $2) as r', [{ clientRequestId: randomUUID(), items: [{ productId: item, qty }], expectedTotal: qty * 100, payment: { method: 'Card' } }, owner]);
    const id = rows[0].r.id;
    await fresh.query('update public.sales set created_at = $1 where id = $2', [at, id]);
    if (status === 'Voided') await fresh.query('select public.void_sale($1, $2, $3)', [id, 'x', owner]);
    return id;
  };
  // 15 March 2026, 09:30 in Sri Lanka.
  const now = '2026-03-15T04:00:00Z';
  const today = await sale(2, '2026-03-14T18:40:00Z'); // 00:10 on the 15th locally.
  await sale(1, '2026-03-14T18:20:00Z'); // 23:50 on the 14th locally.
  await sale(5, '2026-03-15T02:00:00Z', 'Voided');
  await sale(3, '2026-02-10T06:00:00Z');
  await sale(9, '2026-02-20T06:00:00Z');
  const [line] = (await fresh.query('select id from public.sale_items where sale_id = $1', [today])).rows;
  const { rows: [{ r: refunded }] } = await fresh.query('select public.refund_sale($1, $2) as r', [{ clientRequestId: randomUUID(), saleId: today, reason: 'x', method: 'Cash', lines: [{ saleItemId: line.id, qty: 1 }] }, owner]);
  await fresh.query('update public.refunds set created_at = $1 where id = $2', ['2026-03-15T03:00:00Z', refunded.id]);

  const daily = (await fresh.query('select public.transactions_daily($1, $2) as r', ['2026-03-15', now])).rows[0].r;
  assert.deepEqual(daily.day, { gross: 200, refunds: 100, net: 100, orders: 1 });
  assert.equal(daily.previous.net, 100);
  assert.equal(daily.refundCount, 1);
  assert.equal(daily.days.length, 14);
  assert.equal(daily.days[13].date, '2026-03-15');
  assert.equal(daily.days[13].total, 100);

  const future = (await fresh.query('select public.transactions_daily($1, $2) as r', ['2030-01-01', now])).rows[0].r;
  assert.equal(future.date, '2026-03-15', 'a future date falls back to today');

  const march = (await fresh.query('select public.transactions_monthly($1, $2, $3) as r', [2026, 3, now])).rows[0].r;
  assert.deepEqual(march.totals, { gross: 300, refunds: 100, net: 200, orders: 2 });
  assert.equal(march.isCurrent, true);
  assert.equal(march.previous.gross, 300, 'February up to the 15th only');
  assert.equal(march.days.length, 15);
  assert.equal(march.months.length, 12);
  assert.equal(march.months[11].total, 200);
  assert.equal(march.months[10].total, 1200);
  // Sold 3 at 40 profit = 120; one returned to stock gives back 40.
  assert.equal(march.grossProfit, 80);

  const february = (await fresh.query('select public.transactions_monthly($1, $2, $3) as r', [2026, 2, now])).rows[0].r;
  assert.equal(february.totals.net, 1200);
  assert.equal(february.isCurrent, false);
  assert.equal(february.days.length, 28);
  assert.equal(february.grossProfit, 480);
  await fresh.close();
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['void_sale(uuid, text, uuid)', 'refund_sale(jsonb, uuid)', 'transactions_daily(date, timestamptz)', 'transactions_monthly(integer, integer, timestamptz)', 'gross_profit(timestamptz, timestamptz)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('authenticated', 'public.${signature}', 'execute') as signed_in,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, signed_in: false, api: true }, signature);
  }
});
