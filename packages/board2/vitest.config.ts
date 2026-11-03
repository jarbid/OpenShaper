// SPDX-License-Identifier: GPL-3.0-or-later
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The OCCT validator loads a 21 MB WASM kernel: `pnpm test:occt` (vitest.occt.config.ts), not `pnpm test`.
    exclude: [...configDefaults.exclude, 'src/**/*.occt.test.ts'],
    environment: 'node',
    // The same budget as the kernel and geom: `pnpm test` runs every package's
    // suite at once.
    testTimeout: 20_000,
  },
});
