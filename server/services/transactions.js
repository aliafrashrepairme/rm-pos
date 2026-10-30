import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const STATUSES = ['Paid', 'Partially Refunded', 'Refunded', 'Voided'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  return typeof value === 'string' && DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function searchText(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
}

export async function listBills({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const from = (page - 1) * pageSize;

  let request = database.from('sales')
    .select('id, bill_no, status, customer_name, grand_total, created_at, cashier:profiles!sales_cashier_id_fkey(full_name), sale_items(qty), payments(method_code)', { count: 'exact' });

  // Each date is a whole day in the store's time zone.
  if (query.start !== undefined && query.start !== '') {
    if (!validDate(query.start)) throw new HttpError(400, 'Invalid start date.');
    request = request.gte('created_at', unwrap(await database.rpc('store_day_bounds', { p_date: query.start })).start);
  }
  if (query.end !== undefined && query.end !== '') {
    if (!validDate(query.end)) throw new HttpError(400, 'Invalid end date.');
    request = request.lt('created_at', unwrap(await database.rpc('store_day_bounds', { p_date: query.end })).end);
  }
  if (STATUSES.includes(query.status)) request = request.eq('status', query.status);
  const search = searchText(query.q);
  if (search) request = request.or(`bill_no.ilike."*${search}*",customer_name.ilike."*${search}*"`);

  const result = await request.order('created_at', { ascending: false }).order('id').range(from, from + pageSize - 1);
  return {
    bills: unwrap(result).map((row) => ({
      id: row.id,
      billNo: row.bill_no,
      status: row.status,
      customer: row.customer_name,
      cashier: row.cashier?.full_name || '',
      total: Number(row.grand_total),
      createdAt: row.created_at,
      items: row.sale_items.reduce((sum, item) => sum + Number(item.qty), 0),
      payment: row.payments[0]?.method_code || ''
    })),
    total: result.count ?? 0,
    page,
    pageSize
  };
}

export async function getBill({ database }, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Bill not found.');
  const row = unwrap(await database.from('sales')
    .select(`*, cashier:profiles!sales_cashier_id_fkey(full_name),
      sale_items(id, line_no, name, sku, qty, refunded_qty, unit_price, tax_rate, discount_amount, tax_amount, line_total),
      payments(method_code, amount, amount_tendered, change_given, reference),
      refunds(refund_no, reason, total, method_code, created_at, refund_items(sale_item_id, qty, amount, restock))`)
    .eq('id', id)
    .maybeSingle());
  if (!row) throw new HttpError(404, 'Bill not found.');
  const store = unwrap(await database.from('store_settings').select('store_name, address, phone, vat_registration, time_zone').single());
  const payment = row.payments[0];
  return {
    id: row.id,
    billNo: row.bill_no,
    status: row.status,
    customer: row.customer_name,
    cashier: row.cashier?.full_name || '',
    createdAt: row.created_at,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount_total),
    discountLabel: row.discount_label,
    tax: Number(row.tax_total),
    total: Number(row.grand_total),
    pointsEarned: row.points_earned,
    voidReason: row.void_reason,
    payment: payment ? {
      method: payment.method_code,
      amount: Number(payment.amount),
      tendered: payment.amount_tendered === null ? null : Number(payment.amount_tendered),
      change: Number(payment.change_given),
      reference: payment.reference
    } : null,
    lines: [...row.sale_items].sort((a, b) => a.line_no - b.line_no).map((line) => ({
      id: line.id,
      name: line.name,
      sku: line.sku,
      qty: Number(line.qty),
      refundedQty: Number(line.refunded_qty),
      price: Number(line.unit_price),
      taxRate: Number(line.tax_rate),
      total: Number(line.line_total)
    })),
    refunds: [...row.refunds].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((refund) => ({
      refundNo: refund.refund_no,
      reason: refund.reason,
      total: Number(refund.total),
      method: refund.method_code,
      createdAt: refund.created_at
    })),
    store: {
      name: row.store_name ?? store.store_name,
      address: store.address,
      phone: store.phone,
      vatRegistration: store.vat_registration,
      timeZone: store.time_zone
    }
  };
}

export async function voidBill(clients, user, id, body) {
  if (!UUID.test(id)) throw new HttpError(404, 'Bill not found.');
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
  if (!reason) throw new HttpError(400, 'Enter a reason.');
  unwrap(await clients.database.rpc('void_sale', { p_sale_id: id, p_reason: reason, p_user: user.id }));
  const bill = await getBill(clients, id);
  await writeAudit(clients.database, { user, action: 'Sale voided', description: `${bill.billNo} · ${reason}`, entityType: 'sale', entityId: id });
  return bill;
}

export async function refundBill(clients, user, id, body) {
  if (!UUID.test(id)) throw new HttpError(404, 'Bill not found.');
  if (typeof body?.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) throw new HttpError(400, 'A request ID is required.');
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
  if (!reason) throw new HttpError(400, 'Enter a reason.');
  if (!Array.isArray(body?.lines) || !body.lines.length) throw new HttpError(400, 'Choose at least one item to refund.');
  const lines = body.lines.map((line) => {
    const qty = Number(line?.qty);
    if (typeof line?.saleItemId !== 'string' || !UUID.test(line.saleItemId)) throw new HttpError(400, 'An item on this refund is not valid.');
    if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, 'Enter a valid refund quantity.');
    return { saleItemId: line.saleItemId, qty, restock: line.restock !== false };
  });
  const result = unwrap(await clients.database.rpc('refund_sale', {
    p_refund: { clientRequestId: body.clientRequestId, saleId: id, reason, method: body.method, lines },
    p_user: user.id
  }));
  const bill = await getBill(clients, id);
  if (!result.replayed) {
    await writeAudit(clients.database, { user, action: 'Refund processed', description: `${result.refundNo} · ${bill.billNo} · ${result.total} · ${reason}`, entityType: 'sale', entityId: id });
  }
  return { bill, refundNo: result.refundNo, replayed: result.replayed };
}

export async function recordPrinted({ database }, user, id, kind) {
  if (!UUID.test(id)) throw new HttpError(404, 'Bill not found.');
  const row = unwrap(await database.from('sales').select('bill_no').eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Bill not found.');
  await writeAudit(database, { user, action: kind === 'pdf' ? 'Bill PDF generated' : 'Bill printed', description: row.bill_no, entityType: 'sale', entityId: id });
}

export async function daily({ database }, query) {
  if (query.date !== undefined && !validDate(query.date)) throw new HttpError(400, 'Invalid date.');
  return unwrap(await database.rpc('transactions_daily', { p_date: query.date ?? null }));
}

export async function monthly({ database }, query) {
  const year = query.year === undefined ? null : Number(query.year);
  const month = query.month === undefined ? null : Number(query.month);
  if ((year === null) !== (month === null)) throw new HttpError(400, 'Choose both a year and a month.');
  if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new HttpError(400, 'Invalid month.');
  }
  return unwrap(await database.rpc('transactions_monthly', { p_year: year, p_month: month }));
}
