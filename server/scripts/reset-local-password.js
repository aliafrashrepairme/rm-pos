import crypto from 'node:crypto';
import { assertAppClosed, createLocalClients, desktopDatabasePath } from '../local-db.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm --prefix server run local:password-reset -- USERNAME PASSWORD');
  process.exit(1);
}
if (password.length < 8) throw new Error('Password must be at least 8 characters.');

await assertAppClosed();
const dbPath = process.env.RM_POS_DB_PATH || desktopDatabasePath();
console.log(`Database: ${dbPath}`);
const { database } = await createLocalClients({ localDbPath: dbPath });
const profile = await database.from('profiles').select('id, username, email').eq('username', username.toLowerCase()).maybeSingle();
if (profile.error) throw new Error(profile.error.message);
if (!profile.data) throw new Error('User not found.');

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
await database._pglite.query(
  'update auth.users set encrypted_password=$1 where id=$2',
  [`scrypt:${salt}:${hash}`, profile.data.id]
);
await database._pglite.query(
  'update public.profiles set must_change_password=false where id=$1',
  [profile.data.id]
);
console.log(`Reset password for ${username.toLowerCase()}`);
