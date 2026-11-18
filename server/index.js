import { createApp } from './app.js';
import { loadEnvFile, readConfig } from './config.js';
import { createClients } from './db.js';
import { startBackupSchedule } from './services/backups.js';

loadEnvFile();

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const clients = createClients(config);
const app = createApp({ config, ...clients });
const server = app.listen(config.port, () => console.log(`RM POS API running on http://localhost:${config.port} (Supabase storage)`));

// Daily automated backup; BACKUPS=off turns it off (for example on a developer's PC).
const schedule = process.env.BACKUPS === 'off' ? null : startBackupSchedule(clients);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { schedule?.stop(); server.close(() => process.exit(0)); });
}
