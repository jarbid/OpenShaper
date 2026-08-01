import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Offline / service-worker E2E config.
 *
 * Separate from playwright.config.ts because the service worker only exists in a
 * production build — `vite-react-ssg dev` never generates one (and
 * `devOptions.enabled` is deliberately false so the fast dev loop and the main
 * e2e suite stay worker-free). So this config builds and serves `dist`.
 *
 * It serves via tools/serve-dist.mjs rather than `vite preview`, which does not
 * reproduce Cloudflare's `drop-trailing-slash` (it returns the landing page for
 * `/app`) and answers unknown paths with 200 instead of 404.
 *
 * Run with: pnpm --filter @openshaper/web e2e:offline
 */
export default defineConfig({
  testDir: './e2e-offline',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium-offline', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm --filter @openshaper/web build && node tools/serve-dist.mjs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // A cold build includes the three.js chunk.
    timeout: 300_000,
  },
});
