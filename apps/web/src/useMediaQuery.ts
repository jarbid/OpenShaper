import { useEffect, useState } from 'react';

/**
 * SSR-safe media-query hook. Returns whether `query` currently matches.
 *
 * On the server (and the very first client render, before hydration) there is no
 * `window`, so we fall back to `initial` (default `false`) to keep markup stable;
 * the real value is read in an effect right after mount. Editor UI lives behind a
 * `ClientOnly` shell, so the layout settles immediately on the client.
 */
export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(initial);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** True at the editor's desktop tier (Tailwind `lg`, ≥ 1024px). */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
