// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keeps the experimental NURBS viewer's chunks (its layer, worker and fallback core,
 * about 0.6 MB with board2 and geom) out of everyone's page load.
 *
 * vite-react-ssg writes a `<link rel="modulepreload">` into each prerendered page for
 * every lazy chunk the page's modules can reach, transitively. The editor shell
 * reaches the NURBS layer through a dynamic import behind the engine flag, so without
 * this a user who never enables the flag would still download the viewer. The chunks
 * are fetched when the flag is on, by the dynamic import and the worker URL.
 *
 * Pure functions over HTML, so they are unit-tested without a build; the build runs
 * {@link stripNurbsPreloads} on every page and {@link assertNoNurbsPreloads} on the
 * result.
 */

/** Link relations that make the browser fetch a chunk ahead of its import. */
const HINT_RELS = new Set(['modulepreload', 'preload', 'prefetch']);

/** `assets/nurbs-*.js` under any base: `/assets/…`, `assets/…`, `./assets/…`, `/base/assets/…`. */
const NURBS_CHUNK = /(?:^|\/)assets\/nurbs-[^/]*$/;

/** Every `<link …>` start tag, whatever its attributes. */
const LINK_TAG = /<link\b[^>]*>/gi;

/** The value of attribute `name` in a start tag, quoted either way or bare. */
const attributeOf = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/** Whether a `<link>` tag hints at a NURBS viewer chunk, whatever the order of its attributes. */
const hintsAtNurbsChunk = (tag: string): boolean => {
  const rel = attributeOf(tag, 'rel');
  const href = attributeOf(tag, 'href');
  if (rel === null || href === null) return false;
  const hints = rel
    .toLowerCase()
    .split(/\s+/)
    .some((r) => HINT_RELS.has(r));
  return hints && NURBS_CHUNK.test(href.split(/[?#]/)[0]!);
};

/** The page without its preload hints for NURBS chunks. */
export const stripNurbsPreloads = (html: string): string =>
  html.replace(LINK_TAG, (tag) => (hintsAtNurbsChunk(tag) ? '' : tag));

/** Throws if a page still hints at a NURBS chunk anywhere outside the lazy loaders. */
export function assertNoNurbsPreloads(route: string, html: string): void {
  for (const tag of html.match(LINK_TAG) ?? []) {
    if (hintsAtNurbsChunk(tag)) {
      throw new Error(`${route}: the prerendered page preloads a NURBS viewer chunk: ${tag}`);
    }
  }
}
