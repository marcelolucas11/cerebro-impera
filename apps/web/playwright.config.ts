import { defineConfig } from '@playwright/test';

const PORT = 3917;

/*
 * Browser tests against a real installation. Needs TEST_PG_ADMIN_URL (a
 * disposable PostgreSQL 16+) and a built API and page: run `pnpm e2e` from
 * the repository root.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // One installation, used in order: the steps build on each other.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Authenticator codes are accepted once per 30 seconds, so a few steps wait for the next one.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'pt-BR',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    launchOptions: { args: process.env.PLAYWRIGHT_NO_SANDBOX ? ['--no-sandbox'] : [] },
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { CEREBRO_E2E_PORT: String(PORT) },
  },
});
