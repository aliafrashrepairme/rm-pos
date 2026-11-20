import assert from 'node:assert/strict';
import test from 'node:test';
import { bestOffer, cartTotals, couponProblem, pointsFor, roundUpTo } from './totals.js';

test('loyalty points follow the bill total, doubled for Gold, none for walk-ins', () => {
  const silver = { loyaltyPoints: 500, purchaseCount: 3 };
  const gold = { loyaltyPoints: 1200, purchaseCount: 3 };
  assert.equal(pointsFor(null, bestOffer(null, null), 5000), 0);
  assert.equal(pointsFor(silver, bestOffer(silver, null), 25459.2), 254);
  assert.equal(pointsFor(gold, bestOffer(gold, null), 25459.2), 508);
  assert.equal(pointsFor(gold, bestOffer(gold, { code: 'X', rate: 0.1 }), 25459.2), 254, 'a coupon replaces the Gold bonus');
  assert.equal(pointsFor(silver, bestOffer(silver, null), 99), 0);
});

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

test('a regular customer gets the regular rate only when it beats the coupon or member offer', () => {
  const silver = { loyaltyPoints: 500, purchaseCount: 8 };
  const gold = { loyaltyPoints: 1200, purchaseCount: 20 };
  const regular = { rate: 0.06 };
  // 6% beats Silver's 5%.
  assert.deepEqual(bestOffer(silver, null, regular), { rate: 0.06, label: 'Regular customer offer', tier: 'Silver', regular: true });
  // Gold's 7% beats 6%, so Gold stays.
  assert.equal(bestOffer(gold, null, regular).label, 'Gold member offer');
  // A bigger coupon wins; a smaller one loses to the regular rate.
  assert.equal(bestOffer(silver, { code: 'BIG', rate: 0.1 }, regular).label, 'Coupon BIG');
  assert.equal(bestOffer(silver, { code: 'SMALL', rate: 0.02 }, regular).label, 'Regular customer offer');
  // Not a regular (null), or no customer: unchanged.
  assert.equal(bestOffer(silver, null, null).label, 'Silver member offer');
  assert.equal(bestOffer(null, null, regular).rate, 0);
});

test('a Gold member keeps double points under the regular rate', () => {
  const gold = { loyaltyPoints: 1200, purchaseCount: 20 };
  const offer = bestOffer(gold, null, { rate: 0.1 });
  assert.equal(offer.label, 'Regular customer offer');
  assert.equal(pointsFor(gold, offer, 1000), 20);
});
