import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MOVEMENT_TYPES = ['Opening', 'Sale', 'Refund', 'Void', 'Purchase', 'Adjustment', 'Count', 'Import'];
const BILL_SORTS = { date: 'created_at', billNo: 'bill_no', customer: 'customer_name', total: 'grand_total' };
const PAYMENT_SORTS = { date: 'created_at', amount: 'amount' };
const MOVEMENT_SORTS = { date: 'created_at', quantity: 'change_qty' };
const EXPORTABLE = ['sales', 'sales-periods', 'sales-categories', 'sales-products', 'payments', 'stock', 'low-stock', 'stock-categories', 'stock-movements'];

function dateOrNull(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(new Date(value).getTime())) throw new HttpError(400, 'Choose a valid date range.');
  return value;
}

function productOrNull(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'Choose a valid product.');
  return value;
}

function searchText(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
}

function period(database, query) {
  return database.rpc('report_period', { p_preset: query.preset ?? 'last30', p_from: dateOrNull(query.from), p_to: dateOrNull(query.to) });
}

// A page of rows, or every row for an export. Export rights are checked here, not just on the screen.
async function pageOf(user, query, build) {
  if (query.all === '1') {
    if (!user.permissions.includes('reports.export')) throw new HttpError(403, 'You do not have permission to export reports.');
    const rows = await selectAll(() => build(null));
    return { rows, total: rows.length, page: 1, pageSize: rows.length };
  }
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const { data, count, error } = await build([(page - 1) * pageSize, page * pageSize - 1]);
  unwrap({ data, error });
  return { rows: data, total: count ?? data.length, page, pageSize };
}

function sorted(request, query, sorts, tieBreak = 'id') {
  const column = sorts[query.sort] ?? 'created_at';
  return request.order(column, { ascending: query.dir === 'asc' }).order(tieBreak);
}

export async function filters({ database }) {
  const [categories, products, methods] = await Promise.all([
    selectAll(() => database.from('categories').select('name').eq('active', true).order('name')),
    selectAll(() => database.from('products').select('id, name, sku').eq('active', true).order('name').order('id')),
    database.from('payment_methods').select('code').order('code')
  ]);
  return {
    categories: categories.map((row) => row.name),
    products: products.map((row) => ({ id: row.id, name: row.name, sku: row.sku })),
    paymentMethods: unwrap(methods).map((row) => row.code),
    movementTypes: MOVEMENT_TYPES
  };
}

export async function salesSummary({ database }, query) {
  const range = unwrap(await period(database, query));
  return unwrap(await database.rpc('report_sales', {
    p_period: range,
    p_group: query.group ?? 'day',
    p_category: query.category || null,
    p_product: productOrNull(query.product)
  }));
}

export async function salesBills({ database }, user, query) {
  const range = unwrap(await period(database, query));
  const product = productOrNull(query.product);
  const search = searchText(query.q);
  const narrowed = query.category || product;
  const columns = `id, bill_no, status, customer_name, grand_total, created_at, sale_items(qty), payments(method_code), refunds(total)${narrowed ? ', matching:sale_items!inner(id)' : ''}`;
  const result = await pageOf(user, query, (window) => {
    let request = database.from('sales').select(columns, { count: 'exact' }).gte('created_at', range.start).lt('created_at', range.end);
    if (query.category) request = request.eq('matching.category_name', query.category);
    if (product) request = request.eq('matching.product_id', product);
    if (search) request = request.or(`bill_no.ilike."*${search}*",customer_name.ilike."*${search}*"`);
    request = sorted(request, query, BILL_SORTS);
    return window ? request.range(window[0], window[1]) : request;
  });
  return {
    bills: result.rows.map((row) => ({
      id: row.id,
      billNo: row.bill_no,
      status: row.status,
      customer: row.customer_name,
      date: row.created_at,
      items: (row.sale_items || []).reduce((sum, item) => sum + Number(item.qty), 0),
      payment: (row.payments || []).map((item) => item.method_code).join(' + '),
      total: Number(row.grand_total),
      refunded: (row.refunds || []).reduce((sum, item) => sum + Number(item.total), 0)
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize
  };
}

export async function paymentsSummary({ database }, query) {
  const range = unwrap(await period(database, query));
  return unwrap(await database.rpc('report_payments', { p_period: range }));
}

export async function paymentsList({ database }, user, query) {
  const range = unwrap(await period(database, query));
  const search = searchText(query.q);
  const result = await pageOf(user, query, (window) => {
    let request = database.from('payments')
      .select('id, method_code, amount, reference, created_at, sales!inner(bill_no, status, customer_name)', { count: 'exact' })
      .gte('created_at', range.start).lt('created_at', range.end);
    if (query.method) request = request.eq('method_code', query.method);
    if (search) request = request.ilike('sales.bill_no', `*${search}*`);
    request = sorted(request, query, PAYMENT_SORTS);
    return window ? request.range(window[0], window[1]) : request;
  });
  return {
    payments: result.rows.map((row) => ({
      id: row.id,
      date: row.created_at,
      billNo: row.sales.bill_no,
      customer: row.sales.customer_name,
      status: row.sales.status,
      method: row.method_code,
      reference: row.reference,
      amount: Number(row.amount)
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize
  };
}

export async function inventorySummary({ database }) {
  return unwrap(await database.rpc('report_inventory'));
}

export async function listProducts({ database }) {
  const rows = await selectAll(() => database.from('products')
    .select('id, name, sku, unit_code, cost_price, selling_price, stock_qty, min_stock, categories(name)')
    .eq('active', true)
    .order('name')
    .order('id'));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit_code,
    category: row.categories?.name || '',
    unitCost: Number(row.cost_price),
    unitPrice: Number(row.selling_price),
    stock: Number(row.stock_qty),
    reorderLevel: Number(row.min_stock)
  }));
}

export async function stockMovements({ database }, user, query) {
  const range = unwrap(await period(database, query));
  const product = productOrNull(query.product);
  const type = MOVEMENT_TYPES.includes(query.type) ? query.type : null;
  const search = searchText(query.q);
  const totals = unwrap(await database.rpc('report_stock_totals', { p_period: range, p_product: product, p_type: type }));
  const result = await pageOf(user, query, (window) => {
    let request = database.from('inventory_ledger')
      .select('id, product_id, movement_type, change_qty, new_qty, reason, reference_no, created_at, products!inner(name, sku)', { count: 'exact' })
      .gte('created_at', range.start).lt('created_at', range.end);
    if (product) request = request.eq('product_id', product);
    if (type) request = request.eq('movement_type', type);
    if (search) request = request.ilike('products.name', `*${search}*`);
    request = sorted(request, query, MOVEMENT_SORTS);
    return window ? request.range(window[0], window[1]) : request;
  });
  return {
    period: range,
    totals,
    movements: result.rows.map((row) => ({
      id: row.id,
      date: row.created_at,
      name: row.products.name,
      sku: row.products.sku,
      type: row.movement_type,
      change: Number(row.change_qty),
      balance: Number(row.new_qty),
      reference: row.reference_no,
      reason: row.reason
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize
  };
}

export async function recordExport({ database }, user, body) {
  if (!EXPORTABLE.includes(body?.report)) throw new HttpError(400, 'Choose a valid report.');
  const kind = body?.kind === 'print' ? 'printed' : 'exported';
  await writeAudit(database, { user, action: `Report ${kind}`, description: body.report, entityType: 'report' });
}
