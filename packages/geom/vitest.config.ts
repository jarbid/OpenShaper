import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Same budget as the kernel: `pnpm test` runs every package's suite at once,
    // and the fitting, solver and quadrature suites to come are seconds of real
    // geometry each under that load. Vitest 5 fails a synchronous test that
    // overruns its timeout, so the budget is stated here. The OCCT validator
    // suite gets its own config and budget (docs/design/geom-core.md §15).
    testTimeout: 20_000,
  },
});
