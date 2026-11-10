// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Build-time Content-Security-Policy.
 *
 * The prerendered pages carry small inline scripts written by vite-react-ssg (the
 * hydration hash and loader data), whose text changes with every build. Allowing
 * them with `'unsafe-inline'` would allow any injected script too, so instead the
 * build hashes each one and lists the hashes in the policy, and appends the policy
 * to `dist/_headers`, which Cloudflare serves with every response.
 *
 * Everything else the site runs is its own (`'self'`). Analytics goes through the
 * same-origin `/edge` proxy (worker/index.ts); PostHog's own hosts are allowed too,
 * because a build without `VITE_POSTHOG_HOST` talks to them directly.
 *
 * Pure functions over strings, so they're unit-tested without a build.
 */
import { createHash } from 'node:crypto';

/** PostHog's hosts, for a build that talks to it directly rather than through /edge. */
const POSTHOG_SCRIPTS = 'https://us-assets.i.posthog.com';
const POSTHOG_CONNECT = 'https://*.posthog.com';

/** The text of every inline `<script>` (one without a `src`) in an HTML document. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // JSON data blocks are not executed, and CSP does not apply to them.
    if (/\btype\s*=\s*["']?application\/(ld\+)?json/i.test(attrs)) continue;
    out.push(body);
  }
  return out;
}

/** The CSP source expression for one inline script: `'sha256-<base64>'`. */
export function scriptHash(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

/** The site's policy, allowing exactly the given inline-script hashes. */
export function buildCsp(hashes: Iterable<string>): string {
  const unique = [...new Set(hashes)].sort();
  return [
    "default-src 'self'",
    `script-src 'self' ${[...unique, POSTHOG_SCRIPTS].join(' ')}`,
    // Prerendered markup carries style attributes, and offline.html has its own
    // <style>. Styles can't run code, so this is the usual trade.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${POSTHOG_CONNECT}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/**
 * `_headers` with the policy added to its catch-all `/*` block. Throws if there is
 * no such block: a policy silently left out is the failure this exists to prevent.
 */
export function addCspToHeaders(headers: string, csp: string): string {
  const lines = headers.split('\n');
  const start = lines.findIndex((l) => l.trim() === '/*');
  if (start < 0) throw new Error('_headers has no "/*" block to add the CSP to');
  if (lines.some((l) => /^\s+Content-Security-Policy:/i.test(l))) {
    throw new Error('_headers already sets a Content-Security-Policy');
  }
  lines.splice(start + 1, 0, `  Content-Security-Policy: ${csp}`);
  return lines.join('\n');
}
