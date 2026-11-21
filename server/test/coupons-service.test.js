import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoupon, isCouponValidOn, updateCoupon } from '../services/coupons.js';

// A small stand-in for the database: one coupons table plus the audit log.
function fakeClients(rows = []) {
  const table = rows.map((row) => ({ ...row }));
  const audits = [];
  const query = (name) => {
    const filters = [];
    let pending = null;
    const chain = {
      select: () => chain,
      order: () => chain,
      eq: (column, value) => { filters.push([column, value]); return chain; },
      single: () => chain,
      maybeSingle: () => { chain.oneRow = true; return chain; },
      insert(value) {
        if (name === 'audit_logs') { audits.push(value); return chain; }
        pending = table.some((row) => row.code === value.code) ? { error: { code: '23505' } } : (table.push({ ...value }), { error: null });
        return chain;
      },
      update(value) { pending = { update: value }; return chain; },
      then(resolve) {
        if (name === 'store_settings') return resolve({ data: { time_zone: 'Asia/Colombo' }, error: null });
        if (pending?.error !== undefined) return resolve({ data: null, error: pending.error });
        const match = table.filter((row) => filters.every(([c, v]) => row[c] === v));
        if (pending?.update) { match.forEach((row) => Object.assign(row, pending.update)); return resolve({ data: null, error: null }); }
        return resolve({ data: chain.oneRow ? match[0] ?? null : match, error: null });
      }
    };
    return chain;
  };
  return { clients: { database: { from: query } }, table, audits };
}
const user = { id: 'manager', name: 'Manager' };

test('a new coupon needs a 3-20 character code and a 1-50% discount', async () => {
  const { clients, table, audits } = fakeClients();
  await assert.rejects(createCoupon(clients, user, { code: 'AB', rate: 0.1 }), /3 to 20 letters/);
  await assert.rejects(createCoupon(clients, user, { code: 'SALE!', rate: 0.1 }), /3 to 20 letters/);
  await assert.rejects(createCoupon(clients, user, { code: 'HALF', rate: 0.6 }), /1% to 50%/);
  await assert.rejects(createCoupon(clients, user, { code: 'TINY', rate: 0.001 }), /1% to 50%/);
  const list = await createCoupon(clients, user, { code: 'diwali15', rate: 0.15, description: 'Festival' });
  assert.equal(table[0].code, 'DIWALI15');
  assert.equal(list[0].rate, 0.15);
  assert.equal(audits[0].action, 'Coupon added');
});

test('dates must be real and in order; codes are unique', async () => {
  const { clients } = fakeClients([{ code: 'WELCOME10', rate: '0.1', active: true, first_purchase_only: true, description: '' }]);
  await assert.rejects(createCoupon(clients, user, { code: 'WELCOME10', rate: 0.1 }), /already exists/);
  await assert.rejects(createCoupon(clients, user, { code: 'XMAS', rate: 0.1, validFrom: '2026-12-25', validUntil: '2026-12-01' }), /on or after/);
  await assert.rejects(createCoupon(clients, user, { code: 'XMAS', rate: 0.1, validFrom: '25/12/2026' }), /must be a date/);
});

test('switching off and changing a coupon keeps its code', async () => {
  const { clients, table, audits } = fakeClients([{ code: 'WELCOME10', rate: '0.1', active: true, first_purchase_only: true, description: '' }]);
  await updateCoupon(clients, user, 'welcome10', { active: false });
  assert.equal(table[0].active, false);
  assert.equal(audits.at(-1).action, 'Coupon switched off');
  await updateCoupon(clients, user, 'WELCOME10', { rate: 0.12 });
  assert.equal(table[0].rate, 0.12);
  await assert.rejects(updateCoupon(clients, user, 'NOPE', { active: true }), /not found/);
  await assert.rejects(updateCoupon(clients, user, 'WELCOME10', {}), /Nothing to change/);
});

test('a coupon is usable only while switched on and within its dates', () => {
  const coupon = { active: true, validFrom: '2026-12-01', validUntil: '2026-12-31' };
  assert.equal(isCouponValidOn(coupon, '2026-11-30'), false);
  assert.equal(isCouponValidOn(coupon, '2026-12-01'), true);
  assert.equal(isCouponValidOn(coupon, '2026-12-31'), true);
  assert.equal(isCouponValidOn(coupon, '2027-01-01'), false);
  assert.equal(isCouponValidOn({ ...coupon, active: false }, '2026-12-15'), false);
  assert.equal(isCouponValidOn({ active: true, validFrom: null, validUntil: null }, '2030-01-01'), true);
});
