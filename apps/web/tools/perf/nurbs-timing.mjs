// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Timings of the experimental NURBS viewer on the section model, in Chromium, against
 * the production build (docs/design/m1-model.md §3, "As built (step 3)").
 *
 * Three measurements:
 *
 *  1. **Open**: for each sample file, open the app with `?engine=nurbs`, show the 3D
 *     view, load the file, and time until the NURBS surface of that file is on screen.
 *     Also the worker's own convert / build / mesh times for it.
 *  2. **Engine switch**: with the engine off and the 3D view open, turn "Engine: NURBS
 *     (experimental)" on in Settings and time until the NURBS hull is on screen. This
 *     includes fetching the lazy layer chunk and starting the worker.
 *  3. **Drag**: with the quad view (2D outline + 3D) open, drag the shortboard's wide
 *     outline knot and record every NURBS update that arrives: request to answer on the
 *     main thread (clone, convert, build, mesh, transfer), and the worker's share.
 *     The target is a median under 50 ms.
 *
 * Usage (after `pnpm build`):
 *   node tools/perf/nurbs-timing.mjs [--json out.json] [--only substring] [--throttle 4]
 *        [--skip open|switch|drag]
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
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const JSON_OUT = arg('--json');
const ONLY = arg('--only');
const THROTTLE = Number(arg('--throttle') ?? 1) || 1;
const SKIP = new Set((arg('--skip') ?? '').split(',').filter(Boolean));
const DRAG_MOVES = 60;

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

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
const r1 = (v) => Math.round(v * 10) / 10;

/** Records every NURBS update the badge announces (its `data-update` counter changes). */
const recorder = () => {
  window.__updates = [];
  const attach = () => {
    const badge = document.querySelector('[data-testid=nurbs-badge]');
    if (!badge) return false;
    const read = () => {
      const g = (n) => badge.getAttribute(n);
      if (g('data-update') === null) return;
      window.__updates.push({
        t: performance.now(),
        seq: Number(g('data-update')),
        phase: g('data-phase'),
        showing: g('data-showing'),
        roundTrip: Number(g('data-round-trip-ms')),
        worker: Number(g('data-worker-ms')),
        convert: Number(g('data-convert-ms')),
        build: Number(g('data-build-ms')),
        mesh: Number(g('data-mesh-ms')),
        curvature: Number(g('data-curvature-ms')),
        reused: g('data-ladders-reused') === 'true',
        vertices: Number(g('data-vertices')),
      });
    };
    new MutationObserver(read).observe(badge, { attributes: true });
    read();
    return true;
  };
  const poll = setInterval(() => attach() && clearInterval(poll), 20);
};

const newPage = async (browser) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  });
  await context.addInitScript(recorder);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (THROTTLE > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  }
  return { context, page, errors };
};

const waitSurface = (page, afterSeq, timeout = 60_000) =>
  page.waitForFunction(
    (seq) => {
      const b = document.querySelector('[data-testid=nurbs-badge]');
      if (!b) return false;
      const phase = b.getAttribute('data-phase');
      if (phase === 'failed') return true;
      return (
        phase === 'ready' &&
        b.getAttribute('data-showing') === 'nurbs' &&
        Number(b.getAttribute('data-update')) > seq
      );
    },
    afterSeq,
    { timeout, polling: 10 },
  );

/** The badge's data attributes as the browser shows them now. */
const readBadge = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid=nurbs-badge]');
    if (!b) return null;
    const g = (n) => b.getAttribute(n);
    return {
      seq: Number(g('data-update') ?? 0),
      phase: g('data-phase'),
      showing: g('data-showing'),
      roundTrip: Number(g('data-round-trip-ms')),
      worker: Number(g('data-worker-ms')),
      convert: Number(g('data-convert-ms')),
      build: Number(g('data-build-ms')),
      mesh: Number(g('data-mesh-ms')),
      curvature: Number(g('data-curvature-ms')),
      vertices: Number(g('data-vertices')),
    };
  });

async function measureOpen(browser) {
  const rows = [];
  for (const file of FILES) {
    const { context, page, errors } = await newPage(browser);
    await page.goto(`${BASE}/app?engine=nurbs`);
    await page.locator('canvas').first().waitFor();
    await page.getByRole('button', { name: /^3D$/ }).first().click();
    await waitSurface(page, 0);
    const seq = (await readBadge(page)).seq;
    const t0 = Date.now();
    await page.locator('input[type=file]').first().setInputFiles(join(REPO, file));
    // Some files import with warnings (a degenerate section): accept them while waiting.
    const anyway = page
      .getByRole('button', { name: 'Import anyway' })
      .click({ timeout: 20_000 })
      .catch(() => {});
    await Promise.race([waitSurface(page, seq), anyway.then(() => waitSurface(page, seq))]);
    const wallMs = Date.now() - t0;
    const u = await readBadge(page);
    const phase = u.phase;
    let reason = null;
    if (phase === 'failed') {
      await page.getByRole('button', { name: 'NURBS conversion details' }).click();
      reason = (await page.getByTestId('nurbs-info').innerText())
        .split('\n')
        .slice(0, 3)
        .join(' | ');
    }
    const row = {
      file: file.split('/').pop(),
      phase,
      wallMs,
      worker:
        u && phase === 'ready'
          ? { convert: u.convert, build: u.build, mesh: u.mesh, total: u.worker }
          : null,
      vertices: phase === 'ready' ? u.vertices : 0,
      reason,
      errors,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    await context.close();
  }
  return rows;
}

async function measureSwitch(browser) {
  const out = [];
  for (let run = 0; run < 3; run++) {
    const { context, page, errors } = await newPage(browser);
    await page.goto(`${BASE}/app`);
    await page.locator('canvas').first().waitFor();
    await page.getByRole('button', { name: /^3D$/ }).first().click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await page.getByLabel('Engine: NURBS (experimental)').check();
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Apply' }).click();
    await waitSurface(page, 0);
    const ms = Date.now() - t0;
    const u = await readBadge(page);
    const row = { run, applyToHullMs: ms, worker: u.worker, vertices: u.vertices, errors };
    out.push(row);
    console.log(JSON.stringify(row));
    await context.close();
  }
  return out;
}

/** Screen position of an outline point (board cm) in the quad view's 2D outline pane. */
async function dragKnot(page) {
  const view = await page.evaluate(() => {
    // The outline pane is the first canvas; the 3D one is later in the DOM.
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const L = 187.96;
  const s = (view.w - 48) / L;
  const cands = [
    { x: view.x + 24 + 90.13362308681752 * s, y: view.y + view.h / 2 - 23.49499750470692 * s },
    { x: view.x + 24 + 90.13362308681752 * s, y: view.y + view.h / 2 + 23.49499750470692 * s },
  ];
  let start = null;
  for (const c of cands) {
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.up();
    if (
      await page
        .getByLabel(/ position editor$/)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      start = c;
      break;
    }
  }
  return start;
}

async function measureDrag(browser) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${BASE}/app?engine=nurbs`);
  await page.locator('canvas').first().waitFor();
  await page.keyboard.press('1'); // quad: outline, profile, section and 3D
  await waitSurface(page, 0);
  await page.waitForTimeout(500);
  // The 3D view's analysis mode does not matter here; curvature is computed on settle.
  const start = await dragKnot(page);
  if (!start) {
    await context.close();
    return { error: 'could not select the wide-point knot', errors };
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.evaluate(() => (window.__updates.length = 0));
  const t0 = await page.evaluate(() => performance.now());
  for (let i = 1; i <= DRAG_MOVES; i++) {
    await page.mouse.move(start.x + i * 0.5, start.y - i * 0.3);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  }
  const tEnd = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await page.waitForTimeout(800);
  const ups = await page.evaluate(() => window.__updates.slice());
  const during = ups.filter((u) => u.t >= t0 && u.t <= tEnd);
  const settled = ups.filter((u) => u.t > tEnd);
  const stat = (key) => ({
    median: r1(median(during.map((u) => u[key]))),
    p95: r1(
      pct(
        during.map((u) => u[key]),
        0.95,
      ),
    ),
    max: r1(Math.max(...during.map((u) => u[key]))),
  });
  const res = {
    moves: DRAG_MOVES,
    updatesDuringDrag: during.length,
    updatesPerSecond: r1(during.length / ((tEnd - t0) / 1000)),
    laddersReused: during.filter((u) => u.reused).length,
    vertices: during.at(-1)?.vertices,
    roundTripMs: stat('roundTrip'),
    workerMs: stat('worker'),
    convertMs: stat('convert'),
    buildMs: stat('build'),
    meshMs: stat('mesh'),
    settle: settled.length
      ? {
          updates: settled.length,
          lastWorkerMs: settled.at(-1).worker,
          lastCurvatureMs: settled.at(-1).curvature,
          lastRoundTripMs: settled.at(-1).roundTrip,
          laddersReused: settled.at(-1).reused,
        }
      : null,
    series: process.env.NURBS_SERIES
      ? during.map((u) => [u.convert, u.build, u.mesh, u.worker, u.roundTrip])
      : undefined,
    errors,
  };
  console.log(JSON.stringify(res));
  await context.close();
  return res;
}

const server = spawn(process.execPath, [join(HERE, '..', 'serve-dist.mjs'), String(PORT)], {
  stdio: 'ignore',
});
const result = {};
try {
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  });
  try {
    if (!SKIP.has('open')) result.open = await measureOpen(browser);
    if (!SKIP.has('switch')) result.switch = await measureSwitch(browser);
    if (!SKIP.has('drag')) result.drag = await measureDrag(browser);
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
