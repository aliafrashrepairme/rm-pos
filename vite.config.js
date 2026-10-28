import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the built files load correctly inside Electron (file://)
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: true }
});
