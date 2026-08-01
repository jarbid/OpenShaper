import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDisplayMode, resolveInternalTraffic } from './analytics';

/**
 * The internal-traffic marker is the only thing that can separate my own
 * traffic from real visitors — `persistence: 'memory'` leaves no stable person
 * id for a PostHog cohort to match on. If it silently stopped sticking, every
 * dashboard would quietly absorb my usage again, so pin the behaviour.
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
