import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bundleMigrations } from '../scripts/bundle-migrations.js';

let db;
let user;
let category;
let tax;
let zeroTax;

async function product(name, { price = 100, unit = 'Piece', taxId = tax, stock = 50 } = {}) {
  return (await db.query('select public.create_product($1, $2) as id', [{
    name, categoryId: category, unitCode: unit, taxRateId: taxId, costPrice: price / 2, sellingPrice: price, openingStock: stock
  }, user])).rows[0].id;
}

const today = (days = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const save = async (items, extra = {}) => (await db.query('select public.save_quotation($1, $2) as id', [
  { customerName: 'Walk-in Builder', validUntil: today(7), items, ...extra }, user
])).rows[0].id;
const quote = async (id) => (await db.query('select * from public.quotations where id = $1', [id])).rows[0];
const status = async (id, next) => (await db.query('select public.set_quotation_status($1, $2) as r', [id, next])).rows[0].r;
const stock = async (id) => Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty);

async function sell(productId, qty, total) {
  return (await db.query('select public.create_sale($1, $2) as r', [{
    clientRequestId: randomUUID(), items: [{ productId, qty }], expectedTotal: total,
    payment: { method: 'Cash', amountTendered: total }
  }, user])).rows[0].r;
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
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'tester', 'Test', 't@example.com', 'Manager')`, [user]);
  category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  zeroTax = (await db.query('select id from public.tax_rates where rate = 0')).rows[0].id;
});

test('a quote copies prices and tax, numbers itself and moves no stock', async () => {
  const hammer = await product('Hammer', { price: 1000 });
  const nails = await product('Nails', { price: 250, unit: 'Kg', taxId: zeroTax });
  const id = await save([{ productId: hammer, qty: 2 }, { productId: nails, qty: 1.5 }]);
  const row = await quote(id);
  assert.match(row.quote_no, /^QT-\d{6}$/);
  assert.equal(row.status, 'Draft');
  assert.equal(Number(row.subtotal), 2375);
  assert.equal(Number(row.tax_total), 360);
  assert.equal(Number(row.grand_total), 2735);
  assert.equal(await stock(hammer), 50);

  // A later price change does not rewrite what the customer was offered.
  await db.query('update public.products set selling_price = 9999 where id = $1', [hammer]);
  const { rows } = await db.query('select unit_price from public.quotation_items where quotation_id = $1 and product_id = $2', [id, hammer]);
  assert.equal(Number(rows[0].unit_price), 1000);
});

test('quotes are validated', async () => {
  const item = await product('Valid');
  const pipe = await product('Pipe');
  await assert.rejects(() => save([]), /at least one product/);
  await assert.rejects(() => save([{ productId: item, qty: 1 }, { productId: item, qty: 2 }]), /appears twice/);
  await assert.rejects(() => save([{ productId: pipe, qty: 1.5 }]), /whole units/);
  await assert.rejects(() => save([{ productId: item, qty: 1 }], { validUntil: today(-1) }), /valid-until/);
  await assert.rejects(() => save([{ productId: item, qty: 1 }], { customerName: '' }), /customer's name/);
  await db.query('update public.products set active = false where id = $1', [pipe]);
  await assert.rejects(() => save([{ productId: pipe, qty: 1 }]), /not active/);
});

test('only a draft can be edited, and statuses follow the allowed path', async () => {
  const item = await product('Path', { price: 100, taxId: zeroTax });
  const id = await save([{ productId: item, qty: 1 }]);
  await save([{ productId: item, qty: 3 }], { id, note: 'Revised' });
  assert.equal(Number((await quote(id)).grand_total), 300);

  await assert.rejects(() => status(id, 'Accepted'), /draft quotation cannot be marked accepted/);
  assert.equal((await status(id, 'Sent')).to, 'Sent');
  assert.ok((await quote(id)).sent_at);
  await assert.rejects(() => save([{ productId: item, qty: 1 }], { id }), /Only a draft/);
  await assert.rejects(() => status(id, 'Converted'), /cannot be marked converted/);
  await status(id, 'Rejected');
  await assert.rejects(() => status(id, 'Accepted'), /rejected quotation/);

  const other = await save([{ productId: item, qty: 1 }]);
  await status(other, 'Cancelled');
  assert.equal((await quote(other)).status, 'Cancelled');
});

test('open quotes past their date expire', async () => {
  const item = await product('Old');
  const draft = await save([{ productId: item, qty: 1 }]);
  const sent = await save([{ productId: item, qty: 1 }]);
  await status(sent, 'Sent');
  const rejected = await save([{ productId: item, qty: 1 }]);
  await status(rejected, 'Sent');
  await status(rejected, 'Rejected');
  await db.query('update public.quotations set valid_until = current_date - 1 where id = any($1)', [[draft, sent, rejected]]);
  await db.query('select public.expire_quotations()');
  assert.equal((await quote(draft)).status, 'Expired');
  assert.equal((await quote(sent)).status, 'Expired');
  assert.equal((await quote(rejected)).status, 'Rejected', 'a decided quote keeps its outcome');
});

test('an accepted quote converts once, to a real bill', async () => {
  const item = await product('Convert', { price: 100, taxId: zeroTax });
  const id = await save([{ productId: item, qty: 2 }]);
  const sale = await sell(item, 2, 200);
  await assert.rejects(() => db.query('select public.convert_quotation($1, $2)', [id, sale.id]), /Only an accepted/);
  await status(id, 'Sent');
  await status(id, 'Accepted');
  await assert.rejects(() => db.query('select public.convert_quotation($1, $2)', [id, randomUUID()]), /Bill not found/);

  const { rows: [{ r }] } = await db.query('select public.convert_quotation($1, $2) as r', [id, sale.id]);
  assert.equal(r.billNo, sale.billNo);
  const row = await quote(id);
  assert.equal(row.status, 'Converted');
  assert.equal(row.sale_id, sale.id);
  // Retrying the same link is harmless.
  assert.equal((await db.query('select public.convert_quotation($1, $2) as r', [id, sale.id])).rows[0].r.replayed, true);

  const second = await save([{ productId: item, qty: 1 }]);
  await status(second, 'Sent');
  await status(second, 'Accepted');
  await assert.rejects(() => db.query('select public.convert_quotation($1, $2)', [second, sale.id]), /already linked/);
  await assert.rejects(() => status(id, 'Cancelled'), /converted quotation/);
});

test('only the API can reach quotations', async () => {
  for (const table of ['quotations', 'quotation_items']) {
    const { rows } = await db.query(`select has_table_privilege('anon', 'public.${table}', 'select') as anon,
      has_table_privilege('authenticated', 'public.${table}', 'select') as signed_in,
      (select relrowsecurity from pg_class where oid = 'public.${table}'::regclass) as rls`);
    assert.deepEqual(rows[0], { anon: false, signed_in: false, rls: true }, table);
  }
  for (const signature of ['save_quotation(jsonb, uuid)', 'set_quotation_status(uuid, text)', 'convert_quotation(uuid, uuid)', 'expire_quotations()', 'quotation_counts()']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
  const holders = (await db.query(`select role_code from public.role_permissions where permission_code = 'quotations.manage' order by role_code`)).rows.map((row) => row.role_code);
  assert.deepEqual(holders, ['Cashier', 'Manager']);
});

test('a quotation sent twice with one request ID is saved once', async () => {
  const saw = await product('Hand Saw', { price: 1500 });
  const request = randomUUID();
  const body = { customerName: 'Offline Builder', validUntil: today(7), items: [{ productId: saw, qty: 1 }] };
  const first = (await db.query('select public.save_quotation_once($1, $2, $3) as r', [body, user, request])).rows[0].r;
  const second = (await db.query('select public.save_quotation_once($1, $2, $3) as r', [body, user, request])).rows[0].r;
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.id, first.id);
  const copies = (await db.query('select count(*)::int as n from public.quotations where client_request_id = $1', [request])).rows[0].n;
  assert.equal(copies, 1);
  await assert.rejects(db.query('select public.save_quotation_once($1, $2, null)', [body, user]), /request ID is required/);
});
