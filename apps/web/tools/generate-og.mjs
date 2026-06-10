/**
 * Rasterize public/og-cover.svg → public/og-cover.png (1200×630).
 * Social scrapers (Twitter, Slack, iMessage) do not render SVG og:images,
 * so the PNG is what ships in the meta tags. Re-run after editing the SVG:
 *   pnpm --filter @openshaper/web og
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public/og-cover.svg'), 'utf8');

const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: { loadSystemFonts: true },
})
  .render()
  .asPng();

writeFileSync(join(root, 'public/og-cover.png'), png);
console.log(`og-cover.png written (${(png.length / 1024).toFixed(1)} KiB)`);
