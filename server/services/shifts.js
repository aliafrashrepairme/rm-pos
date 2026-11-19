import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['Transport', 'Utilities', 'Supplies', 'Maintenance', 'Other'];
const COLUMNS = 'id, shift_no, status, opening_cash, expected_cash, counted_cash, opened_at, closed_at, cashier_id, counters(name), cashier:profiles!shifts_cashier_id_fkey(full_name)';

const seesAll = (user) => user.permissions.includes('shifts.manage');

function asShift(row, figures) {
  const expected = row.status === 'Closed' ? Number(row.expected_cash) : figures?.expectedCash ?? null;
  const counted = row.counted_cash === null ? null : Number(row.counted_cash);
  return {
    id: row.id,
    shiftNo: row.shift_no,
    status: row.status,
    counter: row.counters?.name ?? '',
    cashier: row.cashier?.full_name ?? '',
    cashierId: row.cashier_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingCash: Number(row.opening_cash),
    expectedCash: expected,
    countedCash: counted,
    variance: counted === null ? null : Math.round((counted - expected) * 100) / 100
  };
}

function money(value, message) {
  const amount = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(amount) || amount < 0 || amount > 9999999999) throw new HttpError(400, message);
  return Math.round(amount * 100) / 100;
}

// Opening or closing a drawer needs the person's own password, so an unattended signed-in till can't be used.
// A wrong password is a 400, not a 401, so the app doesn't treat it as an expired session and sign out.
async function confirmPassword({ authClient, database }, user, password) {
  if (typeof password !== 'string' || !password) throw new HttpError(400, 'Enter your password.');
  const { data, error } = await authClient.auth.signInWithPassword({ email: user.email, password });
  if (error || !data?.session) {
    await writeAudit(database, { user, action: 'Shift password failed', entityType: 'user', entityId: user.id });
    throw new HttpError(400, 'Your password is not correct.');
  }
  const { error: signOutError } = await database.auth.admin.signOut(data.session.access_token, 'local');
  if (signOutError && signOutError.name !== 'AuthSessionMissingError') console.error('Could not end session:', signOutError);
}

// Cashiers reach only their own shifts. Asking for someone else's looks the same as asking for nothing.
async function shiftFor({ database }, user, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Shift not found.');
  const row = unwrap(await database.from('shifts').select(COLUMNS).eq('id', id).maybeSingle());
  if (!row || (!seesAll(user) && row.cashier_id !== user.id)) throw new HttpError(404, 'Shift not found.');
  return row;
}

export async function listShifts({ database }, user, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = 25;
  let request = database.from('shifts').select(COLUMNS, { count: 'exact' });
  if (!seesAll(user)) request = request.eq('cashier_id', user.id);
  const { data, count, error } = await request.order('opened_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  unwrap({ data, error });
  const shifts = await Promise.all(data.map(async (row) => asShift(row, row.status === 'Open' ? unwrap(await database.rpc('shift_figures', { p_shift: row.id })) : null)));
  return { shifts, total: count ?? shifts.length, page, pageSize };
}

export async function options({ database }, user) {
  const [counters, current, open, busy, last] = await Promise.all([
    database.from('counters').select('id, name').eq('active', true).order('name'),
    database.from('shifts').select('id, shift_no').eq('cashier_id', user.id).eq('status', 'Open').maybeSingle(),
    seesAll(user) ? database.from('shifts').select('id, shift_no').eq('status', 'Open').order('shift_no') : Promise.resolve({ data: [], error: null }),
    database.from('shifts').select('counter_id').eq('status', 'Open'),
    database.from('shifts').select('counter_id').eq('cashier_id', user.id).order('opened_at', { ascending: false }).limit(1)
  ]);
  // Each cashier starts on the counter they used last; failing that, the first one nobody is using.
  const inUse = new Set(unwrap(busy).map((row) => row.counter_id));
  const list = unwrap(counters).map((counter) => ({ ...counter, inUse: inUse.has(counter.id) }));
  const lastId = unwrap(last)[0]?.counter_id;
  const preferred = list.find((counter) => counter.id === lastId && !counter.inUse) ?? list.find((counter) => !counter.inUse) ?? list[0];
  return {
    counters: list,
    defaultCounterId: preferred?.id ?? null,
    current: unwrap(current),
    openShifts: unwrap(open),
    categories: CATEGORIES,
    canOpen: user.permissions.includes('shifts.own')
  };
}

export async function getShift(clients, user, id) {
  const row = await shiftFor(clients, user, id);
  const { database } = clients;
  const [figures, expenses] = await Promise.all([
    database.rpc('shift_figures', { p_shift: id }),
    database.from('expenses').select('expense_no, category, description, amount, paid_from_cash, created_at').eq('shift_id', id).order('created_at', { ascending: false })
  ]);
  const detail = unwrap(figures);
  return {
    ...asShift(row, detail),
    figures: detail,
    expenses: unwrap(expenses).map(asExpense)
  };
}

export async function openShift(clients, user, body) {
  const { database } = clients;
  if (typeof body?.counterId !== 'string' || !UUID.test(body.counterId)) throw new HttpError(400, 'Choose a counter.');
  const opening = money(body?.openingCash, 'Enter the opening cash.');
  await confirmPassword(clients, user, body?.password);
  const id = unwrap(await database.rpc('open_shift', { p_counter: body.counterId, p_opening: opening, p_user: user.id }));
  await writeAudit(database, { user, action: 'Shift opened', description: `Opening cash ${opening.toFixed(2)}`, entityType: 'shift', entityId: id });
  return { id };
}

export async function closeShift(clients, user, id, body) {
  await shiftFor(clients, user, id);
  const counted = money(body?.countedCash, 'Enter the cash counted.');
  await confirmPassword(clients, user, body?.password);
  const result = unwrap(await clients.database.rpc('close_shift', { p_shift: id, p_counted: counted, p_user: user.id }));
  await writeAudit(clients.database, { user, action: 'Shift closed', description: `${result.shiftNo} · expected ${Number(result.expected).toFixed(2)} · counted ${counted.toFixed(2)} · variance ${Number(result.variance).toFixed(2)}`, entityType: 'shift', entityId: id });
  return result;
}

function asExpense(row) {
  return {
    expenseNo: row.expense_no,
    category: row.category,
    description: row.description,
    amount: Number(row.amount),
    paidFromCash: row.paid_from_cash,
    shiftNo: row.shifts?.shift_no ?? '',
    createdBy: row.creator?.full_name ?? '',
    createdAt: row.created_at
  };
}

export async function listExpenses({ database }, user, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = 25;
  let request = database.from('expenses').select('expense_no, category, description, amount, paid_from_cash, created_at, shifts(shift_no), creator:profiles!expenses_created_by_fkey(full_name)', { count: 'exact' });
  if (!seesAll(user)) request = request.eq('created_by', user.id);
  const { data, count, error } = await request.order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  unwrap({ data, error });
  return { expenses: data.map(asExpense), total: count ?? data.length, page, pageSize };
}

export async function addExpense(clients, user, body) {
  const { database } = clients;
  if (!CATEGORIES.includes(body?.category)) throw new HttpError(400, 'Choose a category.');
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (!description || description.length > 300) throw new HttpError(400, 'Enter a description.');
  const amount = money(body?.amount, 'Enter a valid amount.');
  if (amount <= 0) throw new HttpError(400, 'Enter a valid amount.');
  const paidFromCash = body?.paidFromCash !== false;

  // Cashiers use their own open shift. Only someone managing shifts can name another.
  let shiftId = null;
  if (seesAll(user) && body?.shiftId) {
    if (!UUID.test(body.shiftId)) throw new HttpError(400, 'Choose a valid shift.');
    shiftId = body.shiftId;
  } else {
    const own = unwrap(await database.from('shifts').select('id').eq('cashier_id', user.id).eq('status', 'Open').maybeSingle());
    shiftId = own?.id ?? null;
  }
  const { expenseNo } = unwrap(await database.rpc('add_expense', { p_expense: { category: body.category, description, amount, paidFromCash, shiftId }, p_user: user.id }));
  await writeAudit(database, { user, action: 'Expense recorded', description: `${expenseNo} · ${body.category} · ${amount.toFixed(2)}`, entityType: 'expense', entityId: expenseNo });
  return { expenseNo };
}
