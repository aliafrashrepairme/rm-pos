import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

let db;
let userId;
let tools;
let paint;
let taxRateId;

async function product(name, { stock = 0, min = 0, cost = 10, price = 20, category = tools, unit = 'Piece' } = {}) {
  const { rows } = await db.query('select public.create_product($1, $2) as id', [
    { name, categoryId: category, unitCode: unit, taxRateId, costPrice: cost, sellingPrice: price, openingStock: stock, minStock: min },
    userId
  ]);
  return rows[0].id;
}
const stockOf = async (id) => Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty);
const ledger = (id) => db.query('select * from public.inventory_ledger where product_id = $1 order by id', [id]).then(({ rows }) => rows);
const adjust = (lines, reason = 'Damaged', note = 'dropped') => db.query('select public.post_stock_adjustment($1, $2, $3, $4) as id', [reason, note, JSON.stringify(lines), userId]).then(({ rows }) => rows[0].id);
const startCount = (category = null, low = false, blind = true) => db.query('select public.start_stock_count($1, $2, $3, $4, $5) as id', ['Count', category, low, blind, userId]).then(({ rows }) => rows[0].id);
const setLine = (countId, productId, counted) => db.query('select public.set_stock_count_line($1, $2, $3)', [countId, productId, counted]);
const submit = (countId) => db.query('select public.submit_stock_count($1)', [countId]);
const approve = (countId) => db.query('select public.approve_stock_count($1, $2) as posted', [countId, userId]).then(({ rows }) => rows[0].posted);

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql']) await db.exec(await read(file));
  userId = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [userId]);
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test', 't@example.com', 'Manager')`, [userId]);
  tools = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  paint = (await db.query(`insert into public.categories (name) values ('Paint') returning id`)).rows[0].id;
  taxRateId = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
});

test('an adjustment posts every line to the ledger with its reason and number', async () => {
  const a = await product('Adj A', { stock: 10 });
  const b = await product('Adj B', { stock: 5 });
  const id = await adjust([{ productId: a, change: -2 }, { productId: b, change: 3 }], 'Found stock');
  assert.equal(await stockOf(a), 8);
  assert.equal(await stockOf(b), 8);
  const row = (await ledger(a)).at(-1);
  assert.equal(row.movement_type, 'Adjustment');
  assert.equal(row.reason, 'Found stock');
  assert.match(row.reference_no, /^ADJ-\d{6}$/);
  assert.equal(row.reference_id, id);
  assert.equal(Number(row.previous_qty), 10);
  assert.equal(Number(row.new_qty), 8);
  const saved = (await db.query('select status, decided_by from public.stock_adjustments where id = $1', [id])).rows[0];
  assert.deepEqual(saved, { status: 'Approved', decided_by: userId });
});

test('a failing line undoes the whole adjustment', async () => {
  const a = await product('Atomic A', { stock: 10 });
  const b = await product('Atomic B', { stock: 1 });
  const adjustments = async () => (await db.query('select count(*)::int as n from public.stock_adjustments')).rows[0].n;
  const before = await adjustments();
  await assert.rejects(() => adjust([{ productId: a, change: -2 }, { productId: b, change: -5 }]), /INSUFFICIENT_STOCK/);
  assert.equal(await stockOf(a), 10);
  assert.equal(await stockOf(b), 1);
  assert.equal(await adjustments(), before);
  assert.equal((await ledger(a)).length, 1);
});

test('bad adjustments are refused', async () => {
  const a = await product('Bad', { stock: 10 });
  await assert.rejects(() => adjust([]), /at least one/);
  await assert.rejects(() => adjust([{ productId: a, change: 0 }]), /check constraint/);
  await assert.rejects(() => adjust([{ productId: a, change: -1 }], 'Because'), /check constraint/);
  await assert.rejects(() => adjust([{ productId: a, change: -1 }, { productId: a, change: -1 }]), /duplicate key/);
  await assert.rejects(() => adjust([{ productId: a, change: 1.5 }]), /whole units/);
  await assert.rejects(() => adjust([{ productId: randomUUID(), change: 1 }]), /foreign key/);
});

test('the list filters by stock state, category and search', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Listing') returning id`)).rows[0].id;
  await product('Healthy item', { stock: 50, min: 10, category: cat });
  await product('Low item', { stock: 5, min: 10, category: cat });
  await product('Edge item', { stock: 10, min: 10, category: cat });
  await product('Empty item', { stock: 0, min: 10, category: cat });
  const names = async (state, search = '') => {
    const { rows } = await db.query('select public.inventory_list($1, $2, $3, 25, 0) as r', [search, cat, state]);
    return rows[0].r.rows.map((row) => row.name);
  };
  assert.deepEqual(await names('low'), ['Edge item', 'Low item']);
  assert.deepEqual(await names('out'), ['Empty item']);
  assert.deepEqual(await names('in'), ['Healthy item']);
  assert.equal((await names('all')).length, 4);
  assert.deepEqual(await names('all', 'heal'), ['Healthy item']);
});

test('the list pages correctly and reports the full total', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Paged') returning id`)).rows[0].id;
  for (const name of ['P1', 'P2', 'P3']) await product(name, { category: cat, stock: 2, cost: 2.5 });
  const { rows } = await db.query('select public.inventory_list($1, $2, $3, 2, 2) as r', ['', cat, 'all']);
  assert.equal(rows[0].r.total, 3);
  assert.deepEqual(rows[0].r.rows.map((row) => row.name), ['P3']);
  assert.equal(rows[0].r.rows[0].value, 5);
});

test('valuation adds up by category and leaves out inactive products', async () => {
  const before = (await db.query('select public.inventory_summary() as s')).rows[0].s;
  await product('Tin', { stock: 4, cost: 100, price: 150, category: paint });
  await product('Empty tin', { stock: 0, min: 1, cost: 100, price: 150, category: paint });
  const gone = await product('Retired', { stock: 9, cost: 1000, price: 2000, category: paint });
  await db.query('update public.products set active = false where id = $1', [gone]);
  const s = (await db.query('select public.inventory_summary() as s')).rows[0].s;
  assert.equal(s.costValue - before.costValue, 400);
  assert.equal(s.retailValue - before.retailValue, 600);
  assert.equal(s.products - before.products, 2);
  const row = s.categories.find((item) => item.category === 'Paint');
  assert.equal(row.costValue, 400);
  assert.equal(row.products, 2);
  assert.equal(row.out, 1);
});

test('a count snapshots only its scope, and an empty scope is refused', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Scope') returning id`)).rows[0].id;
  const inScope = await product('Scoped low', { stock: 2, min: 5, category: cat });
  await product('Scoped high', { stock: 50, min: 5, category: cat });
  const count = await startCount(cat, true);
  const { rows } = await db.query('select product_id, system_qty, counted_qty from public.stock_count_lines where stock_count_id = $1', [count]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_id, inScope);
  assert.equal(Number(rows[0].system_qty), 2);
  assert.equal(rows[0].counted_qty, null);

  const empty = (await db.query(`insert into public.categories (name) values ('Nothing') returning id`)).rows[0].id;
  await assert.rejects(() => startCount(empty), /No products match/);
});

test('counts change no stock until approved, then post each difference once', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Flow') returning id`)).rows[0].id;
  const more = await product('Count more', { stock: 10, category: cat });
  const fewer = await product('Count fewer', { stock: 10, category: cat });
  const same = await product('Count same', { stock: 10, category: cat });
  const blank = await product('Count blank', { stock: 10, category: cat });
  const count = await startCount(cat);
  await setLine(count, more, 12);
  await setLine(count, fewer, 7);
  await setLine(count, same, 10);
  assert.equal(await stockOf(more), 10);

  await submit(count);
  assert.equal(await stockOf(more), 10, 'submitting alone changes nothing');
  await assert.rejects(() => setLine(count, more, 99), /already been submitted/);

  assert.equal(await approve(count), 2);
  assert.equal(await stockOf(more), 12);
  assert.equal(await stockOf(fewer), 7);
  assert.equal(await stockOf(same), 10);
  assert.equal(await stockOf(blank), 10, 'an uncounted item keeps its quantity');
  const row = (await ledger(fewer)).at(-1);
  assert.equal(row.movement_type, 'Count');
  assert.equal(Number(row.change_qty), -3);
  assert.match(row.reference_no, /^SC-\d{6}$/);

  await assert.rejects(() => approve(count), /Only a submitted count/);
  assert.equal(await stockOf(more), 12, 'a second approval posts nothing');
});

test('sales during a count are kept: only the difference is applied', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('During') returning id`)).rows[0].id;
  const id = await product('Selling', { stock: 10, category: cat });
  const count = await startCount(cat);
  await setLine(count, id, 8);
  await db.query(`select public.post_stock_movement($1, 'Sale', -3, 'Sold', '', '', '', $2)`, [id, userId]);
  await submit(count);
  await approve(count);
  assert.equal(await stockOf(id), 5);
});

test('a shortage larger than remaining stock stops at zero', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Shortage') returning id`)).rows[0].id;
  const id = await product('Nearly gone', { stock: 5, category: cat });
  const count = await startCount(cat);
  await setLine(count, id, 1);
  await db.query(`select public.post_stock_movement($1, 'Sale', -4, 'Sold', '', '', '', $2)`, [id, userId]);
  await submit(count);
  await approve(count);
  assert.equal(await stockOf(id), 0);
});

test('a submitted count can be re-opened, and a finished one cannot', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Reopen') returning id`)).rows[0].id;
  const id = await product('Reopened', { stock: 3, category: cat });
  const count = await startCount(cat);
  await submit(count);
  await db.query('select public.reopen_stock_count($1)', [count]);
  await setLine(count, id, 2);
  await submit(count);
  await approve(count);
  assert.equal(await stockOf(id), 2);
  await assert.rejects(() => db.query('select public.reopen_stock_count($1)', [count]), /Only a submitted count/);
});

test('count lines reject fractions on whole units and products outside the count', async () => {
  const cat = (await db.query(`insert into public.categories (name) values ('Lines') returning id`)).rows[0].id;
  const id = await product('Whole', { stock: 3, category: cat });
  const wire = await product('Wire', { stock: 3, category: cat, unit: 'Metre' });
  const outside = await product('Outside', { stock: 3 });
  const count = await startCount(cat);
  await assert.rejects(() => setLine(count, id, 1.5), /whole units/);
  await setLine(count, wire, 1.5);
  await assert.rejects(() => setLine(count, outside, 1), /not part of the count/);
  await assert.rejects(() => setLine(count, id, -1), /check constraint/);
  await assert.rejects(() => setLine(randomUUID(), id, 1), /Stock count not found/);
});

test('the public API roles cannot run inventory functions', async () => {
  for (const signature of ['inventory_summary()', 'post_stock_adjustment(text, text, jsonb, uuid)', 'approve_stock_count(uuid, uuid)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('authenticated', 'public.${signature}', 'execute') as signed_in,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, signed_in: false, api: true }, signature);
  }
});
