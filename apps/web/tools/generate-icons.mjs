/**
 * Rasterize public/favicon.svg → the PWA icon set in public/icons/.
 *
 * The web app manifest can't use SVG for the install/splash icons on every
 * platform, so these PNGs are what the browser and OS actually show. Re-run
 * after editing favicon.svg:
 *   pnpm --filter @openshaper/web icons
 *
 * Two shapes are emitted:
 *  - `any`      — the favicon as-is, edge to edge.
 *  - `maskable` — the same art inset into a full-bleed background, because
 *                 Android crops maskable icons to a platform-chosen shape and
 *                 only the middle 80% (the "safe zone") is guaranteed visible.
 */
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/icons');
const svg = readFileSync(join(root, 'public/favicon.svg'), 'utf8');

/** Background of the source mark — also the maskable bleed and manifest background_color. */
const BACKGROUND = '#0A1424';

/**
 * Wrap the 32×32 source in a larger square so the art occupies the middle 80%,
 * leaving the safe-zone margin Android needs. The rounded corners of the source
 * are covered by the bleed, which is what a maskable icon wants.
 */
function maskableSvg(source) {
  const inner = source
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    // Drop the source's rounded-rect background and its border stroke: the
    // platform supplies the shape here, and a visible rounded square inside a
    // circular crop reads as a stray outline.
    .replace(/<rect[^>]*\/>/g, '')
    .trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">
  <rect width="40" height="40" fill="${BACKGROUND}"/>
  <g transform="translate(4 4)">${inner}</g>
</svg>`;
}

function render(source, size, name) {
  const png = new Resvg(source, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  writeFileSync(join(outDir, name), png);
  console.log(`icons/${name} written (${(png.length / 1024).toFixed(1)} KiB)`);
}

mkdirSync(outDir, { recursive: true });

render(svg, 192, 'icon-192.png');
render(svg, 512, 'icon-512.png');
// iOS ignores the manifest icons for "Add to Home Screen" and uses this instead.
render(svg, 180, 'apple-touch-icon.png');

const maskable = maskableSvg(svg);
render(maskable, 192, 'maskable-192.png');
render(maskable, 512, 'maskable-512.png');
