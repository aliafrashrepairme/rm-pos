import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';

test('a brand-new database is set up by one file and holds no sample records', async () => {
  const { names, sql } = await bundleMigrations();
  assert.equal(names[0], '0001_core_schema.sql');
  assert.ok(names.includes('0017_clear_sample_store_details.sql'));

  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  await db.exec(sql);

  const count = async (table) => Number((await db.query(`select count(*) as n from public.${table}`)).rows[0].n);
  for (const table of ['profiles', 'products', 'customers', 'suppliers', 'sales', 'purchases', 'shifts', 'expenses', 'audit_logs']) {
    assert.equal(await count(table), 0, `${table} starts empty`);
  }
  assert.equal(await count('roles'), 4);
  assert.ok(await count('payment_methods') > 0);

  const { rows: [store] } = await db.query('select address, phone, vat_registration from public.store_settings');
  assert.deepEqual(store, { address: '', phone: '', vat_registration: '' });

  // Managers keep daily transactions but lose monthly figures and AI invoice scan.
  const holders = async (permission) => (await db.query(
    'select role_code from public.role_permissions where permission_code = $1 order by role_code', [permission]
  )).rows.map((row) => row.role_code);
  assert.deepEqual(await holders('transactions.view'), ['Manager', 'Owner']);
  assert.deepEqual(await holders('transactions.monthly'), ['Owner']);
  assert.deepEqual(await holders('ai_scan.use'), []);

  // Stock counts and adjustments belong to Managers and Inventory Staff; only Managers approve counts.
  assert.deepEqual(await holders('counts.manage'), ['Inventory Staff', 'Manager']);
  assert.deepEqual(await holders('adjustments.manage'), ['Inventory Staff', 'Manager']);
  assert.deepEqual(await holders('counts.approve'), ['Manager']);

  // Only the Owner changes the logo, and a new store starts with the built-in one.
  assert.deepEqual(await holders('settings.logo'), ['Owner']);
  const { rows: [logo] } = await db.query('select logo_path from public.store_settings');
  assert.equal(logo.logo_path, '');
});
