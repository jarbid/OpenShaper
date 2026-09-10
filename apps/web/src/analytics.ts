/**
 * PostHog wrapper with two tiers, gated by visitor consent (see consent.ts
 * and docs/design/analytics.md):
 *
 * - Baseline (always on, no consent needed): anonymous only — no cookies, no
 *   localStorage, no persistent visitor id stored in the browser, no
 *   autocapture, no session recording. Web Vitals / rageclick / dead-click /
 *   exception detection are separate, lightweight, purpose-built signals
 *   that don't touch identity either.
 * - Full tracking (only after explicit accept, via `upgradeToFullTracking`):
 *   persistent cross-session id, full autocapture, session recording,
 *   heatmaps, and a `tracking_tier: 'full'` super property tagging every
 *   subsequent event from this browser.
 *
 * Browser Do-Not-Track is deliberately *not* honoured as an override. It is not
 * legally binding in the EU, several browsers send it by default, and it used to
 * discard visitors who had gone out of their way to click Accept — a specific,
 * deliberate choice about this site losing to a browser-wide default. The
 * consent state above is the only signal that decides which tier applies.
 *
 * Country is resolved by our own Worker rather than by PostHog: cookieless mode
 * strips the client IP before GeoIP runs, so the baseline would otherwise carry
 * no location at all. See `resolveCountry`.
 *
 * Configured via `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (see `.env.example`); with
 * no key set (local clones, forks, PR previews) every call below is a no-op.
 */
import posthog from 'posthog-js';
import type { PostHogConfig } from 'posthog-js';
import { getConsent } from './consent';

/**
 * `cookieless_mode` ships in posthog-js's runtime but is missing from the
 * public `PostHogConfig` type as of 1.404.1 (the type only references it from a
 * doc comment on `opt_out_capturing_by_default`), so it has to be attached
 * outside the checked object literal. Drop this once the type catches up.
 *
 * `'on_reject'` — not `'always'`: under `'always'` posthog-js throws
 * `SessionIdManager cannot be used with cookieless_mode="always"` and refuses
 * to start session recording at all, which would make Tier 2 unimplementable.
 * `'on_reject'` keeps the hash for baseline traffic and hands consenting
 * visitors the full stack.
 */
type CookielessConfig = Partial<PostHogConfig> & { cookieless_mode: 'always' | 'on_reject' };

let enabled = false;

const INTERNAL_KEY = 'bs.internal';

/**
 * Marks this browser as my own traffic, so it can be filtered out of every
 * dashboard.
 *
 * Necessary because the cookieless baseline's person id is a server-side hash
 * that resets with the daily salt, so PostHog's usual "internal users" cohort
 * would empty out every night. Marking at the source is the only thing that
 * survives. Visit `?internal=1` once per browser to set it, `?internal=0` to
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

/** How the app is being presented: its own installed window, or a browser tab. */
export type DisplayMode = 'standalone' | 'browser';

/**
 * Whether this page is running as an installed PWA.
 *
 * Registered as a super property (not an event) so every existing event can be
 * segmented by it — without that, an installed app and a browser tab are
 * indistinguishable, and there is no way to tell whether the offline/install
 * work is used at all. It describes the window, not the visitor: no identity,
 * nothing persistent, so it sits inside the anonymous baseline.
 */
export function resolveDisplayMode(nav?: { standalone?: boolean }): DisplayMode {
  // `standalone` is an iOS Safari extension, absent from the standard Navigator
  // type — hence the cast rather than a typed default parameter.
  const n = nav ?? (globalThis.navigator as unknown as { standalone?: boolean } | undefined);
  // iOS Safari never implemented the display-mode media query for home-screen
  // apps and exposes this flag instead.
  if (n?.standalone === true) return 'standalone';
  try {
    // `minimal-ui` / `fullscreen` are launch modes we don't request, so
    // `standalone` is the only installed presentation to look for.
    if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
  } catch {
    // matchMedia missing or unsupported query — fall through to 'browser'.
  }
  return 'browser';
}

/** PostHog US cloud ingestion, used whenever the same-origin proxy isn't configured. */
const DIRECT_API_HOST = 'https://us.i.posthog.com';

/**
 * Where posthog-js sends events, given the configured value and the origin the
 * page is actually on.
 *
 * `VITE_POSTHOG_HOST` is set in a hosting dashboard, so it is naturally written
 * as one absolute URL — `https://openshaper.com/edge`. That silently stops being
 * same-origin the moment the page is served from anywhere else: `http://`, a
 * `www.` host, a preview deploy. posthog-js then makes a cross-origin request
 * the browser rejects on CORS grounds, and the visit is simply never recorded —
 * the failure shows up as a `Access-Control-Allow-Origin` exception, not as
 * missing data, so it is easy to miss.
 *
 * The proxy is same-origin by definition, so re-point any non-PostHog host at
 * this page's own origin. Only PostHog's own hosts are meant to be cross-origin.
 */
export function resolveApiHost(configured: string | undefined, origin: string): string {
  if (!configured) return DIRECT_API_HOST;
  if (configured.startsWith('/')) return `${origin}${configured.replace(/\/$/, '')}`;
  try {
    const url = new URL(configured);
    if (url.hostname.endsWith('posthog.com')) return configured;
    return `${origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    // Not a URL and not a path — unusable, so fall back rather than ship a
    // config that drops every event.
    return DIRECT_API_HOST;
  }
}

/**
 * Upper bound on how long analytics start-up waits for the country lookup.
 * The request is same-origin and answered at the CDN edge (tens of ms in
 * practice); this only caps the pathological case.
 */
const GEO_TIMEOUT_MS = 800;

/**
 * The visitor's country, resolved by our own Worker rather than by PostHog.
 *
 * PostHog cannot supply it on the cookieless baseline. Its own docs are explicit:
 * with cookieless server hash mode on, "the IP address is stripped before these
 * transformations run", so GeoIP never sees one and location data is not added —
 * the world map goes blank for that traffic. Since every request already passes
 * through the Worker in front of this site, the country Cloudflare resolved is
 * free to hand back, and it arrives as an ordinary event property that no
 * transformation can strip.
 *
 * Nothing about this is less anonymous than the baseline already is: no IP
 * reaches the browser, none is stored, and a country is not a person.
 */
async function resolveCountry(apiHost: string, origin: string): Promise<string | null> {
  // Only our own proxy serves this. Pointed straight at PostHog — local dev,
  // forks, any deploy without the Worker — there is nothing to ask, and asking
  // anyway would just add a cross-origin request that always fails.
  if (!apiHost.startsWith(`${origin}/`)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiHost}/geo`, {
      signal: controller.signal,
      // The endpoint is same-origin and carries no credentials of its own.
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const country = (body as { country?: unknown } | null)?.country;
    return typeof country === 'string' && country.length > 0 ? country : null;
  } catch {
    // Aborted, offline, blocked, or not deployed (local dev, forks). Analytics
    // start-up must not depend on it.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Awaits the country lookup before starting posthog-js, so the property is
 * registered ahead of the first pageview rather than landing one event late.
 * Callers fire and forget; nothing downstream depends on the returned promise
 * except the tests.
 */
export async function initAnalytics(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (import.meta.env.VITEST) return; // never fire real events from the Vitest suite
  // Suppress automated browsers: Playwright e2e runs `pnpm dev`, so the VITEST
  // guard above doesn't cover it. Real users don't set navigator.webdriver.
  if (navigator.webdriver) return;
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return;
  // Production points this at the same-origin proxy (`/edge`, see
  // worker/index.ts) so ad-blockers don't drop events before they leave the
  // browser. The fallback is the direct host, which is what local dev and any
  // fork without the Worker get.
  const origin = window.location.origin;
  const apiHost = resolveApiHost(import.meta.env.VITE_POSTHOG_HOST, origin);
  const country = await resolveCountry(apiHost, origin);
  posthog.init(key, {
    api_host: apiHost,
    // Where PostHog itself lives, as opposed to where events are sent. Without
    // this, a proxied api_host makes posthog-js build toolbar/settings links
    // against our own domain, which serves no such pages.
    ui_host: 'https://us.posthog.com',
    autocapture: false,
    // `true` captures a pageview on the initial page load only. Every internal
    // link here is a React Router `<Link>` (client-side, no reload), so under
    // `true` the entire marketing → /app → /docs journey collapsed into a
    // single pageview for the landing URL: the core conversion funnel was
    // unmeasurable and /docs looked unread (3 pageviews in 30 days) because it
    // is reached by navigation. posthog-js only resolves this to
    // 'history_change' on its own from `defaults: '2025-05-24'` onward; set
    // explicitly rather than adopting a whole defaults bundle, since every
    // other option in this block is explicit and commented.
    //
    // Safe against phantom events: HistoryAutocapture compares pathname only,
    // so `?internal=1` and hash changes don't fire, and the app itself never
    // calls pushState/replaceState. /app is one route, so editing adds none.
    capture_pageview: 'history_change',
    disable_session_recording: true,
    // Surveys are deliberately *not* disabled here, and need no consent check
    // of our own: posthog-js refuses to load them whenever `cookieless_mode` is
    // set and the visitor is opted out ("Not loading surveys in cookieless mode
    // without consent"), which is every Tier 1 visitor. So they reach only
    // people who accepted — the same gate as session recording, enforced by the
    // SDK rather than by us. Requires `surveys_opt_in` on the project; with it
    // off the survey script never loads for anyone.
    //
    // Worth the reach they lose: there are no accounts and no in-app feedback
    // endpoint, so a survey is the only built-in way to ask a visitor anything
    // at all.
    // Baseline identity comes from PostHog's server-side privacy-preserving
    // hash, not from anything stored in the browser. This replaces
    // `persistence: 'memory'`, which left no id at all — every page load
    // became a fresh person AND a fresh session, so "unique visitors" and
    // "sessions" were both just page-load counts. Requires
    // `cookieless_server_hash_mode` to be on for the project; with it off the
    // events arrive with no usable identity.
    cookieless_mode: 'on_reject',
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
  } satisfies CookielessConfig as Partial<PostHogConfig>);
  enabled = true;
  // Under `cookieless_mode: 'on_reject'` posthog-js treats an *undecided*
  // visitor as opted out and captures nothing at all until a choice is made —
  // `isOptedOut()` is true while consent is pending. That would silently drop
  // every visitor who ignores the banner, which is most of them. Declaring the
  // rejection up front puts undecided visitors on the cookieless baseline
  // immediately, matching the pre-existing behaviour: everyone is measured
  // anonymously, and Accept is the only thing that changes anything.
  // (The accepted case is handled by the upgrade call at the end of this
  // function, which opts in.)
  if (getConsent() !== 'accepted') posthog.opt_out_capturing();
  // Tag my own traffic so dashboards can exclude it. Registered rather than
  // opting out entirely, so it stays inspectable in isolation instead of
  // vanishing.
  if (resolveInternalTraffic()) posthog.register({ internal_traffic: true });
  // Segments every event by installed-app vs browser tab.
  posthog.register({ display_mode: resolveDisplayMode() });
  // Registered before the first pageview is captured, so the landing page —
  // the one that actually needs a country — carries it too. Absent rather than
  // empty when the lookup fails, so "no answer" is distinguishable from a
  // country in any breakdown.
  if (country) posthog.register({ geo_country: country });
  // The moment of conversion. Fires while online, so unlike anything captured
  // offline it actually sends. `display_mode` still reads 'browser' on this
  // event — the current window keeps running as a tab; subsequent launches
  // from the installed icon report 'standalone'.
  window.addEventListener('appinstalled', () => track('pwa_installed'), { once: true });
  // Returning visitor who already accepted full tracking: upgrade immediately,
  // no banner, no gap in coverage.
  if (getConsent() === 'accepted') upgradeToFullTracking();
}

/**
 * Upgrade the current (already anonymous) session to full tracking in place —
 * no reload.
 *
 * `opt_in_capturing()` is what leaves cookieless mode: under
 * `cookieless_mode: 'on_reject'` posthog-js picks the storage backend from the
 * consent state itself, so opting in switches persistence to
 * localStorage+cookie without a `set_config({ persistence })` call. Unlike the
 * old memory-persistence path this does start a new id — the server-side hash
 * is deliberately not reversible into a client-side distinct_id, so a
 * visitor's pre-consent and post-consent activity no longer share one id.
 */
export function upgradeToFullTracking(): void {
  if (!enabled) return;
  posthog.opt_in_capturing();
  posthog.set_config({ autocapture: true });
  posthog.set_config({ capture_heatmaps: true });
  posthog.startSessionRecording();
  // Tags every future event from this browser — lets dashboards segment
  // full-tracking vs. baseline-only traffic with no cohort computation.
  posthog.register({ tracking_tier: 'full' });
}

/**
 * Return to the cookieless baseline before /privacy's "turn off" reloads the
 * page. `opt_out_capturing()` is the half that matters: it flips posthog-js
 * back into cookieless mode and clears the stored id, so the reload doesn't
 * come back up still holding a cookie. Unregistering the tag first avoids
 * leaving a stale `tracking_tier: 'full'` behind; the reload resets
 * autocapture/session recording/heatmaps via a fresh posthog.init call.
 */
export function downgradeFromFullTracking(): void {
  if (!enabled) return;
  posthog.unregister('tracking_tier');
  posthog.opt_out_capturing();
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!enabled) return;
  posthog.capture(event, props);
}
