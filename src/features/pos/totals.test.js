import assert from 'node:assert/strict';
import test from 'node:test';
import { bestOffer, cartTotals, couponProblem, roundUpTo } from './totals.js';

test('totals add tax after discount and avoid floating-point errors', () => {
  assert.deepEqual(cartTotals([{ price: 1450, qty: 2, taxRate: 18 }]), { subtotal: 2900, discount: 0, tax: 522, total: 3422 });
  assert.deepEqual(cartTotals([{ price: 1000, qty: 1, taxRate: 18 }], 0.07), { subtotal: 1000, discount: 70, tax: 167.4, total: 1097.4 });
  assert.equal(cartTotals([{ price: 0.1, qty: 3, taxRate: 0 }]).total, 0.3);
  assert.deepEqual(cartTotals([]), { subtotal: 0, discount: 0, tax: 0, total: 0 });
});

test('offers follow the loyalty tiers, and new customers get none without a coupon', () => {
  assert.equal(bestOffer(null).rate, 0);
  assert.equal(bestOffer({ loyaltyPoints: 0, purchaseCount: 0 }).rate, 0);
  assert.equal(bestOffer({ loyaltyPoints: 0, purchaseCount: 1 }).tier, 'Bronze');
  assert.equal(bestOffer({ loyaltyPoints: 399, purchaseCount: 1 }).rate, 0.03);
  assert.equal(bestOffer({ loyaltyPoints: 400, purchaseCount: 1 }).tier, 'Silver');
  assert.equal(bestOffer({ loyaltyPoints: 1000, purchaseCount: 1 }).rate, 0.07);
  assert.equal(bestOffer({ loyaltyPoints: 1000, purchaseCount: 1 }, { code: 'X', rate: 0.1 }).rate, 0.1);
});

test('first-purchase coupons are limited to new known customers', () => {
  const coupon = { code: 'WELCOME10', rate: 0.1, firstPurchaseOnly: true };
  assert.match(couponProblem(undefined, null), /not valid/);
  assert.match(couponProblem(coupon, null), /first-time/);
  assert.match(couponProblem(coupon, { purchaseCount: 2 }), /first-time/);
  assert.equal(couponProblem(coupon, { purchaseCount: 0 }), null);
});

test('quick cash rounds up to the note', () => {
  assert.equal(roundUpTo(3422, 500), 3500);
  assert.equal(roundUpTo(3500, 500), 3500);
  assert.equal(roundUpTo(3422.5, 1000), 4000);
});
