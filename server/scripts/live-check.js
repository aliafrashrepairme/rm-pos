// Tests login and permissions against the real Supabase project, using four dedicated smoke accounts.
// They get a new random password on each run and are disabled again afterwards.
// Their rows stay, because the audit log they appear in can't be edited.
// Usage: npm --prefix server run test:live
// Add -- --with-sales to also make real test sales, which stay in the sales records permanently.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { loadEnvFile, readConfig } from '../config.js';
import { createClients } from '../db.js';
import { NO_EMAIL_DOMAIN } from '../services/auth.js';

const ACCOUNTS = { Owner: 'smoke.owner', Manager: 'smoke.manager', Cashier: 'smoke.cashier', 'Inventory Staff': 'smoke.stock' };
// Route, then the roles allowed to use it. Everyone else must get 403.
const ACCESS = [
  ['/api/dashboard', ['Manager']],
  ['/api/products', ['Manager', 'Inventory Staff']],
  ['/api/transactions/daily', ['Owner', 'Manager']],
  ['/api/transactions/monthly', ['Owner', 'Manager']],
  ['/api/transactions/bills', ['Owner', 'Manager', 'Cashier']],
  ['/api/purchases', ['Manager', 'Inventory Staff']],
  ['/api/purchases/summary', ['Manager', 'Inventory Staff']],
  ['/api/pos/catalog', ['Cashier']],
  ['/api/pos/options', ['Cashier']],
  ['/api/pos/held', ['Cashier']],
  ['/api/inventory/stock', ['Manager', 'Inventory Staff']],
  ['/api/inventory/summary', ['Manager', 'Inventory Staff']],
  ['/api/inventory/movements', ['Manager', 'Inventory Staff']],
  ['/api/inventory/counts', ['Manager', 'Inventory Staff']],
  ['/api/inventory/adjustments', ['Manager']],
  ['/api/products/options', ['Manager', 'Inventory Staff']],
  ['/api/reports/sales', ['Owner', 'Manager']],
  ['/api/reports/products', ['Owner', 'Manager', 'Inventory Staff']],
  ['/api/reports/stock-movements', ['Owner', 'Manager', 'Inventory Staff']]
];

loadEnvFile();
const config = readConfig();
const clients = createClients(config);
const { database } = clients;
const password = () => `Smoke-${randomBytes(12).toString('hex')}`;
const accounts = {};
let passed = 0;

async function check(name, run) {
  await run();
  passed += 1;
  console.log(`ok   ${name}`);
}

async function ensureAccount(role, username) {
  const email = `${username}@${NO_EMAIL_DOMAIN}`;
  const secret = password();
  const existing = await database.from('profiles').select('id').eq('username', username).maybeSingle();
  let id = existing.data?.id;
  if (id) {
    const updated = await database.auth.admin.updateUserById(id, { password: secret });
    if (updated.error) throw updated.error;
  } else {
    const created = await database.auth.admin.createUser({ email, password: secret, email_confirm: true });
    if (created.error) throw created.error;
    id = created.data.user.id;
  }
  const saved = await database.from('profiles').upsert({
    id, username, full_name: `Smoke ${role}`, email, role_code: role, active: true, must_change_password: false
  });
  if (saved.error) throw saved.error;
  accounts[role] = { id, username, email, password: secret };
}

// A brief network or database outage must not leave working test logins behind.
async function withRetry(label, run, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await run();
      if (result?.error) throw new Error(result.error.message || 'request failed');
      return result;
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${label}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function disableAccounts() {
  for (const account of Object.values(accounts)) {
    await withRetry(`disable ${account.username}`, () => database.from('profiles').update({ active: false, must_change_password: false }).eq('id', account.id));
    await withRetry(`reset ${account.username}`, () => database.auth.admin.updateUserById(account.id, { password: password() }));
  }
  const { data } = await withRetry('confirm accounts', () => database.from('profiles').select('username, active').in('id', Object.values(accounts).map((account) => account.id)));
  const stillOn = data.filter((row) => row.active).map((row) => row.username);
  if (stillOn.length) throw new Error(`TEST ACCOUNTS STILL ENABLED: ${stillOn.join(', ')}`);
}

async function deactivateTestData() {
  const { data } = await withRetry('find test product', () => database.from('products').select('id, category_id').eq('sku', 'SMOKE-1').maybeSingle());
  if (!data) return;
  await withRetry('deactivate test product', () => database.from('products').update({ active: false }).eq('id', data.id));
  await withRetry('deactivate test category', () => database.from('categories').update({ active: false }).eq('id', data.category_id));
}

const server = createApp({ config, ...clients }).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function request(path, { token, body, method } = {}) {
  return fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });
}

async function signIn(identifier, secret) {
  const response = await request('/api/auth/login', { body: { identifier, password: secret } });
  assert.equal(response.status, 200, `login for ${identifier}`);
  return response.json();
}

// Uses one permanent test product, left inactive afterwards so it doesn't count as stock.
async function productChecks(sessions) {
  const token = sessions['Inventory Staff'].token;
  const send = (path, method, body) => request(path, { token, method, body });
  const SKU = 'SMOKE-1';

  let category = (await database.from('categories').select('id, active').eq('name', 'Smoke test').maybeSingle()).data;
  if (!category) {
    const response = await send('/api/categories', 'POST', { name: 'Smoke test' });
    assert.equal(response.status, 201);
    category = (await response.json()).category;
  } else if (!category.active) {
    assert.equal((await send(`/api/categories/${category.id}`, 'PATCH', { active: true })).status, 200);
  }
  const options = await (await request('/api/products/options', { token })).json();
  const base = {
    categoryId: category.id,
    unitCode: 'Piece',
    taxRateId: options.taxRates.find((rate) => rate.isDefault).id,
    costPrice: 80,
    sellingPrice: 100
  };

  let product = (await database.from('products').select('id').eq('sku', SKU).maybeSingle()).data;
  if (!product) {
    await check('creating a product generates a valid barcode and posts opening stock', async () => {
      const response = await send('/api/products', 'POST', { ...base, name: 'Smoke product', sku: SKU, openingStock: 3 });
      assert.equal(response.status, 201, await response.clone().text());
      product = (await response.json()).product;
      assert.match(product.barcode, /^20\d{11}$/);
      assert.equal(product.stock, 3);
      const ledger = await database.from('inventory_ledger').select('movement_type, new_qty').eq('product_id', product.id);
      assert.deepEqual(ledger.data.map((row) => [row.movement_type, Number(row.new_qty)]), [['Opening', 3]]);
    });
  }
  await check('a duplicate SKU is refused with a clear message', async () => {
    const response = await send('/api/products', 'POST', { ...base, name: 'Copy', sku: SKU });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /SKU is already used/);
  });
  await check('products can be edited and reactivated, but stock cannot be set', async () => {
    const before = (await database.from('products').select('stock_qty').eq('id', product.id).single()).data;
    const response = await send(`/api/products/${product.id}`, 'PATCH', { active: true, name: 'Smoke product', stock: 999, stock_qty: 999 });
    assert.equal(response.status, 200, await response.clone().text());
    const updated = (await response.json()).product;
    assert.equal(updated.stock, Number(before.stock_qty));
    assert.equal(updated.category, 'Smoke test');
    assert.equal(updated.taxRate, 18);
  });
  await check('search finds a product by part of its name, SKU and barcode', async () => {
    for (const q of ['smoke prod', 'SMOKE-1']) {
      const body = await (await request(`/api/products?q=${encodeURIComponent(q)}`, { token })).json();
      assert.ok(body.products.some((item) => item.id === product.id), q);
      assert.ok(body.total >= 1);
    }
  });
  await check('search survives punctuation', async () => {
    for (const q of ['a,b(c)', 'x"y', "o'neil", '%_*', 'a.eq.1']) {
      assert.equal((await request(`/api/products?q=${encodeURIComponent(q)}`, { token })).status, 200, q);
    }
  });
  await check('a photo is stored privately and served by an expiring link', async () => {
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
    const response = await fetch(`${base_url()}/api/products/${product.id}/image`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
      body: jpeg,
      signal: AbortSignal.timeout(20000)
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { imageUrl } = (await response.json()).product;
    assert.match(imageUrl, /token=/);
    assert.equal((await fetch(imageUrl, { signal: AbortSignal.timeout(20000) })).status, 200);
    const row = (await database.from('products').select('image_path').eq('id', product.id).single()).data;
    const direct = `${config.supabaseUrl}/storage/v1/object/public/product-images/${row.image_path}`;
    assert.notEqual((await fetch(direct, { signal: AbortSignal.timeout(20000) })).status, 200, 'the bucket must not be public');
  });
  await check('a category in use cannot be deactivated', async () => {
    assert.equal((await send(`/api/categories/${category.id}`, 'PATCH', { active: false })).status, 409);
  });
  await check('deactivating hides a product from the active list', async () => {
    assert.equal((await send(`/api/products/${product.id}`, 'PATCH', { active: false })).status, 200);
    const body = await (await request('/api/products?q=SMOKE-1', { token })).json();
    assert.ok(!body.products.some((item) => item.id === product.id));
    const inactive = await (await request('/api/products?q=SMOKE-1&status=inactive', { token })).json();
    assert.ok(inactive.products.some((item) => item.id === product.id));
    assert.equal((await send(`/api/categories/${category.id}`, 'PATCH', { active: false })).status, 200);
  });
}

// Works on the permanent test product, which is only active during these checks.
async function inventoryChecks(sessions) {
  const manager = sessions.Manager.token;
  const staff = sessions['Inventory Staff'].token;
  const product = (await database.from('products').select('id, category_id').eq('sku', 'SMOKE-1').single()).data;
  const stockNow = async () => Number((await withRetry('read stock', () => database.from('products').select('stock_qty').eq('id', product.id).single())).data.stock_qty);
  await database.from('categories').update({ active: true }).eq('id', product.category_id);
  await database.from('products').update({ active: true }).eq('id', product.id);

  await check('the stock list and summary read real data', async () => {
    const list = await (await request('/api/inventory/stock?q=SMOKE-1', { token: staff })).json();
    assert.ok(list.products.some((row) => row.id === product.id));
    assert.equal(typeof list.total, 'number');
    const { summary } = await (await request('/api/inventory/summary', { token: staff })).json();
    assert.ok(summary.categories.some((row) => row.category === 'Smoke test'));
  });
  await check('an adjustment changes stock and appears in the ledger and list', async () => {
    const before = await stockNow();
    const response = await request('/api/inventory/adjustments', { token: manager, body: { reason: 'Found stock', note: 'live check', lines: [{ productId: product.id, change: 2 }] } });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(await stockNow(), before + 2);
    const { movements } = await (await request('/api/inventory/movements?type=Adjustment', { token: manager })).json();
    const latest = movements.find((row) => row.sku === 'SMOKE-1');
    assert.equal(latest.change, 2);
    assert.equal(latest.next, before + 2);
    assert.equal(latest.user, 'Smoke Manager');
    const { adjustments } = await (await request('/api/inventory/adjustments', { token: manager })).json();
    assert.ok(adjustments.some((row) => row.lines.some((line) => line.product === 'Smoke product')));
  });
  await check('removing more than is in stock is refused', async () => {
    const response = await request('/api/inventory/adjustments', { token: manager, body: { reason: 'Damaged', lines: [{ productId: product.id, change: -999999 }] } });
    assert.equal(response.status, 409);
  });
  await check('a blind count hides quantities, then approval posts the difference once', async () => {
    const before = await stockNow();
    const started = await request('/api/inventory/counts', { token: staff, body: { name: 'Live check', scope: product.category_id, blind: true } });
    assert.equal(started.status, 201, await started.clone().text());
    const { count } = await started.json();
    assert.equal(count.lines[0].expected, undefined);
    const line = await request(`/api/inventory/counts/${count.id}/lines/${product.id}`, { token: staff, method: 'PUT', body: { counted: before - 1 } });
    assert.equal(line.status, 204, await line.clone().text());
    assert.equal(await stockNow(), before);
    assert.equal((await request(`/api/inventory/counts/${count.id}/submit`, { token: staff, method: 'POST' })).status, 200);
    assert.equal((await request(`/api/inventory/counts/${count.id}/approve`, { token: staff, method: 'POST' })).status, 403);
    const seen = await (await request(`/api/inventory/counts/${count.id}`, { token: manager })).json();
    assert.equal(seen.count.lines[0].variance, -1);
    const approved = await request(`/api/inventory/counts/${count.id}/approve`, { token: manager, method: 'POST' });
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal(await stockNow(), before - 1);
    assert.equal((await request(`/api/inventory/counts/${count.id}/approve`, { token: manager, method: 'POST' })).status, 409);
    assert.equal(await stockNow(), before - 1);
  });
  await database.from('products').update({ active: false }).eq('id', product.id);
  await database.from('categories').update({ active: false }).eq('id', product.category_id);
}

async function barcodeChecks(sessions) {
  const product = (await database.from('products').select('id, barcode, category_id').eq('sku', 'SMOKE-1').single()).data;
  const look = (role, code) => request(`/api/barcode/lookup?code=${encodeURIComponent(code)}`, { token: sessions[role].token });

  await check('a barcode and a SKU both find the product', async () => {
    assert.equal((await (await look('Inventory Staff', product.barcode)).json()).product.id, product.id);
    assert.equal((await (await look('Inventory Staff', 'smoke-1')).json()).product.id, product.id);
  });
  await check('cashiers can look up a product but do not get its cost', async () => {
    const text = await (await look('Cashier', product.barcode)).text();
    assert.equal(JSON.parse(text).product.id, product.id);
    assert.ok(!text.includes('costPrice'));
    assert.equal((await look('Owner', product.barcode)).status, 403);
  });
  await check('an unknown barcode is reported as unknown', async () => {
    const response = await look('Cashier', '2099999999998');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'UNKNOWN_BARCODE');
  });
  await check('scanning into a count adds one each time and then stops', async () => {
    const token = sessions['Inventory Staff'].token;
    await database.from('categories').update({ active: true }).eq('id', product.category_id);
    await database.from('products').update({ active: true }).eq('id', product.id);
    const { count } = await (await request('/api/inventory/counts', { token, body: { name: 'Live scan', scope: product.category_id, blind: true } })).json();
    const scan = () => request(`/api/inventory/counts/${count.id}/scan`, { token, body: { code: product.barcode } });
    assert.equal((await (await scan()).json()).counted, 1);
    assert.equal((await (await scan()).json()).counted, 2);
    assert.equal((await request(`/api/inventory/counts/${count.id}/submit`, { token, method: 'POST' })).status, 200);
    assert.equal((await scan()).status, 409);
    assert.equal((await request(`/api/inventory/counts/${count.id}/reopen`, { token: sessions.Manager.token, method: 'POST' })).status, 200);
    await database.from('stock_counts').update({ status: 'Rejected' }).eq('id', count.id);
    await database.from('products').update({ active: false }).eq('id', product.id);
    await database.from('categories').update({ active: false }).eq('id', product.category_id);
  });
}

async function purchaseChecks(sessions, productId, stockNow) {
  const staff = sessions['Inventory Staff'].token;
  const manager = sessions.Manager.token;
  const made = await request('/api/suppliers', { token: staff, body: { name: `Live Supplier ${Date.now()}`, paymentTerms: 'Cash' } });
  assert.equal(made.status, 201, await made.clone().text());
  const { supplier } = await made.json();
  const newOrder = async (qty = 10, status = 'Ordered', extra = {}) => {
    const response = await request('/api/purchases', { token: staff, body: { supplierId: supplier.id, status, items: [{ productId, qty, unitCost: 80 }], ...extra } });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).purchase;
  };
  const deliver = (order, qty, requestId = randomUUID(), token = staff) => request(`/api/purchases/${order.id}/receive`, { token, body: { clientRequestId: requestId, lines: [{ purchaseItemId: order.lines[0].id, qty }] } });

  await check('creating an order changes no stock, and delivery does', async () => {
    const before = await stockNow();
    const order = await newOrder(10);
    assert.equal(order.total, 800);
    assert.equal(await stockNow(), before);
    const reply = await deliver(order, 4);
    assert.equal(reply.status, 201, await reply.clone().text());
    const body = await reply.json();
    assert.equal(body.purchase.status, 'Partially Received');
    assert.equal(await stockNow(), before + 4);
    const ledger = await database.from('inventory_ledger').select('change_qty, movement_type, unit_cost').eq('reference_no', body.grnNo);
    assert.deepEqual(ledger.data.map((row) => [row.movement_type, Number(row.change_qty), Number(row.unit_cost)]), [['Purchase', 4, 80]]);
    assert.equal((await deliver(order, 7)).status, 409);
    assert.equal(await stockNow(), before + 4);
  });
  await check('the same delivery sent at the same moment adds stock once', async () => {
    const before = await stockNow();
    const order = await newOrder(5);
    const requestId = randomUUID();
    const replies = await Promise.all([deliver(order, 3, requestId), deliver(order, 3, requestId), deliver(order, 3, requestId)]);
    const numbers = await Promise.all(replies.map(async (reply) => (await reply.json()).grnNo));
    assert.equal(new Set(numbers).size, 1, numbers.join());
    assert.equal(await stockNow(), before + 3);
  });
  await check('two deliveries racing cannot receive more than ordered', async () => {
    const before = await stockNow();
    const order = await newOrder(10);
    const replies = await Promise.all([deliver(order, 6), deliver(order, 6), deliver(order, 6)]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409, 409]);
    assert.equal(await stockNow(), before + 6);
  });
  await check('drafts cannot be received, and send and cancel change state once', async () => {
    const before = await stockNow();
    const draft = await newOrder(1, 'Draft');
    assert.equal((await deliver(draft, 1)).status, 409);
    const url = `/api/purchases/${draft.id}`;
    assert.equal((await request(`${url}/send`, { token: staff, method: 'POST' })).status, 200);
    assert.equal((await request(`${url}/send`, { token: staff, method: 'POST' })).status, 409);
    assert.equal((await request(`${url}/cancel`, { token: staff, method: 'POST' })).status, 200);
    assert.equal((await deliver(draft, 1)).status, 409);
    assert.equal(await stockNow(), before);
  });
  await check('only a Manager can pay, and racing payments cannot overpay', async () => {
    const order = await newOrder(10);
    const pay = (token, amount) => request(`/api/purchases/${order.id}/pay`, { token, body: { amount, method: 'Cash' } });
    assert.equal((await pay(staff, 1)).status, 403);
    assert.equal((await pay(sessions.Owner.token, 1)).status, 403);
    const replies = await Promise.all([pay(manager, 500), pay(manager, 500), pay(manager, 500)]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409, 409]);
    const { purchase } = await (await request(`/api/purchases/${order.id}`, { token: manager })).json();
    assert.equal(purchase.paid, 500);
    assert.equal(purchase.balance, 300);
    assert.equal(purchase.paymentStatus, 'Part Paid');
    assert.equal((await request(`/api/purchases/${order.id}/cancel`, { token: manager, method: 'POST' })).status, 409, 'a paid order cannot be cancelled');
  });
  await check('a supplier invoice number can only be recorded once', async () => {
    const invoice = `LIVE-${Date.now()}`;
    await newOrder(1, 'Ordered', { supplierInvoiceNo: invoice });
    const repeat = await request('/api/purchases', { token: staff, body: { supplierId: supplier.id, supplierInvoiceNo: invoice, items: [{ productId, qty: 1, unitCost: 1 }] } });
    assert.equal(repeat.status, 409);
    assert.match((await repeat.json()).error, /invoice number/);
  });
  await check('the list, details and summary read real data', async () => {
    const { purchases } = await (await request('/api/purchases?status=Partially%20Received', { token: staff })).json();
    assert.ok(purchases.some((row) => row.supplier === supplier.name && row.receivedPercent > 0));
    const { summary } = await (await request('/api/purchases/summary', { token: staff })).json();
    assert.ok(summary.openOrders >= 1 && summary.payable > 0);
    const list = await (await request('/api/purchases/options', { token: staff })).json();
    assert.ok(list.suppliers.some((row) => row.id === supplier.id));
  });
  await database.from('purchases').update({ status: 'Cancelled' }).eq('supplier_id', supplier.id).in('status', ['Draft', 'Ordered', 'Partially Received']).eq('paid_total', 0);
  await database.from('suppliers').update({ active: false }).eq('id', supplier.id);
}

async function saleChecks(sessions) {
  const token = sessions.Cashier.token;
  const manager = sessions.Manager.token;
  const product = (await database.from('products').select('id, category_id').eq('sku', 'SMOKE-1').single()).data;
  await database.from('categories').update({ active: true }).eq('id', product.category_id);
  await database.from('products').update({ active: true }).eq('id', product.id);
  const stockNow = async () => Number((await withRetry('read stock', () => database.from('products').select('stock_qty').eq('id', product.id).single())).data.stock_qty);
  async function setStock(target) {
    const change = target - await stockNow();
    if (!change) return;
    const response = await request('/api/inventory/adjustments', { token: manager, body: { reason: 'Data correction', note: 'live check', lines: [{ productId: product.id, change }] } });
    assert.equal(response.status, 201, await response.clone().text());
  }
  const sale = (overrides = {}) => ({
    clientRequestId: randomUUID(),
    items: [{ productId: product.id, qty: 1 }],
    expectedTotal: 118,
    payment: { method: 'Cash', amountTendered: 200 },
    ...overrides
  });
  const sell = (body) => request('/api/pos/sales', { token, body });

  await setStock(20);
  await check('the catalogue shows selling prices and no costs', async () => {
    const text = await (await request('/api/pos/catalog?q=SMOKE-1', { token })).text();
    assert.equal(JSON.parse(text).products[0].price, 100);
    assert.ok(!text.includes('cost'), text);
  });
  let firstBill;
  await check('a cash sale records change, stock and ledger', async () => {
    const response = await sell(sale());
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json();
    firstBill = body.sale.billNo;
    assert.match(firstBill, /^RM-INV-\d{6}$/);
    assert.equal(body.sale.total, 118);
    assert.equal(body.sale.payment.change, 82);
    assert.equal(await stockNow(), 19);
    const ledger = await database.from('inventory_ledger').select('change_qty').eq('reference_no', firstBill);
    assert.equal(Number(ledger.data[0].change_qty), -1);
  });
  await check('card and bank transfer sales work, and transfer needs a reference', async () => {
    assert.equal((await sell(sale({ payment: { method: 'Card' } }))).status, 201);
    assert.equal((await sell(sale({ payment: { method: 'Bank transfer' } }))).status, 400);
    assert.equal((await sell(sale({ payment: { method: 'Bank transfer', reference: 'LIVE-1' } }))).status, 201);
    assert.equal(await stockNow(), 17);
  });
  await check('short cash and a wrong total are refused without touching stock', async () => {
    assert.equal((await sell(sale({ payment: { method: 'Cash', amountTendered: 50 } }))).status, 400);
    assert.equal((await sell(sale({ expectedTotal: 1 }))).status, 409);
    assert.equal(await stockNow(), 17);
  });
  await check('a retried request does not sell twice', async () => {
    const body = sale();
    const first = await (await sell(body)).json();
    const retry = await sell(body);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).sale.billNo, first.sale.billNo);
    assert.equal(await stockNow(), 16);
  });
  await check('the same request sent at the same moment sells once', async () => {
    const body = sale();
    const replies = await Promise.all([sell(body), sell(body), sell(body)]);
    const bills = await Promise.all(replies.map(async (reply) => (await reply.json()).sale.billNo));
    assert.equal(new Set(bills).size, 1, bills.join());
    assert.equal(await stockNow(), 15);
  });
  await check('selling more than exists is refused', async () => {
    const response = await sell(sale({ items: [{ productId: product.id, qty: 9999 }], expectedTotal: 1179882 , payment: { method: 'Card' } }));
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(await stockNow(), 15);
  });
  await check('two sales racing for the last units cannot oversell', async () => {
    await setStock(3);
    const twoUnits = () => sale({ items: [{ productId: product.id, qty: 2 }], expectedTotal: 236, payment: { method: 'Card' } });
    const replies = await Promise.all([sell(twoUnits()), sell(twoUnits()), sell(twoUnits())]);
    const statuses = replies.map((reply) => reply.status).sort();
    assert.deepEqual(statuses, [201, 409, 409]);
    assert.equal(await stockNow(), 1);
  });
  await check('many sales at once get unique bill numbers and exact stock', async () => {
    await setStock(10);
    const replies = await Promise.all(Array.from({ length: 8 }, () => sell(sale({ payment: { method: 'Card' } }))));
    const bodies = await Promise.all(replies.map((reply) => reply.json()));
    assert.ok(replies.every((reply) => reply.status === 201), JSON.stringify(bodies[0]).slice(0, 200));
    assert.equal(new Set(bodies.map((body) => body.sale.billNo)).size, 8);
    assert.equal(await stockNow(), 2);
  });
  await check('a held order takes no stock, resumes once and can be cancelled', async () => {
    const before = await stockNow();
    const hold = () => request('/api/pos/held', { token, body: { items: [{ productId: product.id, qty: 1 }] } });
    const { order } = await (await hold()).json();
    assert.equal(await stockNow(), before);
    const { orders } = await (await request('/api/pos/held', { token })).json();
    assert.ok(orders.some((item) => item.id === order.id));
    const resumed = await request(`/api/pos/held/${order.id}/resume`, { token, method: 'POST' });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.deepEqual((await resumed.json()).items, [{ productId: product.id, qty: 1 }]);
    assert.equal((await request(`/api/pos/held/${order.id}/resume`, { token, method: 'POST' })).status, 409);
    const second = (await (await hold()).json()).order;
    assert.equal((await request(`/api/pos/held/${second.id}/cancel`, { token, method: 'POST' })).status, 204);
  });
  await check('a partial refund returns stock and money, and lowers the day\'s sales', async () => {
    await setStock(10);
    const { sale: bill } = await (await sell(sale({ items: [{ productId: product.id, qty: 4 }], expectedTotal: 472, payment: { method: 'Card' } }))).json();
    const url = `/api/transactions/bills/${bill.id}`;
    const detail = (await (await request(url, { token: manager })).json()).bill;
    const before = (await (await request('/api/transactions/daily', { token: manager })).json()).daily.day;
    const body = (qty, extra = {}) => ({ clientRequestId: randomUUID(), reason: 'Live check', method: 'Card', lines: [{ saleItemId: detail.lines[0].id, qty }], ...extra });
    assert.equal((await request(`${url}/refund`, { token, body: body(1) })).status, 403, 'a cashier cannot refund');
    const once = body(1);
    const refund = await request(`${url}/refund`, { token: manager, body: once });
    assert.equal(refund.status, 201, await refund.clone().text());
    assert.equal((await refund.json()).bill.status, 'Partially Refunded');
    assert.equal(await stockNow(), 7);
    assert.equal((await request(`${url}/refund`, { token: manager, body: once })).status, 200, 'a retry changes nothing');
    assert.equal(await stockNow(), 7);
    const after = (await (await request('/api/transactions/daily', { token: manager })).json()).daily.day;
    assert.equal(Math.round((after.refunds - before.refunds) * 100) / 100, 118);
    assert.equal((await request(`${url}/refund`, { token: manager, body: body(99) })).status, 409);
    assert.equal((await request(`${url}/void`, { token: manager, body: { reason: 'x' } })).status, 409, 'a refunded bill cannot be voided');
    const rest = await request(`${url}/refund`, { token: manager, body: body(3, { lines: [{ saleItemId: detail.lines[0].id, qty: 3, restock: false }] }) });
    const finished = (await rest.json()).bill;
    assert.equal(finished.status, 'Refunded');
    assert.equal(finished.refunds.reduce((sum, row) => sum + row.total, 0), 472);
    assert.equal(await stockNow(), 7, 'damaged goods stay out of stock');
  });
  await check('a void restores stock, can happen once, and is limited to managers', async () => {
    await setStock(5);
    const { sale: bill } = await (await sell(sale({ items: [{ productId: product.id, qty: 2 }], expectedTotal: 236, payment: { method: 'Card' } }))).json();
    const url = `/api/transactions/bills/${bill.id}/void`;
    assert.equal((await request(url, { token, body: { reason: 'x' } })).status, 403);
    assert.equal((await request(url, { token: sessions.Owner.token, body: { reason: 'x' } })).status, 403);
    assert.equal(await stockNow(), 3);
    const voided = await request(url, { token: manager, body: { reason: 'Live check' } });
    assert.equal(voided.status, 200, await voided.clone().text());
    assert.equal((await voided.json()).bill.status, 'Voided');
    assert.equal(await stockNow(), 5);
    assert.equal((await request(url, { token: manager, body: { reason: 'again' } })).status, 409);
    assert.equal(await stockNow(), 5);
  });
  await check('the bills list, month figures and search read real data', async () => {
    const { bills, total } = await (await request('/api/transactions/bills?status=Voided', { token: sessions.Owner.token })).json();
    assert.ok(total >= 1);
    assert.ok(bills.every((row) => row.status === 'Voided'));
    assert.ok(bills[0].cashier);
    const found = await (await request(`/api/transactions/bills?q=${firstBill}`, { token })).json();
    assert.equal(found.bills[0].billNo, firstBill);
    const { monthly } = await (await request('/api/transactions/monthly', { token: sessions.Owner.token })).json();
    assert.equal(monthly.months.length, 12);
    assert.equal(typeof monthly.grossProfit, 'number');
    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await request(`/api/transactions/bills?start=${today}&end=${today}`, { token })).status, 200);
  });
  await purchaseChecks(sessions, product.id, stockNow);
  await check('sales reach the dashboard and reports', async () => {
    const { dashboard } = await (await request('/api/dashboard', { token: manager })).json();
    assert.ok(dashboard.today.orders > 0);
    assert.ok(dashboard.recentSales.some((row) => row.status === 'Paid'));
    const { sales } = await (await request('/api/reports/sales', { token: sessions.Owner.token })).json();
    assert.ok(sales.some((row) => row.orderId === firstBill && row.status === 'Completed' && row.paymentMethod === 'Cash'));
  });
  await database.from('products').update({ active: false }).eq('id', product.id);
  await database.from('categories').update({ active: false }).eq('id', product.category_id);
}

const base_url = () => base;

try {
  for (const [role, username] of Object.entries(ACCOUNTS)) await ensureAccount(role, username);
  const sessions = {};

  for (const role of Object.keys(ACCOUNTS)) {
    await check(`${role} signs in by username and gets the role's permissions`, async () => {
      sessions[role] = await signIn(accounts[role].username, accounts[role].password);
      assert.equal(sessions[role].user.role, role);
      const expected = await database.from('role_permissions').select('permission_code').eq('role_code', role);
      assert.deepEqual([...sessions[role].user.permissions].sort(), expected.data.map((row) => row.permission_code).sort());
    });
  }

  for (const [path, allowed] of ACCESS) {
    for (const role of Object.keys(ACCOUNTS)) {
      const expected = allowed.includes(role) ? 200 : 403;
      await check(`${role} on ${path} gets ${expected}`, async () => {
        assert.equal((await request(path, { token: sessions[role].token })).status, expected);
      });
    }
  }

  await check('preferences save one field at a time, even when changed quickly', async () => {
    const { token } = sessions.Manager;
    const save = (body) => request('/api/auth/preferences', { token, body, method: 'PUT' });
    const responses = await Promise.all([save({ language: 'ta' }), save({ theme: 'light' })]);
    for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
    const read = await request('/api/auth/preferences', { token });
    assert.deepEqual((await read.json()).preferences, { language: 'ta', theme: 'light' });
    await save({ language: 'en', theme: 'dark' });
  });
  await check('login by email works', async () => {
    const session = await signIn(accounts.Owner.email, accounts.Owner.password);
    sessions.Owner2 = session;
  });
  await check('wrong password and unknown username get the same refusal', async () => {
    const wrong = await request('/api/auth/login', { body: { identifier: accounts.Owner.username, password: 'wrong-password' } });
    const unknown = await request('/api/auth/login', { body: { identifier: 'nobody.here', password: 'wrong-password' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
  });
  await check('requests without a real token are refused', async () => {
    assert.equal((await request('/api/auth/me')).status, 401);
    assert.equal((await request('/api/auth/me', { token: 'forged.token.value' })).status, 401);
  });
  await check('the refresh token gives a working new session', async () => {
    const response = await request('/api/auth/refresh', { body: { refreshToken: sessions.Owner2.refreshToken } });
    assert.equal(response.status, 200);
    sessions.Owner2 = await response.json();
    assert.equal((await request('/api/auth/me', { token: sessions.Owner2.token })).status, 200);
  });
  await check('logout ends the session on the server', async () => {
    assert.equal((await request('/api/auth/logout', { token: sessions.Owner2.token, method: 'POST' })).status, 204);
    assert.equal((await request('/api/auth/me', { token: sessions.Owner2.token })).status, 401);
    assert.equal((await request('/api/auth/refresh', { body: { refreshToken: sessions.Owner2.refreshToken } })).status, 401);
  });

  await productChecks(sessions);
  await inventoryChecks(sessions);
  await barcodeChecks(sessions);
  if (process.argv.includes('--with-sales')) await saleChecks(sessions);

  const cashier = accounts.Cashier;
  const temporary = password();
  await check('a Cashier cannot reset passwords', async () => {
    const response = await request(`/api/users/${accounts['Inventory Staff'].id}/reset-password`, {
      token: sessions.Cashier.token, body: { temporaryPassword: temporary }
    });
    assert.equal(response.status, 403);
  });
  await check('a Manager cannot reset an Owner password', async () => {
    const response = await request(`/api/users/${accounts.Owner.id}/reset-password`, {
      token: sessions.Manager.token, body: { temporaryPassword: temporary }
    });
    assert.equal(response.status, 403);
    await signIn(accounts.Owner.username, accounts.Owner.password);
  });
  await check('a Manager reset forces the Cashier to choose a new password', async () => {
    const reset = await request(`/api/users/${cashier.id}/reset-password`, {
      token: sessions.Manager.token, body: { temporaryPassword: temporary }
    });
    assert.equal(reset.status, 204);
    const session = await signIn(cashier.username, temporary);
    assert.equal(session.user.mustChangePassword, true);
    const blocked = await request('/api/reports/sales', { token: session.token });
    assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED');

    cashier.password = password();
    const wrong = await request('/api/auth/change-password', {
      token: session.token, body: { currentPassword: 'not-the-password', newPassword: cashier.password }
    });
    assert.equal(wrong.status, 400);
    const changed = await request('/api/auth/change-password', {
      token: session.token, body: { currentPassword: temporary, newPassword: cashier.password }
    });
    assert.equal(changed.status, 204);
    assert.equal((await request('/api/auth/me', { token: session.token })).status, 401, 'old session ends');
    const after = await signIn(cashier.username, cashier.password);
    assert.equal(after.user.mustChangePassword, false);
  });

  await check('disabling an account blocks its open session, login and refresh', async () => {
    const stock = accounts['Inventory Staff'];
    await database.from('profiles').update({ active: false }).eq('id', stock.id);
    assert.equal((await request('/api/auth/me', { token: sessions['Inventory Staff'].token })).status, 403);
    assert.equal((await request('/api/auth/refresh', { body: { refreshToken: sessions['Inventory Staff'].refreshToken } })).status, 403);
    const response = await request('/api/auth/login', { body: { identifier: stock.username, password: stock.password } });
    assert.equal(response.status, 403);
  });

  await check('login, logout and failures reached the audit log', async () => {
    const { data } = await database.from('audit_logs').select('action').order('id', { ascending: false }).limit(60);
    const actions = data.map((row) => row.action);
    for (const action of ['User login', 'User logout', 'Login failed', 'Password reset', 'Password changed']) {
      assert.ok(actions.includes(action), `${action} is missing`);
    }
  });

  console.log(`\nAll ${passed} live checks passed.`);
} catch (error) {
  console.error(`\nFAILED after ${passed} passing checks:`, error.message);
  process.exitCode = 1;
} finally {
  // Each step runs even if the one before it fails, and any failure is reported.
  for (const [label, step] of [['Deactivating test data', deactivateTestData], ['Disabling test accounts', disableAccounts]]) {
    try {
      await step();
    } catch (error) {
      console.error(`${label} FAILED: ${error.message}`);
      process.exitCode = 1;
    }
  }
  server.close();
  server.closeAllConnections();
}
