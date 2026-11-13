import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql'];

let db;
let user;
let category;
let tax;
let supplier;

const makeSupplier = async (name = 'Supplier') => (await db.query('select public.create_supplier($1) as id', [{ name }])).rows[0].id;

async function product(name, { stock = 0, min = 0, cost = 100, unit = 'Piece', supplierId = null } = {}) {
  return (await db.query('select public.create_product($1, $2) as id', [{
    name, categoryId: category, unitCode: unit, taxRateId: tax, costPrice: cost, sellingPrice: cost * 2, openingStock: stock, minStock: min, preferredSupplierId: supplierId
  }, user])).rows[0].id;
}

async function order(items, { status = 'Ordered', supplierId = supplier, ...rest } = {}) {
  return (await db.query('select public.create_purchase($1, $2) as id', [{ supplierId, status, items, ...rest }, user])).rows[0].id;
}

const lines = async (id) => (await db.query('select * from public.purchase_items where purchase_id = $1 order by line_no', [id])).rows;
const row = async (id) => (await db.query('select * from public.purchases where id = $1', [id])).rows[0];
const stock = async (id) => Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty);

async function receive(purchaseId, entries, requestId = randomUUID()) {
  return (await db.query('select public.receive_purchase($1, $2) as r', [{ clientRequestId: requestId, purchaseId, lines: entries }, user])).rows[0].r;
}
const pay = async (purchaseId, amount, method = 'Cash') => (await db.query('select public.pay_supplier($1, $2) as r', [{ purchaseId, amount, method }, user])).rows[0].r;

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
  supplier = await makeSupplier('Main');
});

test('creating and sending an order changes no stock', async () => {
  const item = await product('No stock yet', { stock: 5 });
  const id = await order([{ productId: item, qty: 10, unitCost: 80 }]);
  const purchase = await row(id);
  assert.match(purchase.po_no, /^PO-\d{6}$/);
  assert.equal(purchase.status, 'Ordered');
  assert.equal(Number(purchase.total), 800);
  assert.ok(purchase.ordered_at);
  assert.equal(await stock(item), 5);
  assert.equal((await db.query(`select count(*)::int as n from public.inventory_ledger where product_id = $1 and movement_type = 'Purchase'`, [item])).rows[0].n, 0);
});

test('a delivery adds stock to the ledger and sets the latest cost', async () => {
  const item = await product('Received', { stock: 5, cost: 100 });
  const id = await order([{ productId: item, qty: 10, unitCost: 80 }]);
  const [line] = await lines(id);
  const result = await receive(id, [{ purchaseItemId: line.id, qty: 10 }]);
  assert.match(result.grnNo, /^GRN-\d{6}$/);
  assert.equal(result.status, 'Received');
  assert.equal(await stock(item), 15);
  const ledger = (await db.query(`select * from public.inventory_ledger where product_id = $1 and movement_type = 'Purchase'`, [item])).rows[0];
  assert.equal(Number(ledger.previous_qty), 5);
  assert.equal(Number(ledger.new_qty), 15);
  assert.equal(Number(ledger.unit_cost), 80);
  assert.equal(ledger.reference_no, result.grnNo);
  assert.equal(ledger.created_by, user);
  assert.equal(Number((await db.query('select cost_price from public.products where id = $1', [item])).rows[0].cost_price), 80);
});

test('partial deliveries add up, and receiving stops at the amount ordered', async () => {
  const item = await product('Partial', { stock: 0 });
  const other = await product('Other', { stock: 0 });
  const id = await order([{ productId: item, qty: 10, unitCost: 10 }, { productId: other, qty: 2, unitCost: 10 }]);
  const [first, second] = await lines(id);

  assert.equal((await receive(id, [{ purchaseItemId: first.id, qty: 4 }])).status, 'Partially Received');
  assert.equal(await stock(item), 4);
  await assert.rejects(() => receive(id, [{ purchaseItemId: first.id, qty: 7 }]), /Only 6\.000 of Partial is still due/);
  assert.equal(await stock(item), 4);

  assert.equal((await receive(id, [{ purchaseItemId: first.id, qty: 6 }])).status, 'Partially Received');
  const done = await receive(id, [{ purchaseItemId: second.id, qty: 2 }]);
  assert.equal(done.status, 'Received');
  assert.equal(await stock(item), 10);
  await assert.rejects(() => receive(id, [{ purchaseItemId: first.id, qty: 1 }]), /Only an open order can be received/);
  assert.equal(await stock(item), 10);
});

test('a repeated delivery request adds stock only once', async () => {
  const item = await product('Retry');
  const id = await order([{ productId: item, qty: 10, unitCost: 10 }]);
  const [line] = await lines(id);
  const requestId = randomUUID();
  const first = await receive(id, [{ purchaseItemId: line.id, qty: 3 }], requestId);
  const second = await receive(id, [{ purchaseItemId: line.id, qty: 3 }], requestId);
  assert.equal(second.replayed, true);
  assert.equal(second.grnNo, first.grnNo);
  assert.equal(await stock(item), 3);
  assert.equal(Number((await lines(id))[0].qty_received), 3);
});

test('a failing line undoes the whole delivery', async () => {
  const good = await product('Good line');
  const bad = await product('Bad line');
  const id = await order([{ productId: good, qty: 5, unitCost: 10 }, { productId: bad, qty: 1, unitCost: 10 }]);
  const [first, second] = await lines(id);
  await assert.rejects(() => receive(id, [{ purchaseItemId: first.id, qty: 5 }, { purchaseItemId: second.id, qty: 9 }]), /still due/);
  assert.equal(await stock(good), 0);
  assert.equal((await db.query('select count(*)::int as n from public.goods_receipts where purchase_id = $1', [id])).rows[0].n, 0);
});

test('drafts, cancelled orders and foreign lines cannot be received', async () => {
  const item = await product('Rules');
  const draft = await order([{ productId: item, qty: 1, unitCost: 1 }], { status: 'Draft' });
  const [draftLine] = await lines(draft);
  await assert.rejects(() => receive(draft, [{ purchaseItemId: draftLine.id, qty: 1 }]), /Only an open order.*Draft/);

  const open = await order([{ productId: item, qty: 1, unitCost: 1 }]);
  await assert.rejects(() => receive(open, [{ purchaseItemId: draftLine.id, qty: 1 }]), /not on the order/);
  await assert.rejects(() => receive(open, []), /at least one product/);
  await assert.rejects(() => receive(randomUUID(), [{ purchaseItemId: draftLine.id, qty: 1 }]), /Purchase order not found/);
  const [openLine] = await lines(open);
  await assert.rejects(() => receive(open, [{ purchaseItemId: openLine.id, qty: 0 }]), /valid quantity/);
  await assert.rejects(() => receive(open, [{ purchaseItemId: openLine.id, qty: 1 }, { purchaseItemId: openLine.id, qty: 1 }]), /appears twice/);
  assert.equal(await stock(item), 0);
});

test('bad orders are refused', async () => {
  const item = await product('Bad order');
  const retired = await product('Retired');
  await db.query('update public.products set active = false where id = $1', [retired]);
  await assert.rejects(() => order([]), /at least one product/);
  await assert.rejects(() => order([{ productId: item, qty: 0, unitCost: 1 }]), /valid quantity/);
  await assert.rejects(() => order([{ productId: item, qty: 1, unitCost: -1 }]), /valid cost/);
  await assert.rejects(() => order([{ productId: item, qty: 1.5, unitCost: 1 }]), /whole units/);
  await assert.rejects(() => order([{ productId: item, qty: 1, unitCost: 1 }, { productId: item, qty: 1, unitCost: 1 }]), /appears twice/);
  await assert.rejects(() => order([{ productId: retired, qty: 1, unitCost: 1 }]), /not active/);
  await assert.rejects(() => order([{ productId: item, qty: 1, unitCost: 1 }], { supplierId: randomUUID() }), /active supplier/);
  await assert.rejects(() => order([{ productId: item, qty: 1, unitCost: 1 }], { status: 'Received' }), /draft or an order/);
});

test('one supplier invoice number cannot be recorded twice', async () => {
  const item = await product('Invoice');
  await order([{ productId: item, qty: 1, unitCost: 1 }], { supplierInvoiceNo: 'INV-7' });
  await assert.rejects(() => order([{ productId: item, qty: 1, unitCost: 1 }], { supplierInvoiceNo: 'inv-7' }), /purchases_supplier_invoice_key/);
  await order([{ productId: item, qty: 1, unitCost: 1 }], { supplierInvoiceNo: 'INV-7', supplierId: await makeSupplier('Other') });
});

test('payments reduce what is owed and cannot exceed it', async () => {
  const item = await product('Pay');
  const id = await order([{ productId: item, qty: 10, unitCost: 100 }]);
  const first = await pay(id, 400);
  assert.match(first.paymentNo, /^SP-\d{6}$/);
  assert.equal(Number((await row(id)).paid_total), 400);
  await assert.rejects(() => pay(id, 600.01), /Only 600\.00 is still owed/);
  await assert.rejects(() => pay(id, 0), /valid amount/);
  await assert.rejects(() => pay(id, 1, 'Crypto'), /valid payment method/);
  await pay(id, 600, 'Cheque');
  await assert.rejects(() => pay(id, 1), /Only 0\.00 is still owed/);
  const recorded = (await db.query('select amount, method, supplier_id from public.supplier_payments where purchase_id = $1 order by amount', [id])).rows;
  assert.deepEqual(recorded.map((entry) => [Number(entry.amount), entry.method, entry.supplier_id]), [[400, 'Cash', supplier], [600, 'Cheque', supplier]]);

  const draft = await order([{ productId: item, qty: 1, unitCost: 1 }], { status: 'Draft' });
  await assert.rejects(() => pay(draft, 1), /cannot take a payment/);
  assert.equal(await stock(item), 0, 'paying changes no stock');
});

test('suggestions and auto-reorder cover low items not already on order', async () => {
  const own = await makeSupplier('Reorder Co');
  const low = await product('Low item', { stock: 2, min: 10, cost: 50, supplierId: own });
  const out = await product('Out item', { stock: 0, min: 4, cost: 20, supplierId: own });
  await product('Healthy item', { stock: 50, min: 10, supplierId: own });
  await product('Zero level', { stock: 0, min: 0, cost: 5, supplierId: await makeSupplier('Quiet Co') });
  const onOrder = await product('Already on order', { stock: 0, min: 5, supplierId: own });
  await order([{ productId: onOrder, qty: 5, unitCost: 1 }], { supplierId: own });

  const suggestions = (await db.query('select public.reorder_suggestions($1) as r', [own])).rows[0].r;
  assert.deepEqual(suggestions.map((item) => [item.name, item.qty]), [['Low item', 18], ['Out item', 8]]);

  const before = (await db.query('select count(*)::int as n from public.purchases')).rows[0].n;
  const first = (await db.query('select public.auto_reorder($1) as r', [user])).rows[0].r;
  assert.equal(first.created.length, 2, 'one draft per supplier with low items');
  assert.ok(first.withoutSupplier >= 0);
  assert.equal((await db.query('select count(*)::int as n from public.purchases')).rows[0].n, before + 2);
  const draft = (await db.query(`select * from public.purchases where po_no = any($1) and supplier_id = $2`, [first.created, own])).rows[0];
  assert.equal(draft.status, 'Draft');
  assert.equal(draft.source, 'Auto-reorder');
  assert.equal(Number(draft.total), 18 * 50 + 8 * 20);
  assert.equal(await stock(low), 2);
  assert.equal(await stock(out), 0);

  const second = (await db.query('select public.auto_reorder($1) as r', [user])).rows[0].r;
  assert.deepEqual(second.created, [], 'a second run does not order the same items again');
});

test('the summary counts what is awaited, owed and drafted', async () => {
  const fresh = new PGlite({ extensions: { pg_trgm } });
  await fresh.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of MIGRATIONS) await fresh.exec(await read(file));
  const owner = randomUUID();
  await fresh.query('insert into auth.users (id) values ($1)', [owner]);
  await fresh.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'xxx', 'X', 'x@example.com', 'Manager')`, [owner]);
  const cat = (await fresh.query(`insert into public.categories (name) values ('T') returning id`)).rows[0].id;
  const rate = (await fresh.query('select id from public.tax_rates where is_default')).rows[0].id;
  const item = (await fresh.query('select public.create_product($1, $2) as id', [{ name: 'I', categoryId: cat, unitCode: 'Piece', taxRateId: rate, sellingPrice: 1 }, owner])).rows[0].id;
  const sup = (await fresh.query('select public.create_supplier($1) as id', [{ name: 'S' }])).rows[0].id;
  const make = async (status, qty) => (await fresh.query('select public.create_purchase($1, $2) as id', [{ supplierId: sup, status, items: [{ productId: item, qty, unitCost: 10 }] }, owner])).rows[0].id;
  await make('Draft', 100);
  const open = await make('Ordered', 10);
  const [line] = (await fresh.query('select id from public.purchase_items where purchase_id = $1', [open])).rows;
  await fresh.query('select public.receive_purchase($1, $2)', [{ clientRequestId: randomUUID(), purchaseId: open, lines: [{ purchaseItemId: line.id, qty: 4 }] }, owner]);
  await fresh.query('select public.pay_supplier($1, $2)', [{ purchaseId: open, amount: 30, method: 'Cash' }, owner]);
  const summary = (await fresh.query('select public.purchases_summary() as s')).rows[0].s;
  assert.deepEqual(summary, { awaiting: 60, openOrders: 1, payable: 70, drafts: 1 });
  await fresh.close();
});

test('the public API roles cannot run purchase functions', async () => {
  for (const signature of ['create_purchase(jsonb, uuid)', 'receive_purchase(jsonb, uuid)', 'pay_supplier(jsonb, uuid)', 'auto_reorder(uuid)', 'create_supplier(jsonb)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('authenticated', 'public.${signature}', 'execute') as signed_in,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, signed_in: false, api: true }, signature);
  }
});
