import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The page may only call its own API, so the security policy follows the configured address.
function apiInSecurityPolicy(apiUrl) {
  const origin = new URL(apiUrl || 'http://localhost:4000').origin;
  return {
    name: 'rm-pos-api-in-security-policy',
    transformIndexHtml: (html) => html.replace('http://localhost:4000', origin)
  };
}

// base: './' so the built files load correctly inside Electron (file://)
export default defineConfig(({ mode }) => ({
  plugins: [react(), apiInSecurityPolicy(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL)],
  base: './',
  server: { port: 5173, strictPort: true }
}));
