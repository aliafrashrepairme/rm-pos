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

// One unit at 1000 (no tax) for a walk-in, with a coupon.
async function sell(couponCode, total) {
  const { r } = await one('select public.create_sale($1, $2) as r', [{
    clientRequestId: randomUUID(), items: [{ productId: item, qty: 1 }], couponCode, expectedTotal: total,
    payment: { method: 'Cash', amountTendered: total }
  }, user]);
  return one('select discount_label, coupon_code, grand_total from public.sales where id = $1', [r.id]);
}

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
  await db.query(`insert into public.coupons (code, rate, description, valid_from, valid_until) values
    ('ALWAYS5', 0.05, 'No dates', null, null),
    ('NOW10', 0.10, 'Today only', public.shop_today(), public.shop_today()),
    ('OLD15', 0.15, 'Ended yesterday', null, public.shop_today() - 1),
    ('SOON20', 0.20, 'Starts tomorrow', public.shop_today() + 1, null)`);
});

test('a coupon without dates, and one valid today, apply at the till', async () => {
  assert.equal((await sell('ALWAYS5', 950)).discount_label, 'Coupon ALWAYS5');
  assert.equal((await sell('NOW10', 900)).discount_label, 'Coupon NOW10');
});

test('an ended or not-yet-started coupon is refused like an unknown code', async () => {
  await assert.rejects(sell('OLD15', 850), /not valid/);
  await assert.rejects(sell('SOON20', 800), /not valid/);
});

test('a switched-off coupon is refused', async () => {
  await db.query(`update public.coupons set active = false where code = 'ALWAYS5'`);
  await assert.rejects(sell('ALWAYS5', 950), /not valid/);
});

test('the end date cannot be before the start date', async () => {
  await assert.rejects(db.query(`insert into public.coupons (code, rate, valid_from, valid_until) values ('BAD', 0.1, '2026-12-10', '2026-12-01')`), /coupons_dates_check/);
});

test('only the Manager may manage coupons', async () => {
  const { rows } = await db.query(`select role_code from public.role_permissions where permission_code = 'coupons.manage'`);
  assert.deepEqual(rows.map((row) => row.role_code), ['Manager']);
});
