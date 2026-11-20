import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';

let db;
let user;
let item;

const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];

async function customer(name, { points = 0, purchases = 0 } = {}) {
  return (await one(`insert into public.customers (code, name, loyalty_points, purchase_count)
    values ($1, $2, $3, $4) returning id`, [`C-${randomUUID().slice(0, 8)}`, name, points, purchases])).id;
}

// Sells one unit at 1000 (no tax) and returns how the sale was priced.
async function sell(customerId, total, couponCode = null) {
  const { r } = await one('select public.create_sale($1, $2) as r', [{
    clientRequestId: randomUUID(), items: [{ productId: item, qty: 1 }], customerId, couponCode, expectedTotal: total,
    payment: { method: 'Cash', amountTendered: total }
  }, user]);
  return one('select discount_label, coupon_code, grand_total, points_earned from public.sales where id = $1', [r.id]);
}

const setRule = (changes) => db.query(`update public.store_settings set
  regular_discount_enabled = coalesce($1, regular_discount_enabled),
  regular_min_visits = coalesce($2, regular_min_visits),
  regular_discount_rate = coalesce($3, regular_discount_rate)`, [changes.enabled ?? null, changes.visits ?? null, changes.rate ?? null]);

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
  const category = (await one(`insert into public.categories (name) values ('Tools') returning id`)).id;
  const zeroTax = (await one('select id from public.tax_rates where rate = 0')).id;
  item = (await one('select public.create_product($1, $2) as id', [{
    name: 'Hammer', categoryId: category, unitCode: 'Piece', taxRateId: zeroTax, costPrice: 500, sellingPrice: 1000, openingStock: 500
  }, user])).id;
});

test('the rule starts on: 5 purchases in 90 days earn 5%', async () => {
  const rule = await one('select regular_discount_enabled, regular_min_visits, regular_period_days, regular_discount_rate from public.store_settings');
  assert.deepEqual(rule, { regular_discount_enabled: true, regular_min_visits: 5, regular_period_days: 90, regular_discount_rate: '0.0500' });
});

test('after 5 recent purchases a customer gets the regular rate instead of Bronze', async () => {
  const id = await customer('Regular Ravi');
  assert.equal((await sell(id, 1000)).discount_label, '');
  for (let visit = 2; visit <= 5; visit += 1) assert.equal((await sell(id, 970)).discount_label, 'Bronze member offer');
  const sixth = await sell(id, 950);
  assert.equal(sixth.discount_label, 'Regular customer offer');
  assert.equal(Number(sixth.grand_total), 950);
  assert.equal((await one('select public.recent_visits($1, 90) as n', [id])).n, 6);
});

test('switched off, or with old purchases, the member offer applies again', async () => {
  const id = await customer('Lapsed Lal');
  await sell(id, 1000);
  for (let visit = 2; visit <= 5; visit += 1) await sell(id, 970);
  await setRule({ enabled: false });
  assert.equal((await sell(id, 970)).discount_label, 'Bronze member offer');
  await setRule({ enabled: true });
  await db.query(`update public.sales set created_at = now() - interval '100 days' where customer_id = $1`, [id]);
  assert.equal((await sell(id, 970)).discount_label, 'Bronze member offer');
});

test('voided bills do not count as visits', async () => {
  const id = await customer('Voided Vimal');
  await sell(id, 1000);
  for (let visit = 2; visit <= 5; visit += 1) await sell(id, 970);
  await db.query(`update public.sales set status = 'Voided', voided_at = now() where id = (
    select id from public.sales where customer_id = $1 order by created_at desc limit 1)`, [id]);
  assert.equal((await sell(id, 970)).discount_label, 'Bronze member offer');
});

test('only the best offer applies: a bigger coupon wins, a smaller one gives way', async () => {
  const id = await customer('Coupon Chamari');
  await sell(id, 1000);
  for (let visit = 2; visit <= 5; visit += 1) await sell(id, 970);
  await db.query(`insert into public.coupons (code, rate, description) values ('SMALL2', 0.02, 'Two'), ('BIG10', 0.10, 'Ten')`);
  const small = await sell(id, 950, 'SMALL2');
  assert.equal(small.discount_label, 'Regular customer offer');
  assert.equal(small.coupon_code, null);
  const big = await sell(id, 900, 'BIG10');
  assert.equal(big.discount_label, 'Coupon BIG10');
  assert.equal(big.coupon_code, 'BIG10');
});

test('Gold beats a smaller regular rate, and keeps double points under a bigger one', async () => {
  const id = await customer('Gold Gayan', { points: 1200, purchases: 20 });
  for (let visit = 1; visit <= 5; visit += 1) assert.equal((await sell(id, 930)).discount_label, 'Gold member offer');
  await setRule({ rate: 0.1 });
  const sale = await sell(id, 900);
  assert.equal(sale.discount_label, 'Regular customer offer');
  assert.equal(sale.points_earned, 18);
  await setRule({ rate: 0.05 });
});

test('the settings refuse values outside the allowed range', async () => {
  await assert.rejects(setRule({ visits: 0 }), /check/);
  await assert.rejects(setRule({ rate: 0.6 }), /check/);
});
