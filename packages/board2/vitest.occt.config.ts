// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

// The CI-only OCCT validator on whole boards (docs/design/board2.md §7, step S4):
// geom's protocol (`@openshaper/geom/testing/occt`, geom-core.md §15.3) through
// `occt-wasm`, one WASM instance per file, files run one at a time.
export default defineConfig({
  test: {
    include: ['src/**/*.occt.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    // geom's budget: a board's band meshes at 0.03 mm in a few seconds, and
    // massProperties of a board takes about 2 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
