import { createClient } from '@supabase/supabase-js';
import { unwrap } from './errors.js';

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const PAGE_SIZE = 1000;

export function createClients(config) {
  return {
    authClient: createClient(config.supabaseUrl, config.supabaseAnonKey, clientOptions),
    database: createClient(config.supabaseUrl, config.supabaseServiceRoleKey, clientOptions)
  };
}

// Supabase caps each response, so read in pages rather than silently losing rows.
export async function selectAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = unwrap(await buildQuery().range(from, from + PAGE_SIZE - 1));
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// Whether the credit-management update (0023_credit.sql) is on this database. Until it is, POS and the
// Bills Register leave out the new columns so the shop can keep selling. A "no" is checked again after a
// minute, so applying the update switches the new features on without restarting the server.
let creditSchema = { ready: false, checkedAt: 0 };
export async function hasCreditSchema(database) {
  if (creditSchema.ready || Date.now() - creditSchema.checkedAt < 60_000) return creditSchema.ready;
  const { error } = await database.from('payment_methods').select('selectable').eq('code', 'Cash');
  // Only a missing column means "not yet". Any other failure is left for the real query to report.
  creditSchema = { ready: !error || error.code !== '42703', checkedAt: Date.now() };
  if (!creditSchema.ready) console.warn('Database update 0023_credit.sql is not applied yet: points and credit are switched off.');
  return creditSchema.ready;
}

export function resetCreditSchemaCheck() {
  creditSchema = { ready: false, checkedAt: 0 };
}
