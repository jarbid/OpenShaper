import { defineConfig } from 'vitest/config';

// The CI-only OCCT validator (docs/design/geom-core.md §15): our STEP output
// through `occt-wasm`, one 21 MB WASM instance per file, files run one at a time.
export default defineConfig({
  test: {
    include: ['src/**/*.occt.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    // Kernel start-up is about 0.15 s and a corpus solid imports in 0.01 to 0.2 s;
    // the budget covers a cold CI runner and the mesh-volume oracle.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
