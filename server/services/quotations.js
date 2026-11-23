import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

export const STATUSES = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Expired', 'Cancelled'];
const MOVES = { send: 'Sent', accept: 'Accepted', reject: 'Rejected', cancel: 'Cancelled' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireId(id, message = 'Quotation not found.') {
  if (!UUID.test(id)) throw new HttpError(404, message);
}

function searchText(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\",()]/g, ' ').trim().slice(0, 100) : '';
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asQuote(row) {
  return {
    id: row.id,
    quoteNo: row.quote_no,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    validUntil: row.valid_until,
    total: Number(row.grand_total),
    createdAt: row.created_at
  };
}

export async function listQuotations({ database }, query) {
  unwrap(await database.rpc('expire_quotations'));
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = 25;
  let request = database.from('quotations')
    .select('id, quote_no, status, customer_id, customer_name, customer_phone, valid_until, grand_total, created_at', { count: 'exact' });
  if (STATUSES.includes(query.status)) request = request.eq('status', query.status);
  const search = searchText(query.q);
  if (search) request = request.or(`quote_no.ilike."*${search}*",customer_name.ilike."*${search}*",customer_phone.ilike."*${search}*"`);
  const [result, counts] = await Promise.all([
    request.order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1),
    database.rpc('quotation_counts')
  ]);
  return { quotations: unwrap(result).map(asQuote), counts: unwrap(counts), total: result.count ?? 0, page, pageSize };
}

export async function getQuotation({ database }, id) {
  requireId(id);
  const row = unwrap(await database.from('quotations')
    .select(`*, creator:profiles!quotations_created_by_fkey(full_name), sales(bill_no),
      quotation_items(line_no, product_id, qty, unit_price, tax_rate, products(name, sku, unit_code, selling_price, stock_qty, active, tax_rates(rate)))`)
    .eq('id', id)
    .maybeSingle());
  if (!row) throw new HttpError(404, 'Quotation not found.');
  const store = unwrap(await database.from('store_settings').select('store_name, address, phone').single());
  return {
    ...asQuote(row),
    note: row.note,
    labourDescription: row.labour_description ?? '',
    labourFee: Number(row.labour_fee ?? 0),
    subtotal: Number(row.subtotal),
    tax: Number(row.tax_total),
    sentAt: row.sent_at,
    decidedAt: row.decided_at,
    createdBy: row.creator?.full_name ?? '',
    billNo: row.sales?.bill_no ?? null,
    lines: [...row.quotation_items].sort((a, b) => a.line_no - b.line_no).map((item) => ({
      productId: item.product_id,
      name: item.products?.name ?? '',
      sku: item.products?.sku ?? '',
      unit: item.products?.unit_code ?? '',
      qty: Number(item.qty),
      unitPrice: Number(item.unit_price),
      taxRate: Number(item.tax_rate),
      // What POS needs to put the line on a bill at today's price.
      currentPrice: Number(item.products?.selling_price ?? item.unit_price),
      currentTaxRate: Number(item.products?.tax_rates?.rate ?? item.tax_rate),
      stock: Number(item.products?.stock_qty ?? 0),
      active: item.products?.active ?? false
    })),
    store: { name: store.store_name, address: store.address, phone: store.phone }
  };
}

function quoteBody(body) {
  if (!Array.isArray(body?.items) || !body.items.length) throw new HttpError(400, 'Add at least one product.');
  if (body.items.length > 200) throw new HttpError(400, 'This quotation has too many lines.');
  const items = body.items.map((item) => {
    const qty = Number(item?.qty);
    if (typeof item?.productId !== 'string' || !UUID.test(item.productId)) throw new HttpError(400, 'A product on this quotation is not valid.');
    if (!Number.isFinite(qty) || qty <= 0 || qty > 999999999) throw new HttpError(400, 'Enter a valid quantity for every product.');
    return { productId: item.productId, qty };
  });
  if (typeof body.validUntil !== 'string' || !DATE.test(body.validUntil)) throw new HttpError(400, 'Choose a valid-until date from today onwards.');
  const labourFee = body.labourFee === undefined || body.labourFee === null || body.labourFee === '' ? 0 : Number(body.labourFee);
  if (!Number.isFinite(labourFee) || labourFee < 0 || labourFee > 999999999 || Math.round(labourFee * 100) / 100 !== labourFee) {
    throw new HttpError(400, 'Enter a valid labour fee.');
  }
  const customerId = typeof body.customerId === 'string' && body.customerId ? body.customerId : null;
  if (customerId && !UUID.test(customerId)) throw new HttpError(400, 'Choose an active customer.');
  return {
    customerId,
    customerName: text(body.customerName, 120),
    customerPhone: text(body.customerPhone, 30),
    validUntil: body.validUntil,
    note: text(body.note, 500),
    labourDescription: text(body.labourDescription, 200),
    labourFee,
    items
  };
}

// An out-of-date database ignores the labour fee. Say so, rather than saving a quote without it.
function requireLabourSaved(quote, wanted) {
  if (wanted.labourFee > 0 && quote.labourFee !== wanted.labourFee) {
    throw new HttpError(500, 'The labour fee could not be saved. The database needs the 0030_quotation_labour.sql update.');
  }
}

export async function createQuotation(clients, user, body) {
  const wanted = quoteBody(body);
  const id = unwrap(await clients.database.rpc('save_quotation', { p_quote: wanted, p_user: user.id }));
  const quote = await getQuotation(clients, id);
  requireLabourSaved(quote, wanted);
  await writeAudit(clients.database, { user, action: 'Quotation created', description: `${quote.quoteNo} · ${quote.customerName} · ${quote.total.toFixed(2)}`, entityType: 'quotation', entityId: id });
  return quote;
}

export async function updateQuotation(clients, user, id, body) {
  requireId(id);
  const wanted = quoteBody(body);
  unwrap(await clients.database.rpc('save_quotation', { p_quote: { ...wanted, id }, p_user: user.id }));
  const quote = await getQuotation(clients, id);
  requireLabourSaved(quote, wanted);
  await writeAudit(clients.database, { user, action: 'Quotation updated', description: `${quote.quoteNo} · ${quote.total.toFixed(2)}`, entityType: 'quotation', entityId: id });
  return quote;
}

export async function moveQuotation(clients, user, id, move) {
  requireId(id);
  const next = MOVES[move];
  if (!next) throw new HttpError(404, 'Not found.');
  const result = unwrap(await clients.database.rpc('set_quotation_status', { p_quote: id, p_status: next }));
  await writeAudit(clients.database, { user, action: `Quotation ${next.toLowerCase()}`, description: `${result.quoteNo} · ${result.from} → ${result.to}`, entityType: 'quotation', entityId: id });
  return getQuotation(clients, id);
}

export async function convertQuotation(clients, user, id, body) {
  requireId(id);
  if (typeof body?.saleId !== 'string' || !UUID.test(body.saleId)) throw new HttpError(400, 'Bill not found.');
  const result = unwrap(await clients.database.rpc('convert_quotation', { p_quote: id, p_sale: body.saleId }));
  if (!result.replayed) {
    await writeAudit(clients.database, { user, action: 'Quotation converted', description: `${result.quoteNo} → ${result.billNo}`, entityType: 'quotation', entityId: id });
  }
  return getQuotation(clients, id);
}

export async function productPicker({ database }, query) {
  const search = searchText(query.q);
  if (!search) return [];
  const rows = unwrap(await database.from('products')
    .select('id, name, sku, unit_code, selling_price, stock_qty, tax_rates(rate)')
    .eq('active', true)
    .or(`name.ilike."*${search}*",sku.ilike."*${search}*",barcode.ilike."*${search}*"`)
    .order('name')
    .limit(15));
  return rows.map((row) => ({
    productId: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit_code,
    price: Number(row.selling_price),
    taxRate: Number(row.tax_rates?.rate ?? 0),
    stock: Number(row.stock_qty)
  }));
}
