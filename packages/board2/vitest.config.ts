// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The same budget as the kernel and geom: `pnpm test` runs every package's
    // suite at once, and the converter and deviation suites to come fit whole
    // boards under that load (docs/design/board2.md §13.4).
    testTimeout: 20_000,
  },
});
