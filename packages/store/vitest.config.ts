import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The fin slice tests build real geometry (sweep grids, a slice's section from the
    // fin): about a second each here, past 5 s on a shared CI runner while every
    // package's suite runs at once. As in the kernel's config.
    testTimeout: 20_000,
  },
});
