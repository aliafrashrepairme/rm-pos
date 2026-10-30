import assert from 'node:assert/strict';
import test from 'node:test';
import { canOpen, screensFor } from './access.js';

const owner = { permissions: ['transactions.view', 'reports.sales', 'reports.inventory', 'reports.export'] };
const cashier = { permissions: ['pos.sell', 'held.manage', 'bills.view', 'bills.print', 'shifts.own', 'customers.view', 'customers.manage', 'barcode.scan'] };
const stock = { permissions: ['reports.inventory', 'barcode.scan', 'products.view', 'products.manage', 'inventory.view', 'counts.manage', 'purchases.view', 'purchases.manage', 'suppliers.view', 'suppliers.manage'] };

test('each role lands on its first screen, as in the prototype', () => {
  assert.equal(screensFor(owner)[0], 'Daily Transactions');
  assert.equal(screensFor(cashier)[0], 'POS Billing');
  assert.equal(screensFor(stock)[0], 'Inventory');
});

test('the Owner sees only transactions and reports', () => {
  assert.deepEqual(screensFor(owner), ['Daily Transactions', 'Monthly Transactions', 'Reports']);
});

test('screens outside a role cannot be opened, even by name', () => {
  assert.equal(canOpen(cashier, 'User Management'), false);
  assert.equal(canOpen(cashier, 'Reports'), false);
  assert.equal(canOpen(stock, 'POS Billing'), false);
  assert.equal(canOpen(stock, 'Reports'), true);
  assert.equal(canOpen(owner, 'Settings'), false);
  assert.equal(canOpen(owner, 'No such screen'), false);
  assert.equal(canOpen(null, 'Reports'), false);
});
