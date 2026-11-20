import { HttpError, unwrap } from '../errors.js';
import { writeAudit } from './audit.js';

const CODE = /^[A-Z0-9]{3,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function asCoupon(row) {
  return {
    code: row.code,
    description: row.description,
    rate: Number(row.rate),
    firstPurchaseOnly: row.first_purchase_only,
    active: row.active,
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null
  };
}

// Today's date in the shop's time zone, as YYYY-MM-DD (the same day create_sale uses).
export async function shopToday({ database }) {
  let zone = 'Asia/Colombo';
  try {
    const { data } = await database.from('store_settings').select('time_zone').single();
    if (data?.time_zone) zone = data.time_zone;
  } catch {
    // Keep the default zone.
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
}

export function isCouponValidOn(coupon, today) {
  return coupon.active && (!coupon.validFrom || coupon.validFrom <= today) && (!coupon.validUntil || coupon.validUntil >= today);
}

export async function listCoupons(clients) {
  const rows = unwrap(await clients.database.from('coupons').select('*').order('code'));
  const today = await shopToday(clients);
  return rows.map(asCoupon).map((coupon) => ({ ...coupon, usableToday: isCouponValidOn(coupon, today) }));
}

function dateOrNull(value, label) {
  if (value === null || value === '' || value === undefined) return null;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) throw new HttpError(400, `${label} must be a date.`);
  return value;
}

// Fields a Manager may set. `partial` allows sending only what changed.
function couponFields(body, { partial }) {
  const fields = {};
  if (!partial || body?.rate !== undefined) {
    const percent = Number(body?.rate) * 100;
    if (!Number.isFinite(percent) || percent < 1 || percent > 50 || Math.abs(Math.round(percent * 100) - percent * 100) > 1e-6) {
      throw new HttpError(400, 'The discount must be from 1% to 50%.');
    }
    fields.rate = Math.round(percent * 100) / 10000;
  }
  if (!partial || body?.description !== undefined) {
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (description.length > 120) throw new HttpError(400, 'Keep the description to 120 characters.');
    fields.description = description;
  }
  for (const [key, column] of [['firstPurchaseOnly', 'first_purchase_only'], ['active', 'active']]) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new HttpError(400, 'Coupon options must be on or off.');
    fields[column] = body[key];
  }
  if (!partial || body?.validFrom !== undefined) fields.valid_from = dateOrNull(body?.validFrom, 'The start date');
  if (!partial || body?.validUntil !== undefined) fields.valid_until = dateOrNull(body?.validUntil, 'The end date');
  return fields;
}

function checkDates(from, until) {
  if (from && until && until < from) throw new HttpError(400, 'The end date must be on or after the start date.');
}

export async function createCoupon(clients, user, body) {
  const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!CODE.test(code)) throw new HttpError(400, 'A coupon code is 3 to 20 letters or digits, e.g. DIWALI15.');
  const fields = couponFields(body, { partial: false });
  checkDates(fields.valid_from, fields.valid_until);
  const { error } = await clients.database.from('coupons').insert({ code, active: true, first_purchase_only: false, ...fields });
  if (error?.code === '23505') throw new HttpError(409, `The coupon ${code} already exists.`);
  if (error) throw error;
  await writeAudit(clients.database, { user, action: 'Coupon added', description: `${code} · ${Math.round(fields.rate * 1000) / 10}%` });
  return listCoupons(clients);
}

// The code itself never changes: past bills refer to it.
export async function updateCoupon(clients, user, rawCode, body) {
  const code = String(rawCode ?? '').toUpperCase();
  const current = unwrap(await clients.database.from('coupons').select('*').eq('code', code).maybeSingle());
  if (!current) throw new HttpError(404, 'Coupon not found.');
  const fields = couponFields(body, { partial: true });
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to change.');
  checkDates(fields.valid_from !== undefined ? fields.valid_from : current.valid_from, fields.valid_until !== undefined ? fields.valid_until : current.valid_until);
  unwrap(await clients.database.from('coupons').update(fields).eq('code', code));
  const what = fields.active === false ? 'switched off' : fields.active === true ? 'switched on' : 'changed';
  await writeAudit(clients.database, { user, action: `Coupon ${what}`, description: code });
  return listCoupons(clients);
}
