import { assertAppClosed, createLocalClients, desktopDatabasePath } from '../local-db.js';

const [username, password, name, role = 'Owner', email = `${username}@staff.rm-pos.local`] = process.argv.slice(2);
if (!username || !password || !name) {
  console.error('Usage: npm --prefix server run local:user:create -- USERNAME PASSWORD "Full Name" [Owner|Manager|Cashier|Inventory Staff]');
  process.exit(1);
}
if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Username is invalid.');
if (password.length < 8) throw new Error('Password must be at least 8 characters.');
const allowed = ['Owner', 'Manager', 'Cashier', 'Inventory Staff'];
if (!allowed.includes(role)) throw new Error('Invalid role.');

await assertAppClosed();
const dbPath = process.env.RM_POS_DB_PATH || desktopDatabasePath();
console.log(`Database: ${dbPath}`);
const { authClient, database } = await createLocalClients({ localDbPath: dbPath });
const created = await authClient.admin.createUser({
  email,
  password,
  email_confirm: true
});
if (created.error) throw new Error(created.error.message);

const saved = await database.from('profiles').insert({
  id: created.data.user.id,
  username,
  full_name: name,
  email,
  role_code: role,
  active: true,
  must_change_password: false
}).select('*').single();
if (saved.error) {
  await authClient.admin.deleteUser(created.data.user.id);
  throw new Error(saved.error.message);
}
console.log(`Created local ${role} account: ${username}`);
