import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@iln/sdk': resolve(__dirname, 'sdk/src/index.ts'),
      '@iln/oracle-service': resolve(__dirname, 'oracle-service/src/index.ts'),
      '@iln/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
