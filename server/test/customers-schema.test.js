import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql', '0010_customers.sql'];

let db;
let user;

const add = async (details) => (await db.query('select public.add_customer($1) as id', [details])).rows[0].id;
const stats = async (id) => (await db.query('select public.customer_stats($1) as s', [id])).rows[0].s;

async function bill(customerId, { status = 'Paid', total = 100 } = {}) {
  const id = randomUUID();
  await db.query(`insert into public.sales (id, bill_no, client_request_id, customer_id, customer_name, cashier_id, subtotal, grand_total, status, voided_at, voided_by, void_reason)
    values ($1, $2, $3, $4, 'C', $5, $6, $6, 'Paid', null, null, null)`, [id, `B-${id.slice(0, 8)}`, randomUUID(), customerId, user, total]);
  if (status === 'Voided') await db.query(`update public.sales set status = 'Voided', voided_at = now(), voided_by = $2, void_reason = 'x' where id = $1`, [id, user]);
  return id;
}

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
});

test('a customer is saved with trimmed details and a CUS code', async () => {
  const id = await add({ name: '  Ravi  ', phone: ' 0771 ', email: ' r@x.lk ', address: ' Main St ', loyaltyPoints: 250 });
  const { rows: [row] } = await db.query('select * from public.customers where id = $1', [id]);
  assert.equal(row.name, 'Ravi');
  assert.equal(row.phone, '0771');
  assert.equal(row.email, 'r@x.lk');
  assert.equal(row.address, 'Main St');
  assert.equal(row.loyalty_points, 250);
  assert.equal(row.purchase_count, 0);
  assert.match(row.code, /^CUS-/);
});

test('figures leave out voided bills and take off refunds', async () => {
  const id = await add({ name: 'Figures' });
  assert.deepEqual(await stats(id), { bills: 0, purchased: 0, refunded: 0, spent: 0, lastPurchaseAt: null });
  const paid = await bill(id, { total: 300 });
  await bill(id, { total: 200 });
  await bill(id, { total: 999, status: 'Voided' });
  await db.query(`insert into public.refunds (refund_no, client_request_id, sale_id, method_code, reason, total, created_by) values ('RF-T', $1, $2, 'Cash', 'x', 50, $3)`, [randomUUID(), paid, user]);
  const figures = await stats(id);
  assert.equal(figures.bills, 2);
  assert.equal(figures.purchased, 500);
  assert.equal(figures.refunded, 50);
  assert.equal(figures.spent, 450);
  assert.ok(figures.lastPurchaseAt);
});

test('active customers cannot share a phone, but blanks and retired numbers can', async () => {
  const first = await add({ name: 'One', phone: '0770000001' });
  await assert.rejects(() => add({ name: 'Two', phone: '0770000001' }), /customers_active_phone_key/);
  await add({ name: 'Blank A' });
  await add({ name: 'Blank B' });
  await db.query('update public.customers set active = false where id = $1', [first]);
  await add({ name: 'Three', phone: '0770000001' });
  await assert.rejects(() => db.query('update public.customers set active = true where id = $1', [first]), /customers_active_phone_key/);
});

test('only the Manager role can set opening points', async () => {
  const { rows } = await db.query(`select role_code from public.role_permissions where permission_code = 'customers.points'`);
  assert.deepEqual(rows.map((row) => row.role_code), ['Manager']);
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['add_customer(jsonb)', 'customer_stats(uuid)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
