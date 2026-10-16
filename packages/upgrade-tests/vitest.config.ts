import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@iln/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@iln/sdk': resolve(__dirname, '../../sdk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
