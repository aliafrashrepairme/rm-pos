import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATIONS = ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql', '0007_transactions.sql', '0008_purchases.sql', '0009_suppliers.sql', '0010_customers.sql', '0011_reports.sql', '0012_users_settings.sql', '0013_invoice_scans.sql'];

let db;
let user;
let supplier;
let hammer;
let nails;

const stock = async (id) => Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty);
const scanRow = async (id) => (await db.query('select * from public.invoice_scans where id = $1', [id])).rows[0];
const linesOf = async (id) => (await db.query('select * from public.invoice_scan_lines where invoice_scan_id = $1 order by line_no', [id])).rows;

async function newScan(result) {
  const id = randomUUID();
  await db.query(`insert into public.invoice_scans (id, file_path, file_name, mime_type, status, created_by) values ($1, 'p', 'inv.png', 'image/png', 'Processing', $2)`, [id, user]);
  await db.query('select public.save_invoice_extraction($1, $2, $3)', [id, result, 'Claude']);
  return id;
}

const RESULT = {
  supplierName: 'Lanka Hardware Supply', invoiceNo: 'INV-1', invoiceDate: '2026-03-02', subtotal: 100, tax: 18, total: 118, confidence: 88,
  lines: [
    { description: 'Claw Hammer 16oz', qty: 2, unitCost: 900, lineTotal: 1800, confidence: 95 },
    { description: 'Totally unrelated widget', qty: null, unitCost: null, lineTotal: null, confidence: 30 }
  ]
};
const review = (changes = {}) => ({ supplierId: supplier, invoiceNo: 'INV-R', invoiceDate: '2026-03-02', lines: [{ description: 'Claw Hammer', qty: 2, unitCost: 900, productId: hammer, confidence: 95 }], ...changes });
const approve = async (id, body) => (await db.query('select public.approve_invoice_scan($1, $2, $3) as r', [id, body, user])).rows[0].r;

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
  supplier = (await db.query('select public.create_supplier($1) as id', [{ name: 'Lanka Hardware' }])).rows[0].id;
  const category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  const tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  const make = async (name, extra = {}) => (await db.query('select public.create_product($1, $2) as id', [{ name, categoryId: category, unitCode: 'Piece', taxRateId: tax, sellingPrice: 20, openingStock: 5, ...extra }, user])).rows[0].id;
  hammer = await make('Claw Hammer 16oz');
  nails = await make('Wire Nails');
});

test('extraction stores what was read and suggests matches', async () => {
  const id = await newScan(RESULT);
  const scan = await scanRow(id);
  assert.equal(scan.status, 'Extracted');
  assert.equal(scan.provider, 'Claude');
  assert.equal(scan.invoice_no, 'INV-1');
  assert.equal(scan.supplier_id, supplier);
  assert.equal(Number(scan.overall_confidence), 88);
  const lines = await linesOf(id);
  assert.equal(lines[0].matched_product_id, hammer);
  assert.ok(Number(lines[0].match_score) > 90);
  assert.equal(lines[1].matched_product_id, null, 'an unrelated line is left for a person to match');
  assert.equal(lines[1].qty, null);
});

test('an exact SKU in the text beats a similar name', async () => {
  const { rows: [{ sku }] } = await db.query('select sku from public.products where id = $1', [nails]);
  const { rows } = await db.query('select * from public.match_invoice_text($1)', [`Claw Hammer 16oz ${sku}`]);
  assert.equal(rows[0].product_id, nails);
  assert.equal(Number(rows[0].score), 100);
});

test('an inactive product is never suggested', async () => {
  const category = (await db.query(`select category_id from public.products where id = $1`, [hammer])).rows[0].category_id;
  const tax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  const old = (await db.query('select public.create_product($1, $2) as id', [{ name: 'Retired Spanner Unique', categoryId: category, unitCode: 'Piece', taxRateId: tax, sellingPrice: 20 }, user])).rows[0].id;
  await db.query('update public.products set active = false where id = $1', [old]);
  const { rows } = await db.query('select * from public.match_invoice_text($1)', ['Retired Spanner Unique']);
  assert.equal(rows.length, 0);
});

test('a scan not being processed cannot take a result', async () => {
  const id = await newScan(RESULT);
  await assert.rejects(() => db.query('select public.save_invoice_extraction($1, $2, $3)', [id, RESULT, 'Claude']), /no longer being processed/);
});

test('corrections replace what was read', async () => {
  const id = await newScan(RESULT);
  await db.query('select public.save_invoice_review($1, $2)', [id, review({ invoiceNo: ' FIXED ', lines: [{ description: 'Corrected', qty: 3, unitCost: 10, productId: nails }] })]);
  assert.equal((await scanRow(id)).invoice_no, 'FIXED');
  const lines = await linesOf(id);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].raw_text, Number(lines[0].qty), lines[0].matched_product_id], ['Corrected', 3, nails]);
  await assert.rejects(() => db.query('select public.save_invoice_review($1, $2)', [id, review({ lines: [] })]), /at least one line/);
});

test('approval needs a supplier, a number and every line complete', async () => {
  const id = await newScan(RESULT);
  await assert.rejects(() => approve(id, review({ supplierId: '' })), /Choose the supplier/);
  await assert.rejects(() => approve(id, review({ invoiceNo: ' ' })), /invoice number/);
  await assert.rejects(() => approve(id, review({ lines: [{ description: 'x', qty: 1, unitCost: 1, productId: '' }] })), /Match every line/);
  await assert.rejects(() => approve(id, review({ lines: [{ description: 'x', qty: '', unitCost: 1, productId: hammer }] })), /quantity and unit cost/);
  assert.equal((await scanRow(id)).status, 'Extracted', 'a refused approval changes nothing');
});

test('approval creates one order and leaves stock alone until it is received', async () => {
  const id = await newScan(RESULT);
  const before = await stock(hammer);
  const result = await approve(id, review({ invoiceNo: 'INV-STOCK' }));
  assert.equal(await stock(hammer), before, 'approving must not change stock');
  const scan = await scanRow(id);
  assert.equal(scan.status, 'Approved');
  assert.equal(scan.purchase_id, result.purchaseId);
  const { rows: [order] } = await db.query('select * from public.purchases where id = $1', [result.purchaseId]);
  assert.deepEqual([order.status, order.source, order.supplier_invoice_no, Number(order.total)], ['Ordered', 'AI Scan', 'INV-STOCK', 1800]);
  await assert.rejects(() => approve(id, review({ invoiceNo: 'INV-AGAIN' })), /already been approved/);

  const { rows: [line] } = await db.query('select id, qty_ordered from public.purchase_items where purchase_id = $1', [result.purchaseId]);
  await db.query('select public.receive_purchase($1, $2)', [{ clientRequestId: randomUUID(), purchaseId: result.purchaseId, lines: [{ purchaseItemId: line.id, qty: 2 }] }, user]);
  assert.equal(await stock(hammer), before + 2);
});

test('the same invoice cannot be approved twice from two scans', async () => {
  const first = await newScan(RESULT);
  const second = await newScan(RESULT);
  await approve(first, review({ invoiceNo: 'INV-DUP' }));
  await assert.rejects(() => approve(second, review({ invoiceNo: 'INV-DUP' })), /purchases_supplier_invoice_key/);
  assert.equal((await scanRow(second)).status, 'Extracted');
});

test('the public API roles cannot run these functions', async () => {
  for (const signature of ['match_invoice_text(text)', 'save_invoice_extraction(uuid, jsonb, text)', 'save_invoice_review(uuid, jsonb)', 'approve_invoice_scan(uuid, jsonb, uuid)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, api: true }, signature);
  }
});
