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
 *  - the same drag with the 3D view mounted: also tessellation jobs per move and
 *    how long the workers keep going after release;
 *  - memory (forced GC before each reading): JS heap and ArrayBuffer backing
 *    stores before/after that drag plus 40 separate small drags (40 undo steps).
 *
 * Usage (after `pnpm build`):
 *   node tools/perf/browser-perf.mjs [--runs 3] [--profile desktop|mobile] [--json out.json]
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
const ONLY = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : null;

const DRAG_MOVES = 60;
const HISTORY_EDITS = 40;

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
  // Count posts per worker script, to see how much work each edit queues.
  const posts = {};
  window.__perf.workerPosts = posts;
  const lastReply = {};
  window.__perf.lastReply = lastReply;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, opts) {
      super(url, opts);
      const name = String(url).split('/').pop().split('-')[0].split('.')[0];
      this.addEventListener('message', () => (lastReply[name] = performance.now()));
      const post = this.postMessage.bind(this);
      this.postMessage = (...a) => {
        posts[name] = (posts[name] ?? 0) + 1;
        return post(...a);
      };
    }
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

/** ArrayBuffer backing stores (typed arrays, meshes) — not part of the JS heap. */
async function backingMB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const u = await cdp.send('Runtime.getHeapUsage');
  return (u.backingStorageSize ?? NaN) / 1048576;
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

/**
 * Select the shortboard's wide-point knot (sample-board.brd outline knot 2) in the
 * first canvas — the outline pane — then drag it DRAG_MOVES steps, measuring each
 * move. Returns null if the knot could not be selected.
 */
async function dragWideKnot(page, cdp, profile) {
  const candidates = await outlineToScreen(page, 90.13362308681752, 23.49499750470692, 187.96);
  let start = null;
  for (const c of candidates) {
    await pointer(page, cdp, profile.touch, 'down', c);
    await pointer(page, cdp, profile.touch, 'up', c);
    await nextFrames(page);
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
  if (!start) return null;
  await pointer(page, cdp, profile.touch, 'down', start);
  await nextFrames(page);
  await page.evaluate(() => {
    window.__perf.reset();
    window.__perf.latency.length = 0;
    for (const k of Object.keys(window.__perf.workerPosts)) delete window.__perf.workerPosts[k];
  });
  const before = await metrics(cdp);
  for (let i = 1; i <= DRAG_MOVES; i++) {
    await pointer(page, cdp, profile.touch, 'move', { x: start.x + i * 0.5, y: start.y - i * 0.3 });
    await nextFrames(page);
  }
  const after = await metrics(cdp);
  await pointer(page, cdp, profile.touch, 'up', start);
  const releasedAt = await page.evaluate(() => performance.now());
  // Settled = no worker reply for 1 s; report when the last one arrived.
  let settleMs = 0;
  for (let quiet = 0; quiet < 1000; ) {
    const last = await page.evaluate(() => Math.max(0, ...Object.values(window.__perf.lastReply)));
    await page.waitForTimeout(100);
    const now = await page.evaluate(() => Math.max(0, ...Object.values(window.__perf.lastReply)));
    quiet = now === last ? quiet + 100 : 0;
    settleMs = Math.max(0, now - releasedAt);
  }
  const probe = await page.evaluate(() => ({
    lat: window.__perf.latency.slice(),
    commits: window.__perf.stats.commits,
    rendered: window.__perf.stats.rendered,
    posts: { ...window.__perf.workerPosts },
  }));
  const perMove = (o) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r1(v / DRAG_MOVES)]));
  return {
    latencyMedianMs: r1(median(probe.lat)),
    latencyP95Ms: r1(pct(probe.lat, 0.95)),
    // Throttled CPU time is reported in real time, so it includes the slowdown.
    taskMsPerMove: r1(((after.TaskDuration - before.TaskDuration) * 1000) / DRAG_MOVES),
    scriptMsPerMove: r1(((after.ScriptDuration - before.ScriptDuration) * 1000) / DRAG_MOVES),
    commitsPerMove: perMove(
      Object.fromEntries(Object.entries(probe.commits).map(([k, v]) => [`renderer${k}`, v])),
    ),
    componentsRenderedPerMove: perMove(
      Object.fromEntries(Object.entries(probe.rendered).map(([k, v]) => [`renderer${k}`, v])),
    ),
    workerPostsPerMove: perMove(probe.posts),
    workersSettledAfterReleaseMs: Math.round(settleMs),
    start,
  };
}

/** Short grab-and-drag of the knot at `from` by (dx, dy) px: one undo step. */
async function nudge(page, cdp, touch, from, dx, dy, steps = 5) {
  await pointer(page, cdp, touch, 'down', from);
  for (let i = 1; i <= steps; i++) {
    await pointer(page, cdp, touch, 'move', {
      x: from.x + (dx * i) / steps,
      y: from.y + (dy * i) / steps,
    });
    await nextFrames(page);
  }
  await pointer(page, cdp, touch, 'up', { x: from.x + dx, y: from.y + dy });
  await nextFrames(page);
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
  const drag = await dragWideKnot(page, cdp, profile);

  // --- the same drag with the 3D view mounted, then memory ----------------------
  // Quad (desktop) / split (phone) keep the 3D view mounted, so every drag move
  // makes a new board for the tessellation worker. Undo the outline drag first so
  // the knot is back where dragWideKnot looks for it.
  // The drag leaves focus in the point's position editor, where a key would be
  // typed rather than act as a shortcut.
  await page.evaluate(() => document.activeElement?.blur());
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(profile.touch ? '6' : '1');
  await page.waitForTimeout(1500);
  if (process.env.PERF_SHOT)
    await page.screenshot({ path: `${process.env.PERF_SHOT}-${name}.png` });
  const heapBefore = await heapMB(cdp);
  const buffersBefore = await backingMB(cdp);
  const drag3d = await dragWideKnot(page, cdp, profile);

  // Many separate edits, each its own undo step holding a distinct board: short
  // drags of the same knot, back and forth. What the history pins shows up here.
  if (drag3d) {
    const end = { x: drag3d.start.x + DRAG_MOVES * 0.5, y: drag3d.start.y - DRAG_MOVES * 0.3 };
    for (let i = 0; i < HISTORY_EDITS; i++) {
      const back = i % 2 === 0;
      await nudge(page, cdp, profile.touch, end, back ? -6 : 6, 0);
      if (back) end.x -= 6;
      else end.x += 6;
    }
    delete drag3d.start;
  }
  if (drag) delete drag.start;
  await page.waitForTimeout(2500);
  const heapAfter = await heapMB(cdp);
  const buffersAfter = await backingMB(cdp);
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
    drag3d,
    memory: {
      heapBeforeMB: r1(heapBefore),
      heapAfterMB: r1(heapAfter),
      arrayBuffersBeforeMB: r1(buffersBefore),
      arrayBuffersAfterMB: r1(buffersAfter),
      edits: `3D drag + ${HISTORY_EDITS} separate drags`,
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
    if (ONLY && name !== ONLY) continue;
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
