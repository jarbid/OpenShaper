import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { assertEditorPrecache, rewriteAppShellUrl } from './tools/precache-guard';

const SITE_URL = (process.env.VITE_SITE_URL ?? 'https://openshaper.com').replace(/\/+$/, '');

// The Tauri desktop shell loads bundled files over a custom protocol with a
// relative base and has no service-worker support.
const IS_TAURI = !!process.env.TAURI_ENV_PLATFORM;

const OUT_DIR = join(import.meta.dirname, 'dist');

// Kept in sync with SITE_TAGLINE in src/seo/site.ts by hand: that module reads
// import.meta.env, which isn't available in the config's Node context.
const SITE_TAGLINE = 'Free, open-source surfboard design software';

// Routes worth advertising to crawlers (the editor /app shell is intentionally
// excluded — it's a noindex hydration shell, not content).
const SITEMAP_ROUTES: { path: string; priority: string; changefreq: string }[] = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/surfboard-design-guide', priority: '0.8', changefreq: 'monthly' },
  { path: '/surfboard-construction-methods', priority: '0.8', changefreq: 'monthly' },
  { path: '/surfboard-volume-calculator', priority: '0.7', changefreq: 'monthly' },
  { path: '/build-a-hollow-wooden-surfboard', priority: '0.7', changefreq: 'monthly' },
  { path: '/about', priority: '0.6', changefreq: 'monthly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
];

function writeSitemap(outDir: string) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_ROUTES.map(
    (r) =>
      `  <url>\n    <loc>${SITE_URL}${r.path}</loc>\n    <lastmod>${today}</lastmod>\n` +
      `    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  writeFileSync(join(outDir, 'sitemap.xml'), xml, 'utf8');
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      disable: IS_TAURI,
      // A hand-written worker: the offline-fallback behaviour this app needs
      // cannot be expressed by a generated one. See src/sw.ts for why.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null, // registered from the editor only — see UpdatePrompt
      devOptions: { enabled: false }, // keep the dev server (and its e2e run) worker-free
      // Registration scope is the origin root so the worker can serve the
      // offline fallback for marketing navigations. Manifest `scope` is separate.
      scope: '/',
      manifest: {
        id: '/app',
        name: 'OpenShaper — Surfboard Design',
        short_name: 'OpenShaper',
        description: SITE_TAGLINE,
        // Installing launches straight into the editor, but scope stays '/' so
        // the manifest linked from every prerendered page is in-scope for that
        // page — a narrower scope makes Chrome log a warning on marketing routes.
        start_url: '/app',
        scope: '/',
        display: 'standalone',
        background_color: '#0A1424',
        theme_color: '#0A1424',
        lang: 'en',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // An allowlist: nothing is precached unless it is named here. Marketing
        // HTML and the ~2.7 MB of guide images are excluded by omission.
        globPatterns: [
          'assets/**/*.{js,css,woff2}',
          'app/index.html',
          'offline.html',
          'static-loader-data-manifest-*.json',
          'manifest.webmanifest',
          'favicon.svg',
          'icons/*.png',
        ],
        globIgnores: ['**/*.map', 'images/**', 'og-cover.*', 'sitemap.xml', 'robots.txt'],
        // The three.js chunk exceeds the 2 MiB default, and an over-size entry is
        // dropped with only a warning — which would silently break the editor offline.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        manifestTransforms: [
          (entries) => {
            const manifest = rewriteAppShellUrl(entries);
            // vite-plugin-pwa runs once at closeBundle, before prerendering, when
            // dist/app/index.html does not exist yet; vite-react-ssg then re-runs
            // it afterwards. Only assert on that second, complete pass.
            if (existsSync(join(OUT_DIR, 'app/index.html'))) {
              assertEditorPrecache(manifest);
            }
            return { manifest, warnings: [] };
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  // Web is served from a domain root (Cloudflare Pages → openshaper.com); the
  // Tauri desktop shell loads bundled files over a custom protocol and needs a
  // relative base. Tauri v2 sets TAURI_ENV_PLATFORM during its build command.
  base: process.env.TAURI_ENV_PLATFORM ? './' : '/',
  ssgOptions: {
    dirStyle: 'nested',
    // Keep the default 'sync' (deferred module). Do NOT use 'async': it lets the
    // app module execute before vite-react-ssg's inline __VITE_REACT_SSG_HASH__
    // script runs, so the static-loader-data manifest URL becomes
    // `...-undefined.json` (404) behind a fast CDN — a race that passes locally
    // but crashes in production.
    formatting: 'none',
    onFinished: (outDir: string) => writeSitemap(outDir),
  },
});
