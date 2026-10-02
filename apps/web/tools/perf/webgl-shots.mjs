// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Screenshot check for 3D rendering changes: drive every kind of 3D interaction
 * in the production build and print a SHA-256 of the 3D pane after each one, so
 * two builds can be diffed. Built for changes to *when* the scene renders
 * (e.g. R3F's frameloop): a step whose hash differs from the reference build is a
 * frame that was not redrawn, or was drawn differently.
 *
 * Each step waits for the tessellation worker and a few frames before the shot.
 * Run it twice on one build first: software WebGL should be deterministic here.
 *
 * Usage (after `pnpm build`): node tools/perf/webgl-shots.mjs [port] [--save dir]
 * PW_CHROMIUM overrides the browser binary.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 4182);
const SAVE = args.includes('--save') ? args[args.indexOf('--save') + 1] : null;
if (SAVE) mkdirSync(SAVE, { recursive: true });
const server = spawn(process.execPath, [join(HERE, '..', 'serve-dist.mjs'), String(PORT)], {
  stdio: 'ignore',
});

const settle = async (page, ms = 1200) => {
  await page.waitForTimeout(ms);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
};

let step = 0;
async function shot(page, label) {
  await settle(page);
  const canvas = page.locator('canvas').last(); // the 3D pane is the last canvas
  const png = await canvas.screenshot();
  if (SAVE) writeFileSync(join(SAVE, `${String(++step).padStart(2, '0')}-${label}.png`), png);
  console.log(`${label.padEnd(26)} ${createHash('sha256').update(png).digest('hex').slice(0, 12)}`);
}

try {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/app`);
  await page.locator('canvas').first().waitFor();
  const reject = page.getByRole('button', { name: 'Reject' });
  await settle(page, 1500);
  if (await reject.isVisible().catch(() => false)) await reject.click();

  await page.keyboard.press('5');
  await shot(page, '3d view loaded');

  const box = await page.locator('canvas').last().boundingBox();
  const cx = box.x + box.width * 0.4;
  const cy = box.y + box.height * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 8, cy + i * 3);
  await page.mouse.up();
  await shot(page, 'orbit drag');

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  await shot(page, 'wheel zoom');

  await page.getByRole('button', { name: 'Flip view' }).click();
  await shot(page, 'flip button');

  // View cube: bottom-right corner of the pane; its centre face snaps the view.
  await page.mouse.click(box.x + box.width - 58, box.y + box.height - 58);
  await shot(page, 'view cube click');

  await page.getByTitle('3D: Wire', { exact: true }).click();
  await shot(page, 'mode: wire');
  await page.getByTitle('3D: Shaded', { exact: true }).click();
  await shot(page, 'mode: shaded');

  await page.getByTitle('Lighting').selectOption('shaping-bay');
  await shot(page, 'lighting: shaping bay');

  await page.getByTitle('Surface analysis').selectOption('zebra');
  await shot(page, 'analysis: zebra');
  await page.getByTitle('Surface analysis').selectOption('none');

  await page.getByTitle('Draw the stringer line down the centre of the board').click();
  await page.getByTitle(/Draw a ring at every cross-section/).click();
  await shot(page, 'stringer + sections');

  await page.getByTitle('Mesh quality').selectOption('draft');
  await shot(page, 'mesh quality: draft');

  // Fins (their own meshes, placed off the hull's centre): Build tab → Fins.
  await page.getByRole('tab', { name: 'Build' }).click();
  const finsHeader = page.getByRole('button', { name: 'Fins', exact: true });
  if ((await finsHeader.getAttribute('aria-expanded')) !== 'true') await finsHeader.click();
  await page.getByTitle('Fin setup').selectOption('thruster');
  await shot(page, 'fins: thruster');

  await page.setViewportSize({ width: 1200, height: 800 });
  await shot(page, 'viewport resized');

  // A board edit with the 3D pane mounted: quad view, drag the outline's widest
  // knot (first canvas, fitted on its long axis with 24 px padding).
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await settle(page);
  const o = await page.locator('canvas').first().boundingBox();
  const s = (o.width - 48) / 187.96;
  const knot = { x: o.x + 24 + 90.1336 * s, y: o.y + o.height / 2 - 23.495 * s };
  await page.mouse.click(knot.x, knot.y);
  await page.mouse.move(knot.x, knot.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(knot.x + i * 3, knot.y - i * 2);
  await page.mouse.up();
  await shot(page, 'quad: after outline drag');

  await browser.close();
} finally {
  server.kill();
}
