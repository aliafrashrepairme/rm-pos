import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql'];

let db;
let user;
let item;

const makeSupplier = async (name, extra = {}) => (await db.query('select public.create_supplier($1) as id', [{ name, ...extra }])).rows[0].id;
const stats = async (id) => (await db.query('select public.supplier_stats($1) as s', [id])).rows[0].s;
const dayOffset = (days) => {
  const date = new Date(Date.now() + 5.5 * 3600000 + days * 86400000);
  return date.toISOString().slice(0, 10);
};

async function order(supplierId, { expectedAt = null, status = 'Ordered', qty = 10 } = {}) {
  return (await db.query('select public.create_purchase($1, $2) as id', [{ supplierId, status, expectedAt, items: [{ productId: item, qty, unitCost: 10 }] }, user])).rows[0].id;
}

async function receiveAll(purchaseId, receivedDaysAgo = 0) {
  const { rows } = await db.query('select id, qty_ordered from public.purchase_items where purchase_id = $1', [purchaseId]);
  const { rows: [{ r }] } = await db.query('select public.receive_purchase($1, $2) as r', [{
    clientRequestId: randomUUID(), purchaseId, lines: rows.map((row) => ({ purchaseItemId: row.id, qty: Number(row.qty_ordered) }))
  }, user]);
  await db.query(`update public.goods_receipts set received_at = now() - ($1 || ' days')::interval where id = $2`, [receivedDaysAgo, r.id]);
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
  const category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  const tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  item = (await db.query('select public.create_product($1, $2) as id', [{ name: 'Item', categoryId: category, unitCode: 'Piece', taxRateId: tax, sellingPrice: 20 }, user])).rows[0].id;
});

test('a new supplier has empty figures, and on-time is unknown rather than zero', async () => {
  const s = await stats(await makeSupplier('Empty'));
  assert.deepEqual(s, { orders: 0, openOrders: 0, purchased: 0, paid: 0, balance: 0, judged: 0, onTimePercent: null, products: 0 });
});

test('on-time counts delivered and overdue orders, and ignores what cannot be judged', async () => {
  const id = await makeSupplier('Timing');
  await receiveAll(await order(id, { expectedAt: dayOffset(-2) }), 3); // On time.
  await receiveAll(await order(id, { expectedAt: dayOffset(-2) }), 2); // On the day.
  await receiveAll(await order(id, { expectedAt: dayOffset(-5) }), 1); // Late.
  await order(id, { expectedAt: dayOffset(-1) }); // Open and overdue: late.
  await order(id, { expectedAt: dayOffset(5) }); // Open, not yet due: left out.
  await receiveAll(await order(id), 1); // No expected date: left out.
  await order(id, { status: 'Draft', expectedAt: dayOffset(-9) }); // A draft: left out.
  const s = await stats(id);
  assert.equal(s.judged, 4);
  assert.equal(s.onTimePercent, 50);
  assert.equal(s.openOrders, 2);
});

test('a cancelled order counts for nothing', async () => {
  const id = await makeSupplier('Cancelling');
  const cancelled = await order(id, { expectedAt: dayOffset(-3) });
  await db.query(`update public.purchases set status = 'Cancelled' where id = $1`, [cancelled]);
  assert.deepEqual(await stats(id), { orders: 0, openOrders: 0, purchased: 0, paid: 0, balance: 0, judged: 0, onTimePercent: null, products: 0 });
});

test('balance is purchases less payments, leaving out drafts', async () => {
  const id = await makeSupplier('Owed');
  const first = await order(id, { qty: 10 });
  await order(id, { qty: 5 });
  await order(id, { qty: 100, status: 'Draft' });
  await db.query('select public.pay_supplier($1, $2)', [{ purchaseId: first, amount: 30, method: 'Cash' }, user]);
  const s = await stats(id);
  assert.equal(s.purchased, 150);
  assert.equal(s.paid, 30);
  assert.equal(s.balance, 120);
  assert.equal(s.orders, 3);
});

test('the list filters, searches and pages, with the full total', async () => {
  const off = await makeSupplier('Zeta Old', { city: 'Galle' });
  await db.query('update public.suppliers set active = false where id = $1', [off]);
  await makeSupplier('Zeta New', { city: 'Jaffna', phone: '0771112222', contactPerson: 'Ravi' });
  const list = async (search, status, limit = 50, offset = 0) => (await db.query('select public.supplier_list($1, $2, $3, $4) as r', [search, status, limit, offset])).rows[0].r;

  assert.deepEqual((await list('zeta', 'active')).rows.map((row) => row.name), ['Zeta New']);
  assert.deepEqual((await list('zeta', 'inactive')).rows.map((row) => row.name), ['Zeta Old']);
  assert.equal((await list('zeta', 'all')).rows.length, 2);
  for (const term of ['jaffna', '0771112', 'ravi']) assert.equal((await list(term, 'active')).total, 1, term);
  const paged = await list('', 'all', 1, 1);
  assert.equal(paged.rows.length, 1);
  assert.ok(paged.total > 1);
  assert.ok('balance' in paged.rows[0].stats);
  // The total owed covers every match, not just this page.
  const owed = await makeSupplier('Zeta Owed');
  await order(owed, { qty: 10 });
  const second = await makeSupplier('Zeta Owed Two');
  await order(second, { qty: 1 });
  const onePage = await list('zeta owed', 'all', 1, 0);
  assert.equal(onePage.rows.length, 1);
  assert.equal(onePage.balance, 110);
});

test('active suppliers cannot share a name, but a retired name can be reused', async () => {
  const first = await makeSupplier('Same Name');
  await assert.rejects(() => makeSupplier('same name'), /suppliers_active_name_key/);
  await db.query('update public.suppliers set active = false where id = $1', [first]);
  const second = await makeSupplier('Same Name');
  assert.ok(second);
  await assert.rejects(() => db.query('update public.suppliers set active = true where id = $1', [first]), /suppliers_active_name_key/);
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['supplier_stats(uuid)', 'supplier_list(text, text, integer, integer)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
