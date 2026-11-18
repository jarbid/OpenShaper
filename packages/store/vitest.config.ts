// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The same budget as the kernel, geom and board2: `pnpm test` runs every package's suite at once, and
    // the rail zone tests build and mesh boards. Vitest fails a synchronous test that overruns its timeout,
    // and one of them took 6 s on a 4-core runner against the 5 s default.
    testTimeout: 20_000,
  },
});
