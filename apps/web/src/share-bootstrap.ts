// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Lifting a shared board out of the address bar, before anything else can see it.
 *
 * A share link is `/app#board=v1.<payload>` — a whole board, and its Board Info,
 * sitting in the URL. PostHog captures `$current_url` unmasked on every
 * pageview, records the address bar in session replay, and attaches the URL to
 * error reports. So the fragment has to be gone before analytics starts.
 *
 * "Before analytics starts" is a stronger constraint than it reads:
 * `initAnalytics()` runs from a `useEffect` in RootLayout, i.e. after React
 * mounts. Anything React-scoped is already too late. This module is therefore
 * called from `main.tsx` at *module scope*, above `ViteReactSSG(...)`.
 *
 * The payload then lives only here, in memory, until `takeSharedPayload()`
 * hands it over exactly once. It is never stored, never logged, and never put
 * into a React state that could be serialized somewhere.
 *
 * `main.tsx` also executes in Node during the static prerender, hence the
 * `typeof window` guard.
 */

const PARAM = 'board=';

/** The extracted payload, awaiting its single reader. */
let pending: string | null = null;

/**
 * Read and remove a `board=` fragment from the current URL.
 *
 * Unrelated fragment entries are preserved byte-for-byte — the segments are
 * filtered as raw text rather than round-tripped through `URLSearchParams`,
 * which would re-encode a fragment that was never ours to touch. The query
 * string and path are left exactly as they were.
 */
export function extractSharedFragment(): void {
  if (typeof window === 'undefined') return;
  try {
    const hash = window.location.hash;
    if (!hash) return;

    const segments = hash.slice(1).split('&');
    const board = segments.find((s) => s.startsWith(PARAM));
    if (board === undefined) return;

    // Clean the address bar first: a payload that fails to decode below must
    // not be left where analytics would read it.
    const rest = segments.filter((s) => s !== board).join('&');
    const { pathname, search } = window.location;
    window.history.replaceState(null, '', `${pathname}${search}${rest ? `#${rest}` : ''}`);

    pending = decodeURIComponent(board.slice(PARAM.length));
  } catch {
    // A malformed escape sequence or a history API the browser will not let us
    // call must never stop the editor booting. Worst case the link is ignored.
    pending = null;
  }
}

/**
 * Read the extracted payload without consuming it.
 *
 * Deliberately not a take-once accessor. The only reader is a mount effect,
 * and React StrictMode runs those twice in development — a take-once read
 * would hand the board to the first run, which is then cancelled, and `null`
 * to the second, silently losing the link on exactly the builds we develop
 * against. Consumption is tied to the *decision* instead.
 */
export const peekSharedPayload = (): string | null => pending;

/**
 * Drop the payload, once it has been opened, declined, or failed to decode.
 * After this a remount cannot re-apply a board the user already dealt with.
 */
export const clearSharedPayload = (): void => {
  pending = null;
};
