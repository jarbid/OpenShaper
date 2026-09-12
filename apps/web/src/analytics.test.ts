import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import {
  captureError,
  resolveApiHost,
  resolveDisplayMode,
  resolveInternalTraffic,
} from './analytics';

vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    register: vi.fn(),
    capture: vi.fn(),
    unregister: vi.fn(),
    set_config: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    startSessionRecording: vi.fn(),
    captureException: vi.fn(),
  },
}));

/**
 * The internal-traffic marker is the only thing that can separate my own
 * traffic from real visitors — the cookieless baseline exposes no stable
 * client-side id for a PostHog cohort to match on. If it silently stopped
 * sticking, every dashboard would quietly absorb my usage again, so pin the
 * behaviour.
 */
describe('resolveInternalTraffic', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('is off by default', () => {
    expect(resolveInternalTraffic()).toBe(false);
  });

  it('?internal=1 turns it on and persists it', () => {
    window.history.replaceState({}, '', '/app?internal=1');
    expect(resolveInternalTraffic()).toBe(true);
    expect(localStorage.getItem('bs.internal')).toBe('1');
  });

  it('stays on for later visits without the flag', () => {
    window.history.replaceState({}, '', '/app?internal=1');
    resolveInternalTraffic();
    window.history.replaceState({}, '', '/app');
    expect(resolveInternalTraffic()).toBe(true);
  });

  it('?internal=0 clears it', () => {
    localStorage.setItem('bs.internal', '1');
    window.history.replaceState({}, '', '/app?internal=0');
    expect(resolveInternalTraffic()).toBe(false);
    expect(localStorage.getItem('bs.internal')).toBeNull();
  });

  it('ignores other values of the flag', () => {
    window.history.replaceState({}, '', '/app?internal=yes');
    expect(resolveInternalTraffic()).toBe(false);
    expect(localStorage.getItem('bs.internal')).toBeNull();
  });

  it('leaves unrelated query params alone', () => {
    window.history.replaceState({}, '', '/app?utm_source=forum');
    expect(resolveInternalTraffic()).toBe(false);
  });
});

/**
 * `display_mode` is the only thing separating installed-PWA usage from an
 * ordinary browser tab — nothing else in the payload differs. If it silently
 * started reporting 'browser' for everyone, the offline/install work would look
 * unused rather than unmeasured, so pin both detection paths.
 */
describe('resolveDisplayMode', () => {
  const setMatchMedia = (matches: boolean) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is 'browser' in an ordinary tab", () => {
    setMatchMedia(false);
    expect(resolveDisplayMode()).toBe('browser');
  });

  it("is 'standalone' when launched from an installed icon", () => {
    setMatchMedia(true);
    expect(resolveDisplayMode()).toBe('standalone');
  });

  // iOS Safari never implemented the display-mode query for home-screen apps.
  it("is 'standalone' via navigator.standalone on iOS", () => {
    setMatchMedia(false);
    expect(resolveDisplayMode({ standalone: true })).toBe('standalone');
  });

  it('falls back to browser when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(resolveDisplayMode()).toBe('browser');
  });
});

/**
 * The consent gate under `cookieless_mode: 'on_reject'`.
 *
 * posthog-js treats an *undecided* visitor as opted out and captures nothing
 * at all until a choice is made (`isOptedOut()` is true while consent is
 * pending). Most visitors never touch the banner, so without the explicit
 * `opt_out_capturing()` on load the baseline silently collects nothing — the
 * failure is invisible from the code and only shows up as an empty dashboard
 * weeks later. That is exactly the class of bug this file exists to catch.
 */
describe('initAnalytics consent gating', () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const load = async () => {
    const posthog = (await import('posthog-js')).default;
    const { initAnalytics } = await import('./analytics');
    return { posthog, initAnalytics };
  };

  it('opts an undecided visitor out, so the cookieless baseline still captures', async () => {
    const { posthog, initAnalytics } = await load();
    initAnalytics();
    expect(posthog.opt_out_capturing).toHaveBeenCalled();
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
  });

  it('opts a rejected visitor out too — reject means baseline, not silence', async () => {
    localStorage.setItem('bs.consent', 'rejected');
    const { posthog, initAnalytics } = await load();
    initAnalytics();
    expect(posthog.opt_out_capturing).toHaveBeenCalled();
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
  });

  it('opts a returning accepted visitor in, with no baseline opt-out first', async () => {
    localStorage.setItem('bs.consent', 'accepted');
    const { posthog, initAnalytics } = await load();
    initAnalytics();
    expect(posthog.opt_in_capturing).toHaveBeenCalled();
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthog.startSessionRecording).toHaveBeenCalled();
  });

  // `'always'` makes posthog-js throw from SessionIdManager, which would take
  // session replay (Tier 2) down with it.
  it("initialises in cookieless 'on_reject' mode, never 'always'", async () => {
    const { posthog, initAnalytics } = await load();
    initAnalytics();
    const config = vi.mocked(posthog.init).mock.calls[0]?.[1] as
      | { cookieless_mode?: string; persistence?: string }
      | undefined;
    expect(config?.cookieless_mode).toBe('on_reject');
    // The bug this replaced: memory persistence left no id, so every page load
    // counted as a fresh person *and* a fresh session.
    expect(config?.persistence).toBeUndefined();
  });

  /**
   * DNT is not binding in the EU, some browsers send it by default, and
   * posthog-js's `respect_dnt` outranks an explicit opt-in — so a visitor who
   * deliberately clicked Accept was still dropped. Pinned because reinstating
   * it looks like a harmless privacy win and silently costs consenting traffic.
   */
  it('does not let browser Do-Not-Track override an explicit choice', async () => {
    const { posthog, initAnalytics } = await load();
    initAnalytics();
    const config = vi.mocked(posthog.init).mock.calls[0]?.[1] as
      | { respect_dnt?: boolean }
      | undefined;
    expect(config?.respect_dnt).toBeUndefined();
  });

  /**
   * Every internal link is a React Router `<Link>`, so with the plain `true`
   * that posthog-js still defaults to, the whole marketing → /app → /docs
   * journey collapses into one pageview for the landing URL. Nothing errors
   * and events keep flowing — the funnel just silently doesn't exist, which
   * is why this is pinned rather than left to the config comment.
   */
  it('captures pageviews on SPA route changes, not just the initial load', async () => {
    const { posthog, initAnalytics } = await load();
    initAnalytics();
    const config = vi.mocked(posthog.init).mock.calls[0]?.[1] as
      | { capture_pageview?: boolean | string }
      | undefined;
    expect(config?.capture_pageview).toBe('history_change');
  });
});

/**
 * `VITE_POSTHOG_HOST` is pinned to one absolute URL in a hosting dashboard, so
 * it goes cross-origin the moment a page is served from anywhere else — and a
 * cross-origin ingestion request is rejected outright, losing the visit with no
 * sign in the data. That is what the `Access-Control-Allow-Origin` exceptions in
 * error tracking were: real visitors on `http://openshaper.com`.
 */
describe('resolveApiHost', () => {
  it('re-points the proxy at the origin the page is actually on', () => {
    expect(resolveApiHost('https://openshaper.com/edge', 'http://openshaper.com')).toBe(
      'http://openshaper.com/edge',
    );
    expect(resolveApiHost('https://openshaper.com/edge', 'https://www.openshaper.com')).toBe(
      'https://www.openshaper.com/edge',
    );
  });

  it('accepts a bare path, which cannot go cross-origin in the first place', () => {
    expect(resolveApiHost('/edge', 'https://openshaper.com')).toBe('https://openshaper.com/edge');
  });

  it("leaves PostHog's own hosts alone — those are meant to be cross-origin", () => {
    expect(resolveApiHost('https://us.i.posthog.com', 'https://openshaper.com')).toBe(
      'https://us.i.posthog.com',
    );
  });

  it('falls back to the direct host when unset or unusable', () => {
    expect(resolveApiHost(undefined, 'https://openshaper.com')).toBe('https://us.i.posthog.com');
    expect(resolveApiHost('not a url', 'https://openshaper.com')).toBe('https://us.i.posthog.com');
  });
});

/**
 * `captureError` is called from the app's failure paths — the session-restore
 * catch, the specs worker's error branch, the route error screen. Those run in
 * every build, including the ones with no PostHog key at all (local clones,
 * forks, PR previews), where `initAnalytics` returns before enabling anything.
 *
 * So the property that matters is not what it sends but that it stays inert and
 * silent when analytics never started: a reporting call that throws inside a
 * `catch` block would turn a handled failure into the crash it was reporting.
 */
describe('captureError', () => {
  it('is a silent no-op when analytics never initialised', () => {
    expect(() => captureError('session_restore', new Error('boom'))).not.toThrow();
    expect(posthog.captureException).not.toHaveBeenCalled();
  });

  it('stays inert for a non-Error throw too', () => {
    expect(() => captureError('route_error', 'a bare string')).not.toThrow();
    expect(() => captureError('route_error', undefined)).not.toThrow();
    expect(posthog.captureException).not.toHaveBeenCalled();
  });
});
