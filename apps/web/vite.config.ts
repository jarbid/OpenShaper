import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SITE_URL = (process.env.VITE_SITE_URL ?? 'https://openshaper.com').replace(/\/+$/, '');

// Routes worth advertising to crawlers (the editor /app shell is intentionally
// excluded — it's a noindex hydration shell, not content).
const SITEMAP_ROUTES: { path: string; priority: string; changefreq: string }[] = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/surfboard-design-guide', priority: '0.8', changefreq: 'monthly' },
  { path: '/surfboard-construction-methods', priority: '0.8', changefreq: 'monthly' },
  { path: '/about', priority: '0.6', changefreq: 'monthly' },
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
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // Web is served from a domain root (Cloudflare Pages → openshaper.com); the
  // Tauri desktop shell loads bundled files over a custom protocol and needs a
  // relative base. Tauri v2 sets TAURI_ENV_PLATFORM during its build command.
  base: process.env.TAURI_ENV_PLATFORM ? './' : '/',
  ssgOptions: {
    dirStyle: 'nested',
    script: 'async',
    formatting: 'none',
    onFinished: (outDir: string) => writeSitemap(outDir),
  },
});
