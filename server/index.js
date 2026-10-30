import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const requiredEnvironment = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
if (missingEnvironment.length) {
  console.error(`Missing Supabase configuration: ${missingEnvironment.join(', ')}`);
  process.exit(1);
}

const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});
const database = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fromSupabase(error) {
  const message = error.message || 'Supabase request failed.';
  if (error.code === 'P0001') {
    if (message.startsWith('INSUFFICIENT_STOCK:')) return new HttpError(409, message.slice(19));
    if (message.startsWith('NOT_FOUND:')) return new HttpError(404, message.slice(10));
    return new HttpError(400, message);
  }
  if (error.code === '23505') return new HttpError(409, 'A record with the same unique value already exists.');
  if (error.code === '23503') return new HttpError(400, 'A referenced record does not exist.');
  if (error.code === '23514' || error.code === '22P02') return new HttpError(400, 'The request contains invalid data.');
  if (error.code === '42501') return new HttpError(403, 'You do not have permission to perform this action.');
  console.error('Supabase error:', error);
  return new HttpError(500, 'The storage service could not complete the request.');
}

function unwrap(result) {
  if (result.error) throw fromSupabase(result.error);
  return result.data;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} is required.`);
  return value.trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, `${label} must be a positive whole number.`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new HttpError(400, `${label} must be a non-negative whole number.`);
  return number;
}

function amount(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new HttpError(400, `${label} must be a non-negative amount.`);
  return Math.round(number * 100) / 100;
}

function dateRange(query) {
  let start;
  let end;
  if (query.start) {
    start = new Date(query.start);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Invalid start date.');
  }
  if (query.end) {
    end = new Date(query.end);
    if (Number.isNaN(end.getTime())) throw new HttpError(400, 'Invalid end date.');
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.end)) end.setUTCHours(23, 59, 59, 999);
  }
  if (start && end && start > end) throw new HttpError(400, 'Start date must not be after end date.');
  return { start: start?.toISOString(), end: end?.toISOString() };
}

function asProduct(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    unitCost: Number(row.unit_cost),
    unitPrice: Number(row.unit_price),
    stock: row.stock,
    reorderLevel: row.reorder_level,
    updatedAt: row.updated_at
  };
}

function asSale(row, items) {
  return {
    orderId: row.order_id,
    transactionId: row.transaction_id,
    date: row.date,
    items: items.map((item) => ({
      productId: item.product_id,
      name: item.name,
      category: item.category,
      qty: item.qty,
      unitPrice: Number(item.unit_price),
      lineTotal: Number(item.line_total)
    })),
    total: Number(row.total),
    status: row.status,
    paymentMethod: row.payment_method,
    customer: row.customer
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new HttpError(401, 'Sign in is required.');
    const authResult = await authClient.auth.getUser(token);
    if (authResult.error || !authResult.data.user) throw new HttpError(401, 'Session expired. Sign in again.');
    const profile = unwrap(await database.from('profiles')
      .select('id, name, role, email, active')
      .eq('id', authResult.data.user.id)
      .maybeSingle());
    if (!profile || !profile.active) throw new HttpError(403, 'This account is not enabled for RM POS.');
    req.user = profile;
    next();
  } catch (error) {
    next(error);
  }
}

function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role)
    ? next()
    : next(new HttpError(403, 'You do not have permission to perform this action.'));
}

async function listProducts(search = '') {
  const products = unwrap(await database.from('products').select('*').order('name').limit(1000));
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return products
    .filter((product) => !normalizedSearch || [product.name, product.sku, product.category]
      .some((value) => value.toLocaleLowerCase().includes(normalizedSearch)))
    .map(asProduct);
}

async function listSales(query = {}) {
  const range = dateRange(query);
  let salesQuery = database.from('sales').select('*').order('date', { ascending: false }).limit(1000);
  if (range.start) salesQuery = salesQuery.gte('date', range.start);
  if (range.end) salesQuery = salesQuery.lte('date', range.end);
  const rows = unwrap(await salesQuery);
  if (rows.length === 0) return [];
  const items = unwrap(await database.from('sale_items').select('*').in('sale_id', rows.map((sale) => sale.id)));
  const itemsBySale = new Map();
  for (const item of items) {
    const saleItems = itemsBySale.get(item.sale_id) || [];
    saleItems.push(item);
    itemsBySale.set(item.sale_id, saleItems);
  }
  return rows.map((sale) => asSale(sale, itemsBySale.get(sale.id) || []));
}

async function listMovements(query = {}) {
  const range = dateRange(query);
  let movementsQuery = database.from('stock_movements').select('*').order('date', { ascending: false }).limit(2000);
  if (range.start) movementsQuery = movementsQuery.gte('date', range.start);
  if (range.end) movementsQuery = movementsQuery.lte('date', range.end);
  return unwrap(await movementsQuery).map((movement) => ({
    id: movement.id,
    date: movement.date,
    productId: movement.product_id,
    name: movement.name,
    type: movement.type,
    quantity: movement.quantity,
    referenceId: movement.reference_id,
    note: movement.note
  }));
}

async function saleById(saleId) {
  const row = unwrap(await database.from('sales').select('*').eq('id', saleId).maybeSingle());
  if (!row) throw new HttpError(404, 'Sale not found.');
  const items = unwrap(await database.from('sale_items').select('*').eq('sale_id', saleId));
  return asSale(row, items);
}

async function listPurchases(query = {}) {
  const range = dateRange(query);
  let purchasesQuery = database.from('purchases').select('*').order('date', { ascending: false }).limit(1000);
  if (range.start) purchasesQuery = purchasesQuery.gte('date', range.start);
  if (range.end) purchasesQuery = purchasesQuery.lte('date', range.end);
  const purchases = unwrap(await purchasesQuery);
  if (purchases.length === 0) return [];
  const supplierIds = [...new Set(purchases.map((purchase) => purchase.supplier_id))];
  const purchaseIds = purchases.map((purchase) => purchase.id);
  const suppliers = unwrap(await database.from('suppliers').select('id, name').in('id', supplierIds));
  const items = unwrap(await database.from('purchase_items').select('*').in('purchase_id', purchaseIds));
  const supplierNames = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  const itemsByPurchase = new Map();
  for (const item of items) {
    const purchaseItems = itemsByPurchase.get(item.purchase_id) || [];
    purchaseItems.push({
      productId: item.product_id,
      name: item.name,
      qty: item.qty,
      unitCost: Number(item.unit_cost),
      lineTotal: Number(item.line_total)
    });
    itemsByPurchase.set(item.purchase_id, purchaseItems);
  }
  return purchases.map((purchase) => ({
    id: purchase.id,
    reference: purchase.reference,
    supplierId: purchase.supplier_id,
    supplier: supplierNames.get(purchase.supplier_id) || '',
    date: purchase.date,
    total: Number(purchase.total),
    status: purchase.status,
    items: itemsByPurchase.get(purchase.id) || []
  }));
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'rm-pos-server', storage: 'supabase' }));

app.post('/api/auth/login', async (req, res) => {
  const email = requiredText(req.body?.email, 'Email');
  const password = req.body?.password;
  if (typeof password !== 'string' || !password.length) throw new HttpError(400, 'Password is required.');
  const { data, error } = await authClient.auth.signInWithPassword({ email: email.toLowerCase(), password });
  if (error || !data.session || !data.user) throw new HttpError(401, 'Incorrect email or password.');
  const profile = unwrap(await database.from('profiles')
    .select('id, name, role, email, active')
    .eq('id', data.user.id)
    .maybeSingle());
  if (!profile || !profile.active) throw new HttpError(403, 'This account is not enabled for RM POS.');
  res.json({
    user: { id: profile.id, name: profile.name, role: profile.role, email: profile.email },
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: new Date(data.session.expires_at * 1000).toISOString()
  });
});

app.post('/api/auth/refresh', async (req, res) => {
  const refreshToken = requiredText(req.body?.refreshToken, 'Refresh token');
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user) throw new HttpError(401, 'Session expired. Sign in again.');
  const profile = unwrap(await database.from('profiles')
    .select('id, name, role, email, active')
    .eq('id', data.user.id)
    .maybeSingle());
  if (!profile || !profile.active) throw new HttpError(403, 'This account is not enabled for RM POS.');
  res.json({
    user: { id: profile.id, name: profile.name, role: profile.role, email: profile.email },
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: new Date(data.session.expires_at * 1000).toISOString()
  });
});

app.use('/api', requireAuth);

app.get('/api/auth/me', (req, res) => {
  const { id, name, role, email } = req.user;
  res.json({ user: { id, name, role, email } });
});
app.post('/api/auth/logout', (req, res) => res.status(204).end());

app.get('/api/products', async (req, res) => res.json({ products: await listProducts(req.query.q || '') }));
app.post('/api/products', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  const body = req.body || {};
  const productId = body.id ? requiredText(body.id, 'Product ID') : `P-${randomUUID().slice(0, 8).toUpperCase()}`;
  const result = unwrap(await database.rpc('create_product', {
    p_product_id: productId,
    p_name: requiredText(body.name, 'Name'),
    p_sku: requiredText(body.sku, 'SKU'),
    p_category: requiredText(body.category, 'Category'),
    p_unit_cost: amount(body.unitCost, 'Unit cost'),
    p_unit_price: amount(body.unitPrice, 'Unit price'),
    p_initial_stock: nonNegativeInteger(body.stock ?? 0, 'Stock'),
    p_reorder_level: nonNegativeInteger(body.reorderLevel ?? 0, 'Reorder level'),
    p_created_by: req.user.id
  }));
  const product = unwrap(await database.from('products').select('*').eq('id', result).single());
  res.status(201).json({ product: asProduct(product) });
});

app.patch('/api/products/:productId', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  const current = unwrap(await database.from('products').select('*').eq('id', req.params.productId).maybeSingle());
  if (!current) throw new HttpError(404, 'Product not found.');
  const body = req.body || {};
  const update = {
    updated_at: new Date().toISOString(),
    ...(body.name === undefined ? {} : { name: requiredText(body.name, 'Name') }),
    ...(body.sku === undefined ? {} : { sku: requiredText(body.sku, 'SKU') }),
    ...(body.category === undefined ? {} : { category: requiredText(body.category, 'Category') }),
    ...(body.unitCost === undefined ? {} : { unit_cost: amount(body.unitCost, 'Unit cost') }),
    ...(body.unitPrice === undefined ? {} : { unit_price: amount(body.unitPrice, 'Unit price') }),
    ...(body.reorderLevel === undefined ? {} : { reorder_level: nonNegativeInteger(body.reorderLevel, 'Reorder level') })
  };
  const product = unwrap(await database.from('products').update(update).eq('id', current.id).select('*').single());
  res.json({ product: asProduct(product) });
});

app.post('/api/stock-movements', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  const body = req.body || {};
  const type = body.type;
  if (type !== 'Stock In' && type !== 'Stock Out') throw new HttpError(400, 'Type must be Stock In or Stock Out.');
  const movementId = unwrap(await database.rpc('adjust_stock', {
    p_product_id: requiredText(body.productId, 'Product ID'),
    p_type: type,
    p_quantity: positiveInteger(body.quantity, 'Quantity'),
    p_reference_id: typeof body.referenceId === 'string' ? body.referenceId : '',
    p_note: typeof body.note === 'string' ? body.note : '',
    p_created_by: req.user.id
  }));
  const movement = unwrap(await database.from('stock_movements').select('*').eq('id', movementId).single());
  res.status(201).json({ movement: {
    id: movement.id,
    date: movement.date,
    productId: movement.product_id,
    name: movement.name,
    type: movement.type,
    quantity: movement.quantity,
    referenceId: movement.reference_id,
    note: movement.note
  } });
});
app.get('/api/stock-movements', async (req, res) => res.json({ movements: await listMovements(req.query) }));

app.get('/api/sales', async (req, res) => res.json({ sales: await listSales(req.query) }));
app.post('/api/sales', allowRoles('Owner', 'Manager', 'Cashier'), async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'At least one sale item is required.');
  const paymentMethod = requiredText(body.paymentMethod, 'Payment method');
  if (!['Cash', 'Card', 'Bank Transfer'].includes(paymentMethod)) throw new HttpError(400, 'Unsupported payment method.');
  const items = body.items.map((item) => ({
    productId: requiredText(item.productId, 'Product ID'),
    qty: positiveInteger(item.qty, 'Quantity')
  }));
  const saleId = unwrap(await database.rpc('create_sale', {
    p_items: items,
    p_payment_method: paymentMethod,
    p_customer: typeof body.customer === 'string' && body.customer.trim() ? body.customer.trim() : 'Walk-in Customer',
    p_created_by: req.user.id
  }));
  res.status(201).json({ sale: await saleById(saleId) });
});

app.get('/api/suppliers', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  const suppliers = unwrap(await database.from('suppliers').select('*').order('name'));
  res.json({ suppliers: suppliers.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    email: supplier.email,
    address: supplier.address,
    createdAt: supplier.created_at
  })) });
});
app.post('/api/suppliers', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  const body = req.body || {};
  const supplier = unwrap(await database.from('suppliers').insert({
    name: requiredText(body.name, 'Name'),
    phone: typeof body.phone === 'string' ? body.phone.trim() : '',
    email: typeof body.email === 'string' ? body.email.trim() : '',
    address: typeof body.address === 'string' ? body.address.trim() : ''
  }).select('*').single());
  res.status(201).json({ supplier });
});

app.get('/api/purchases', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  res.json({ purchases: await listPurchases(req.query) });
});
app.post('/api/purchases', allowRoles('Owner', 'Manager', 'Inventory Staff'), async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'At least one purchase item is required.');
  const items = body.items.map((item) => ({
    productId: requiredText(item.productId, 'Product ID'),
    qty: positiveInteger(item.qty, 'Quantity'),
    unitCost: amount(item.unitCost, 'Unit cost')
  }));
  const purchaseId = unwrap(await database.rpc('receive_purchase', {
    p_supplier_id: requiredText(body.supplierId, 'Supplier ID'),
    p_items: items,
    p_created_by: req.user.id
  }));
  const purchase = (await listPurchases({})).find((item) => item.id === purchaseId);
  res.status(201).json({ purchase });
});

app.get('/api/reports/sales', async (req, res) => res.json({ sales: await listSales(req.query) }));
app.get('/api/reports/products', async (req, res) => res.json({ products: await listProducts(req.query.q || '') }));
app.get('/api/reports/stock-movements', async (req, res) => res.json({ movements: await listMovements(req.query) }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`RM POS API running on http://localhost:${port} (Supabase storage)`));