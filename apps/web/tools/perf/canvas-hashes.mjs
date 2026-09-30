// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pixel-exact check for 2D rendering changes: drive a fixed script in the
 * production build and print a SHA-256 of every 2D canvas after each step.
 * Run it against two builds and diff the output — identical hashes mean identical
 * pixels.
 *
 * Steps (desktop 1440×900, DPR 2): load → quad view → select, then drag, the
 * outline's widest knot → hover the rocker pane (scrub probe) → outline,
 * cross-section and rocker views.
 *
 * Usage (after `pnpm build`): node tools/perf/canvas-hashes.mjs [port]
 * PW_CHROMIUM overrides the browser binary.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? 4181);
const server = spawn(process.execPath, [join(HERE, '..', 'serve-dist.mjs'), String(PORT)], {
  stdio: 'ignore',
});

const frames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function hashes(page, label) {
  await frames(page);
  await page.waitForTimeout(400);
  const urls = await page.evaluate(() =>
    [...document.querySelectorAll('canvas')]
      .filter((c) => !c.getContext('webgl2') && !c.getContext('webgl'))
      .map((c) => `${c.width}x${c.height}:${c.toDataURL('image/png')}`),
  );
  const hs = urls.map((u) => createHash('sha256').update(u).digest('hex').slice(0, 12));
  console.log(`${label.padEnd(22)} ${hs.join(' ')}`);
}

try {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/app`);
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(1500);
  const reject = page.getByRole('button', { name: 'Reject' });
  if (await reject.isVisible().catch(() => false)) await reject.click();

  await page.keyboard.press('1');
  await hashes(page, 'quad, loaded');

  // Outline pane is the first canvas; the board is fitted on its long axis with
  // 24 px padding, tail at the left.
  const box = await page.locator('canvas').first().boundingBox();
  const s = (box.width - 48) / 187.96;
  const knot = { x: box.x + 24 + 90.1336 * s, y: box.y + box.height / 2 - 23.495 * s };
  await page.mouse.click(knot.x, knot.y);
  await hashes(page, 'quad, knot selected');
  await page.mouse.move(knot.x, knot.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(knot.x + i * 2, knot.y - i);
    await frames(page);
  }
  await page.mouse.up();
  await hashes(page, 'quad, after drag');

  const rocker = await page.locator('canvas').nth(2).boundingBox();
  await page.mouse.move(rocker.x + rocker.width * 0.4, rocker.y + rocker.height / 2);
  await hashes(page, 'quad, rocker hover');

  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('2');
  await hashes(page, 'outline view');
  await page.keyboard.press('4');
  await hashes(page, 'cross-section view');
  await page.keyboard.press('3');
  await hashes(page, 'rocker view');

  await browser.close();
} finally {
  server.kill();
}
