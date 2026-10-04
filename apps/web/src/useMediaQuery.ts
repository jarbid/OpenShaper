import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * SSR-safe media-query hook. Returns whether `query` currently matches.
 *
 * The value is read synchronously on the client, so it is right on the *first*
 * render rather than a frame later. That matters because these queries pick a
 * layout: settling in an effect meant every tier reported `false` initially, so
 * a desktop briefly painted the compact layout and a phone would briefly paint
 * a view it is not supposed to have.
 *
 * On the server there is no `window`, so `getServerSnapshot` returns `initial`
 * and the markup stays stable; React swaps to the live value after hydration.
 * Editor UI lives behind a `ClientOnly` shell, so it mounts fresh on the client
 * and never pays even that one frame.
 */
export function useMediaQuery(query: string, initial = false): boolean {
  const mql = useMemo(
    () => (typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia(query)),
    [query],
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!mql) return () => {};
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    [mql],
  );

  return useSyncExternalStore(
    subscribe,
    () => mql?.matches ?? initial,
    () => initial,
  );
}

const SHORT_VIEWPORT = '(max-height: 480px)';

/** True at the editor's desktop tier (Tailwind `lg`, ≥ 1024px). */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}

/**
 * True on a phone-sized viewport.
 *
 * 640px is not a new number — it is Tailwind's `sm`, already the point where the
 * menubar collapses into the command palette and the wordmark drops. The height
 * arm catches a phone held landscape (844×390 on an iPhone), which is wide
 * enough to pass a width test but far too short for a column of stacked panes.
 */
export function useIsPhone(): boolean {
  // 639.98, not 640: Tailwind's `sm` is `min-width: 640px`, so at exactly 640px a
  // `max-width: 640px` phone query and `sm:` styles would both apply.
  return useMediaQuery(`(max-width: 639.98px), ${SHORT_VIEWPORT}`);
}

/**
 * A viewport with very little height — a phone held landscape, mostly.
 *
 * Height is the scarce axis there, not width: at 844x390 the two header rows and
 * the sheet's peek take more than half the screen. Chrome that collapses on this
 * query must be gated on height and not on width, because the merged single
 * header row needs ~399px, which 844 has and 360 does not.
 */
export function useIsShortViewport(): boolean {
  return useMediaQuery(SHORT_VIEWPORT);
}

/**
 * True where the primary input is a finger or a stylus rather than a mouse.
 *
 * This is the same condition Tailwind's `pointer-coarse:` variant tests, so UI that
 * has to *restructure* for touch flips together with the sizing that grows for it.
 * It is deliberately not a size tier: a tablet is a large coarse viewport and a
 * narrow desktop window is a small fine one, and 44px targets are owed to the first
 * and not the second.
 */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

/** The same query, for a `useState` initialiser that cannot call a hook. */
export function isShortViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(SHORT_VIEWPORT).matches;
}
