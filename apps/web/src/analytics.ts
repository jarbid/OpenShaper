/**
 * PostHog wrapper with two tiers, gated by visitor consent (see consent.ts
 * and docs/design/analytics.md):
 *
 * - Baseline (always on, no consent needed): anonymous only — no cookies, no
 *   localStorage, no persistent visitor id (`persistence: 'memory'`), no
 *   autocapture, no session recording. Web Vitals / rageclick / dead-click /
 *   exception detection are separate, lightweight, purpose-built signals
 *   that don't touch identity either.
 * - Full tracking (only after explicit accept, via `upgradeToFullTracking`):
 *   persistent cross-session id, full autocapture, session recording,
 *   heatmaps, and a `tracking_tier: 'full'` super property tagging every
 *   subsequent event from this browser.
 *
 * `respect_dnt: true` means browser Do-Not-Track overrides everything above —
 * even the anonymous baseline — since it's a stronger, standing signal than
 * whatever this site's own consent state says.
 *
 * Configured via `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (see `.env.example`); with
 * no key set (local clones, forks, PR previews) every call below is a no-op.
 */
import posthog from 'posthog-js';
import { getConsent } from './consent';

let enabled = false;

const INTERNAL_KEY = 'bs.internal';

/**
 * Marks this browser as my own traffic, so it can be filtered out of every
 * dashboard.
 *
 * Necessary because `persistence: 'memory'` leaves no stable person id, which
 * means PostHog's usual "internal users" cohort has nothing to match on and
 * can never contain anyone. Marking at the source is the only thing that
 * works. Visit `?internal=1` once per browser to set it, `?internal=0` to
 * clear it; the project's test-account filter then excludes
 * `internal_traffic`.
 *
 * The one key this writes is the deliberate exception to the no-persistent-
 * storage rule: a single boolean, in my own browser, holding no visitor data.
 */
export function resolveInternalTraffic(): boolean {
  let flag: string | null = null;
  try {
    flag = new URLSearchParams(window.location.search).get('internal');
  } catch {
    // Malformed query string — fall through to whatever is already stored.
  }
  try {
    if (flag === '1') localStorage.setItem(INTERNAL_KEY, '1');
    else if (flag === '0') localStorage.removeItem(INTERNAL_KEY);
    return localStorage.getItem(INTERNAL_KEY) === '1';
  } catch {
    // localStorage unavailable (private browsing, quota). Honour the URL flag
    // for this page load rather than silently mixing the traffic back in.
    return flag === '1';
  }
}

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
    respect_dnt: true,
    // UX signals, not identity: none of these set a persistent id or record
    // content, so the anonymous baseline above is unchanged.
    capture_performance: { web_vitals: true }, // Core Web Vitals (LCP/CLS/INP)
    rageclick: true, // rapid repeated clicks in one spot
    capture_dead_clicks: {
      // Dead-click detection has no interactive-element allowlist (unlike
      // autocapture) — the 2D/3D editor canvases are valid candidates by
      // default and dominate the signal with noise. Excluding them keeps the
      // defaults (`.ph-no-capture`/`.ph-no-deadclick`) and adds `canvas`,
      // since supplying this list replaces posthog-js's built-in default.
      //
      // Form controls are excluded for the same reason, on evidence: of the
      // dead clicks carrying an element chain in the first 30 days, `select`
      // (139) and `input`/`label` (~100) were the two largest buckets. Both
      // are false positives — opening a native select, focusing an input, or
      // clicking a label mutates no DOM, so the heuristic's "nothing happened"
      // timeout expires even though the click worked perfectly. Left in, they
      // bury the real misses.
      css_selector_ignorelist: [
        '.ph-no-capture',
        '.ph-no-deadclick',
        'canvas',
        'select',
        'input',
        'label',
      ],
    },
    capture_exceptions: {
      // Independent of autocapture/session recording, and carries no more
      // identity risk than the pageview capture already sends (same
      // unmasked $current_url) — a canvas/WebGL-heavy app is worth watching
      // for real crashes from every visitor, not just consenting ones.
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false, // arbitrary console.error content is harder to reason about than a genuine uncaught exception
    },
  });
  enabled = true;
  // Tag my own traffic so dashboards can exclude it. Registered rather than
  // opting out entirely, so it stays inspectable in isolation instead of
  // vanishing.
  if (resolveInternalTraffic()) posthog.register({ internal_traffic: true });
  // Returning visitor who already accepted full tracking: upgrade immediately,
  // no banner, no gap in coverage.
  if (getConsent() === 'accepted') upgradeToFullTracking();
}

/**
 * Upgrade the current (already anonymous) session to full tracking in place —
 * no reload, no new identity. `set_config` re-persists the existing
 * distinct_id/device_id into the new storage backend, so the same visitor
 * keeps the same id across the switch.
 */
export function upgradeToFullTracking(): void {
  if (!enabled) return;
  posthog.set_config({ persistence: 'localStorage+cookie' });
  posthog.set_config({ autocapture: true });
  posthog.set_config({ capture_heatmaps: true });
  posthog.startSessionRecording();
  // Tags every future event from this browser — lets dashboards segment
  // full-tracking vs. baseline-only traffic with no cohort computation.
  posthog.register({ tracking_tier: 'full' });
}

/**
 * Clear the tracking_tier tag before /privacy's "turn off" reloads the page —
 * the reload itself resets persistence/autocapture/session recording/heatmaps
 * back to the Tier 1 baseline (a fresh posthog.init call), so this just
 * avoids leaving a stale `tracking_tier: 'full'` sitting in storage.
 */
export function downgradeFromFullTracking(): void {
  if (!enabled) return;
  posthog.unregister('tracking_tier');
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!enabled) return;
  posthog.capture(event, props);
}
