import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const STORE_TEXT = { storeName: ['store_name', 120, 'Store name'], address: ['address', 300, 'Address'], phone: ['phone', 40, 'Phone'], vatRegistration: ['vat_registration', 60, 'VAT registration'] };
const RECEIPT_SIZES = ['80mm', '100mm', 'A4'];
const RECEIPT_SWITCHES = ['showTax', 'showBalance', 'printAfterSale'];

export const DEFAULT_RECEIPT = { size: '80mm', showTax: true, showBalance: true, printAfterSale: false, footer: '' };

// Regular-customer discount settings (migration 0026), or null before it is applied.
function asRegularDiscount(row) {
  if (row.regular_discount_enabled === undefined) return null;
  return { enabled: row.regular_discount_enabled, minVisits: row.regular_min_visits, periodDays: row.regular_period_days, rate: Number(row.regular_discount_rate) };
}

export async function regularDiscountSettings({ database }) {
  return asRegularDiscount(unwrap(await database.from('store_settings').select('*').single()));
}

function regularDiscountFrom(body) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Regular-customer discount settings are not valid.');
  const changes = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'The regular-customer discount must be on or off.');
    changes.regular_discount_enabled = body.enabled;
  }
  if (body.minVisits !== undefined) {
    if (!Number.isInteger(body.minVisits) || body.minVisits < 1 || body.minVisits > 100) throw new HttpError(400, 'Purchases needed must be a whole number from 1 to 100.');
    changes.regular_min_visits = body.minVisits;
  }
  if (body.periodDays !== undefined) {
    if (!Number.isInteger(body.periodDays) || body.periodDays < 7 || body.periodDays > 365) throw new HttpError(400, 'The period must be from 7 to 365 days.');
    changes.regular_period_days = body.periodDays;
  }
  if (body.rate !== undefined) {
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 0.5 || Math.abs(Math.round(rate * 10000) - rate * 10000) > 1e-6) throw new HttpError(400, 'The discount must be more than 0% and at most 50%.');
    changes.regular_discount_rate = rate;
  }
  return changes;
}

function asSettings(row, taxRates, methods) {
  return {
    storeName: row.store_name,
    address: row.address,
    phone: row.phone,
    vatRegistration: row.vat_registration,
    currency: row.currency_code,
    timeZone: row.time_zone,
    receipt: { ...DEFAULT_RECEIPT, ...row.receipt },
    regularDiscount: asRegularDiscount(row),
    taxRates: taxRates.map((rate) => ({ id: rate.id, name: rate.name, rate: Number(rate.rate), isDefault: rate.is_default })),
    paymentMethods: methods.map((method) => ({ code: method.code, isCash: method.is_cash, requiresReference: method.requires_reference, active: method.active }))
  };
}

export async function getSettings({ database }) {
  const [store, taxRates, methods] = await Promise.all([
    database.from('store_settings').select('*').single(),
    database.from('tax_rates').select('id, name, rate, is_default').eq('active', true).order('rate', { ascending: false }).order('name'),
    database.from('payment_methods').select('code, is_cash, requires_reference, active').order('sort_order')
  ]);
  return asSettings(unwrap(store), unwrap(taxRates), unwrap(methods));
}

function receiptFrom(body) {
  const receipt = {};
  if (body.size !== undefined) {
    if (!RECEIPT_SIZES.includes(body.size)) throw new HttpError(400, 'Choose a valid receipt size.');
    receipt.size = body.size;
  }
  for (const key of RECEIPT_SWITCHES) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw new HttpError(400, 'Receipt options must be on or off.');
      receipt[key] = body[key];
    }
  }
  if (body.footer !== undefined) {
    if (typeof body.footer !== 'string' || body.footer.length > 200) throw new HttpError(400, 'The receipt message must be 200 characters or fewer.');
    receipt.footer = body.footer.trim();
  }
  return receipt;
}

export async function updateSettings(clients, user, body) {
  const { database } = clients;
  const store = {};
  for (const [key, [column, max, label]] of Object.entries(STORE_TEXT)) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== 'string' || body[key].length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
    store[column] = body[key].trim();
  }
  if (store.store_name === '') throw new HttpError(400, 'Enter the store name.');
  let receipt = {};
  if (body?.receipt !== undefined) {
    if (typeof body.receipt !== 'object' || body.receipt === null) throw new HttpError(400, 'Receipt options must be on or off.');
    receipt = receiptFrom(body.receipt);
  }
  const regular = body?.regularDiscount !== undefined ? regularDiscountFrom(body.regularDiscount) : {};
  const changed = [...Object.keys(store), ...(Object.keys(receipt).length ? ['receipt'] : []), ...(Object.keys(regular).length ? ['regular-customer discount'] : [])];
  if (!changed.length) throw new HttpError(400, 'Nothing to change.');
  if (Object.keys(store).length || Object.keys(receipt).length) {
    unwrap(await database.rpc('save_store_settings', { p_store: store, p_receipt: receipt, p_user: user.id }));
  }
  if (Object.keys(regular).length) {
    unwrap(await database.from('store_settings').update({ ...regular, updated_by: user.id, updated_at: new Date().toISOString() }).eq('id', true));
  }
  await writeAudit(database, { user, action: 'Settings changed', description: changed.join(', '), entityType: 'settings' });
  return getSettings(clients);
}

export async function updateTaxRate(clients, user, id, body) {
  const { database } = clients;
  const rate = Number(body?.rate);
  if (body?.rate === '' || body?.rate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, 'Enter a tax rate between 0 and 100.');
  const row = unwrap(await database.from('tax_rates').select('name, rate').eq('id', id).eq('active', true).maybeSingle());
  if (!row) throw new HttpError(404, 'Tax rate not found.');
  const rounded = Math.round(rate * 100) / 100;
  unwrap(await database.from('tax_rates').update({ rate: rounded }).eq('id', id).select('id').single());
  await writeAudit(database, { user, action: 'Tax rate changed', description: `${row.name}: ${Number(row.rate)}% → ${rounded}%`, entityType: 'tax_rate', entityId: id });
  return getSettings(clients);
}

export async function setDefaultTaxRate(clients, user, id) {
  const { database } = clients;
  unwrap(await database.rpc('set_default_tax_rate', { p_rate: id }));
  await writeAudit(database, { user, action: 'Default tax rate changed', entityType: 'tax_rate', entityId: id });
  return getSettings(clients);
}

export async function updatePaymentMethod(clients, user, code, body) {
  const { database } = clients;
  const changes = {};
  for (const [key, column] of [['active', 'active'], ['requiresReference', 'requires_reference']]) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new HttpError(400, 'Payment options must be on or off.');
    changes[column] = body[key];
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
  if (changes.active === false) {
    const others = unwrap(await database.from('payment_methods').select('code').eq('active', true).neq('code', code));
    if (!others.length) throw new HttpError(409, 'Keep at least one payment method on.');
  }
  const row = unwrap(await database.from('payment_methods').update(changes).eq('code', code).select('code').maybeSingle());
  if (!row) throw new HttpError(404, 'Payment method not found.');
  await writeAudit(database, { user, action: 'Payment method changed', description: `${code}: ${Object.entries(changes).map(([key, value]) => `${key === 'active' ? 'status' : 'asks for a reference'} ${value ? 'on' : 'off'}`).join(', ')}`, entityType: 'payment_method', entityId: code });
  return getSettings(clients);
}
