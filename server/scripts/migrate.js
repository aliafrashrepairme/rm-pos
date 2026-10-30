// Applies new files from supabase/migrations in number order, each in its own transaction.
// Usage: npm --prefix server run db:migrate            (add -- --status to only list them)
// Needs SUPABASE_DB_URL in .env. Keep that out of the hosted API: only this command uses it.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvFile } from '../config.js';

// Files applied by hand before this command existed, with what proves each one ran.
const APPLIED_BY_HAND = {
  '0001_core_schema.sql': "to_regclass('public.store_settings') is not null",
  '0002_dashboard.sql': "to_regprocedure('public.dashboard_summary(timestamptz)') is not null",
  '0003_products.sql': "to_regprocedure('public.create_product(jsonb, uuid)') is not null",
  '0004_inventory.sql': "to_regprocedure('public.inventory_summary()') is not null",
  '0005_barcode_counts.sql': "to_regprocedure('public.scan_stock_count(uuid, uuid)') is not null",
  '0006_pos.sql': "to_regprocedure('public.create_sale(jsonb, uuid)') is not null",
  '0007_transactions.sql': "to_regprocedure('public.refund_sale(jsonb, uuid)') is not null",
  '0008_purchases.sql': "to_regprocedure('public.receive_purchase(jsonb, uuid)') is not null"
};

const folder = new URL('../supabase/migrations/', import.meta.url);
const statusOnly = process.argv.includes('--status');

loadEnvFile();
if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL is not set in .env.');
  process.exit(1);
}

// Always verifies the server, using the project's certificate from the Supabase dashboard.
// It isn't secret, but it is specific to the project's certificate authority.
const caFile = process.env.SUPABASE_DB_CA_FILE || fileURLToPath(new URL('../supabase/supabase-ca.crt', import.meta.url));
let ca;
try {
  ca = await readFile(caFile, 'utf8');
} catch {
  console.error(`Supabase's SSL certificate was not found at ${caFile}.\nDownload it from Project Settings > Database > SSL Configuration.`);
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { ca, rejectUnauthorized: true } });

async function recordEarlierMigrations(files) {
  await client.query('create schema if not exists internal');
  await client.query('revoke all on schema internal from public');
  await client.query(`create table if not exists internal.schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  for (const name of files) {
    const proof = APPLIED_BY_HAND[name];
    if (!proof) continue;
    const { rows } = await client.query(`select ${proof} as found`);
    if (rows[0].found) {
      await client.query('insert into internal.schema_migrations (name) values ($1) on conflict do nothing', [name]);
    }
  }
}

async function main() {
  await client.connect();
  const files = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();
  await recordEarlierMigrations(files);
  const { rows } = await client.query('select name from internal.schema_migrations');
  const done = new Set(rows.map((row) => row.name));
  const pending = files.filter((name) => !done.has(name));

  for (const name of files) console.log(`${done.has(name) ? 'applied' : 'pending'}  ${name}`);
  if (statusOnly) return;
  if (!pending.length) {
    console.log('\nThe database is up to date.');
    return;
  }

  for (const name of pending) {
    const sql = await readFile(new URL(name, folder), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into internal.schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`${name} failed and was rolled back: ${error.message}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
