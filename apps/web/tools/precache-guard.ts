// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Build-time guard over the service worker's precache manifest.
 *
 * The offline feature is scoped to the `/fin` fin designer and its help: any other
 * page stays network-served and must never be precached (it would go stale). That
 * scope is expressed as glob patterns in
 * vite.config.ts, which is easy to get subtly wrong and impossible to notice by
 * eye — a glob that silently matches nothing still produces a working build,
 * just one with no offline support.
 *
 * So the invariant is asserted instead. `assertEditorPrecache` throws, which
 * fails `pnpm build`, which fails CI.
 *
 * These are pure functions over the manifest array so they can be unit-tested
 * without running a build.
 */

/** The subset of workbox's ManifestEntry this module needs. */
export interface PrecacheEntry {
  url: string;
  revision?: string | null;
  size?: number;
}

/**
 * On disk the prerenderer emits `dist/fin/index.html` and `dist/docs/fin-designer/index.html`,
 * but the canonical URLs are `/fin` and `/docs/fin-designer` with no trailing slash
 * (wrangler.toml sets `html_handling = "drop-trailing-slash"`, and commit b796761
 * fixed analytics splitting across the two forms).
 *
 * Precaching the on-disk path caches a URL nobody ever requests. Workbox matches the
 * exact request URL, and its `directoryIndex` fallback only applies to paths ending
 * in `/` — so a navigation to `/docs/fin-designer` would miss the cache entirely and fall
 * through to the offline page, with the content sitting right there unused.
 * Rewriting to the canonical form is what makes these entries reachable at all.
 */
export function rewriteAppShellUrl<T extends PrecacheEntry>(entries: T[]): T[] {
  return entries.map((e) => {
    if (e.url === 'fin/index.html') return { ...e, url: 'fin' };
    if (e.url.startsWith('docs/') && e.url.endsWith('/index.html')) {
      return { ...e, url: e.url.slice(0, -'/index.html'.length) };
    }
    return e;
  });
}

/** Total precache budget. Generous enough for three.js, tight enough to catch a runaway glob. */
export const MAX_PRECACHE_BYTES = 12 * 1024 * 1024;

/** A glob matching nothing still builds — require a plausible floor of app chunks. */
const MIN_JS_ENTRIES = 5;

const isHtml = (url: string) =>
  url.endsWith('.html') || url === 'app' || url === 'fin' || url.startsWith('docs/');

/**
 * HTML that is *meant* to be precached: the designer's shell, the offline fallback,
 * and its help. Everything else stays network-served, so it can never go stale in a
 * cache.
 */
const isAllowedHtml = (url: string) =>
  url === 'fin' || url === 'offline.html' || (url.startsWith('docs/') && !url.endsWith('.html'));

export class PrecacheGuardError extends Error {
  constructor(problems: string[]) {
    super(
      `Service worker precache is wrong (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nSee apps/web/tools/precache-guard.ts and the globs in vite.config.ts.',
    );
    this.name = 'PrecacheGuardError';
  }
}

/**
 * Assert the precache contains exactly the fin designer's asset graph, and nothing
 * else: no other page, and none of the OpenShaper board editor this was forked from. Throws {@link PrecacheGuardError} on any
 * violation.
 */
export function assertEditorPrecache(entries: readonly PrecacheEntry[]): void {
  const urls = entries.map((e) => e.url);
  const problems: string[] = [];

  const has = (u: string) => urls.includes(u);
  const countMatching = (re: RegExp) => urls.filter((u) => re.test(u)).length;

  // --- required ---
  if (!has('fin')) {
    problems.push("missing the fin designer shell ('fin')");
  }
  if (has('fin/index.html')) {
    problems.push("'fin/index.html' was not rewritten to 'fin' (rewriteAppShellUrl did not run)");
  }
  if (!has('offline.html')) {
    problems.push("missing 'offline.html' (the catch-handler fallback)");
  }

  // vite-react-ssg's synthetic route loaders fetch this on client-side navigation.
  const loaderManifests = countMatching(/^static-loader-data-manifest-[^/]+\.json$/);
  if (loaderManifests !== 1) {
    problems.push(
      `expected exactly 1 static-loader-data-manifest-*.json, found ${loaderManifests}`,
    );
  }

  const jsCount = countMatching(/\.js$/);
  if (jsCount < MIN_JS_ENTRIES) {
    problems.push(`only ${jsCount} JS entries — the assets glob probably matched nothing`);
  }
  if (countMatching(/\.css$/) < 1) {
    problems.push('no CSS entries — the assets glob probably matched nothing');
  }

  // --- forbidden ---
  const otherHtml = urls.filter((u) => isHtml(u) && !isAllowedHtml(u));
  if (otherHtml.length > 0) {
    problems.push(`no other page may be precached: ${otherHtml.join(', ')}`);
  }

  // The board editor is unrouted, so its code should never be built at all.
  const boardEditor = urls.filter((u) => /^assets\/EditorPage-/.test(u));
  if (boardEditor.length > 0) {
    problems.push(`the board editor must not ship: ${boardEditor.join(', ')}`);
  }

  // A docs glob that matches nothing still builds — it just quietly ships help
  // that can't be read offline, which is the whole reason it's precached.
  if (!has('docs/fin-designer')) {
    problems.push("missing the help page ('docs/fin-designer') — the docs glob matched nothing");
  }

  const strayRaster = urls.filter((u) => /\.(png|jpe?g|webp)$/.test(u) && !u.startsWith('icons/'));
  if (strayRaster.length > 0) {
    problems.push(`unexpected raster assets outside icons/: ${strayRaster.join(', ')}`);
  }

  const totalBytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
  if (totalBytes > MAX_PRECACHE_BYTES) {
    problems.push(
      `precache is ${(totalBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(MAX_PRECACHE_BYTES / 1024 / 1024).toFixed(0)} MB budget`,
    );
  }

  if (problems.length > 0) throw new PrecacheGuardError(problems);
}
