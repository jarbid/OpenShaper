// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which React components render per pointer move during an outline-knot drag.
 * Run against the dev server so component names are not minified:
 *
 *   pnpm dev   # then, in another shell:
 *   BASE=http://localhost:5173 node tools/perf/who-renders.mjs
 *
 * Env: BASE (dev server URL), VIEW (view key before dragging, default '2' =
 * outline), TOP (rows to print), PW_CHROMIUM (browser binary). Counts are
 * `renderer:Component` averaged per move (renderer 1 = react-dom, 2 = R3F).
 */
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://localhost:5173';
const VIEW = process.env.VIEW ?? '2';
const b = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  const counts = {};
  window.__counts = counts;
  const name = (f) => {
    const t = f.type;
    if (!t) return null;
    if (typeof t === 'function') return t.displayName || t.name || 'anon';
    if (t.render) return t.displayName || t.render.displayName || t.render.name || 'forwardRef';
    if (t.type) return 'memo(' + (t.type.displayName || t.type.name || '') + ')';
    return null;
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) {
      this.renderers.set(++id, r);
      return id;
    },
    onCommitFiberRoot(rid, root) {
      const st = [root.current];
      while (st.length) {
        const f = st.pop();
        if (!f) continue;
        if ([0, 1, 11, 14, 15].includes(f.tag) && f.flags & 1) {
          const n = `${rid}:${name(f)}`;
          counts[n] = (counts[n] ?? 0) + 1;
        }
        if (f.child) st.push(f.child);
        if (f.sibling) st.push(f.sibling);
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
});
const p = await ctx.newPage();
await p.goto(BASE + '/app');
await p.locator('canvas').first().waitFor();
await p.waitForTimeout(3000);
const rej = p.getByRole('button', { name: 'Reject' });
if (await rej.isVisible().catch(() => false)) await rej.click();
await p.keyboard.press(VIEW);
await p.waitForTimeout(800);
const box = await p.locator('canvas').first().boundingBox();
const s = (box.width - 48) / 187.96;
let start = { x: box.x + 24 + 90.1336 * s, y: box.y + box.height / 2 - 23.495 * s };
await p.mouse.click(start.x, start.y);
await p.waitForTimeout(300);
await p.mouse.move(start.x, start.y);
await p.mouse.down();
await p.evaluate(() => {
  for (const k in window.__counts) delete window.__counts[k];
});
const N = 20;
for (let i = 1; i <= N; i++) {
  await p.mouse.move(start.x + i, start.y - i * 0.5);
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
const c = await p.evaluate(() => ({ ...window.__counts }));
await p.mouse.up();
const rows = Object.entries(c)
  .map(([k, v]) => [k, v / N])
  .sort((a, b) => b[1] - a[1]);
console.log('total per move', rows.reduce((a, r) => a + r[1], 0).toFixed(1));
for (const [k, v] of rows.slice(0, Number(process.env.TOP ?? 45)))
  console.log(v.toFixed(1).padStart(6), k);
await b.close();
