/**
 * Vitest configuration for E2E tests.
 *
 * Runs tests from tests/e2e/ in Node environment with a generous timeout
 * since they depend on a live (or local docker) Stellar node.
 *
 * Run:  npm run test:e2e
 * Env:  Set E2E_RPC_URL / E2E_FRIENDBOT_URL to point at a non-default node.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    // E2E tests talk to a real (local) Stellar node — allow up to 60 s per test.
    testTimeout: 60_000,
    // Do not parallelise across workers; each test uses Friendbot which has
    // rate-limit behaviour on the quickstart container.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Print each test name so CI logs are easy to scan.
    reporter: ['verbose'],
  },
});
