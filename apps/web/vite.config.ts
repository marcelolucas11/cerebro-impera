import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // No inline scripts or styles: the page is served with a Content-Security-Policy
    // that only allows files from its own origin.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    // In development the API runs separately; in production it serves this bundle itself.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
