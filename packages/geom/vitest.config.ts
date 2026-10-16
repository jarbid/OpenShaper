import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The OCCT validator suite loads a 21 MB WASM kernel: it has its own config
    // and budget (`vitest.occt.config.ts`, `pnpm test:occt`; docs/design/geom-core.md
    // §15) and is a required CI step, but not part of `pnpm test`.
    exclude: [...configDefaults.exclude, 'src/**/*.occt.test.ts'],
    environment: 'node',
    // Same budget as the kernel: `pnpm test` runs every package's suite at once,
    // and the fitting, solver and quadrature suites to come are seconds of real
    // geometry each under that load. Vitest 5 fails a synchronous test that
    // overruns its timeout, so the budget is stated here.
    testTimeout: 20_000,
  },
});
