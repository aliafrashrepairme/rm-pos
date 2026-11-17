// Stops an installer being built that points at this PC instead of the hosted server.
import { loadEnv } from 'vite';

const address = loadEnv('production', process.cwd(), 'VITE_').VITE_API_URL ?? '';
let url = null;
try {
  url = new URL(address);
} catch {
  // Reported below.
}

if (url?.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)) {
  console.error(`The installer needs the hosted server's https address, but VITE_API_URL is "${address}".`);
  console.error('Put VITE_API_URL=https://your-server in .env.production. See docs/deployment.md.');
  process.exit(1);
}
console.log(`The installer will connect to ${url.origin}`);
