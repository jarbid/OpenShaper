import { defineConfig } from 'vitest/config';

// The CI-only OCCT validator of the board's STEP export (docs/design/m3-exports.md, step 2): the
// files through `occt-wasm`, via the protocol module of @openshaper/geom (`pnpm test:occt` at the root).
export default defineConfig({
  test: {
    include: ['src/**/*.occt.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
