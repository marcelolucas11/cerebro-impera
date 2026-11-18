import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Tests run against the shared package's sources, no build step needed.
      {
        find: /^@cerebro\/shared\/protocol$/,
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/protocol.ts', import.meta.url),
        ),
      },
      {
        find: /^@cerebro\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
