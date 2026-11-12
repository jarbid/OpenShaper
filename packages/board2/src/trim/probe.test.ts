// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails engine's section probe (`probe.ts`) on the made boards, converted and built: the
 * point count and framing, the middle point on the wall, d rising along the bottom and falling
 * along the deck, the half width equal to the outline's, and the section and the apex against
 * the kernel mesh's own slice and apex away from the tips.
 */
import { describe, expect, it } from 'vitest';
import { compileChain, funcEval } from '../chain';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import { convertSections } from './convert';
import { buildRails } from './native';
import type { BuiltRails } from './native';
import { halfWidthOf } from './outline';
import { apexRails, halfWidthRails, probeRails } from './probe';
import { buildTrimMesh, sliceX } from './solid';
import type { TrimMesh } from './solid';
import { gap, halfOfSlice } from './test-support/measure';
import { TRIM } from '../params';

const BOARDS: { readonly [name: string]: () => BoardDoc } = {
  analytic: analyticBoard,
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
};

/** Rows across the blends: twice the display mesh's, so its facets are not what is measured. */
const ROWS = { deckRows: 28, tuckRows: 20 } as const;
/** Stations a side, and how far (cm) from either end, a corner or a notch they stay. */
const STATIONS = 10;
const TIP_REACH = 3;
const SAMPLES = 401;

function builtOf(doc: BoardDoc): BuiltRails {
  const c = convertSections({ ...doc, features: [] });
  if (!c.ok) throw new Error(c.issues.map((i) => i.message).join('; '));
  const r = buildRails(c.value.board);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

/** The stations away from the tips: not within TIP_REACH of an end or a corner, nor aft of the crotch's reach. */
function stationsOf(b: BuiltRails): number[] {
  const crotch = b.board.outline.plus.knots[0]!.p[0];
  const lo = Math.max(b.xiMin + TIP_REACH, crotch > 0 ? crotch + TIP_REACH : -Infinity);
  const hi = b.xiMax - TIP_REACH;
  const corners: number[] = [];
  for (let i = 0; i < b.loop.n; i++) if (b.loop.corner[i] !== 0) corners.push(b.loop.x[i]!);
  const ok: number[] = [];
  for (let x = lo; x <= hi; x += 0.25) {
    if (!corners.some((c) => Math.abs(c - x) < TIP_REACH)) ok.push(x);
  }
  return Array.from(
    { length: STATIONS },
    (_, k) => ok[Math.floor(((k + 0.5) * ok.length) / STATIONS)]!,
  );
}

/** The loop's apex height and y at x on a side, from the two samples that bracket x. */
function meshApex(mesh: TrimMesh, side: 0 | 1, x: number): { y: number; z: number } {
  const { loop } = mesh;
  for (let i = 0; i < loop.n; i++) {
    const k = (i + 1) % loop.n;
    if (loop.y[i]! * (side === 0 ? 1 : -1) <= 0 || loop.y[k]! * (side === 0 ? 1 : -1) <= 0)
      continue;
    const a = loop.x[i]! - x;
    const c = loop.x[k]! - x;
    if (a > 0 === c > 0) continue;
    const f = a / (a - c);
    return {
      y: loop.y[i]! + f * (loop.y[k]! - loop.y[i]!),
      z: mesh.apex[i]! + f * (mesh.apex[k]! - mesh.apex[i]!),
    };
  }
  throw new Error(`no loop sample brackets x = ${x}`);
}

/**
 * The bound, cm, on the probe's gap to the kernel's slice and on the apex's difference. The
 * probe is first-order: it builds each blend in the plane x = const, and the kernel sweeps it
 * square to the outline. Along the middle of a board, where the outline runs at under 10
 * degrees to the stringer, the two agree to 0.02 cm (0.2 mm); the worst figures are at the
 * stations nearest a tail or nose curve, where the outline is at 15 to 35 degrees (slope 0.26
 * to 0.70 at the fish's x = 16.75 and the asymmetric board's x = 11.75) and a plane cuts the
 * sweep obliquely: 0.088 cm on the section and 0.063 cm on the apex there. The bound sits just
 * above those.
 */
const BOUND = 0.1;

describe.each(Object.keys(BOARDS))('probeRails: %s', (name) => {
  const doc = BOARDS[name]!();
  const built = builtOf(doc);
  // a mirror board's minus side is the plus side's mirror image; it is probed too
  const sides: (0 | 1)[] = [0, 1];
  const rocker = compileChain(built.board.rocker);

  it('returns the points asked for, the middle one on the wall, d rising then falling', () => {
    for (const side of sides) {
      const x = stationsOf(built)[4]!;
      const wall = apexRails(built, side, x);
      expect(Math.abs(wall.y)).toBeCloseTo(built.halfWidth[side](x), 12);
      for (const n of [3, 21, 51]) {
        const p = probeRails(built, side, x, n);
        expect(p.length).toBe(2 * n);
        expect(p.every(Number.isFinite)).toBe(true);
        const m = (n - 1) / 2;
        expect(p[0]).toBeCloseTo(0, 9);
        expect(p[2 * m]).toBeCloseTo(Math.abs(wall.y), 9);
        expect(p[2 * n - 2]).toBeCloseTo(0, 9);
        for (let i = 1; i <= m; i++) expect(p[2 * i]!).toBeGreaterThan(p[2 * i - 2]!);
        for (let i = m + 1; i < n; i++) expect(p[2 * i]!).toBeLessThan(p[2 * i - 2]!);
        // heights are above the rocker at x
        const r = new Float64Array(3);
        funcEval(rocker, x, r, 0);
        expect(p[2 * m + 1]! + r[0]!).toBeCloseTo(wall.z, 9);
        expect(p[1]!).toBeLessThan(p[2 * n - 1]!);
      }
    }
  });

  it('has the outline half width', () => {
    const w = halfWidthRails(built.board);
    const ref = halfWidthOf(built.board.outline);
    for (let x = 0; x <= built.xiMax; x += 2.5) expect(w(x)).toBe(ref(x));
    if (built.board.outline.minus !== undefined) {
      const m = halfWidthRails(built.board, 'minus');
      const refm = halfWidthOf(built.board.outline, 'minus');
      for (let x = 0; x <= built.xiMax; x += 2.5) expect(m(x)).toBe(refm(x));
    }
  });

  it('stands within the bound of the kernel mesh away from the tips', () => {
    const mesh = buildTrimMesh(built.loop, built.laws, built.panels, TRIM.viewGrid, ROWS);
    const xs = stationsOf(built);
    let wSection = 0;
    let wApex = 0;
    for (const x of xs) {
      const slice = sliceX(mesh, mesh.panels, x);
      for (const side of sides) {
        const sign = side === 0 ? 1 : -1;
        const p = probeRails(built, side, x, SAMPLES);
        const r = new Float64Array(3);
        funcEval(rocker, x, r, 0);
        const section = new Float64Array(p.length);
        for (let i = 0; i < p.length; i += 2) {
          section[i] = sign * p[i]!;
          section[i + 1] = p[i + 1]! + r[0]!;
        }
        const g = gap(halfOfSlice(slice, side), section);
        wSection = Math.max(wSection, g.max);
        const a = apexRails(built, side, x);
        const m = meshApex(mesh, side, x);
        wApex = Math.max(wApex, Math.hypot(a.y - m.y, a.z - m.z));
      }
    }
    expect(wSection).toBeLessThan(BOUND);
    expect(wApex).toBeLessThan(BOUND);
  });
});
