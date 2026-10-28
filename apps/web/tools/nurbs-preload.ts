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

/** `assets/nurbs-*.js`, the chunk names `vite.config.ts` also keeps out of the precache. */
const NURBS_PRELOAD = /<link\s+rel="modulepreload"[^>]*href="[^"]*\/assets\/nurbs-[^"]*"[^>]*>/g;

/** The page without its modulepreload hints for NURBS chunks. */
export const stripNurbsPreloads = (html: string): string => html.replace(NURBS_PRELOAD, '');

/** Throws if a page still names a NURBS chunk anywhere outside the lazy loaders. */
export function assertNoNurbsPreloads(route: string, html: string): void {
  if (/\bmodulepreload\b[^>]*\/assets\/nurbs-/.test(html)) {
    throw new Error(`${route}: the prerendered page preloads a NURBS viewer chunk`);
  }
}
