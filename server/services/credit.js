import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, code, name, phone, loyalty_points, purchase_count, credit_limit, credit_balance';

function requireId(id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Customer not found.');
}

function searchText(value) {
  return typeof value === 'string' ? value.replace(/[%*_\\",()]/g, ' ').trim().slice(0, 100) : '';
}

function money(value, message) {
  const amount = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(amount) || amount < 0 || amount > 9999999999) throw new HttpError(400, message);
  return Math.round(amount * 100) / 100;
}

export function asCreditCustomer(row) {
  const limit = Number(row.credit_limit);
  const balance = Number(row.credit_balance);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    loyaltyPoints: row.loyalty_points,
    purchaseCount: row.purchase_count,
    creditLimit: limit,
    creditBalance: balance,
    creditAvailable: Math.max(limit - balance, 0)
  };
}

// Customers who can buy on credit or still owe something.
export async function creditCustomers({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = 25;
  let request = database.from('customers').select(COLUMNS, { count: 'exact' });
  request = query.filter === 'owing' ? request.gt('credit_balance', 0) : request.or('credit_limit.gt.0,credit_balance.gt.0');
  const search = searchText(query.q);
  // Searching finds any customer, so a Manager can give a new one a limit.
  if (search) request = database.from('customers').select(COLUMNS, { count: 'exact' }).eq('active', true)
    .or(`name.ilike."*${search}*",phone.ilike."*${search}*",code.ilike."*${search}*"`);
  const [result, totals] = await Promise.all([
    request.order('credit_balance', { ascending: false }).order('name').range((page - 1) * pageSize, page * pageSize - 1),
    database.from('customers').select('credit_balance, credit_limit').gt('credit_balance', 0)
  ]);
  const owing = unwrap(totals);
  return {
    customers: unwrap(result).map(asCreditCustomer),
    summary: {
      totalOwed: owing.reduce((sum, row) => sum + Number(row.credit_balance), 0),
      customersOwing: owing.length,
      overLimit: owing.filter((row) => Number(row.credit_balance) > Number(row.credit_limit)).length
    },
    total: result.count ?? 0,
    page,
    pageSize
  };
}

export async function creditLedger({ database }, id) {
  requireId(id);
  const customer = unwrap(await database.from('customers').select(COLUMNS).eq('id', id).maybeSingle());
  if (!customer) throw new HttpError(404, 'Customer not found.');
  const entries = unwrap(await database.from('customer_credit_entries')
    .select('entry_no, kind, amount, balance_after, method_code, reference, created_at, sales(bill_no), creator:profiles!customer_credit_entries_created_by_fkey(full_name)')
    .eq('customer_id', id)
    .order('created_at', { ascending: false })
    .limit(100));
  return {
    customer: asCreditCustomer(customer),
    entries: entries.map((row) => ({
      entryNo: row.entry_no,
      kind: row.kind,
      amount: Number(row.amount),
      balanceAfter: Number(row.balance_after),
      method: row.method_code,
      reference: row.reference,
      billNo: row.sales?.bill_no ?? null,
      by: row.creator?.full_name ?? '',
      createdAt: row.created_at
    }))
  };
}

export async function recordPayment(clients, user, id, body) {
  requireId(id);
  const amount = money(body?.amount, 'Enter a valid amount.');
  if (amount <= 0) throw new HttpError(400, 'Enter a valid amount.');
  const result = unwrap(await clients.database.rpc('record_credit_payment', {
    p_payment: { customerId: id, amount, method: body?.method, reference: typeof body?.reference === 'string' ? body.reference.trim().slice(0, 100) : '' },
    p_user: user.id
  }));
  await writeAudit(clients.database, { user, action: 'Credit payment received', description: `${result.customer} · ${body.method} ${amount.toFixed(2)} · balance ${Number(result.balance).toFixed(2)}`, entityType: 'customer', entityId: id });
  return { ...(await creditLedger(clients, id)), inShift: result.inShift };
}

export async function setLimit(clients, user, id, body) {
  requireId(id);
  const limit = money(body?.limit, 'Enter a valid credit limit.');
  const result = unwrap(await clients.database.rpc('set_credit_limit', { p_customer: id, p_limit: limit }));
  await writeAudit(clients.database, { user, action: 'Credit limit changed', description: `${result.customer} · ${Number(result.from).toFixed(2)} → ${limit.toFixed(2)}`, entityType: 'customer', entityId: id });
  return creditLedger(clients, id);
}

export async function supplierCredit({ database }) {
  const rows = unwrap(await database.rpc('supplier_payables'));
  const due = rows.map((row) => ({ ...row, total: Number(row.total), paid: Number(row.paid), balance: Number(row.balance) }));
  return {
    payables: due,
    summary: {
      totalOwed: due.reduce((sum, row) => sum + row.balance, 0),
      overdue: due.filter((row) => row.daysOverdue > 0).reduce((sum, row) => sum + row.balance, 0),
      overdueCount: due.filter((row) => row.daysOverdue > 0).length
    }
  };
}

export async function loyalty({ database }, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = 25;
  let request = database.from('customers').select(COLUMNS, { count: 'exact' }).eq('active', true).gt('loyalty_points', 0);
  const search = searchText(query.q);
  if (search) request = request.or(`name.ilike."*${search}*",phone.ilike."*${search}*",code.ilike."*${search}*"`);
  const [result, all, redeemed] = await Promise.all([
    request.order('loyalty_points', { ascending: false }).order('name').range((page - 1) * pageSize, page * pageSize - 1),
    database.from('customers').select('loyalty_points').eq('active', true).gt('loyalty_points', 0),
    database.from('sales').select('bill_no, customer_name, points_redeemed, grand_total, created_at').gt('points_redeemed', 0).neq('status', 'Voided')
      .order('created_at', { ascending: false }).limit(20)
  ]);
  const points = unwrap(all).reduce((sum, row) => sum + row.loyalty_points, 0);
  return {
    customers: unwrap(result).map(asCreditCustomer),
    summary: { outstandingPoints: points, outstandingValue: points, pointValue: 1 },
    redemptions: unwrap(redeemed).map((row) => ({
      billNo: row.bill_no, customer: row.customer_name, points: row.points_redeemed, billTotal: Number(row.grand_total), createdAt: row.created_at
    })),
    total: result.count ?? 0,
    page,
    pageSize
  };
}
