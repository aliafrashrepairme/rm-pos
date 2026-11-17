import { bestOffer } from '../pos/totals.js';

// Uses the till's own rule, so this always matches the discount the customer gets.
export function memberLabel(customer) {
  return bestOffer(customer).tier ?? 'First-time buyer';
}
