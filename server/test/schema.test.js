import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/0001_core_schema.sql', import.meta.url), 'utf8');
const starterSchema = await readFile(new URL('./fixtures/starter_schema.sql', import.meta.url), 'utf8');

// Stands in for what Supabase provides before migrations run.
const supabaseStub = `
  create role anon; create role authenticated; create role service_role;
  create schema auth; create schema extensions;
  create table auth.users (id uuid primary key);
`;
const starter = starterSchema.replace(/^create extension.*$/m, '');

let db;
let userId;
let categoryId;
let taxRateId;

async function rejects(query, params, pattern) {
  await assert.rejects(() => db.query(query, params), pattern);
}

async function createProduct(sku, unit = 'Piece') {
  const { rows } = await db.query(
    `insert into public.products (sku, barcode, name, category_id, unit_code, selling_price, tax_rate_id)
     values ($1, $2, $3, $4, $5, 100, $6) returning id`,
    [sku, `${sku}-BC`, `Product ${sku}`, categoryId, unit, taxRateId]
  );
  return rows[0].id;
}

function postMovement(productId, change, type = 'Adjustment') {
  return db.query(
    `select public.post_stock_movement($1, $2, $3, 'test', 'test', '', '', $4)`,
    [productId, type, change, userId]
  );
}

before(async () => {
  db = new PGlite();
  await db.exec(supabaseStub);
  await db.exec(starter);
  await db.exec(migration);

  userId = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [userId]);
  await db.query(
    `insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test User', 'test@example.com', 'Manager')`,
    [userId]
  );
  categoryId = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  taxRateId = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
});

test('migration replaces the starter tables and removes the test products', async () => {
  const { rows } = await db.query('select count(*)::int as count from public.products');
  assert.equal(rows[0].count, 0);
  assert.equal((await db.query(`select to_regclass('public.stock_movements') as t`)).rows[0].t, null);
});

test('migration refuses to run over starter data that holds transactions', async () => {
  const other = new PGlite();
  await other.exec(supabaseStub);
  await other.exec(starter);
  await other.query(`insert into public.suppliers (name) values ('Real supplier')`);
  await assert.rejects(() => other.exec(migration), /Migrate this data by hand/);
  assert.equal((await other.query('select count(*)::int as count from public.suppliers')).rows[0].count, 1);
  await other.close();
});

test('every requested model has a table', async () => {
  const required = ['profiles', 'roles', 'permissions', 'products', 'categories', 'customers', 'suppliers',
    'purchases', 'purchase_items', 'sales', 'sale_items', 'payments', 'inventory_ledger', 'stock_counts',
    'stock_adjustments', 'held_orders', 'expenses', 'shifts', 'audit_logs', 'store_settings'];
  const { rows } = await db.query(`select tablename from pg_tables where schemaname = 'public'`);
  const tables = rows.map((row) => row.tablename);
  for (const table of required) assert.ok(tables.includes(table), `${table} is missing`);
});

test('every table has row level security and no access for public API roles', async () => {
  const unprotected = await db.query(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`);
  assert.deepEqual(unprotected.rows, []);
  const exposed = await db.query(
    `select table_name from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`
  );
  assert.deepEqual(exposed.rows, []);
});

test('role permissions match the agreed access rules', async () => {
  const has = async (role, permission) => (await db.query(
    'select 1 from public.role_permissions where role_code = $1 and permission_code = $2', [role, permission]
  )).rows.length === 1;
  const write = /(manage|approve|sell|process|own|use|print|labels|scan)$/;
  const owner = await db.query(`select permission_code as code from public.role_permissions where role_code = 'Owner'`);
  assert.deepEqual(owner.rows.filter((row) => write.test(row.code)), [], 'Owner must be read-only');

  assert.equal(await has('Manager', 'adjustments.manage'), true);
  assert.equal(await has('Manager', 'users.manage'), true);
  assert.equal(await has('Manager', 'refunds.process'), true);
  assert.equal(await has('Cashier', 'pos.sell'), true);
  assert.equal(await has('Cashier', 'refunds.process'), false);
  assert.equal(await has('Cashier', 'products.view'), false, 'cost prices stay hidden from cashiers');
  assert.equal(await has('Inventory Staff', 'barcode.scan'), true);
  assert.equal(await has('Inventory Staff', 'adjustments.manage'), false);
  assert.equal(await has('Inventory Staff', 'pos.sell'), false);
});

test('stock cannot be set directly, on insert or update', async () => {
  await rejects(
    `insert into public.products (sku, name, category_id, unit_code, selling_price, tax_rate_id, stock_qty)
     values ('DIRECT', 'Direct', $1, 'Piece', 1, $2, 5)`,
    [categoryId, taxRateId],
    /New products start at zero/
  );
  const id = await createProduct('GUARD');
  await rejects('update public.products set stock_qty = 5 where id = $1', [id], /only change through a ledger movement/);
});

test('a movement updates stock and records previous, change and new quantity', async () => {
  const id = await createProduct('LEDGER');
  await postMovement(id, 10, 'Opening');
  await postMovement(id, -3, 'Sale');
  const product = await db.query('select stock_qty from public.products where id = $1', [id]);
  assert.equal(Number(product.rows[0].stock_qty), 7);
  const ledger = await db.query(
    'select previous_qty, change_qty, new_qty, created_by, reason from public.inventory_ledger where product_id = $1 order by id',
    [id]
  );
  assert.deepEqual(ledger.rows.map((row) => [Number(row.previous_qty), Number(row.change_qty), Number(row.new_qty)]), [[0, 10, 10], [10, -3, 7]]);
  assert.equal(ledger.rows[0].created_by, userId);
});

test('stock can never go below zero, and a failed movement leaves no trace', async () => {
  const id = await createProduct('OVERSELL');
  await postMovement(id, 2, 'Opening');
  await assert.rejects(() => postMovement(id, -3, 'Sale'), /INSUFFICIENT_STOCK/);
  assert.equal(Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty), 2);
  assert.equal((await db.query('select count(*)::int as count from public.inventory_ledger where product_id = $1', [id])).rows[0].count, 1);
});

test('whole-unit products reject fractions; metre products accept them', async () => {
  const piece = await createProduct('WHOLE');
  await assert.rejects(() => postMovement(piece, 1.5, 'Opening'), /whole units/);
  const metre = await createProduct('WIRE', 'Metre');
  await postMovement(metre, 2.5, 'Opening');
  assert.equal(Number((await db.query('select stock_qty from public.products where id = $1', [metre])).rows[0].stock_qty), 2.5);
});

test('ledger and audit log are append-only', async () => {
  const id = await createProduct('APPEND');
  await postMovement(id, 1, 'Opening');
  await rejects('update public.inventory_ledger set reason = $1 where product_id = $2', ['x', id], /APPEND_ONLY/);
  await rejects('delete from public.inventory_ledger where product_id = $1', [id], /APPEND_ONLY/);
  await rejects('truncate public.inventory_ledger', [], /APPEND_ONLY/);
  await db.query(`insert into public.audit_logs (user_name, action) values ('Test User', 'Login')`);
  await rejects(`update public.audit_logs set action = 'x'`, [], /APPEND_ONLY/);
  await rejects('delete from public.audit_logs', [], /APPEND_ONLY/);
});

test('duplicate SKU and barcode are rejected', async () => {
  await createProduct('DUP');
  await rejects(
    `insert into public.products (sku, name, category_id, unit_code, selling_price, tax_rate_id)
     values ('DUP', 'Copy', $1, 'Piece', 1, $2)`,
    [categoryId, taxRateId],
    /duplicate key/
  );
  await rejects(
    `insert into public.products (sku, barcode, name, category_id, unit_code, selling_price, tax_rate_id)
     values ('DUP2', 'DUP-BC', 'Copy', $1, 'Piece', 1, $2)`,
    [categoryId, taxRateId],
    /duplicate key/
  );
});

test('document numbers are sequential and a rolled-back number is reused', async () => {
  const next = async () => (await db.query(`select public.next_document_number('RM-INV-') as n`)).rows[0].n;
  assert.equal(await next(), 'RM-INV-000001');
  await db.exec('begin');
  assert.equal(await next(), 'RM-INV-000002');
  await db.exec('rollback');
  assert.equal(await next(), 'RM-INV-000002');
});

test('a repeated checkout request cannot create a second sale', async () => {
  const requestId = randomUUID();
  const insert = () => db.query(
    `insert into public.sales (bill_no, client_request_id, cashier_id, subtotal, grand_total) values ($1, $2, $3, 100, 100)`,
    [`T-${randomUUID()}`, requestId, userId]
  );
  await insert();
  await assert.rejects(insert, /duplicate key/);
});

test('sale totals must add up', async () => {
  await rejects(
    `insert into public.sales (bill_no, client_request_id, cashier_id, subtotal, discount_total, tax_total, grand_total)
     values ('BAD', $1, $2, 100, 10, 18, 500)`,
    [randomUUID(), userId],
    /check constraint/
  );
});

test('receiving cannot exceed the quantity ordered', async () => {
  const supplier = (await db.query(`insert into public.suppliers (code, name) values ('SUP-T', 'Test') returning id`)).rows[0].id;
  const purchase = (await db.query(
    `insert into public.purchases (po_no, supplier_id, created_by) values ('PO-T', $1, $2) returning id`, [supplier, userId]
  )).rows[0].id;
  const product = await createProduct('RECV');
  await rejects(
    `insert into public.purchase_items (purchase_id, line_no, product_id, qty_ordered, qty_received, unit_cost)
     values ($1, 1, $2, 5, 6, 10)`,
    [purchase, product],
    /check constraint/
  );
});

test('the same supplier invoice cannot be recorded twice', async () => {
  const supplier = (await db.query(`insert into public.suppliers (code, name) values ('SUP-I', 'Invoice') returning id`)).rows[0].id;
  const insert = (poNo, invoice) => db.query(
    `insert into public.purchases (po_no, supplier_id, supplier_invoice_no, created_by) values ($1, $2, $3, $4)`,
    [poNo, supplier, invoice, userId]
  );
  await insert('PO-I1', 'INV/1');
  await assert.rejects(() => insert('PO-I2', 'inv/1'), /duplicate key/);
});

test('one open shift per counter and per cashier', async () => {
  const counter = (await db.query(`select id from public.counters where name = 'Counter 01'`)).rows[0].id;
  const open = (no) => db.query(
    `insert into public.shifts (shift_no, counter_id, cashier_id, opening_cash) values ($1, $2, $3, 1000)`,
    [no, counter, userId]
  );
  await open('SH-T1');
  await assert.rejects(() => open('SH-T2'), /duplicate key/);
});
