import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { hasTranslation } from '../i18n/translate.js';
import { canOpen, menuFor, screenFromSlug, SCREENS, screensFor, slugFor } from './access.js';

const owner = { permissions: ['transactions.view', 'transactions.monthly', 'reports.sales', 'reports.inventory', 'reports.export', 'users.manage'] };
const cashier = { permissions: ['pos.sell', 'held.manage', 'bills.view', 'bills.print', 'shifts.own', 'customers.view', 'customers.manage', 'barcode.scan'] };
const stock = { permissions: ['reports.inventory', 'barcode.scan', 'products.view', 'products.manage', 'inventory.view', 'counts.manage', 'purchases.view', 'purchases.manage', 'suppliers.view', 'suppliers.manage'] };

test('each role lands on its first screen, as in the prototype', () => {
  assert.equal(screensFor(owner)[0], 'Daily Transactions');
  assert.equal(screensFor(cashier)[0], 'POS Billing');
  assert.equal(screensFor(stock)[0], 'Inventory');
});

test('menu groups keep their order and drop empty groups', () => {
  assert.deepEqual(menuFor(owner).map((group) => group.label), ['TRANSACTIONS', 'ADMINISTRATION']);
  assert.deepEqual(menuFor(cashier).map((group) => group.label), ['WORKSPACE', 'SMART TOOLS']);
  assert.deepEqual(menuFor(stock).map((group) => group.label), ['INVENTORY', 'SMART TOOLS', 'ADMINISTRATION']);
});

test('every screen has a route that leads back to it', () => {
  for (const screen of SCREENS) assert.equal(screenFromSlug(slugFor(screen.name)), screen.name);
  assert.equal(screenFromSlug('no-such-screen'), null);
});

test('every label on the built screens exists in Tamil and Sinhala', () => {
  const src = new URL('..', import.meta.url);
  const sources = readdirSync(src, { recursive: true })
    .filter((file) => file.endsWith('.jsx'))
    .map((file) => new URL(file.replaceAll('\\', '/'), src));
  const labels = new Set(SCREENS.flatMap((screen) => [screen.name, screen.group]));
  for (const role of ['Owner', 'Manager', 'Cashier', 'Inventory Staff']) labels.add(role);
  for (const source of sources) {
    for (const match of readFileSync(source, 'utf8').matchAll(/\bt\((['"])((?:(?!\1)[^\\]|\\.)+)\1\)/g)) labels.add(match[2]);
  }
  const missing = [...labels].flatMap((label) => ['ta', 'si'].filter((language) => !hasTranslation(label, language)).map((language) => `${language}: ${label}`));
  assert.deepEqual(missing, []);
});

test('the Owner sees transactions, reports and User Management', () => {
  assert.deepEqual(screensFor(owner), ['Daily Transactions', 'Monthly Transactions', 'Reports', 'User Management']);
});

test('a Manager gets daily but not monthly transactions', () => {
  // The Manager role holds every permission except these, as the database grants it.
  const manager = { permissions: ['dashboard.view', 'transactions.view', 'bills.view', 'purchases.view', 'reports.sales'] };
  assert.equal(canOpen(manager, 'Daily Transactions'), true);
  assert.equal(canOpen(manager, 'Monthly Transactions'), false);
});

test('only the Owner opens Counters and Printers', () => {
  const ownerSetup = { permissions: [...owner.permissions, 'counters.manage', 'printers.manage'] };
  assert.equal(canOpen(ownerSetup, 'Counters'), true);
  assert.equal(canOpen(ownerSetup, 'Printers'), true);
  const managerLike = { permissions: ['settings.manage', 'users.manage', 'shifts.manage', 'lists.manage'] };
  assert.equal(canOpen(managerLike, 'Counters'), false);
  assert.equal(canOpen(managerLike, 'Printers'), false);
  assert.equal(canOpen(cashier, 'Counters'), false);
});

test('only the Owner opens Store Logo', () => {
  const ownerWithLogo = { permissions: [...owner.permissions, 'settings.logo'] };
  assert.deepEqual(screensFor(ownerWithLogo), ['Daily Transactions', 'Monthly Transactions', 'Reports', 'Store Logo', 'User Management']);
  assert.equal(canOpen({ permissions: ['settings.manage', 'users.manage'] }, 'Store Logo'), false);
});

test('only someone with backups.manage opens Backups & Status', () => {
  assert.equal(canOpen({ permissions: ['settings.manage', 'backups.manage'] }, 'Backups & Status'), true);
  assert.equal(canOpen(owner, 'Backups & Status'), false);
  assert.equal(canOpen(cashier, 'Backups & Status'), false);
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
