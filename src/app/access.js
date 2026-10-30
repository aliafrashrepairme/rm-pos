// Screens in prototype order. A screen is open to anyone holding one of its permissions.
// This only shapes the menu: the API checks every request again.
export const SCREENS = [
  { name: 'Dashboard', anyOf: ['dashboard.view'] },
  { name: 'POS Billing', anyOf: ['pos.sell'] },
  { name: 'Held Orders', anyOf: ['held.manage'] },
  { name: 'Bills Register', anyOf: ['bills.view'] },
  { name: 'Daily Transactions', anyOf: ['transactions.view'] },
  { name: 'Monthly Transactions', anyOf: ['transactions.view'] },
  { name: 'Shifts & Cash', anyOf: ['shifts.own', 'shifts.manage'] },
  { name: 'Customers', anyOf: ['customers.view'] },
  { name: 'Inventory', anyOf: ['inventory.view'] },
  { name: 'Products', anyOf: ['products.view'] },
  { name: 'Purchases', anyOf: ['purchases.view'] },
  { name: 'Suppliers', anyOf: ['suppliers.view'] },
  { name: 'AI Invoice Scan', anyOf: ['ai_scan.use'] },
  { name: 'Barcode Scanner', anyOf: ['barcode.scan'] },
  { name: 'Reports', anyOf: ['reports.sales', 'reports.inventory'] },
  { name: 'Import / Export', anyOf: ['import_export.use'] },
  { name: 'Settings', anyOf: ['settings.manage'] },
  { name: 'User Management', anyOf: ['users.manage'] },
  { name: 'Audit Log', anyOf: ['audit.view'] }
];

export function can(user, ...permissions) {
  return permissions.some((permission) => user?.permissions?.includes(permission));
}

export function screensFor(user) {
  return SCREENS.filter((screen) => can(user, ...screen.anyOf)).map((screen) => screen.name);
}

export function canOpen(user, name) {
  const screen = SCREENS.find((item) => item.name === name);
  return Boolean(screen) && can(user, ...screen.anyOf);
}
