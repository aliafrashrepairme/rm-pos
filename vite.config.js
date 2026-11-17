import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The page may only call its own API, so the security policy follows the configured address.
// The dev server's live-reload connection stays out of a finished build.
function apiInSecurityPolicy(apiUrl, command) {
  const origin = new URL(apiUrl || 'http://localhost:4000').origin;
  return {
    name: 'rm-pos-api-in-security-policy',
    transformIndexHtml(html) {
      const updated = html.replace('http://localhost:4000', origin);
      return command === 'build' ? updated.replace(' ws://localhost:5173', '') : updated;
    }
  };
}

// base: './' so the built files load correctly inside Electron
export default defineConfig(({ mode, command }) => ({
  plugins: [react(), apiInSecurityPolicy(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL, command)],
  base: './',
  server: { port: 5173, strictPort: true }
}));
