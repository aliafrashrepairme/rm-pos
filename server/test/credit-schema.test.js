import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';

let db;
let user;
let category;
let zeroTax;
let vat;

async function product(name, { price = 1000, cost = 800, stock = 100, taxId = zeroTax } = {}) {
  return (await db.query('select public.create_product($1, $2) as id', [{
    name, categoryId: category, unitCode: 'Piece', taxRateId: taxId, costPrice: cost, sellingPrice: price, openingStock: stock
  }, user])).rows[0].id;
}

async function customer(name, { points = 0, limit = 0, purchases = 0 } = {}) {
  const id = (await db.query(`insert into public.customers (code, name, loyalty_points, credit_limit, purchase_count)
    values ($1, $2, $3, $4, $5) returning id`, [`C-${randomUUID().slice(0, 8)}`, name, points, limit, purchases])).rows[0].id;
  return id;
}

async function sell(items, { total, customerId = null, method = 'Cash', tendered, points = 0 } = {}) {
  return (await db.query('select public.create_sale($1, $2) as r', [{
    clientRequestId: randomUUID(), items, customerId, expectedTotal: total, pointsToRedeem: points,
    payment: { method, amountTendered: tendered ?? null }
  }, user])).rows[0].r;
}

const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const who = (id) => one('select loyalty_points, credit_balance, credit_limit from public.customers where id = $1', [id]);
const paymentsOf = async (saleId) => (await db.query('select method_code, amount from public.payments where sale_id = $1 order by method_code', [saleId]))
  .rows.map((row) => [row.method_code, Number(row.amount)]);
const lineOf = async (saleId) => (await one('select id from public.sale_items where sale_id = $1', [saleId])).id;
const refund = async (saleId, qty, method = 'Cash') => (await db.query('select public.refund_sale($1, $2) as r', [{
  clientRequestId: randomUUID(), saleId, reason: 'Return', method, lines: [{ saleItemId: await lineOf(saleId), qty }]
}, user])).rows[0].r;

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  await db.exec((await bundleMigrations()).sql);
  user = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [user]);
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test', 't@example.com', 'Cashier')`, [user]);
  category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  zeroTax = (await one('select id from public.tax_rates where rate = 0')).id;
  vat = (await one('select id from public.tax_rates where is_default')).id;
});

test('points pay part of a bill, capped at the profit so nothing is sold below cost', async () => {
  // Price 1000, cost 800: at most 200 points on one unit.
  const item = await product('Drill');
  const buyer = await customer('Saman', { points: 500 });
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 1000, customerId: buyer, points: 201, tendered: 1000 }), /Only 200 points/);
  const { rows: [{ cap }] } = await db.query('select public.points_cap($1, 0) as cap', [[{ productId: item, qty: 2 }]]);
  assert.equal(cap, 400);

  const sale = await sell([{ productId: item, qty: 1 }], { total: 1000, customerId: buyer, points: 200, tendered: 800 });
  assert.deepEqual(await paymentsOf(sale.id), [['Cash', 800], ['Loyalty points', 200]]);
  const row = await one('select grand_total, points_redeemed, points_earned from public.sales where id = $1', [sale.id]);
  assert.equal(Number(row.grand_total), 1000, 'the bill value and VAT are unchanged');
  assert.equal(row.points_redeemed, 200);
  assert.equal(row.points_earned, 8, 'points are earned only on the LKR 800 paid');
  assert.equal((await who(buyer)).loyalty_points, 500 - 200 + 8);
});

test('points need a known customer and cannot exceed their balance', async () => {
  const item = await product('Saw', { price: 1000, cost: 100 });
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 1000, points: 10, tendered: 1000 }), /Choose the customer/);
  const poor = await customer('Kamal', { points: 50 });
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 1000, customerId: poor, points: 60, tendered: 1000 }), /Only 50 points/);
  // A bill paid fully in points takes no other payment and earns nothing.
  const cheap = await product('Washer', { price: 40, cost: 0 });
  const sale = await sell([{ productId: cheap, qty: 1 }], { total: 40, customerId: poor, points: 40 });
  assert.deepEqual(await paymentsOf(sale.id), [['Loyalty points', 40]]);
  assert.equal((await who(poor)).loyalty_points, 10);
});

test('the points method cannot be chosen by hand', async () => {
  const item = await product('Tape');
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 1000, method: 'Loyalty points' }), /valid payment method/);
});

test('credit sales respect the limit and build up the balance', async () => {
  const item = await product('Cement', { price: 2000, cost: 1500 });
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 2000, method: 'Credit' }), /Choose the customer to sell on credit/);
  const builder = await customer('Builder', { limit: 5000 });
  await sell([{ productId: item, qty: 2 }], { total: 4000, customerId: builder, method: 'Credit' });
  assert.equal(Number((await who(builder)).credit_balance), 4000);
  // A returning customer gets the 3% Bronze offer, so this bill is 1940.
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 1940, customerId: builder, method: 'Credit' }), /credit limit\. Available credit: 1000/);

  const noLimit = await customer('New');
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 2000, customerId: noLimit, method: 'Credit' }), /credit limit/);

  const entries = (await db.query('select kind, amount, balance_after from public.customer_credit_entries where customer_id = $1', [builder])).rows;
  assert.deepEqual(entries.map((row) => [row.kind, Number(row.amount), Number(row.balance_after)]), [['Sale', 4000, 4000]]);
  await assert.rejects(() => db.query('delete from public.customer_credit_entries where customer_id = $1', [builder]), /cannot be changed/);
});

test('repayments lower the balance, and cash ones count in the collector\'s shift', async () => {
  const item = await product('Sand', { price: 1000, cost: 500 });
  const buyer = await customer('Ruwan', { limit: 10000 });
  await sell([{ productId: item, qty: 3 }], { total: 3000, customerId: buyer, method: 'Credit' });

  const counter = (await one('select id from public.counters limit 1')).id;
  const shift = (await one('select public.open_shift($1, 1000, $2) as id', [counter, user])).id;
  const pay = async (amount, method = 'Cash', reference = '') => (await one('select public.record_credit_payment($1, $2) as r', [{ customerId: buyer, amount, method, reference }, user])).r;

  await assert.rejects(() => pay(5000), /only owes 3000/);
  await assert.rejects(() => pay(100, 'Credit'), /valid payment method/);
  await assert.rejects(() => pay(100, 'Bank transfer'), /reference/);
  const result = await pay(1200);
  assert.equal(Number(result.balance), 1800);
  assert.equal(result.inShift, true);
  await pay(300, 'Card');

  const figures = (await one('select public.shift_figures($1) as f', [shift])).f;
  assert.equal(Number(figures.cashCollected), 1200, 'card repayments are not drawer cash');
  assert.equal(Number(figures.creditCollected), 1500);
  assert.equal(Number(figures.expectedCash), 1000 + 1200);
  assert.equal(Number((await who(buyer)).credit_balance), 1500);
  await db.query('select public.close_shift($1, 2200, $2)', [shift, user]);
});

test('voiding gives back points and removes the credit', async () => {
  const item = await product('Pipe', { price: 1000, cost: 500 });
  const buyer = await customer('Void', { points: 300, limit: 5000 });
  const sale = await sell([{ productId: item, qty: 1 }], { total: 1000, customerId: buyer, method: 'Credit', points: 300 });
  assert.equal(Number((await who(buyer)).credit_balance), 700);
  await db.query('select public.void_sale($1, $2, $3)', [sale.id, 'Mistake', user]);
  const after = await who(buyer);
  assert.equal(after.loyalty_points, 300);
  assert.equal(Number(after.credit_balance), 0);

  // Once some of the credit is repaid, only a refund can undo the bill.
  const second = await sell([{ productId: item, qty: 1 }], { total: 1000, customerId: buyer, method: 'Credit' });
  await db.query('select public.record_credit_payment($1, $2)', [{ customerId: buyer, amount: 500, method: 'Card' }, user]);
  await assert.rejects(() => db.query('select public.void_sale($1, $2, $3)', [second.id, 'Late', user]), /Use a refund/);
});

test('refunds return spent points first and pay out only the rest', async () => {
  const item = await product('Tiles', { price: 1000, cost: 500 });
  const buyer = await customer('Refund', { points: 1000 });
  const sale = await sell([{ productId: item, qty: 2 }], { total: 2000, customerId: buyer, points: 1000, tendered: 1000 });
  assert.equal((await who(buyer)).loyalty_points, 10);

  const half = await refund(sale.id, 1);
  assert.equal(half.pointsReturned, 500);
  assert.equal(Number(half.paidOut), 500);
  const last = await refund(sale.id, 1);
  assert.equal(last.pointsReturned, 500, 'the last refund gives back whatever is left');
  assert.equal(Number(last.paidOut), 500);
  assert.equal((await who(buyer)).loyalty_points, 1000, 'earned points reversed, spent points restored');
  await assert.rejects(() => refund(sale.id, 1, 'Loyalty points'), /valid refund method|already been fully refunded/);
});

test('a credit bill can be refunded to credit, but not below zero', async () => {
  const item = await product('Paint', { price: 1000, cost: 500, taxId: vat });
  const buyer = await customer('Credit refund', { limit: 10000 });
  const sale = await sell([{ productId: item, qty: 2 }], { total: 2360, customerId: buyer, method: 'Credit' });
  await refund(sale.id, 1, 'Credit');
  assert.equal(Number((await who(buyer)).credit_balance), 1180);
  await db.query('select public.record_credit_payment($1, $2)', [{ customerId: buyer, amount: 1000, method: 'Card' }, user]);
  await assert.rejects(() => refund(sale.id, 1, 'Credit'), /only owes 180/);

  const walkIn = await sell([{ productId: item, qty: 1 }], { total: 1180, tendered: 1180 });
  await assert.rejects(() => refund(walkIn.id, 1, 'Credit'), /customer's bill/);
});

test('only a Manager sets limits, and limits are validated', async () => {
  const buyer = await customer('Limit');
  await assert.rejects(() => db.query('select public.set_credit_limit($1, -1)', [buyer]), /valid credit limit/);
  const result = (await one('select public.set_credit_limit($1, 25000) as r', [buyer])).r;
  assert.equal(Number(result.to), 25000);
  const holders = async (permission) => (await db.query('select role_code from public.role_permissions where permission_code = $1 order by role_code', [permission])).rows.map((row) => row.role_code);
  assert.deepEqual(await holders('credit.manage'), ['Manager']);
  assert.deepEqual(await holders('credit.collect'), ['Cashier', 'Manager']);
});

test('supplier credit shows what is owed and when it is due', async () => {
  const supplier = (await one(`select public.create_supplier($1) as id`, [{ name: 'Lanka Hardware' }])).id;
  await db.query(`update public.suppliers set payment_terms = 'Credit 30 days' where id = $1`, [supplier]);
  const item = await product('Bolt', { price: 50, cost: 20 });
  const po = (await one('select public.create_purchase($1, $2) as id', [{ supplierId: supplier, status: 'Ordered', items: [{ productId: item, qty: 10, unitCost: 20 }] }, user])).id;
  await db.query(`update public.purchases set ordered_at = now() - interval '40 days' where id = $1`, [po]);
  await db.query('select public.pay_supplier($1, $2)', [{ purchaseId: po, amount: 50, method: 'Cash' }, user]);

  const rows = (await one('select public.supplier_payables() as r')).r;
  const row = rows.find((entry) => entry.id === po);
  assert.equal(Number(row.balance), 150);
  assert.equal(row.daysOverdue, 10);
  assert.equal(row.terms, 'Credit 30 days');
});

test('only the API reaches the credit ledger and functions', async () => {
  const { rows: [table] } = await db.query(`select has_table_privilege('anon', 'public.customer_credit_entries', 'select') as anon,
    (select relrowsecurity from pg_class where oid = 'public.customer_credit_entries'::regclass) as rls`);
  assert.deepEqual(table, { anon: false, rls: true });
  for (const signature of ['record_credit_payment(jsonb, uuid)', 'set_credit_limit(uuid, numeric)', 'supplier_payables()', 'points_cap(jsonb, numeric)', 'create_sale(jsonb, uuid)']) {
    const { rows: [row] } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(row, { anon: false, api: true }, signature);
  }
});
