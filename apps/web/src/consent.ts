/**
 * Analytics consent: a single tri-state choice (accepted / rejected /
 * undecided), readable via useSyncExternalStore so the global banner and the
 * /privacy page's controls stay in sync even though they're mounted
 * independently.
 *
 * Rejected is a real, terminal choice — not an opt-out. It means "stay on
 * the anonymous baseline forever," matching the behavior before any decision
 * is made. See docs/design/analytics.md.
 *
 * Written to a cookie *and* localStorage, and read back from either. The two
 * fail in different ways: localStorage is per-origin (a visitor bounced from
 * `http://` to `https://` used to arrive in an empty bucket and get asked
 * again — worker/index.ts now stops that at the door), while Safari's tracking
 * prevention evicts script-written storage after about a week of not visiting.
 * A cookie recording nothing but the visitor's own answer is the textbook
 * "strictly necessary" case under ePrivacy, so it needs no consent of its own.
 */

export type Consent = 'accepted' | 'rejected' | null;

const STORAGE_KEY = 'bs.consent';
/** A year: long enough not to nag, short enough to count as a fresh ask later. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const listeners = new Set<() => void>();

const parse = (raw: string | null | undefined): Consent =>
  raw === 'accepted' || raw === 'rejected' ? raw : null;

function readCookie(): Consent {
  try {
    const match = document.cookie.match(/(?:^|;\s*)bs\.consent=([^;]*)/);
    return parse(match ? decodeURIComponent(match[1]!) : null);
  } catch {
    return null;
  }
}

function writeCookie(next: Consent): void {
  try {
    // `Secure` only where it is meaningful — omitting it on http://localhost
    // keeps dev working, and production is https-only anyway.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const base = `${STORAGE_KEY}=`;
    document.cookie =
      next === null
        ? `${base}; path=/; max-age=0; SameSite=Lax${secure}`
        : `${base}${next}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  } catch {
    // Cookies disabled — localStorage below is the remaining chance.
  }
}

export function getConsent(): Consent {
  try {
    const stored = parse(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // localStorage unavailable (private browsing, quota) — try the cookie.
  }
  return readCookie();
}

export function subscribeConsent(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setConsent(next: Consent): void {
  try {
    if (next === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage unavailable (private browsing, quota) — the cookie below
    // and the in-memory listeners still carry the choice.
  }
  writeCookie(next);
  for (const cb of listeners) cb();
}
