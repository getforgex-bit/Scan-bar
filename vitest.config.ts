import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globalSetup: ['tests/global-setup.ts'], testTimeout: 60_000, hookTimeout: 120_000, include: ['**/*.test.ts'], exclude: ['node_modules/**', '.pgdata/**'], fileParallelism: false },
});
