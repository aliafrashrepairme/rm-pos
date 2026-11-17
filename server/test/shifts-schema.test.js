import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql', '0010_customers.sql', '0011_reports.sql', '0012_users_settings.sql', '0013_invoice_scans.sql', '0014_import_lists.sql', '0015_shifts.sql'];

let db;
let product;
let counters;

async function person(role) {
  const id = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [id]);
  const tag = id.slice(0, 8);
  await db.query('insert into public.profiles (id, username, full_name, email, role_code) values ($1, $2, $3, $4, $5)', [id, `u${tag}`, tag, `${tag}@x.lk`, role]);
  return id;
}
const open = async (user, counter = counters.pop(), cash = 1000) => (await db.query('select public.open_shift($1, $2, $3) as id', [counter, cash, user])).rows[0].id;
const figures = async (shift) => (await db.query('select public.shift_figures($1) as f', [shift])).rows[0].f;
const expense = (body, user) => db.query('select public.add_expense($1, $2) as r', [body, user]);
const sell = async (user, method = 'Cash') => (await db.query('select public.create_sale($1, $2) as r', [{
  clientRequestId: randomUUID(),
  items: [{ productId: product, qty: 1 }],
  expectedTotal: 118,
  payment: method === 'Cash' ? { method, amountTendered: 200 } : { method }
}, user])).rows[0].r;

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of MIGRATIONS) await db.exec(await read(file));
  const manager = await person('Manager');
  const category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  const tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  product = (await db.query('select public.create_product($1, $2) as id', [{ name: 'Item', categoryId: category, unitCode: 'Piece', taxRateId: tax, sellingPrice: 100, openingStock: 500 }, manager])).rows[0].id;
  for (let index = 2; index <= 12; index += 1) await db.query('insert into public.counters (name) values ($1) on conflict do nothing', [`Counter ${index + 10}`]);
  counters = (await db.query('select id from public.counters')).rows.map((row) => row.id);
});

test('expected cash is the float plus cash sales, less cash refunds and cash expenses', async () => {
  const cashier = await person('Cashier');
  const shift = await open(cashier);
  const first = await sell(cashier, 'Cash');
  await sell(cashier, 'Card');
  const voided = await sell(cashier, 'Cash');
  await db.query('select public.void_sale($1, $2, $3)', [voided.id, 'mistake', cashier]);
  await expense({ category: 'Other', description: 'Tea', amount: 30, paidFromCash: true, shiftId: shift }, cashier);
  await expense({ category: 'Other', description: 'Bank paid', amount: 500, paidFromCash: false, shiftId: shift }, cashier);
  const { rows: [line] } = await db.query('select id from public.sale_items where sale_id = $1', [first.id]);
  await db.query('select public.refund_sale($1, $2)', [{ clientRequestId: randomUUID(), saleId: first.id, method: 'Cash', reason: 'x', lines: [{ saleItemId: line.id, qty: 1, restock: true }] }, cashier]);
  const result = await figures(shift);
  assert.equal(result.bills, 2);
  assert.equal(result.sales, 236);
  assert.deepEqual(result.byMethod, { Cash: 118, Card: 118 });
  assert.equal(result.cashSales, 118);
  assert.equal(result.cashRefunds, 118);
  assert.equal(result.cashExpenses, 30);
  assert.equal(result.expenses, 530);
  assert.equal(result.expectedCash, 970);
});

test('a card refund does not take cash from the drawer', async () => {
  const cashier = await person('Cashier');
  const shift = await open(cashier);
  const sale = await sell(cashier, 'Card');
  const { rows: [line] } = await db.query('select id from public.sale_items where sale_id = $1', [sale.id]);
  await db.query('select public.refund_sale($1, $2)', [{ clientRequestId: randomUUID(), saleId: sale.id, method: 'Card', reason: 'x', lines: [{ saleItemId: line.id, qty: 1, restock: true }] }, cashier]);
  assert.equal((await figures(shift)).expectedCash, 1000);
});

test('a refund after its shift closed comes from the refunder\'s drawer', async () => {
  const cashier = await person('Cashier');
  const shift = await open(cashier);
  const sale = await sell(cashier, 'Cash');
  await db.query('select public.close_shift($1, $2, $3)', [shift, 1118, cashier]);
  const other = await person('Cashier');
  const drawer = await open(other);
  const { rows: [line] } = await db.query('select id from public.sale_items where sale_id = $1', [sale.id]);
  await db.query('select public.refund_sale($1, $2)', [{ clientRequestId: randomUUID(), saleId: sale.id, method: 'Cash', reason: 'x', lines: [{ saleItemId: line.id, qty: 1, restock: true }] }, other]);
  assert.equal((await figures(drawer)).expectedCash, 882);
  assert.equal((await figures(shift)).expectedCash, 1118);
});

test('one open shift per person and per counter', async () => {
  const [one, two] = [await person('Cashier'), await person('Cashier')];
  const counter = counters.pop();
  await open(one, counter);
  await assert.rejects(() => open(one), /shifts_one_open_per_cashier/);
  await assert.rejects(() => open(two, counter), /shifts_one_open_per_counter/);
});

test('bad values are refused', async () => {
  const cashier = await person('Cashier');
  await assert.rejects(() => open(cashier, counters.at(-1), -5), /opening cash/);
  await assert.rejects(() => open(cashier, randomUUID()), /counter/);
});

test('closing fixes the figures, records the variance and cannot repeat', async () => {
  const cashier = await person('Cashier');
  const shift = await open(cashier);
  await sell(cashier, 'Cash');
  const { rows: [{ r }] } = await db.query('select public.close_shift($1, $2, $3) as r', [shift, 1100, cashier]);
  assert.equal(r.expected, 1118);
  assert.equal(r.variance, -18);
  const { rows: [row] } = await db.query('select status, expected_cash, counted_cash, closed_by from public.shifts where id = $1', [shift]);
  assert.deepEqual([row.status, Number(row.expected_cash), Number(row.counted_cash), row.closed_by], ['Closed', 1118, 1100, cashier]);
  await assert.rejects(() => db.query('select public.close_shift($1, $2, $3)', [shift, 1100, cashier]), /already closed/);
  await assert.rejects(() => db.query('select public.close_shift($1, $2, $3)', [randomUUID(), 1, cashier]), /not found/);
});

test('a sale after closing is not added to the old shift', async () => {
  const cashier = await person('Cashier');
  const shift = await open(cashier);
  await db.query('select public.close_shift($1, $2, $3)', [shift, 1000, cashier]);
  const sale = await sell(cashier, 'Cash');
  const { rows: [row] } = await db.query('select shift_id from public.sales where id = $1', [sale.id]);
  assert.equal(row.shift_id, null);
});

test('expense rules', async () => {
  const cashier = await person('Cashier');
  const noShift = { category: 'Other', description: 'x', amount: 10 };
  await assert.rejects(() => expense(noShift, cashier), /need an open shift/);
  const { rows: [{ r }] } = await expense({ ...noShift, paidFromCash: false }, cashier);
  assert.match(r.expenseNo, /^EXP-/);
  await assert.rejects(() => expense({ ...noShift, amount: 0, paidFromCash: false }, cashier), /valid amount/);
  const shift = await open(cashier);
  await db.query('select public.close_shift($1, $2, $3)', [shift, 1000, cashier]);
  await assert.rejects(() => expense({ ...noShift, shiftId: shift }, cashier), /not open/);
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['shift_figures(uuid)', 'open_shift(uuid, numeric, uuid)', 'close_shift(uuid, numeric, uuid)', 'add_expense(jsonb, uuid)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
