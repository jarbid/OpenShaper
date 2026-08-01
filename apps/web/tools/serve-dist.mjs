// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Static server for `dist/`, used by the offline E2E suite.
 *
 * `vite preview` is not a faithful stand-in for production here: it falls back to
 * the landing page for `/app` (so the editor shell is never served at its
 * canonical URL) and answers unknown paths with 200 instead of 404. Both would
 * make the service-worker specs test something the real site never does.
 *
 * This mirrors the Cloudflare Worker's static-asset behaviour instead:
 *  - `html_handling = "drop-trailing-slash"` — `/app` serves `dist/app/index.html`
 *  - no SPA catch-all — unknown paths 404 (wrangler.toml documents this)
 *
 * Usage: node tools/serve-dist.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.argv[2] ?? 4173);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a request path to a file, treating a directory as its index.html. */
async function resolveFile(pathname) {
  const candidate = join(DIST, normalize(pathname));
  if (!candidate.startsWith(DIST)) return null; // no traversal outside dist
  try {
    const stats = await stat(candidate);
    if (stats.isFile()) return candidate;
    if (stats.isDirectory()) return join(candidate, 'index.html');
  } catch {
    /* fall through to the directory-index form below */
  }
  const asIndex = join(candidate, 'index.html');
  try {
    if ((await stat(asIndex)).isFile()) return asIndex;
  } catch {
    /* not found */
  }
  return null;
}

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const file = await resolveFile(pathname);

  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const body = await readFile(file);
    const headers = { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' };
    // Mirrors public/_headers: the worker must never be served from a stale cache.
    if (pathname === '/sw.js') headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`serving dist on http://localhost:${PORT}`));
