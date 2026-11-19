import { hasCreditSchema, selectAll } from '../db.js';
import { regularDiscountSettings } from './settings.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';
import { createCustomer as saveCustomer } from './customers.js';
import { signedImageUrls } from './products.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanSearch(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
}

// Whether this customer currently earns the regular-customer discount, so the till shows the same
// total the sale will charge (create_sale applies the same rule).
export async function regularOffer(clients, customerId) {
  if (typeof customerId !== 'string' || !UUID.test(customerId)) throw new HttpError(400, 'Choose a valid customer.');
  const rule = await regularDiscountSettings(clients);
  if (!rule?.enabled) return { qualifies: false, enabled: false };
  const since = new Date(Date.now() - rule.periodDays * 86400000).toISOString();
  const { count, error } = await clients.database.from('sales').select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId).neq('status', 'Voided').gte('created_at', since);
  if (error) throw error;
  const visits = count ?? 0;
  return { qualifies: visits >= rule.minVisits, enabled: true, visits, minVisits: rule.minVisits, periodDays: rule.periodDays, rate: rule.rate };
}

export async function options({ database }) {
  const credit = await hasCreditSchema(database);
  let methodQuery = database.from('payment_methods').select('code, is_cash, requires_reference').eq('active', true);
  if (credit) methodQuery = methodQuery.eq('selectable', true);
  const [categories, methods, coupons, units] = await Promise.all([
    database.from('categories').select('id, name').eq('active', true).order('name'),
    methodQuery.order('sort_order'),
    database.from('coupons').select('code, rate, first_purchase_only, description').eq('active', true),
    database.from('units').select('code, allow_decimal_qty')
  ]);
  return {
    categories: unwrap(categories),
    paymentMethods: unwrap(methods).map((row) => ({ code: row.code, isCash: row.is_cash, requiresReference: row.requires_reference })),
    coupons: unwrap(coupons).map((row) => ({ code: row.code, rate: Number(row.rate), firstPurchaseOnly: row.first_purchase_only, description: row.description })),
    decimalUnits: unwrap(units).filter((row) => row.allow_decimal_qty).map((row) => row.code)
  };
}

// Selling columns only: cost prices are never sent to the counter.
export async function catalog({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 24, 1), 60);
  const from = (page - 1) * pageSize;
  const search = cleanSearch(query.q);
  let request = database.from('products')
    .select('id, sku, barcode, name, unit_code, selling_price, stock_qty, min_stock, location, image_path, category_id, categories(name), tax_rates(rate)', { count: 'exact' })
    .eq('active', true);
  if (query.categoryId) request = request.eq('category_id', query.categoryId);
  if (search) {
    const pattern = `"*${search}*"`;
    request = request.or(`name.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`);
  }
  if (query.ids) {
    const ids = String(query.ids).split(',').filter((id) => UUID.test(id)).slice(0, 100);
    request = request.in('id', ids);
  }
  const result = await request.order('name').order('id').range(from, from + pageSize - 1);
  const rows = unwrap(result);
  const images = await signedImageUrls(database, rows);
  return {
    products: rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      barcode: row.barcode,
      name: row.name,
      category: row.categories?.name || '',
      unit: row.unit_code,
      price: Number(row.selling_price),
      taxRate: Number(row.tax_rates?.rate ?? 0),
      stock: Number(row.stock_qty),
      minStock: Number(row.min_stock),
      imageUrl: images[row.image_path] || null
    })),
    total: result.count ?? rows.length,
    page,
    pageSize
  };
}

function asCustomer(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    loyaltyPoints: row.loyalty_points,
    purchaseCount: row.purchase_count,
    creditLimit: Number(row.credit_limit ?? 0),
    creditBalance: Number(row.credit_balance ?? 0),
    creditAvailable: Math.max(Number(row.credit_limit ?? 0) - Number(row.credit_balance ?? 0), 0)
  };
}

const BASE_CUSTOMER_COLUMNS = 'id, code, name, phone, loyalty_points, purchase_count';
const customerColumns = async (database) => (await hasCreditSchema(database) ? `${BASE_CUSTOMER_COLUMNS}, credit_limit, credit_balance` : BASE_CUSTOMER_COLUMNS);

export async function searchCustomers({ database }, query) {
  const search = cleanSearch(query.q);
  let request = database.from('customers').select(await customerColumns(database)).eq('active', true);
  if (search) request = request.or(`name.ilike."*${search}*",phone.ilike."*${search}*",code.ilike."*${search}*"`);
  return unwrap(await request.order('name').limit(20)).map(asCustomer);
}

export function createCustomer(clients, user, body) {
  return saveCustomer(clients, user, { name: body?.name, phone: body?.phone }, { phoneRequired: true });
}

function itemsFrom(body) {
  if (!Array.isArray(body?.items) || !body.items.length) throw new HttpError(400, 'The bill is empty. Add a product first.');
  if (body.items.length > 200) throw new HttpError(400, 'This bill has too many lines.');
  return body.items.map((item) => {
    const qty = Number(item?.qty);
    if (typeof item?.productId !== 'string' || !UUID.test(item.productId)) throw new HttpError(400, 'A product on this bill is not valid.');
    if (!Number.isFinite(qty) || qty <= 0 || qty > 999999999) throw new HttpError(400, 'Enter a valid quantity for every product.');
    return { productId: item.productId, qty };
  });
}

async function saleDetail({ database }, id) {
  const row = unwrap(await database.from('sales')
    .select('*, sale_items(line_no, name, sku, qty, unit_price, discount_amount, tax_amount, line_total), payments(method_code, amount, amount_tendered, change_given, reference)')
    .eq('id', id)
    .single());
  // Points are their own payment line; the other one is how the rest was paid.
  const payment = row.payments?.find((item) => item.method_code !== 'Loyalty points');
  return {
    id: row.id,
    billNo: row.bill_no,
    status: row.status,
    customer: row.customer_name,
    createdAt: row.created_at,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount_total),
    discountLabel: row.discount_label,
    tax: Number(row.tax_total),
    total: Number(row.grand_total),
    pointsEarned: row.points_earned,
    pointsRedeemed: row.points_redeemed ?? 0,
    payment: payment ? {
      method: payment.method_code,
      amount: Number(payment.amount),
      tendered: payment.amount_tendered === null ? null : Number(payment.amount_tendered),
      change: Number(payment.change_given),
      reference: payment.reference
    } : null,
    lines: [...row.sale_items].sort((a, b) => a.line_no - b.line_no).map((line) => ({
      name: line.name,
      sku: line.sku,
      qty: Number(line.qty),
      price: Number(line.unit_price),
      total: Number(line.line_total)
    }))
  };
}

export async function createSale(clients, user, body) {
  if (typeof body?.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) throw new HttpError(400, 'A request ID is required.');
  const total = Number(body?.expectedTotal);
  if (!Number.isFinite(total) || total < 0) throw new HttpError(400, 'The bill total is missing.');
  const points = body?.pointsToRedeem === undefined || body.pointsToRedeem === null || body.pointsToRedeem === '' ? 0 : Number(body.pointsToRedeem);
  if (!Number.isInteger(points) || points < 0 || points > 100000000) throw new HttpError(400, 'Enter a valid number of points.');
  const tendered = body?.payment?.amountTendered;
  if (tendered !== undefined && tendered !== null && !Number.isFinite(Number(tendered))) throw new HttpError(400, 'Enter a valid amount received.');
  const result = unwrap(await clients.database.rpc('create_sale', {
    p_sale: {
      clientRequestId: body.clientRequestId,
      items: itemsFrom(body),
      customerId: body.customerId || null,
      couponCode: body.couponCode || null,
      expectedTotal: total,
      pointsToRedeem: points,
      payment: {
        method: body?.payment?.method,
        amountTendered: tendered === undefined || tendered === null || tendered === '' ? null : Number(tendered),
        reference: typeof body?.payment?.reference === 'string' ? body.payment.reference.slice(0, 100) : ''
      }
    },
    p_cashier: user.id
  }));
  const sale = await saleDetail(clients, result.id);
  if (!result.replayed) {
    await writeAudit(clients.database, { user, action: 'Sale completed', description: `${result.billNo} · ${sale.total.toFixed(2)}${sale.pointsRedeemed ? ` · ${sale.pointsRedeemed} points used` : ''}${sale.payment?.method === 'Credit' ? ' · on credit' : ''}`, entityType: 'sale', entityId: result.id });
  }
  return { sale, replayed: result.replayed };
}

export async function holdOrder({ database }, user, body) {
  const id = unwrap(await database.rpc('hold_order', {
    p_order: { items: itemsFrom(body), customerId: body?.customerId || null, couponCode: body?.couponCode || null },
    p_created_by: user.id
  }));
  const held = unwrap(await database.from('held_orders').select('hold_no').eq('id', id).single());
  await writeAudit(database, { user, action: 'Order held', description: held.hold_no, entityType: 'held_order', entityId: id });
  return { id, holdNo: held.hold_no };
}

export async function listHeld({ database }) {
  const rows = await selectAll(() => database.from('held_orders')
    .select('id, hold_no, customer_id, customer_name, coupon_code, created_at, held_order_items(qty, products(name, selling_price, tax_rates(rate)))')
    .eq('status', 'Held')
    .order('created_at', { ascending: false })
    .order('id'));
  return rows.map((row) => ({
    id: row.id,
    holdNo: row.hold_no,
    customer: row.customer_name,
    createdAt: row.created_at,
    lines: row.held_order_items.map((item) => ({
      name: item.products?.name || '',
      qty: Number(item.qty),
      price: Number(item.products?.selling_price ?? 0),
      taxRate: Number(item.products?.tax_rates?.rate ?? 0)
    }))
  }));
}

// Claiming the order in one statement means two cashiers can't resume the same one.
async function closeHeld({ database }, id, status) {
  const row = unwrap(await database.from('held_orders')
    .update({ status, closed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'Held')
    .select('id, hold_no, customer_id, coupon_code, held_order_items(product_id, qty)')
    .maybeSingle());
  if (!row) throw new HttpError(409, 'This order has already been resumed or cancelled.');
  return row;
}

export async function resumeHeld(clients, user, id) {
  const row = await closeHeld(clients, id, 'Resumed');
  const customer = row.customer_id
    ? unwrap(await clients.database.from('customers').select(await customerColumns(clients.database)).eq('id', row.customer_id).maybeSingle())
    : null;
  await writeAudit(clients.database, { user, action: 'Held order resumed', description: row.hold_no, entityType: 'held_order', entityId: id });
  return {
    holdNo: row.hold_no,
    couponCode: row.coupon_code,
    customer: customer ? asCustomer(customer) : null,
    items: row.held_order_items.map((item) => ({ productId: item.product_id, qty: Number(item.qty) }))
  };
}

export async function cancelHeld(clients, user, id) {
  const row = await closeHeld(clients, id, 'Cancelled');
  await writeAudit(clients.database, { user, action: 'Held order cancelled', description: row.hold_no, entityType: 'held_order', entityId: id });
}

// The most points this cart can take, before the customer's own balance. The sale checks it again.
export async function pointsCap({ database }, body) {
  const items = itemsFrom(body);
  const rate = Number(body?.discountRate ?? 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new HttpError(400, 'Invalid discount.');
  return { cap: unwrap(await database.rpc('points_cap', { p_items: items, p_rate: rate })) };
}
