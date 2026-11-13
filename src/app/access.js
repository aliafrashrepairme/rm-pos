// Screens in menu order. A screen is open to anyone holding one of its permissions.
// This only shapes the menu: the API checks every request again.
export const SCREENS = [
  { name: 'Dashboard', group: 'WORKSPACE', icon: '▦', anyOf: ['dashboard.view'] },
  { name: 'POS Billing', group: 'WORKSPACE', icon: '▣', anyOf: ['pos.sell'] },
  { name: 'Held Orders', group: 'WORKSPACE', icon: '◫', anyOf: ['held.manage'] },
  { name: 'Bills Register', group: 'WORKSPACE', icon: '▧', anyOf: ['bills.view'] },
  { name: 'Customers', group: 'WORKSPACE', icon: '♙', anyOf: ['customers.view'] },
  { name: 'Shifts & Cash', group: 'WORKSPACE', icon: '◴', anyOf: ['shifts.own', 'shifts.manage'] },
  { name: 'Daily Transactions', group: 'TRANSACTIONS', icon: '◷', anyOf: ['transactions.view'] },
  { name: 'Monthly Transactions', group: 'TRANSACTIONS', icon: '▤', anyOf: ['transactions.view'] },
  { name: 'Inventory', group: 'INVENTORY', icon: '▥', anyOf: ['inventory.view'] },
  { name: 'Products', group: 'INVENTORY', icon: '▨', anyOf: ['products.view'] },
  { name: 'Purchases', group: 'INVENTORY', icon: '⇩', anyOf: ['purchases.view'] },
  { name: 'Suppliers', group: 'INVENTORY', icon: '♧', anyOf: ['suppliers.view'] },
  { name: 'AI Invoice Scan', group: 'INVENTORY', icon: '✦', anyOf: ['ai_scan.use'] },
  { name: 'Barcode Scanner', group: 'SMART TOOLS', icon: '⌸', anyOf: ['barcode.scan'] },
  { name: 'Reports', group: 'ADMINISTRATION', icon: '◔', anyOf: ['reports.sales', 'reports.inventory'] },
  { name: 'Import / Export', group: 'ADMINISTRATION', icon: '⇅', anyOf: ['import_export.use'] },
  { name: 'List Management', group: 'ADMINISTRATION', icon: '≣', anyOf: ['lists.manage'] },
  { name: 'Settings', group: 'ADMINISTRATION', icon: '⚙', anyOf: ['settings.manage'] },
  { name: 'User Management', group: 'ADMINISTRATION', icon: '♔', anyOf: ['users.manage'] },
  { name: 'Audit Log', group: 'ADMINISTRATION', icon: '☰', anyOf: ['audit.view'] }
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

// Groups with nothing the user can open are left out, as in the prototype.
export function menuFor(user) {
  const groups = [];
  for (const screen of SCREENS.filter((item) => can(user, ...item.anyOf))) {
    const last = groups.at(-1);
    if (last?.label === screen.group) last.screens.push(screen);
    else groups.push({ label: screen.group, screens: [screen] });
  }
  return groups;
}

export function slugFor(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function screenFromSlug(slug) {
  return SCREENS.find((screen) => slugFor(screen.name) === slug)?.name ?? null;
}
