// Stops an installer being built that points at this PC instead of the hosted server.
import { loadEnv } from 'vite';

const address = process.env.VITE_API_URL || (loadEnv('production', process.cwd(), 'VITE_').VITE_API_URL ?? '');
if (process.env.RM_POS_BUILD_MODE === 'offline') {
  if (!/^http:\/\/(localhost|127\.0\.0\.1):4000\/?$/.test(address)) {
    console.error(`Offline installer VITE_API_URL must be http://localhost:4000, but got "${address}".`);
    process.exit(1);
  }
  console.log('The offline installer will use the bundled local server');
  process.exit(0);
}
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
