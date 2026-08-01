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
 * On disk the prerenderer emits `dist/app/index.html`, but the canonical URL is
 * `/app` with no trailing slash (wrangler.toml sets `html_handling =
 * "drop-trailing-slash"`, and commit b796761 fixed analytics splitting across the
 * two forms). Precaching `app/index.html` would cache a URL nobody requests, so
 * rewrite the entry to `app` — which is what the browser actually navigates to.
 */
export function rewriteAppShellUrl<T extends PrecacheEntry>(entries: T[]): T[] {
  return entries.map((e) => (e.url === 'app/index.html' ? { ...e, url: 'app' } : e));
}

/** Total precache budget. Generous enough for three.js, tight enough to catch a runaway glob. */
export const MAX_PRECACHE_BYTES = 12 * 1024 * 1024;

/** A glob matching nothing still builds — require a plausible floor of app chunks. */
const MIN_JS_ENTRIES = 5;

const isHtml = (url: string) => url.endsWith('.html') || url === 'app';

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
  const marketingHtml = urls.filter((u) => isHtml(u) && u !== 'app' && u !== 'offline.html');
  if (marketingHtml.length > 0) {
    problems.push(`marketing HTML must not be precached: ${marketingHtml.join(', ')}`);
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
