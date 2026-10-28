// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M1 step 1 acceptance (docs/design/m1-model.md §6): the section-based surface on the
 * swallow, fish, asymmetric and analytic boards.
 *
 * 1. the u = 0 and u = 1 lines lie on the rocker, deck and outline within 1e-9, notch zone included;
 * 2. at each station the evaluated section is within the fit tolerance (0.05 cm) of the stored one;
 * 3. the analytic board matches its closed form;
 * 4. first and second derivatives agree with finite differences;
 * 5. across every interior station the normal jump is < 1e-5 rad and the curvature jump < 1 %.
 */
import { describe, expect, it } from 'vitest';
import { SECTION_FIT_TOL } from './params';
import { buildBoard, createEvaluator, MEASURE } from './surface';
import type { BuiltBoard, SurfaceEvaluator } from './surface';
import {
  analyticBoard,
  analyticFacts,
  asymmetricBoard,
  chainZ,
  distanceToChain,
  distanceToPolyline,
  fishBoard,
  sampleChain,
  swallowBoard,
} from './testing';
import type { BoardDoc } from './types';

const BOARDS: readonly [string, () => BoardDoc][] = [
  ['analytic', analyticBoard],
  ['swallow', swallowBoard],
  ['fish', fishBoard],
  ['asymmetric', asymmetricBoard],
];

function built(doc: BoardDoc): { board: BuiltBoard; ev: SurfaceEvaluator } {
  const r = buildBoard(doc);
  if (!r.ok) throw new Error(`build failed: ${r.issues.map((i) => i.message).join('; ')}`);
  return { board: r.value, ev: createEvaluator(r.value) };
}

const S = new Float64Array(18);
const sides = [0, 1] as const;
const noFeatures = (d: BoardDoc): BoardDoc => ({ ...d, features: [] });

/** `n` ξ values over the station range, ends included. */
const xiGrid = (b: BuiltBoard, n: number): number[] =>
  Array.from({ length: n + 1 }, (_, i) => b.xiMin + ((b.xiMax - b.xiMin) * i) / n);

describe.each(BOARDS)('%s board: the lines', (_name, make) => {
  const doc = make();
  const { board, ev } = built(doc);

  it('the bottom and deck centre lines lie on the rocker and deck, the same from both sides', () => {
    for (const xi of xiGrid(board, 120)) {
      const zr = chainZ(doc.rocker, xi);
      const zd = chainZ(doc.deck, xi);
      // features move the bottom only (the stringer line is the rocker plus the depth at u = 0)
      const bottoms: number[][] = [];
      for (const side of sides) {
        ev.at(side, xi, 0, 0, S);
        expect(S[0]).toBeCloseTo(xi, 12);
        expect(Math.abs(S[1]!)).toBeLessThan(1e-12);
        bottoms.push([S[0]!, S[1]!, S[2]!]);
        ev.at(side, xi, 1, 0, S);
        expect(S[0]).toBeCloseTo(xi, 12);
        expect(Math.abs(S[1]!)).toBeLessThan(1e-12);
        expect(Math.abs(S[2]! - zd)).toBeLessThan(1e-9);
      }
      // the seam is bitwise shared
      expect(bottoms[0]).toEqual(bottoms[1]);
      if (doc.features.length === 0) expect(Math.abs(bottoms[0]![2]! - zr)).toBeLessThan(1e-9);
    }
  });

  it('the apex line lies on the outline, the notch zone included', () => {
    for (const side of sides) {
      const outline = side === 1 && doc.outline.minus ? doc.outline.minus : doc.outline.plus;
      for (const xi of xiGrid(board, 160)) {
        ev.at(side, xi, 0.5, 0, S);
        const y = side === 1 ? -S[1]! : S[1]!;
        expect(distanceToChain(outline, S[0]!, y)).toBeLessThan(1e-9);
      }
    }
  });

  it('the rocker line is the stringer line when no feature acts', () => {
    const d = noFeatures(doc);
    const b = built(d);
    for (const xi of xiGrid(b.board, 60)) {
      b.ev.at(0, xi, 0, 0, S);
      expect(Math.abs(S[2]! - chainZ(d.rocker, xi))).toBeLessThan(1e-9);
    }
  });
});

describe.each(BOARDS)('%s board: stations', (_name, make) => {
  const doc = noFeatures(make());
  const { board, ev } = built(doc);

  it('the evaluated section is within the fit tolerance (0.05 cm) of the stored one at every station', () => {
    for (const st of doc.stations) {
      for (const side of sides) {
        const sec = side === 1 && st.minus ? st.minus : st.plus;
        ev.row(side, st.x, 0);
        ev.eval(0.5, 0, S);
        // the chord of this row: from the stringer to the apex point
        const a = S[0]! - st.x;
        const b = Math.abs(S[1]!);
        const stored = sampleChain(sec.chain, 100).map(([u, v]) => {
          const X = st.x + u * a;
          return [
            X,
            (side === 1 ? -1 : 1) * u * b,
            chainZ(doc.rocker, X) + v * (chainZ(doc.deck, X) - chainZ(doc.rocker, X)),
          ];
        });
        let worst = 0;
        for (let i = 0; i <= 200; i++) {
          ev.eval(i / 200, 0, S);
          worst = Math.max(worst, distanceToPolyline(stored, [S[0]!, S[1]!, S[2]!]));
        }
        expect(worst, `station ${st.id} side ${side}`).toBeLessThan(SECTION_FIT_TOL);
      }
    }
    expect(board.report.stationFitError).toBeLessThanOrEqual(SECTION_FIT_TOL);
  });
});

describe('analytic board: the closed form', () => {
  const { board, ev } = built(analyticBoard());

  it('x, the plan outline, the rocker and the thickness are exact; the section is within 0.05 cm', () => {
    const f = analyticFacts;
    for (let i = 3; i < 100; i += 8) {
      const xi = i;
      const w = f.halfWidth(xi);
      const R = f.rocker(xi);
      const T = f.thickness(xi);
      ev.row(0, xi, 0);
      ev.eval(0.5, 0, S);
      expect(Math.abs(S[0]! - xi)).toBeLessThan(1e-12);
      expect(Math.abs(S[1]! - w)).toBeLessThan(1e-9);
      // every point maps back to a (u, v) on the stored section; compare in cm
      const stored = sampleChain(f.section.chain, 100).map(([u, v]) => [xi, u * w, R + T * v]);
      for (let j = 0; j <= 200; j++) {
        ev.eval(j / 200, 0, S);
        expect(Math.abs(S[0]! - xi)).toBeLessThan(1e-12);
        expect(distanceToPolyline(stored, [S[0]!, S[1]!, S[2]!])).toBeLessThan(0.01);
      }
    }
    expect(board.xiMin).toBe(0);
    expect(board.xiMax).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Derivatives
// ---------------------------------------------------------------------------

/**
 * Points to test, away from every place where a derivative may jump: the outline, rocker
 * and deck knots and the feature keys (in ξ), the fit's knots and the apex (in t).
 */
function testPoints(board: BuiltBoard): [0 | 1, number, number][] {
  const out: [0 | 1, number, number][] = [];
  const ts = [0.037, 0.113, 0.241, 0.333, 0.397, 0.452, 0.538, 0.611, 0.719, 0.83, 0.923, 0.971];
  const span = board.xiMax - board.xiMin;
  const margin = 2e-3;
  const doc = board.doc;
  const kinks = [
    ...[doc.outline.plus, doc.outline.minus, doc.rocker, doc.deck].flatMap((c) =>
      c ? c.knots.map((k) => k.p[0]) : [],
    ),
    ...doc.features.flatMap((f) => f.depth.keys.map((k) => k.s)),
    board.sides[0].frame.notch?.xiEnd ?? Number.NaN,
  ];
  for (const side of sides) {
    const knots = board.sides[side].blend.knots;
    for (let i = 0; i < 14; i++) {
      const xi = board.xiMin + span * (0.04 + (0.92 * (i + 0.37 * side + 0.21)) / 14);
      if (kinks.some((k) => Math.abs(k - xi) < margin)) continue;
      for (const t of ts) {
        if (Array.from(knots).some((k) => Math.abs(k - t) < margin)) continue;
        out.push([side, xi, t]);
      }
    }
  }
  return out;
}

describe.each(BOARDS)('%s board: derivatives agree with finite differences', (_name, make) => {
  const { board, ev } = built(make());
  const a = new Float64Array(18);

  /** Five-point derivative (error O(h⁴)) of slot `slot` at the given order along (dxi, dt), step `h`. */
  const fd = (
    side: 0 | 1,
    xi: number,
    t: number,
    dxi: number,
    dt: number,
    order: 0 | 1,
    slot: number,
    h: number,
  ): number[] =>
    [0, 1, 2].map((k) => {
      const f = (m: number): number => {
        ev.at(side, xi + m * h * dxi, t + m * h * dt, order, a);
        return a[slot + k]!;
      };
      return (8 * (f(1) - f(-1)) - (f(2) - f(-2))) / (12 * h);
    });

  it('S_ξ and S_t from S; S_ξξ, S_ξt (both ways) and S_tt from the first derivatives', () => {
    const h = 2e-4;
    let worst1 = 0;
    let worst2 = 0;
    let checked = 0;
    let skipped = 0;
    const mag = (v: Float64Array, o: number): number =>
      Math.max(1, Math.abs(v[o]!), Math.abs(v[o + 1]!), Math.abs(v[o + 2]!));
    for (const [side, xi, t] of testPoints(board)) {
      ev.at(side, xi, t, 2, S);
      // [direction in ξ, in t, differenced order, slot read, slot compared, first order?]
      const checks: [number, number, 0 | 1, number, number][] = [
        [1, 0, 0, 0, 3],
        [0, 1, 0, 0, 6],
        [1, 0, 1, 3, 9], // S_ξξ from S_ξ
        [1, 0, 1, 6, 12], // S_ξt from S_t, differenced in ξ
        [0, 1, 1, 3, 12], // S_ξt from S_ξ, differenced in t
        [0, 1, 1, 6, 15], // S_tt from S_t
      ];
      for (const [dxi, dt, order, from, slot] of checks) {
        const d1 = fd(side, xi, t, dxi, dt, order, from, h);
        const d2 = fd(side, xi, t, dxi, dt, order, from, 2 * h);
        const m = mag(S, slot);
        // a place where a derivative jumps (a feature's edge, say): the two steps disagree, skip it
        if (Math.max(...d1.map((v, k) => Math.abs(v - d2[k]!))) > 1e-7 * m) {
          skipped++;
          continue;
        }
        checked++;
        const e = Math.max(...d1.map((v, k) => Math.abs(v - S[slot + k]!))) / m;
        if (slot < 9) worst1 = Math.max(worst1, e);
        else worst2 = Math.max(worst2, e);
      }
    }
    expect(checked).toBeGreaterThan(8 * skipped);
    expect(worst1).toBeLessThan(1e-7);
    expect(worst2).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// C2 across the stations
// ---------------------------------------------------------------------------

describe.each(BOARDS.slice(1))('%s board: no crease at the stations', (_name, make) => {
  const doc = make();
  const { ev } = built(doc);
  const delta = 1e-6;
  const A = new Float64Array(MEASURE.size);
  const B = new Float64Array(MEASURE.size);

  it('the normal jump is below 1e-5 rad and the curvature jump below 1 % across every interior station', () => {
    let worstAngle = 0;
    let worstCurv = 0;
    let measured = 0;
    for (const st of doc.stations.slice(1, -1)) {
      for (const side of sides) {
        for (const t of [0.07, 0.19, 0.31, 0.43, 0.57, 0.66, 0.78, 0.9]) {
          ev.row(side, st.x - delta, 2);
          ev.measure(t, A);
          ev.row(side, st.x + delta, 2);
          ev.measure(t, B);
          if (A[MEASURE.flags]! !== 0 || B[MEASURE.flags]! !== 0) continue;
          const dot = A[0]! * B[0]! + A[1]! * B[1]! + A[2]! * B[2]!;
          worstAngle = Math.max(worstAngle, Math.acos(Math.min(1, dot)));
          // against the larger principal curvature at the point (a flat spot has no relative jump)
          const scale = Math.max(Math.abs(A[MEASURE.k1]!), Math.abs(A[MEASURE.k2]!), 0.01);
          for (const k of [MEASURE.k1, MEASURE.k2, MEASURE.H]) {
            worstCurv = Math.max(worstCurv, Math.abs(A[k]! - B[k]!) / scale);
          }
          measured++;
        }
      }
    }
    expect(measured).toBeGreaterThan(20);
    expect(worstAngle).toBeLessThan(1e-5);
    expect(worstCurv).toBeLessThan(0.01);
  });
});

describe('curvature signs', () => {
  it('an analytic board is convex nearly everywhere: outward normals, k1 >= k2', () => {
    const { ev } = built(analyticBoard());
    const out = new Float64Array(MEASURE.size);
    for (const side of sides) {
      ev.row(side, 50, 2);
      ev.measure(0.5, out); // the rail apex: normal points out along +-y
      expect(out[MEASURE.ny]! * (side === 0 ? 1 : -1)).toBeGreaterThan(0.9);
      expect(out[MEASURE.k1]!).toBeGreaterThanOrEqual(out[MEASURE.k2]!);
      ev.measure(1 - 1e-3, out); // the deck: normal up
      expect(out[MEASURE.nz]!).toBeGreaterThan(0.9);
      ev.measure(1e-3, out); // the bottom: normal down
      expect(out[MEASURE.nz]!).toBeLessThan(-0.9);
    }
  });
});
