import { createApp } from './app.js';
import { loadEnvFile, readConfig } from './config.js';
import { createClients } from './db.js';

loadEnvFile();

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const app = createApp({ config, ...createClients(config) });
const server = app.listen(config.port, () => console.log(`RM POS API running on http://localhost:${config.port} (Supabase storage)`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
