import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { bestOffer, cartTotals } from '../../src/features/pos/totals.js';

const read = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

let db;
let cashier;
let category;
let standardTax;
let zeroTax;

async function product(name, { price = 100, cost = 50, stock = 100, tax = standardTax, unit = 'Piece', active = true } = {}) {
  const { rows } = await db.query('select public.create_product($1, $2) as id', [
    { name, categoryId: category, unitCode: unit, taxRateId: tax, costPrice: cost, sellingPrice: price, openingStock: stock },
    cashier
  ]);
  if (!active) await db.query('update public.products set active = false where id = $1', [rows[0].id]);
  return rows[0].id;
}

async function customer({ points = 0, purchases = 0 } = {}) {
  const id = (await db.query('select public.create_customer($1, $2) as id', ['Customer', '077'])).rows[0].id;
  await db.query('update public.customers set loyalty_points = $1, purchase_count = $2 where id = $3', [points, purchases, id]);
  return id;
}

const cash = (amountTendered) => ({ method: 'Cash', amountTendered });

async function sell(items, { total, payment, customerId, couponCode, requestId = randomUUID() }) {
  const { rows } = await db.query('select public.create_sale($1, $2) as r', [
    { clientRequestId: requestId, items, expectedTotal: total, payment: payment ?? cash(total), customerId, couponCode },
    cashier
  ]);
  return rows[0].r;
}

const stock = async (id) => Number((await db.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty);
const saleRow = async (id) => (await db.query('select * from public.sales where id = $1', [id])).rows[0];
const counts = async () => (await db.query(`select
  (select count(*)::int from public.sales) as sales,
  (select count(*)::int from public.sale_items) as items,
  (select count(*)::int from public.payments) as payments,
  (select count(*)::int from public.inventory_ledger) as ledger`)).rows[0];

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key);
  `);
  for (const file of ['0001_core_schema.sql', '0002_dashboard.sql', '0003_products.sql', '0004_inventory.sql', '0005_barcode_counts.sql', '0006_pos.sql']) {
    await db.exec(await read(file));
  }
  cashier = randomUUID();
  await db.query('insert into auth.users (id) values ($1)', [cashier]);
  await db.query(`insert into public.profiles (id, username, full_name, email, role_code) values ($1, 'cashier', 'Test Cashier', 'c@example.com', 'Cashier')`, [cashier]);
  category = (await db.query(`insert into public.categories (name) values ('Tools') returning id`)).rows[0].id;
  standardTax = (await db.query('select id from public.tax_rates where is_default')).rows[0].id;
  zeroTax = (await db.query(`select id from public.tax_rates where rate = 0`)).rows[0].id;
});

test('a sale records totals, lines, payment, change, stock and ledger together', async () => {
  const hammer = await product('Hammer', { price: 1450, cost: 980, stock: 10 });
  const result = await sell([{ productId: hammer, qty: 2 }], { total: 3422, payment: cash(4000) });
  assert.match(result.billNo, /^RM-INV-\d{6}$/);
  assert.equal(result.replayed, false);

  const sale = await saleRow(result.id);
  assert.equal(Number(sale.subtotal), 2900);
  assert.equal(Number(sale.tax_total), 522);
  assert.equal(Number(sale.grand_total), 3422);
  assert.equal(sale.status, 'Paid');
  assert.equal(sale.customer_name, 'Walk-in Customer');
  assert.equal(sale.cashier_id, cashier);

  const line = (await db.query('select * from public.sale_items where sale_id = $1', [result.id])).rows[0];
  assert.equal(line.name, 'Hammer');
  assert.equal(Number(line.unit_price), 1450);
  assert.equal(Number(line.unit_cost), 980);
  assert.equal(Number(line.line_total), 3422);

  const payment = (await db.query('select * from public.payments where sale_id = $1', [result.id])).rows[0];
  assert.equal(Number(payment.amount), 3422);
  assert.equal(Number(payment.amount_tendered), 4000);
  assert.equal(Number(payment.change_given), 578);

  assert.equal(await stock(hammer), 8);
  const ledger = (await db.query(`select * from public.inventory_ledger where product_id = $1 and movement_type = 'Sale'`, [hammer])).rows[0];
  assert.equal(Number(ledger.change_qty), -2);
  assert.equal(ledger.reference_no, result.billNo);
  assert.equal(ledger.created_by, cashier);
});

test('a repeated request returns the first sale and charges nothing again', async () => {
  const item = await product('Retry', { stock: 5, tax: zeroTax });
  const requestId = randomUUID();
  const first = await sell([{ productId: item, qty: 1 }], { total: 100, requestId });
  const before = await counts();
  const second = await sell([{ productId: item, qty: 1 }], { total: 100, requestId });
  assert.equal(second.id, first.id);
  assert.equal(second.billNo, first.billNo);
  assert.equal(second.replayed, true);
  assert.deepEqual(await counts(), before);
  assert.equal(await stock(item), 4);
});

test('selling more than is in stock fails and leaves no trace', async () => {
  const scarce = await product('Scarce', { stock: 2, tax: zeroTax });
  const other = await product('Other', { stock: 9, tax: zeroTax });
  const before = await counts();
  const sequence = (await db.query(`select next_value from public.number_sequences where prefix = 'RM-INV-'`)).rows[0].next_value;
  await assert.rejects(() => sell([{ productId: other, qty: 1 }, { productId: scarce, qty: 3 }], { total: 400 }), /INSUFFICIENT_STOCK/);
  assert.deepEqual(await counts(), before);
  assert.equal(await stock(other), 9);
  assert.equal((await db.query(`select next_value from public.number_sequences where prefix = 'RM-INV-'`)).rows[0].next_value, sequence, 'no bill number is used up');
});

test('the total the cashier saw must match, so a price change stops the sale', async () => {
  const item = await product('Repriced', { price: 100, tax: zeroTax, stock: 5 });
  await db.query('update public.products set selling_price = 120 where id = $1', [item]);
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 100 }), /Prices or offers have changed/);
  await assert.rejects(() => db.query('select public.create_sale($1, $2)', [{ clientRequestId: randomUUID(), items: [{ productId: item, qty: 1 }], payment: cash(500) }, cashier]), /Prices or offers have changed/);
  assert.equal(await stock(item), 5);
  await sell([{ productId: item, qty: 1 }], { total: 120 });
  assert.equal(await stock(item), 4);
});

test('payment rules are enforced', async () => {
  const item = await product('Pay', { stock: 20, tax: zeroTax });
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 100, payment: cash(99.99) }), /less than the total/);
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 100, payment: { method: 'Cash' } }), /less than the total/);
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 100, payment: { method: 'Crypto' } }), /valid payment method/);
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 100, payment: { method: 'Bank transfer' } }), /payment reference/);
  assert.equal(await stock(item), 20);

  const exact = await sell([{ productId: item, qty: 1 }], { total: 100, payment: cash(100) });
  assert.equal(Number((await db.query('select change_given from public.payments where sale_id = $1', [exact.id])).rows[0].change_given), 0);
  const card = await sell([{ productId: item, qty: 1 }], { total: 100, payment: { method: 'Card', amountTendered: 5000 } });
  const row = (await db.query('select amount_tendered, change_given from public.payments where sale_id = $1', [card.id])).rows[0];
  assert.equal(row.amount_tendered, null, 'cards have no tendered amount or change');
  assert.equal(Number(row.change_given), 0);
  const bank = await sell([{ productId: item, qty: 1 }], { total: 100, payment: { method: 'Bank transfer', reference: 'TX-1' } });
  assert.equal((await db.query('select reference from public.payments where sale_id = $1', [bank.id])).rows[0].reference, 'TX-1');
});

test('bad bills are refused', async () => {
  const item = await product('Bad bill', { stock: 5, tax: zeroTax });
  const gone = await product('Retired', { stock: 5, tax: zeroTax, active: false });
  await assert.rejects(() => sell([], { total: 0 }), /bill is empty/);
  await assert.rejects(() => sell([{ productId: item, qty: 1 }, { productId: item, qty: 1 }], { total: 200 }), /appears twice/);
  await assert.rejects(() => sell([{ productId: item, qty: 0 }], { total: 0 }), /valid quantity/);
  await assert.rejects(() => sell([{ productId: item, qty: -1 }], { total: -100 }), /valid quantity/);
  await assert.rejects(() => sell([{ productId: item, qty: 1.5 }], { total: 150 }), /whole units/);
  await assert.rejects(() => sell([{ productId: gone, qty: 1 }], { total: 100 }), /no longer for sale/);
  await assert.rejects(() => sell([{ productId: randomUUID(), qty: 1 }], { total: 100 }), /Product not found/);
});

test('metre products sell in fractions', async () => {
  const wire = await product('Wire', { price: 200, stock: 10, unit: 'Metre', tax: zeroTax });
  await sell([{ productId: wire, qty: 2.5 }], { total: 500 });
  assert.equal(await stock(wire), 7.5);
});

test('loyalty tiers set the discount, and points follow the amount paid', async () => {
  const item = await product('Loyal', { price: 1000, tax: zeroTax, stock: 100 });
  const cases = [
    { points: 0, purchases: 1, total: 970, label: 'Bronze member offer', earned: 9 },
    { points: 399, purchases: 1, total: 970, label: 'Bronze member offer', earned: 9 },
    { points: 400, purchases: 1, total: 950, label: 'Silver member offer', earned: 9 },
    { points: 999, purchases: 1, total: 950, label: 'Silver member offer', earned: 9 },
    { points: 1000, purchases: 1, total: 930, label: 'Gold member offer', earned: 18 }
  ];
  for (const { points, purchases, total, label, earned } of cases) {
    const customerId = await customer({ points, purchases });
    const { id } = await sell([{ productId: item, qty: 1 }], { total, customerId });
    const sale = await saleRow(id);
    assert.equal(sale.discount_label, label);
    assert.equal(sale.points_earned, earned);
    const after = (await db.query('select loyalty_points, purchase_count from public.customers where id = $1', [customerId])).rows[0];
    assert.equal(after.loyalty_points, points + earned);
    assert.equal(after.purchase_count, purchases + 1);
  }
});

test('WELCOME10 works once, only for a first purchase by a known customer', async () => {
  const item = await product('Welcome', { price: 1000, tax: zeroTax, stock: 100 });
  const newCustomer = await customer();
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 900, couponCode: 'WELCOME10' }), /first-time buyers/, 'walk-in');
  const first = await sell([{ productId: item, qty: 1 }], { total: 900, customerId: newCustomer, couponCode: 'welcome10' });
  assert.equal((await saleRow(first.id)).discount_label, 'Coupon WELCOME10');
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 900, customerId: newCustomer, couponCode: 'WELCOME10' }), /first-time buyers/, 'second use');
  await assert.rejects(() => sell([{ productId: item, qty: 1 }], { total: 900, couponCode: 'FAKE' }), /not valid/);
  const noOffer = await customer();
  const plain = await sell([{ productId: item, qty: 1 }], { total: 1000, customerId: noOffer });
  assert.equal(Number((await saleRow(plain.id)).discount_total), 0);
});

test('tax applies after the discount, per line', async () => {
  const item = await product('Taxed', { price: 1000, stock: 10 });
  const customerId = await customer({ points: 1000, purchases: 5 });
  const { id } = await sell([{ productId: item, qty: 1 }], { total: 1097.4, customerId });
  const sale = await saleRow(id);
  assert.equal(Number(sale.discount_total), 70);
  assert.equal(Number(sale.tax_total), 167.4);
});

test('the screen and the database agree to the cent across random carts', async () => {
  // A fixed seed, so a failure can be reproduced.
  let seed = 20261030;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const taxes = [{ id: standardTax, rate: 18 }, { id: zeroTax, rate: 0 }];
  const prices = [0.01, 0.05, 0.33, 1.005, 12.35, 99.99, 120, 450.55, 780.49, 1450.5, 2850.75, 18900.99];
  const quantities = [0.001, 0.333, 1.5, 2.25, 3.125];

  for (let cart = 0; cart < 40; cart += 1) {
    const lines = [];
    for (let index = 0; index < 1 + Math.floor(random() * 4); index += 1) {
      const tax = taxes[Math.floor(random() * taxes.length)];
      const price = Math.round(prices[Math.floor(random() * prices.length)] * 100) / 100;
      const qty = random() < 0.5 ? 1 + Math.floor(random() * 9) : quantities[Math.floor(random() * quantities.length)];
      const id = await product(`Random ${cart}-${index}`, { price, stock: 1000, tax: tax.id, unit: 'Metre' });
      lines.push({ productId: id, qty, price, taxRate: tax.rate });
    }
    const customerSetup = [null, { points: 10, purchases: 1 }, { points: 500, purchases: 1 }, { points: 2000, purchases: 1 }][cart % 4];
    const customerId = customerSetup ? await customer(customerSetup) : undefined;
    const offer = bestOffer(customerSetup && { loyaltyPoints: customerSetup.points, purchaseCount: customerSetup.purchases });
    const screen = cartTotals(lines, offer.rate);
    const { id } = await sell(lines.map(({ productId, qty }) => ({ productId, qty })), { total: screen.total, customerId, payment: cash(screen.total + 10) });
    const sale = await saleRow(id);
    assert.equal(Number(sale.subtotal), screen.subtotal, `cart ${cart} subtotal`);
    assert.equal(Number(sale.discount_total), screen.discount, `cart ${cart} discount`);
    assert.equal(Number(sale.tax_total), screen.tax, `cart ${cart} tax`);
    assert.equal(Number(sale.grand_total), screen.total, `cart ${cart} total`);
  }
});

test('held orders keep products, customer and coupon, and take no stock', async () => {
  const item = await product('Held', { stock: 5 });
  const customerId = await customer();
  const id = (await db.query('select public.hold_order($1, $2) as id', [{ customerId, couponCode: 'welcome10', items: [{ productId: item, qty: 2 }] }, cashier])).rows[0].id;
  const held = (await db.query('select * from public.held_orders where id = $1', [id])).rows[0];
  assert.match(held.hold_no, /^H-\d{6}$/);
  assert.equal(held.status, 'Held');
  assert.equal(held.coupon_code, 'WELCOME10');
  assert.equal(held.customer_name, 'Customer');
  assert.equal(Number((await db.query('select qty from public.held_order_items where held_order_id = $1', [id])).rows[0].qty), 2);
  assert.equal(await stock(item), 5);
  await assert.rejects(() => db.query('select public.hold_order($1, $2)', [{ items: [] }, cashier]), /at least one product/);
});

test('customers get sequential codes', async () => {
  const first = (await db.query('select public.create_customer($1, $2) as id', ['  Ravi  ', ' 077 '])).rows[0].id;
  const row = (await db.query('select code, name, phone from public.customers where id = $1', [first])).rows[0];
  assert.match(row.code, /^CUS-\d{6}$/);
  assert.equal(row.name, 'Ravi');
  assert.equal(row.phone, '077');
});

test('the public API roles cannot run POS functions', async () => {
  for (const signature of ['create_sale(jsonb, uuid)', 'hold_order(jsonb, uuid)', 'create_customer(text, text)']) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${signature}', 'execute') as anon,
      has_function_privilege('authenticated', 'public.${signature}', 'execute') as signed_in,
      has_function_privilege('service_role', 'public.${signature}', 'execute') as api`);
    assert.deepEqual(rows[0], { anon: false, signed_in: false, api: true }, signature);
  }
});
