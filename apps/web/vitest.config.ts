import { defineConfig } from 'vitest/config';

/**
 * Vitest runs only unit/component tests. The Playwright end-to-end specs live in
 * `e2e/` and are driven by `playwright test` (see playwright.config.ts) — exclude
 * them here so Vitest does not try to import `@playwright/test`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
