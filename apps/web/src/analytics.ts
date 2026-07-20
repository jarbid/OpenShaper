/**
 * Minimal, privacy-respecting PostHog wrapper. Anonymous only: no cookies, no
 * localStorage, no persistent visitor id (`persistence: 'memory'`), autocapture and
 * session recording disabled — so there's nothing that requires visitor consent.
 * Configured via `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (see `.env.example`); with
 * no key set (local clones, forks, PR previews) every call below is a no-op.
 */
import posthog from 'posthog-js';

let enabled = false;

export function initAnalytics(): void {
  if (typeof window === 'undefined') return;
  if (import.meta.env.VITEST) return; // never fire real events from the Vitest suite
  // Suppress automated browsers: Playwright e2e runs `pnpm dev`, so the VITEST
  // guard above doesn't cover it. Real users don't set navigator.webdriver.
  if (navigator.webdriver) return;
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return;
  posthog.init(key, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    autocapture: false,
    capture_pageview: true,
    disable_session_recording: true,
    disable_surveys: true,
    persistence: 'memory',
  });
  enabled = true;
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!enabled) return;
  posthog.capture(event, props);
}
