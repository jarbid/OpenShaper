import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest runs only unit/component tests. The Playwright end-to-end specs live in
 * `e2e/` (and the offline suite in `e2e-offline/`) and are driven by
 * `playwright test` — exclude them here so Vitest does not try to import
 * `@playwright/test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Synthesised by vite-plugin-pwa at build time, so it does not resolve
      // under Vitest. Tests drive the stub directly.
      'virtual:pwa-register/react': fileURLToPath(
        new URL('./src/test/pwa-register-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**', 'e2e-offline/**'],
  },
});
