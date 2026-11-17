import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql', '0010_customers.sql', '0011_reports.sql', '0012_users_settings.sql', '0013_invoice_scans.sql', '0014_import_lists.sql'];

let db;
let user;
let category;
let tax;

const count = async (table) => (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n;
const run = (type, rows) => db.query('select public.import_records($1, $2, $3) as n', [type, JSON.stringify(rows), user]);
const product = (name, extra = {}) => ({ name, categoryId: category, unitCode: 'Piece', taxRateId: tax, sellingPrice: 10, ...extra });

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
});

test('products import with stock through the ledger', async () => {
  const { rows } = await run('products', [product('Import A', { openingStock: 7, sku: 'IMP-A' }), product('Import B')]);
  assert.equal(rows[0].n, 2);
  const { rows: [a] } = await db.query(`select id, stock_qty from public.products where sku = 'IMP-A'`);
  assert.equal(Number(a.stock_qty), 7);
  const { rows: moves } = await db.query('select movement_type, change_qty from public.inventory_ledger where product_id = $1', [a.id]);
  assert.deepEqual(moves.map((row) => [row.movement_type, Number(row.change_qty)]), [['Opening', 7]]);
});

test('customers and suppliers import', async () => {
  assert.equal((await run('customers', [{ name: 'Ravi', phone: '0771111111', loyaltyPoints: 50 }])).rows[0].n, 1);
  assert.equal((await db.query(`select loyalty_points from public.customers where name = 'Ravi'`)).rows[0].loyalty_points, 50);
  assert.equal((await run('suppliers', [{ name: 'Import Supplier', city: 'Galle', leadTimeDays: 3 }])).rows[0].n, 1);
});

test('one bad row saves nothing at all', async () => {
  const before = [await count('products'), await count('inventory_ledger')];
  await assert.rejects(() => run('products', [product('Good One', { openingStock: 5 }), product('Good Two', { sku: 'IMP-A' })]), /products_sku_key/);
  assert.deepEqual([await count('products'), await count('inventory_ledger')], before);
});

test('bad requests are refused', async () => {
  await assert.rejects(() => run('users', [{ name: 'x' }]), /what to import/);
  await assert.rejects(() => run('products', []), /no rows/);
});

test('the audit log lists its actions, and stays read-only', async () => {
  await db.query(`insert into public.audit_logs (user_id, user_name, action) values ($1, 'x', 'Zeta'), ($1, 'x', 'Alpha'), ($1, 'x', 'Alpha')`, [user]);
  assert.deepEqual((await db.query('select public.audit_actions() as a')).rows[0].a, ['Alpha', 'Zeta']);
  await assert.rejects(() => db.query(`update public.audit_logs set action = 'hacked'`));
  await assert.rejects(() => db.query('delete from public.audit_logs'));
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['import_records(text, jsonb, uuid)', 'audit_actions()']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
