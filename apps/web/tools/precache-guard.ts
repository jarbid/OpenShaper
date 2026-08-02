// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Build-time guard over the service worker's precache manifest.
 *
 * The offline feature is scoped to the `/app` editor: marketing and guide pages
 * stay network-served and must never be precached (they would go stale, and the
 * guide images alone are ~2.7 MB). That scope is expressed as glob patterns in
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
 * On disk the prerenderer emits `dist/app/index.html` and `dist/docs/fins/index.html`,
 * but the canonical URLs are `/app` and `/docs/fins` with no trailing slash
 * (wrangler.toml sets `html_handling = "drop-trailing-slash"`, and commit b796761
 * fixed analytics splitting across the two forms).
 *
 * Precaching the on-disk path caches a URL nobody ever requests. Workbox matches the
 * exact request URL, and its `directoryIndex` fallback only applies to paths ending
 * in `/` — so a navigation to `/docs/fins` would miss the cache entirely and fall
 * through to the offline page, with the content sitting right there unused.
 * Rewriting to the canonical form is what makes these entries reachable at all.
 */
export function rewriteAppShellUrl<T extends PrecacheEntry>(entries: T[]): T[] {
  return entries.map((e) => {
    if (e.url === 'app/index.html') return { ...e, url: 'app' };
    if (e.url === 'docs/index.html') return { ...e, url: 'docs' };
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

const isHtml = (url: string) => url.endsWith('.html') || url === 'app';

/**
 * HTML that is *meant* to be precached: the editor shell, the offline fallback,
 * and the reference docs. Everything else — the landing page, the guide pillars —
 * stays network-served, so it can never go stale in a cache.
 */
const isAllowedHtml = (url: string) =>
  url === 'app' || url === 'offline.html' || url === 'docs/index.html' || url.startsWith('docs/');

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
 * Assert the precache contains exactly the editor's asset graph and nothing
 * belonging to the marketing site. Throws {@link PrecacheGuardError} on any
 * violation.
 */
export function assertEditorPrecache(entries: readonly PrecacheEntry[]): void {
  const urls = entries.map((e) => e.url);
  const problems: string[] = [];

  const has = (u: string) => urls.includes(u);
  const countMatching = (re: RegExp) => urls.filter((u) => re.test(u)).length;

  // --- required ---
  if (!has('app')) {
    problems.push("missing the editor shell ('app')");
  }
  if (has('app/index.html')) {
    problems.push("'app/index.html' was not rewritten to 'app' (rewriteAppShellUrl did not run)");
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
  const marketingHtml = urls.filter((u) => isHtml(u) && !isAllowedHtml(u));
  if (marketingHtml.length > 0) {
    problems.push(`marketing HTML must not be precached: ${marketingHtml.join(', ')}`);
  }

  // A docs glob that matches nothing still builds — it just quietly ships docs
  // that can't be read offline, which is the whole reason they're precached.
  if (countMatching(/^docs(\/|$)/) < 2) {
    problems.push('fewer than 2 docs pages precached — the docs glob probably matched nothing');
  }

  const images = urls.filter((u) => u.startsWith('images/'));
  if (images.length > 0) {
    problems.push(`guide images must not be precached (${images.length} found)`);
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
