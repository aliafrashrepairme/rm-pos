import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';
import { restoreSnapshot } from '../services/restore.js';

async function freshDatabase() {
  const { sql } = await bundleMigrations();
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  await db.exec(sql);
  return db;
}

const snapshotOf = async (db) => (await db.query('select public.backup_snapshot() as s')).rows[0].s;

test('a backup holds every table and restores the database exactly as it was', async () => {
  const db = await freshDatabase();
  await db.exec(`
    insert into public.categories (name) values ('Tools'), ('Paint');
    insert into public.audit_logs (user_name, action) values ('System', 'First'), ('System', 'Second');
  `);
  const backup = await snapshotOf(db);
  assert.equal(backup.format, 'rm-pos-backup');
  assert.equal(backup.version, 1);
  const tables = (await db.query(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`)).rows.map((row) => row.name).sort();
  assert.deepEqual(Object.keys(backup.tables).sort(), tables, 'every table is in the backup');
  assert.equal(backup.tables.categories.length, 2);

  // Something goes wrong after the backup: a category is deleted, a stray one added, the logo changed.
  await db.exec(`
    delete from public.categories where name = 'Tools';
    insert into public.categories (name) values ('Wrong');
    update public.store_settings set logo_path = 'logo/x.png';
  `);

  const run = (sql, params) => db.query(sql, params);
  const result = await restoreSnapshot(run, backup);
  assert.equal(result.tables, tables.length);

  const after = await snapshotOf(db);
  assert.deepEqual(after.tables, backup.tables, 'every row is back exactly as backed up');

  // Numbered rows carry on after the restored ones instead of clashing with them.
  await db.exec(`insert into public.audit_logs (user_name, action) values ('System', 'After restore')`);
  const ids = (await db.query('select id from public.audit_logs order by id')).rows.map((row) => Number(row.id));
  assert.deepEqual(ids, [1, 2, 3]);
});

test('a failed restore changes nothing, and only the server may take a backup', async () => {
  const db = await freshDatabase();
  await db.exec(`insert into public.categories (name) values ('Tools')`);
  const backup = await snapshotOf(db);
  backup.tables.categories.push({ id: 'not-a-uuid', name: 'Broken', active: true, created_at: backup.created_at });
  await db.exec(`insert into public.categories (name) values ('Kept')`);

  await assert.rejects(restoreSnapshot((sql, params) => db.query(sql, params), backup));
  const names = (await db.query('select name from public.categories order by name')).rows.map((row) => row.name);
  assert.deepEqual(names, ['Kept', 'Tools']);

  await assert.rejects(restoreSnapshot(() => ({ rows: [] }), { format: 'other' }), /not an RM POS backup/);

  const grants = (await db.query(`select grantee from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name = 'backup_snapshot' order by grantee`)).rows.map((row) => row.grantee);
  assert.ok(grants.includes('service_role'));
  assert.ok(!grants.includes('anon') && !grants.includes('authenticated'));

  const holders = (await db.query(`select role_code from public.role_permissions where permission_code = 'backups.manage'`)).rows.map((row) => row.role_code);
  assert.deepEqual(holders, ['Manager']);
});
