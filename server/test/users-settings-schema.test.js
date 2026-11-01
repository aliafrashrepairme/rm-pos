import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql', '0010_customers.sql', '0011_reports.sql', '0012_users_settings.sql', '0016_store_settings_merge.sql'];

let db;

async function person(role, name = role) {
  const id = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [id]);
  const tag = id.slice(0, 8);
  await db.query('insert into public.profiles (id, username, full_name, email, role_code) values ($1, $2, $3, $4, $5)', [id, `u${tag}`, name, `${tag}@example.com`, role]);
  return id;
}
const update = async (actor, target, changes) => (await db.query('select public.update_staff($1, $2, $3) as r', [actor, target, changes])).rows[0].r;

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of MIGRATIONS) await db.exec(await read(file));
});

test('saving one receipt option keeps the others, even when saves overlap', async () => {
  const manager = await person('Manager');
  const save = (store, receipt) => db.query('select public.save_store_settings($1, $2, $3)', [store, receipt, manager]);
  await Promise.all([save({}, { footer: 'Thanks' }), save({}, { size: '100mm' }), save({ phone: '021' }, { showTax: false })]);
  const { rows: [row] } = await db.query('select phone, address, receipt, updated_by from public.store_settings');
  assert.deepEqual([row.receipt.footer, row.receipt.size, row.receipt.showTax, row.receipt.showBalance], ['Thanks', '100mm', false, true]);
  assert.equal(row.phone, '021');
  assert.equal(typeof row.address, 'string', 'fields not sent stay as they were');
  assert.equal(row.updated_by, manager);
  await assert.rejects(() => save({}, {}), /Nothing to change/);
  await save({}, { footer: '', size: '80mm', showTax: true });
});

test('name, email, role and status can be changed', async () => {
  const manager = await person('Manager');
  const cashier = await person('Cashier');
  const row = await update(manager, cashier, { fullName: ' New Name ', role: 'Inventory Staff', email: 'new@example.com', active: false });
  assert.deepEqual([row.full_name, row.role_code, row.email, row.active], ['New Name', 'Inventory Staff', 'new@example.com', false]);
  const unchanged = await update(manager, cashier, { active: true });
  assert.deepEqual([unchanged.full_name, unchanged.role_code, unchanged.active], ['New Name', 'Inventory Staff', true]);
});

test('Owner accounts are protected', async () => {
  const manager = await person('Manager');
  const owner = await person('Owner');
  const cashier = await person('Cashier');
  await assert.rejects(() => update(manager, owner, { active: false }), /Owner accounts/);
  await assert.rejects(() => update(manager, cashier, { role: 'Owner' }), /Owner accounts/);
});

test('nobody changes their own role or status, but their name is fine', async () => {
  const manager = await person('Manager');
  await person('Manager', 'Second');
  await assert.rejects(() => update(manager, manager, { role: 'Cashier' }), /your own/);
  await assert.rejects(() => update(manager, manager, { active: false }), /your own/);
  assert.equal((await update(manager, manager, { fullName: 'Renamed', role: 'Manager', active: true })).full_name, 'Renamed');
});

test('the last active Manager cannot be disabled or demoted', async () => {
  await db.query(`update public.profiles set active = false where role_code = 'Manager'`);
  const only = await person('Manager', 'Only');
  const other = await person('Manager', 'Other');
  await db.query('update public.profiles set active = false where id = $1', [other]);
  const actor = await person('Cashier');
  await assert.rejects(() => update(actor, only, { active: false }), /at least one active Manager/);
  await assert.rejects(() => update(actor, only, { role: 'Cashier' }), /at least one active Manager/);
  await update(actor, other, { active: true });
  assert.equal((await update(actor, only, { active: false })).active, false);
});

test('an account with activity cannot be deleted, and an unused one can', async () => {
  const used = await person('Cashier');
  await db.query(`insert into public.audit_logs (user_id, user_name, action) values ($1, 'x', 'User login')`, [used]);
  await assert.rejects(() => db.query('delete from public.profiles where id = $1', [used]), /foreign key/);
  const unused = await person('Cashier');
  await db.query('delete from public.profiles where id = $1', [unused]);
});

test('only one tax rate is the default', async () => {
  const { rows } = await db.query('select id, is_default from public.tax_rates');
  const other = rows.find((row) => !row.is_default).id;
  await db.query('select public.set_default_tax_rate($1)', [other]);
  const { rows: defaults } = await db.query('select id from public.tax_rates where is_default');
  assert.deepEqual(defaults.map((row) => row.id), [other]);
  await assert.rejects(() => db.query('select public.set_default_tax_rate($1)', [randomUUID()]), /not found/);
});

test('receipt settings start with the existing behaviour', async () => {
  const { rows: [{ receipt }] } = await db.query('select receipt from public.store_settings');
  assert.deepEqual(receipt, { size: '80mm', showTax: true, showBalance: true, printAfterSale: false, footer: '' });
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['update_staff(uuid, uuid, jsonb)', 'set_default_tax_rate(uuid)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
