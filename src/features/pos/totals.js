// Mirrors create_sale in the database, so the screen shows what the server will charge.
// Whole numbers (cents, thousandths) avoid floating-point rounding errors.
function divideRounded(value, divisor) {
  return Math.round(value / divisor);
}

function memberOffer(customer) {
  if (!customer || customer.purchaseCount === 0) return { rate: 0, label: '' };
  if (customer.loyaltyPoints >= 1000) return { rate: 0.07, label: 'Gold member offer', tier: 'Gold' };
  if (customer.loyaltyPoints >= 400) return { rate: 0.05, label: 'Silver member offer', tier: 'Silver' };
  return { rate: 0.03, label: 'Bronze member offer', tier: 'Bronze' };
}

// Same rule as create_sale: a coupon replaces the member offer, then the regular-customer rate
// (`regular`, when this customer qualifies) applies only if it is bigger. Only one offer ever applies.
// A Gold member keeps double points under the regular rate; a coupon earns single points.
export function bestOffer(customer, coupon, regular = null) {
  const first = coupon ? { rate: coupon.rate, label: `Coupon ${coupon.code}` } : memberOffer(customer);
  if (customer && regular?.rate > first.rate) {
    return { rate: regular.rate, label: 'Regular customer offer', tier: memberOffer(customer).tier, regular: true };
  }
  return first;
}

// Same rule as create_sale: 1 point per LKR 100 paid, doubled for Gold members. Walk-in bills earn nothing.
export function pointsFor(customer, offer, total) {
  if (!customer || !(total > 0)) return 0;
  return Math.floor(total / 100) * (offer.tier === 'Gold' ? 2 : 1);
}

export function couponProblem(coupon, customer) {
  if (!coupon) return 'This coupon code is not valid.';
  if (coupon.firstPurchaseOnly && (!customer || customer.purchaseCount > 0)) return `${coupon.code} is only for first-time buyers.`;
  return null;
}

export function cartTotals(lines, discountRate = 0) {
  const rate = Math.round(discountRate * 10000);
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const line of lines) {
    const amount = divideRounded(Math.round(line.price * 100) * Math.round(line.qty * 1000), 1000);
    const lineDiscount = divideRounded(amount * rate, 10000);
    subtotal += amount;
    discount += lineDiscount;
    tax += divideRounded((amount - lineDiscount) * Math.round(line.taxRate * 100), 10000);
  }
  return {
    subtotal: subtotal / 100,
    discount: discount / 100,
    tax: tax / 100,
    total: (subtotal - discount + tax) / 100
  };
}

export function roundUpTo(amount, step) {
  return Math.ceil(amount / step) * step;
}
