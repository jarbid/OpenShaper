import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // STEP and STL accuracy tests export full-resolution boards: seconds each,
    // past 5 s when `pnpm test` runs every package at once. See the kernel config.
    testTimeout: 20_000,
  },
});
