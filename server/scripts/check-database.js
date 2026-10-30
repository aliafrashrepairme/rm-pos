// Read-only check that the migrations have been applied to the configured Supabase project.
import { loadEnvFile, readConfig } from '../config.js';
import { createClients } from '../db.js';

const EXPECTED_ROWS = {
  roles: 4,
  permissions: 33,
  units: 10,
  tax_rates: 2,
  payment_methods: 3,
  counters: 2,
  store_settings: 1,
  number_sequences: 13
};
const ANY_ROWS = ['role_permissions', 'profiles', 'categories', 'products', 'inventory_ledger', 'customers', 'suppliers',
  'sales', 'sale_items', 'payments', 'refunds', 'held_orders', 'purchases', 'goods_receipts', 'stock_counts',
  'stock_adjustments', 'shifts', 'expenses', 'invoice_scans', 'audit_logs'];

loadEnvFile();
const { database } = createClients(readConfig());
let failed = false;

async function countRows(table) {
  const { count, error, status } = await database.from(table).select('*', { count: 'exact', head: true });
  if (error || count === null) throw new Error(`not reachable (status ${status})`);
  return count;
}

for (const table of [...Object.keys(EXPECTED_ROWS), ...ANY_ROWS]) {
  try {
    const count = await countRows(table);
    const expected = EXPECTED_ROWS[table];
    const ok = expected === undefined || count >= expected;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${table}: ${count} row(s)${ok ? '' : `, expected at least ${expected}`}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${table}: ${error.message}`);
  }
}

const dashboard = await database.rpc('dashboard_summary');
if (dashboard.error) failed = true;
console.log(`${dashboard.error ? 'FAIL' : 'ok  '} dashboard_summary function${dashboard.error ? ' (run 0002_dashboard.sql)' : ''}`);

const barcode = await database.rpc('ean13_check_digit', { p_first_twelve: '200000000001' });
if (barcode.error) failed = true;
console.log(`${barcode.error ? 'FAIL' : 'ok  '} product functions${barcode.error ? ' (run 0003_products.sql)' : ''}`);

console.log(failed ? '\nThe database does not match. Run the files in server/supabase/migrations/ in number order.' : '\nThe database matches the migrations.');
process.exit(failed ? 1 : 0);
