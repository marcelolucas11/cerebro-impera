import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, defineConfig, type Plugin } from 'vite';

/*
 * The service worker is built on its own, after the page, into /sw.js: a fixed
 * address (browsers check it for updates) with the list of the page's files
 * written in, so it can keep exactly those and drop the ones of older versions.
 */
function serviceWorker(): Plugin {
  let files: string[] = [];
  return {
    name: 'cerebro-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      files = Object.keys(bundle)
        .filter((name) => name.startsWith('assets/'))
        .map((name) => `/${name}`)
        .sort();
    },
    async closeBundle() {
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
      await build({
        configFile: false,
        logLevel: 'warn',
        define: {
          __SHELL_FILES__: JSON.stringify(files),
          __SHELL_VERSION__: JSON.stringify(version),
        },
        build: {
          outDir: fileURLToPath(new URL('dist', import.meta.url)),
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: {
            entry: fileURLToPath(new URL('src/worker/sw.ts', import.meta.url)),
            formats: ['iife'],
            name: 'cerebroWorker',
            fileName: () => 'sw.js',
          },
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
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
