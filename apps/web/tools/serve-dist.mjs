// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Static server for `dist/`, used by the offline E2E suite.
 *
 * `vite preview` is not a faithful stand-in for production here: it answers unknown
 * paths with 200 instead of 404, and ignores `_headers` and `_redirects`. That would
 * make the service-worker specs test something the real site never does.
 *
 * This mirrors the Cloudflare Worker's static-asset behaviour instead:
 *  - `html_handling = "drop-trailing-slash"` — `/fin` serves `dist/fin/index.html`
 *  - no SPA catch-all — unknown paths 404 (wrangler.toml documents this)
 *  - `_redirects` (exact paths only, which is all this site uses)
 *  - `_headers`, so every spec runs under the real Content-Security-Policy
 *
 * Usage: node tools/serve-dist.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.argv[2] ?? 4173);

/** `_redirects` as [from, to, status]: exact paths only. */
async function loadRedirects() {
  const text = await readFile(join(DIST, '_redirects'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [from, to, status] = l.split(/\s+/);
      if (from.includes('*') || from.includes(':')) throw new Error(`unsupported rule: ${l}`);
      return [from, to, Number(status ?? 302)];
    });
}

/** `_headers` as [pattern, headers]: a path line, then indented `Name: value` lines. */
async function loadHeaders() {
  const text = await readFile(join(DIST, '_headers'), 'utf8');
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const glob = line
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      rules.push([new RegExp(`^${glob}$`), {}]);
    } else {
      const i = line.indexOf(':');
      rules.at(-1)[1][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

const REDIRECTS = await loadRedirects();
const HEADER_RULES = await loadHeaders();

/** Every `_headers` rule matching `pathname`, merged in file order. */
const headersFor = (pathname) =>
  Object.assign({}, ...HEADER_RULES.filter(([re]) => re.test(pathname)).map(([, h]) => h));

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
  const redirect = REDIRECTS.find(([from]) => from === pathname);
  if (redirect) {
    res.writeHead(redirect[2], { location: redirect[1] });
    res.end();
    return;
  }
  const file = await resolveFile(pathname);

  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const body = await readFile(file);
    const headers = {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      ...headersFor(pathname),
    };
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`serving dist on http://localhost:${PORT}`));
