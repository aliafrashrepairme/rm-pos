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
