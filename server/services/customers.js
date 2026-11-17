import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, code, name, phone, email, address, loyalty_points, purchase_count, active';
const HISTORY_LIMIT = 50;

function requireId(id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Customer not found.');
}

function customerName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'Enter the customer name.');
  return name;
}

function customerPhone(value, required) {
  const phone = typeof value === 'string' ? value.trim() : '';
  if (!phone && !required) return '';
  if (!/^[0-9+() -]{6,20}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number.');
  return phone;
}

function customerEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > 120 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function customerAddress(value) {
  const address = typeof value === 'string' ? value.trim() : '';
  if (address.length > 300) throw new HttpError(400, 'Address must be 300 characters or fewer.');
  return address;
}

function openingPoints(user, value) {
  if (value === undefined || value === null || value === '') return 0;
  const points = Number(value);
  if (!Number.isInteger(points) || points < 0 || points > 1000000) throw new HttpError(400, 'Opening points must be a whole number.');
  if (points > 0 && !user.permissions.includes('customers.points')) throw new HttpError(403, 'Only a Manager can set opening loyalty points.');
  return points;
}

function asCustomer(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    loyaltyPoints: row.loyalty_points,
    purchaseCount: row.purchase_count,
    active: row.active
  };
}

export async function listCustomers({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const status = ['active', 'inactive', 'all'].includes(query.status) ? query.status : 'active';
  const search = typeof query.q === 'string' ? query.q.replace(/[%*_\\"]/g, ' ').trim().slice(0, 100) : '';
  let request = database.from('customers').select(COLUMNS, { count: 'exact' });
  if (status !== 'all') request = request.eq('active', status === 'active');
  if (search) request = request.or(`name.ilike."*${search}*",code.ilike."*${search}*",phone.ilike."*${search}*",email.ilike."*${search}*"`);
  const { data, count, error } = await request.order('name').order('id').range((page - 1) * pageSize, page * pageSize - 1);
  unwrap({ data, error });
  return { customers: data.map(asCustomer), total: count ?? data.length, page, pageSize };
}

export async function getCustomer({ database }, id) {
  requireId(id);
  const row = unwrap(await database.from('customers').select(COLUMNS).eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Customer not found.');
  const [stats, bills, refunds] = await Promise.all([
    database.rpc('customer_stats', { p_customer: id }),
    database.from('sales').select('id, bill_no, status, grand_total, points_earned, created_at', { count: 'exact' }).eq('customer_id', id).order('created_at', { ascending: false }).order('id').limit(HISTORY_LIMIT),
    database.from('refunds').select('refund_no, total, reason, created_at, sales!inner(id, bill_no, customer_id)').eq('sales.customer_id', id).order('created_at', { ascending: false }).order('id').limit(HISTORY_LIMIT)
  ]);
  const billRows = unwrap(bills);
  return {
    ...asCustomer(row),
    stats: unwrap(stats),
    billCount: bills.count ?? billRows.length,
    bills: billRows.map((bill) => ({
      id: bill.id,
      billNo: bill.bill_no,
      status: bill.status,
      total: Number(bill.grand_total),
      points: bill.points_earned,
      createdAt: bill.created_at
    })),
    refunds: unwrap(refunds).map((refund) => ({
      refundNo: refund.refund_no,
      saleId: refund.sales.id,
      billNo: refund.sales.bill_no,
      total: Number(refund.total),
      reason: refund.reason,
      createdAt: refund.created_at
    }))
  };
}

export async function createCustomer({ database }, user, body, { phoneRequired = false } = {}) {
  const details = {
    name: customerName(body?.name),
    phone: customerPhone(body?.phone, phoneRequired),
    email: customerEmail(body?.email),
    address: customerAddress(body?.address),
    loyaltyPoints: openingPoints(user, body?.loyaltyPoints)
  };
  if (details.phone) {
    const existing = unwrap(await database.from('customers').select('id').eq('phone', details.phone).eq('active', true).maybeSingle());
    if (existing) throw new HttpError(409, 'A customer with this phone number already exists.');
  }
  const id = unwrap(await database.rpc('add_customer', { p_customer: details }));
  const row = unwrap(await database.from('customers').select(COLUMNS).eq('id', id).single());
  const points = details.loyaltyPoints ? ` · ${details.loyaltyPoints} opening points` : '';
  await writeAudit(database, { user, action: 'Customer added', description: `${row.code} ${row.name}${points}`, entityType: 'customer', entityId: id });
  return asCustomer(row);
}

export async function updateCustomer({ database }, user, id, body) {
  requireId(id);
  const changes = {};
  if (body?.name !== undefined) changes.name = customerName(body.name);
  if (body?.phone !== undefined) changes.phone = customerPhone(body.phone, false);
  if (body?.email !== undefined) changes.email = customerEmail(body.email);
  if (body?.address !== undefined) changes.address = customerAddress(body.address);
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Active must be true or false.');
    changes.active = body.active;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');

  if (changes.active === false) {
    const { count, error } = await database.from('held_orders').select('id', { count: 'exact', head: true }).eq('customer_id', id).eq('status', 'Held');
    unwrap({ error });
    if (count > 0) throw new HttpError(409, `${count} held order(s) use this customer. Resume or cancel them first.`);
  }

  const row = unwrap(await database.from('customers').update(changes).eq('id', id).select(COLUMNS).maybeSingle());
  if (!row) throw new HttpError(404, 'Customer not found.');
  const onlyStatus = Object.keys(changes).length === 1 && 'active' in changes;
  await writeAudit(database, {
    user,
    action: onlyStatus ? (changes.active ? 'Customer reactivated' : 'Customer deactivated') : 'Customer updated',
    description: `${row.code} ${row.name}`,
    entityType: 'customer',
    entityId: id
  });
  return asCustomer(row);
}
