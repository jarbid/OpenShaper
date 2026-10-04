import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The surface-fit tests are seconds of real geometry each, and `pnpm test`
    // runs every package's suite at once: under that load they pass 5 s (6 s on
    // a 4-core runner). Vitest 2 let a synchronous test overrun its timeout;
    // Vitest 5 fails it, so the budget is stated here instead.
    testTimeout: 20_000,
  },
});
