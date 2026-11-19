// Restores a backup file made by the server (Backups screen > Download, or the backups bucket).
// It REPLACES every table's contents, in one transaction: if anything fails nothing changes.
// Usage: npm --prefix server run db:restore -- path/to/rm-pos-backup-....json --yes
// Needs SUPABASE_DB_URL in .env, like db:migrate. See docs/recovery.md before using it.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvFile } from '../config.js';
import { checkSnapshot, restoreSnapshot } from '../services/restore.js';

const file = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (!file || !process.argv.includes('--yes')) {
  console.error('Usage: npm --prefix server run db:restore -- <backup-file.json> --yes\n'
    + 'This replaces ALL data in the database with the backup. Add --yes to confirm.');
  process.exit(1);
}

loadEnvFile();
if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL is not set in .env.');
  process.exit(1);
}

const snapshot = JSON.parse(await readFile(file, 'utf8'));
checkSnapshot(snapshot);
console.log(`Backup from ${snapshot.created_at}: ${Object.keys(snapshot.tables).length} tables.`);

const caFile = process.env.SUPABASE_DB_CA_FILE || fileURLToPath(new URL('../supabase/supabase-ca.crt', import.meta.url));
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { ca: await readFile(caFile, 'utf8'), rejectUnauthorized: true } });
await client.connect();
try {
  const result = await restoreSnapshot((sql, params) => client.query(sql, params), snapshot);
  console.log(`Restored ${result.rows} rows into ${result.tables} tables.`);
} catch (error) {
  console.error(`Restore failed, nothing was changed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
