// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Conversion and build time of the experimental NURBS viewer per sample file, in the
 * browser's worker, against the production build (docs/design/board2.md, "V1 viewer").
 *
 * For each file: open it in the editor with `?engine=nurbs`, wait for the 3D view to
 * finish converting, and read what the worker measured (`data-*` on the badge) plus
 * the wall time from opening to the surface being on screen (which includes the
 * 1.2 s quiet period before a conversion starts).
 *
 * Usage (after `pnpm build`):
 *   node tools/perf/nurbs-timing.mjs [--json out.json] [--only substring]
 * Serves dist/ itself via tools/serve-dist.mjs on port 4179.
 */
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const PORT = 4179;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const fixtures = join(REPO, 'packages/io/src/__fixtures__');
const FILES = [
  'docs/specs/golden/shortboard.brd',
  'docs/specs/golden/funboard.brd',
  'docs/specs/golden/longboard.brd',
  'packages/io/src/__fixtures__/self-authored-shortboard.brd',
  ...readdirSync(fixtures)
    .filter((f) => f.endsWith('.s3dx'))
    .sort()
    .map((f) => `packages/io/src/__fixtures__/${f}`),
].filter((f) => !ONLY || f.includes(ONLY));

const server = spawn('node', [join(HERE, '../serve-dist.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const rows = [];
try {
  for (const file of FILES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/app?engine=nurbs`);
    await page.locator('canvas').first().waitFor();
    await page.getByRole('button', { name: /^3D$/ }).first().click();
    const badge = page.getByTestId('nurbs-badge');
    // The bundled sample converts first; wait for it so what is timed below is the file.
    await page.waitForFunction(
      () => {
        const p = document.querySelector('[data-testid=nurbs-badge]')?.getAttribute('data-phase');
        return p === 'ready' || p === 'failed';
      },
      null,
      { timeout: 300_000, polling: 500 },
    );
    const t0 = Date.now();
    await page.locator('input[type=file]').first().setInputFiles(join(REPO, file));
    // Some files import with warnings (a degenerate section): accept them.
    await page
      .getByRole('button', { name: 'Import anyway' })
      .click({ timeout: 3000 })
      .catch(() => {});
    // The new board makes the shown surface stale at once: the phase leaves 'ready'.
    await page.waitForFunction(
      () => {
        const p = document.querySelector('[data-testid=nurbs-badge]')?.getAttribute('data-phase');
        return p !== 'ready' && p !== 'failed';
      },
      null,
      { timeout: 20_000, polling: 100 },
    );
    await page.waitForFunction(
      () => {
        const p = document.querySelector('[data-testid=nurbs-badge]')?.getAttribute('data-phase');
        return p === 'ready' || p === 'failed';
      },
      null,
      { timeout: 300_000, polling: 500 },
    );
    const phase = await badge.getAttribute('data-phase');
    const row = {
      file: file.split('/').pop(),
      phase,
      wallS: +((Date.now() - t0) / 1000).toFixed(1),
      convertS: +(Number((await badge.getAttribute('data-convert-ms')) ?? 0) / 1000).toFixed(1),
      meshS: +(Number((await badge.getAttribute('data-mesh-ms')) ?? 0) / 1000).toFixed(1),
      vertices: Number((await badge.getAttribute('data-vertices')) ?? 0),
      errors,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
