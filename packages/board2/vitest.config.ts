// SPDX-License-Identifier: GPL-3.0-or-later
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The OCCT validator loads a 21 MB WASM kernel: `pnpm test:occt` (vitest.occt.config.ts), not `pnpm test`.
    exclude: [...configDefaults.exclude, 'src/**/*.occt.test.ts'],
    environment: 'node',
    // `pnpm test` runs every package's suite at once, and these tests build and mesh boards, fit
    // surfaces and sweep every control of a kernel board: seconds each here, and on a 2-core CI runner
    // under that load 3 to 10 times that (one swept 30 meshes in 11 s on a green run and 28 s on the
    // next). Vitest fails a synchronous test that overruns its timeout, so the budget is stated here:
    // a hang is the CI job's timeout to catch, not this one's.
    testTimeout: 60_000,
  },
});
