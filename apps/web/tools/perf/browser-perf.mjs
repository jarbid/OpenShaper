// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Browser performance baseline for the editor, against the production build.
 *
 * Profiles: `desktop` (1440×900, unthrottled) and `mobile` (390×844 touch,
 * 4× CPU slowdown, Slow-4G network). For each it records:
 *  - initial load of /app: FCP, DOMContentLoaded, load, editor-ready (canvas sized)
 *    and the JS bytes fetched;
 *  - a control-point drag in the outline view: input → next-frame latency per
 *    pointer move (median / p95), main-thread task time per move, React commits
 *    and components rendered per move (DOM renderer and R3F separately);
 *  - memory: JS heap after load and after repeated edits with the 3D view mounted
 *    (forced GC before each reading).
 *
 * Usage (after `pnpm build`):
 *   node tools/perf/browser-perf.mjs [--runs 3] [--json out.json]
 * Serves dist/ itself via tools/serve-dist.mjs on port 4178.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4178;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1] || 3) || 3;
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const DRAG_MOVES = 60;
const MEMORY_EDITS = 150;

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, cpu: 1, network: null, touch: false },
  mobile: {
    viewport: { width: 390, height: 844 },
    cpu: 4,
    // Lighthouse "Slow 4G": 150 ms RTT, 1.6 Mbps down, 750 kbps up.
    network: { latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 },
    touch: true,
  },
};

/**
 * Runs before any page script: a minimal React DevTools hook that counts commits
 * and the components that actually ran (PerformedWork flag) per renderer.
 */
const reactProbe = () => {
  const stats = { commits: {}, rendered: {} };
  window.__perf = { stats, reset: () => ((stats.commits = {}), (stats.rendered = {})) };
  const PERFORMED_WORK = 1;
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simpleMemo
  const walk = (fiber, id) => {
    let n = 0;
    const stack = [fiber];
    while (stack.length) {
      const f = stack.pop();
      if (!f) continue;
      if (COMPONENT_TAGS.has(f.tag) && f.flags & PERFORMED_WORK) n++;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    stats.rendered[id] = (stats.rendered[id] ?? 0) + n;
  };
  let nextId = 1;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = nextId++;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(id, root) {
      stats.commits[id] = (stats.commits[id] ?? 0) + 1;
      walk(root.current, id);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  // Input → next frame latency for pointer moves.
  const lat = [];
  window.__perf.latency = lat;
  addEventListener(
    'pointermove',
    (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => requestAnimationFrame(() => lat.push(performance.now() - t0)));
    },
    { capture: true },
  );
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
const r1 = (v) => Math.round(v * 10) / 10;

async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

async function heapMB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  return (await metrics(cdp)).JSHeapUsedSize / 1048576;
}

const nextFrames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Screen position of an outline point (board cm), for the full-pane outline view. */
async function outlineToScreen(page, x, y, length) {
  const box = await page.locator('canvas').first().boundingBox();
  const turned = await page.evaluate(
    () => getComputedStyle(document.querySelector('canvas')).transform !== 'none',
  );
  if (!turned) {
    const s = (box.width - 48) / length;
    return [
      { x: box.x + 24 + x * s, y: box.y + box.height / 2 - y * s },
      { x: box.x + 24 + x * s, y: box.y + box.height / 2 + y * s },
    ];
  }
  const s = (box.height - 48) / length;
  const sy = box.y + box.height - 24 - x * s;
  return [
    { x: box.x + box.width / 2 + y * s, y: sy },
    { x: box.x + box.width / 2 - y * s, y: sy },
  ];
}

async function pointer(page, cdp, touch, type, p) {
  if (!touch) {
    if (type === 'down') {
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
    } else if (type === 'move') await page.mouse.move(p.x, p.y);
    else await page.mouse.up();
    return;
  }
  const map = { down: 'touchStart', move: 'touchMove', up: 'touchEnd' };
  await cdp.send('Input.dispatchTouchEvent', {
    type: map[type],
    touchPoints: type === 'up' ? [] : [{ x: p.x, y: p.y }],
  });
}

async function runProfile(browser, name, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    hasTouch: profile.touch,
    isMobile: profile.touch,
    deviceScaleFactor: profile.touch ? 3 : 1,
    serviceWorkers: 'block',
  });
  await context.addInitScript(reactProbe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  if (profile.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  }

  // --- initial load ------------------------------------------------------------
  const t0 = Date.now();
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.locator('canvas').first().waitFor();
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    return !!c && c.getBoundingClientRect().height > 0;
  });
  const ready = Date.now() - t0;
  const load = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const js = performance
      .getEntriesByType('resource')
      .filter((r) => r.name.endsWith('.js'))
      .reduce((a, r) => a + (r.encodedBodySize || r.transferSize || 0), 0);
    return {
      fcp: fcp?.startTime ?? NaN,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      jsKB: js / 1024,
    };
  });
  const reject = page.getByRole('button', { name: 'Reject' });
  if (await reject.isVisible().catch(() => false)) await reject.click();

  // --- drag latency in the outline view -----------------------------------------
  await page.keyboard.press('2');
  await nextFrames(page);
  await page.waitForTimeout(300);
  // The shortboard's wide-point knot (sample-board.brd outline knot 2).
  const candidates = await outlineToScreen(page, 90.13362308681752, 23.49499750470692, 187.96);
  let start = null;
  for (const c of candidates) {
    await pointer(page, cdp, profile.touch, 'down', c);
    await pointer(page, cdp, profile.touch, 'up', c);
    await nextFrames(page);
    if (
      await page
        .getByLabel(/ position editor$/)
        .isVisible()
        .catch(() => false)
    ) {
      start = c;
      break;
    }
  }
  let drag = null;
  if (start) {
    await pointer(page, cdp, profile.touch, 'down', start);
    await nextFrames(page);
    await page.evaluate(() => {
      window.__perf.reset();
      window.__perf.latency.length = 0;
    });
    const before = await metrics(cdp);
    for (let i = 1; i <= DRAG_MOVES; i++) {
      await pointer(page, cdp, profile.touch, 'move', {
        x: start.x + i * 0.5,
        y: start.y - i * 0.3,
      });
      await nextFrames(page);
    }
    const after = await metrics(cdp);
    await pointer(page, cdp, profile.touch, 'up', start);
    const probe = await page.evaluate(() => ({
      lat: window.__perf.latency.slice(),
      commits: window.__perf.stats.commits,
      rendered: window.__perf.stats.rendered,
    }));
    drag = {
      latencyMedianMs: r1(median(probe.lat)),
      latencyP95Ms: r1(pct(probe.lat, 0.95)),
      // Throttled CPU time is reported in real time, so it includes the slowdown.
      taskMsPerMove: r1(((after.TaskDuration - before.TaskDuration) * 1000) / DRAG_MOVES),
      scriptMsPerMove: r1(((after.ScriptDuration - before.ScriptDuration) * 1000) / DRAG_MOVES),
      commitsPerMove: Object.fromEntries(
        Object.entries(probe.commits).map(([k, v]) => [`renderer${k}`, r1(v / DRAG_MOVES)]),
      ),
      componentsRenderedPerMove: Object.fromEntries(
        Object.entries(probe.rendered).map(([k, v]) => [`renderer${k}`, r1(v / DRAG_MOVES)]),
      ),
    };
  }

  // --- memory after repeated edits with the 3D view mounted ------------------------
  // Quad (desktop) / split (phone) keep the 3D view mounted, so every undo/redo
  // re-tessellates and swaps the hull geometry.
  await page.keyboard.press(profile.touch ? '6' : '1');
  await page.waitForTimeout(1500);
  const heapBefore = await heapMB(cdp);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  for (let i = 0; i < MEMORY_EDITS; i++) {
    await page.keyboard.press(i % 2 === 0 ? `${mod}+z` : `${mod}+Shift+z`);
    if (i % 10 === 9) await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1500);
  const heapAfter = await heapMB(cdp);
  const dom = (await metrics(cdp)).Nodes;

  await context.close();
  return {
    profile: name,
    load: {
      fcpMs: r1(load.fcp),
      domContentLoadedMs: r1(load.dcl),
      loadMs: r1(load.load),
      editorReadyMs: ready,
      jsKB: r1(load.jsKB),
    },
    drag,
    memory: {
      heapAfterLoadMB: r1(heapBefore),
      heapAfterEditsMB: r1(heapAfter),
      edits: MEMORY_EDITS,
      domNodes: dom,
    },
  };
}

const server = spawn(process.execPath, [join(HERE, '..', 'serve-dist.mjs'), String(PORT)], {
  stdio: 'ignore',
});
try {
  await new Promise((r) => setTimeout(r, 800));
  // PW_CHROMIUM lets a sandbox with a pinned browser build point at it.
  const browser = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  );
  const results = [];
  for (const [name, profile] of Object.entries(PROFILES)) {
    for (let run = 0; run < RUNS; run++) {
      const r = await runProfile(browser, name, profile);
      results.push({ run, ...r });
      console.log(JSON.stringify({ run, ...r }));
    }
  }
  await browser.close();
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
} finally {
  server.kill();
}
