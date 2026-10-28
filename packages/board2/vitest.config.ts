// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The same budget as the kernel and geom: `pnpm test` runs every package's
    // suite at once.
    testTimeout: 20_000,
  },
});
