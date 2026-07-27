/**
 * Analytics consent: a single tri-state choice (accepted / rejected /
 * undecided), persisted to localStorage and readable via useSyncExternalStore
 * so the global banner and the /privacy page's controls stay in sync even
 * though they're mounted independently.
 *
 * Rejected is a real, terminal choice — not an opt-out. It means "stay on
 * the anonymous baseline forever," matching the behavior before any decision
 * is made. See docs/design/analytics.md.
 */

export type Consent = 'accepted' | 'rejected' | null;

const STORAGE_KEY = 'bs.consent';

const listeners = new Set<() => void>();

export function getConsent(): Consent {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'accepted' || raw === 'rejected' ? raw : null;
  } catch {
    return null;
  }
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
    // localStorage unavailable (private browsing, quota) — in-memory listeners
    // still fire below so the UI reflects the choice for this page load.
  }
  for (const cb of listeners) cb();
}
