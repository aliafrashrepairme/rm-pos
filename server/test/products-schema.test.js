import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

let db;
let userId;
let categoryId;
let taxRateId;

function create(overrides = {}) {
  return db.query('select public.create_product($1, $2) as id', [{
    name: 'Hammer 500g',
    categoryId,
    unitCode: 'Piece',
    taxRateId,
    costPrice: 980,
    sellingPrice: 1450,
    ...overrides
  }, userId]).then(({ rows }) => rows[0].id);
}

const product = async (id) => (await db.query('select * from public.products where id = $1', [id])).rows[0];
const checkDigitIsValid = (code) => {
  const sum = [...code.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
};

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql']) await db.exec(await read(file));
  userId = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [userId]);
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test', 't@example.com', 'Manager')`, [userId]);
  categoryId = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  taxRateId = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
});

test('the check digit matches a known EAN-13 code', async () => {
  const { rows } = await db.query(`select public.ean13_check_digit('479123400100') as digit`);
  assert.equal(rows[0].digit, String((10 - ([4, 7, 9, 1, 2, 3, 4, 0, 0, 1, 0, 0].reduce((sum, digit, index) => sum + digit * (index % 2 ? 3 : 1), 0) % 10)) % 10));
});

test('a new product gets a sequential SKU and a valid in-store barcode', async () => {
  const first = await product(await create());
  const second = await product(await create({ name: 'Second' }));
  assert.equal(first.sku, 'RM-000001');
  assert.equal(second.sku, 'RM-000002');
  assert.match(first.barcode, /^20\d{11}$/);
  assert.notEqual(first.barcode, second.barcode);
  assert.ok(checkDigitIsValid(first.barcode));
  assert.ok(checkDigitIsValid(second.barcode));
});

test('a typed SKU or manufacturer barcode is kept, and a generated code skips it', async () => {
  const typed = await product(await create({ sku: 'PAINT-1', barcode: '4791234001001' }));
  assert.equal(typed.sku, 'PAINT-1');
  assert.equal(typed.barcode, '4791234001001');

  await create({ sku: 'RM-000004', name: 'Taken SKU' });
  const generated = await product(await create({ name: 'After taken' }));
  assert.notEqual(generated.sku, 'RM-000004');

  const { rows } = await db.query(`select next_value from public.number_sequences where prefix = 'BC-'`);
  const nextTwelve = `20${String(rows[0].next_value).padStart(10, '0')}`;
  const digit = (await db.query('select public.ean13_check_digit($1) as d', [nextTwelve])).rows[0].d;
  await create({ name: 'Blocks next code', barcode: nextTwelve + digit });
  const skipped = await product(await create({ name: 'Skips it' }));
  assert.notEqual(skipped.barcode, nextTwelve + digit);
  assert.ok(checkDigitIsValid(skipped.barcode));
});

test('duplicates are rejected and leave nothing behind', async () => {
  await create({ sku: 'DUP', barcode: 'DUP-CODE' });
  const count = async () => (await db.query('select count(*)::int as n from public.products')).rows[0].n;
  const before = await count();
  await assert.rejects(() => create({ sku: 'DUP', openingStock: 5 }), /products_sku_key/);
  await assert.rejects(() => create({ sku: 'OTHER', barcode: 'DUP-CODE', openingStock: 5 }), /products_barcode_key/);
  assert.equal(await count(), before);
});

test('opening stock goes through the ledger with who, why and the cost', async () => {
  const id = await create({ sku: 'OPEN', openingStock: 12, costPrice: 50 });
  assert.equal(Number((await product(id)).stock_qty), 12);
  const { rows } = await db.query('select * from public.inventory_ledger where product_id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].movement_type, 'Opening');
  assert.equal(Number(rows[0].previous_qty), 0);
  assert.equal(Number(rows[0].new_qty), 12);
  assert.equal(Number(rows[0].unit_cost), 50);
  assert.equal(rows[0].reason, 'Opening stock');
  assert.equal(rows[0].created_by, userId);
});

test('no opening stock means no ledger entry', async () => {
  const id = await create({ sku: 'NONE' });
  const { rows } = await db.query('select count(*)::int as n from public.inventory_ledger where product_id = $1', [id]);
  assert.equal(rows[0].n, 0);
});

test('a failed opening movement undoes the whole product', async () => {
  await assert.rejects(() => create({ sku: 'FRACTION', openingStock: 1.5 }), /whole units/);
  assert.equal((await db.query(`select 1 from public.products where sku = 'FRACTION'`)).rows.length, 0);
});

test('metre products accept a fractional opening stock', async () => {
  const id = await create({ sku: 'WIRE', unitCode: 'Metre', openingStock: 2.5 });
  assert.equal(Number((await product(id)).stock_qty), 2.5);
});

test('inactive lists and bad values are refused', async () => {
  const inactive = (await db.query(`insert into public.categories (name, active) values ('Old', false) returning id`)).rows[0].id;
  await assert.rejects(() => create({ categoryId: inactive }), /active category/);
  await assert.rejects(() => create({ unitCode: 'Nonsense' }), /active unit/);
  await assert.rejects(() => create({ taxRateId: randomUUID() }), /active tax rate/);
  await assert.rejects(() => create({ openingStock: -1 }), /cannot be negative/);
  await assert.rejects(() => create({ sellingPrice: -1 }), /check constraint/);
});

test('the public API roles cannot create products', async () => {
  const { rows } = await db.query(`select has_function_privilege('anon', 'public.create_product(jsonb, uuid)', 'execute') as anon,
    has_function_privilege('authenticated', 'public.next_store_barcode()', 'execute') as signed_in,
    has_function_privilege('service_role', 'public.create_product(jsonb, uuid)', 'execute') as api`);
  assert.deepEqual(rows[0], { anon: false, signed_in: false, api: true });
});

test('searching by part of a name works', async () => {
  await create({ sku: 'SEARCH', name: 'Angle Grinder 750W' });
  const { rows } = await db.query(`select sku from public.products where name ilike '%grinder%'`);
  assert.deepEqual(rows.map((row) => row.sku), ['SEARCH']);
});
