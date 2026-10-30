import { selectAll } from '../db.js';
import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_FIELDS = {
  contactPerson: ['contact_person', 120, 'Contact person'],
  phone: ['phone', 30, 'Phone'],
  email: ['email', 120, 'Email'],
  address: ['address', 300, 'Address'],
  city: ['city', 80, 'City'],
  paymentTerms: ['payment_terms', 40, 'Payment terms']
};

function requireId(id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Supplier not found.');
}

function supplierName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'Enter the supplier name.');
  return name;
}

function textField(value, [, max, label]) {
  if (value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  if (value.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return value.trim();
}

function checkEmail(email) {
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function leadTime(value) {
  const days = value === '' || value === undefined || value === null ? 5 : Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, 'Lead time must be a whole number of days.');
  return days;
}

function rating(value) {
  if (value === '' || value === null) return null;
  const stars = Number(value);
  if (!Number.isFinite(stars) || stars < 0 || stars > 5) throw new HttpError(400, 'Rating must be between 0 and 5.');
  return Math.round(stars * 10) / 10;
}

function asSupplier(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    city: row.city,
    paymentTerms: row.payment_terms,
    leadTimeDays: row.lead_time_days,
    rating: row.rating === null ? null : Number(row.rating),
    active: row.active,
    stats: row.stats
  };
}

export async function listSuppliers({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 24, 1), 100);
  const status = ['active', 'inactive', 'all'].includes(query.status) ? query.status : 'active';
  const search = typeof query.q === 'string' ? query.q.replace(/[%_\\]/g, ' ').trim().slice(0, 100) : '';
  const result = unwrap(await database.rpc('supplier_list', { p_search: search, p_status: status, p_limit: pageSize, p_offset: (page - 1) * pageSize }));
  return { suppliers: result.rows.map(asSupplier), total: result.total, balance: result.balance, page, pageSize };
}

export async function getSupplier({ database }, id) {
  requireId(id);
  const row = unwrap(await database.from('suppliers').select('*').eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Supplier not found.');
  const [stats, products, purchases, payments] = await Promise.all([
    database.rpc('supplier_stats', { p_supplier: id }),
    selectAll(() => database.from('products').select('id, name, sku, stock_qty, min_stock, cost_price, unit_code').eq('preferred_supplier_id', id).eq('active', true).order('name').order('id')),
    selectAll(() => database.from('purchases').select('id, po_no, status, expected_at, ordered_at, created_at, total, paid_total').eq('supplier_id', id).order('created_at', { ascending: false }).order('id')),
    selectAll(() => database.from('supplier_payments').select('payment_no, amount, method, reference, created_at, purchases(po_no)').eq('supplier_id', id).order('created_at', { ascending: false }).order('id'))
  ]);
  return {
    ...asSupplier({ ...row, stats: unwrap(stats) }),
    products: products.map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit_code,
      stock: Number(item.stock_qty),
      minStock: Number(item.min_stock),
      costPrice: Number(item.cost_price)
    })),
    purchases: purchases.map((item) => ({
      id: item.id,
      poNo: item.po_no,
      status: item.status,
      expectedAt: item.expected_at,
      createdAt: item.created_at,
      total: Number(item.total),
      // Drafts and cancelled orders aren't owed, matching the supplier's balance.
      balance: ['Draft', 'Cancelled'].includes(item.status) ? 0 : Number(item.total) - Number(item.paid_total)
    })),
    payments: payments.map((item) => ({
      paymentNo: item.payment_no,
      poNo: item.purchases?.po_no || '',
      amount: Number(item.amount),
      method: item.method,
      reference: item.reference,
      createdAt: item.created_at
    }))
  };
}

export async function createSupplier({ database }, user, body) {
  const details = { name: supplierName(body?.name), leadTimeDays: leadTime(body?.leadTimeDays) };
  for (const [key, spec] of Object.entries(TEXT_FIELDS)) details[key] = body?.[key] === undefined ? '' : textField(body[key], spec);
  checkEmail(details.email);
  const id = unwrap(await database.rpc('create_supplier', { p_supplier: details }));
  const row = unwrap(await database.from('suppliers').select('*').eq('id', id).single());
  await writeAudit(database, { user, action: 'Supplier added', description: `${row.code} ${row.name}`, entityType: 'supplier', entityId: id });
  // The purchase order form reads the terms under this short name.
  return { ...asSupplier(row), terms: row.payment_terms };
}

export async function updateSupplier({ database }, user, id, body) {
  requireId(id);
  const changes = {};
  if (body?.name !== undefined) changes.name = supplierName(body.name);
  for (const [key, spec] of Object.entries(TEXT_FIELDS)) {
    if (body?.[key] !== undefined) changes[spec[0]] = textField(body[key], spec);
  }
  if (changes.email !== undefined) checkEmail(changes.email);
  if (body?.leadTimeDays !== undefined) changes.lead_time_days = leadTime(body.leadTimeDays);
  if (body?.rating !== undefined) changes.rating = rating(body.rating);
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Active must be true or false.');
    changes.active = body.active;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');

  if (changes.active === false) {
    const { count, error } = await database.from('purchases').select('id', { count: 'exact', head: true }).eq('supplier_id', id).in('status', ['Draft', 'Ordered', 'Partially Received']);
    unwrap({ error });
    if (count > 0) throw new HttpError(409, `${count} open order(s) use this supplier. Finish or cancel them first.`);
  }

  const row = unwrap(await database.from('suppliers').update(changes).eq('id', id).select('*').maybeSingle());
  if (!row) throw new HttpError(404, 'Supplier not found.');
  const onlyStatus = Object.keys(changes).length === 1 && 'active' in changes;
  await writeAudit(database, {
    user,
    action: onlyStatus ? (changes.active ? 'Supplier reactivated' : 'Supplier deactivated') : 'Supplier updated',
    description: `${row.code} ${row.name}`,
    entityType: 'supplier',
    entityId: id
  });
  return asSupplier(row);
}
