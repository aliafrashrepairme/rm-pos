// Creates a staff account from the terminal. This is the only way to create an Owner.
// Usage: npm --prefix server run user:create
import { createInterface } from 'node:readline';
import { loadEnvFile, readConfig } from '../config.js';
import { createClients } from '../db.js';
import { writeAudit } from '../services/audit.js';
import { NO_EMAIL_DOMAIN } from '../services/auth.js';
import { newPassword } from '../validation/common.js';

const ROLES = ['Owner', 'Manager', 'Cashier', 'Inventory Staff'];

if (!process.stdin.isTTY) {
  console.error('Run this command in a terminal, so the password stays hidden.');
  process.exit(1);
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
let hideInput = false;
const write = terminal._writeToOutput.bind(terminal);
terminal._writeToOutput = (text) => {
  if (!hideInput || text.includes('Password') || text.includes('again')) write(text);
};
const ask = (question) => new Promise((resolve) => terminal.question(question, (answer) => resolve(answer.trim())));

async function askPassword() {
  hideInput = true;
  const first = await new Promise((resolve) => terminal.question('Password (hidden, at least 8 characters): ', resolve));
  write('\n');
  const second = await new Promise((resolve) => terminal.question('Type the password again: ', resolve));
  write('\n');
  hideInput = false;
  if (first !== second) throw new Error('The passwords do not match.');
  return newPassword(first);
}

async function main() {
  const fullName = await ask('Full name: ');
  if (!fullName) throw new Error('Full name is required.');
  const username = (await ask('Username (letters, numbers, . _ -): ')).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Username must be 3 to 40 letters, numbers, dots, dashes or underscores.');
  const typedEmail = (await ask('Email (leave blank if they have none): ')).toLowerCase();
  const email = typedEmail || `${username}@${NO_EMAIL_DOMAIN}`;
  const role = ROLES[Number(await ask(`Role (${ROLES.map((name, index) => `${index + 1} ${name}`).join(', ')}): `)) - 1];
  if (!role) throw new Error('Choose a role by its number.');
  const password = await askPassword();

  loadEnvFile();
  const { database } = createClients(readConfig());
  const created = await database.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`Could not create the login: ${created.error.message}`);

  const { error } = await database.from('profiles').insert({
    id: created.data.user.id,
    username,
    full_name: fullName,
    email,
    role_code: role
  });
  if (error) {
    await database.auth.admin.deleteUser(created.data.user.id);
    throw new Error(`Could not save the account: ${error.message}`);
  }
  await writeAudit(database, {
    userName: 'System setup',
    action: 'User created',
    description: `${username} created as ${role} from the terminal`,
    entityType: 'user',
    entityId: created.data.user.id
  });
  console.log(`\nCreated ${fullName} as ${role}. Sign in with username "${username}".`);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => terminal.close());
