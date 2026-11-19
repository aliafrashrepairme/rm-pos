import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';

let db;
let user;
const save = async (id, name, active = null) => (await db.query('select public.save_counter($1, $2, $3) as r', [id, name, active])).rows[0].r;
const counter = async (id) => (await db.query('select name, active from public.counters where id = $1', [id])).rows[0];

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
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'till', 'Till', 't@example.com', 'Cashier')`, [user]);
});

test('counters are added and renamed with unique names', async () => {
  const added = await save(null, '  Counter 03 ');
  assert.equal(added.created, true);
  assert.deepEqual(await counter(added.id), { name: 'Counter 03', active: true });
  await assert.rejects(() => save(null, 'counter 03'), /already exists/);
  await assert.rejects(() => save(null, ''), /counter name/);
  await save(added.id, 'Hardware desk');
  assert.equal((await counter(added.id)).name, 'Hardware desk');
  await assert.rejects(() => save(randomUUID(), 'Ghost'), /Counter not found/);
});

test('a counter with an open shift cannot be switched off', async () => {
  const { id } = await save(null, 'Busy counter');
  const shift = (await db.query('select public.open_shift($1, 500, $2) as id', [id, user])).rows[0].id;
  await assert.rejects(() => save(id, 'Busy counter', false), /shift is open/);
  await db.query('select public.close_shift($1, 500, $2)', [shift, user]);
  await save(id, 'Busy counter', false);
  assert.equal((await counter(id)).active, false);
  // A switched-off counter can't take a new shift.
  await assert.rejects(() => db.query('select public.open_shift($1, 500, $2)', [id, user]), /Choose a counter/);
  await save(id, 'Busy counter', true);
  assert.equal((await counter(id)).active, true);
});

test('only the Owner holds the counter and printer permissions', async () => {
  for (const permission of ['counters.manage', 'printers.manage']) {
    const { rows } = await db.query('select role_code from public.role_permissions where permission_code = $1', [permission]);
    assert.deepEqual(rows.map((row) => row.role_code), ['Owner'], permission);
  }
  const { rows: [access] } = await db.query(`select has_function_privilege('anon', 'public.save_counter(uuid, text, boolean)', 'execute') as anon,
    has_function_privilege('service_role', 'public.save_counter(uuid, text, boolean)', 'execute') as api`);
  assert.deepEqual(access, { anon: false, api: true });
});
