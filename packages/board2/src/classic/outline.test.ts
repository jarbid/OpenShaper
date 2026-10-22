// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Outline corners and fillets (docs/design/board2.md §9.3, S6 as built).
 *
 * Oracles, all independent of the fillet solvers:
 * - **Straight neighbours** (the synthetic files' polygonal outlines): the arc
 *   is tangent to both lines (centre at distance r from each line, tangent
 *   points on them), and the corner's distance to the arc is exactly
 *   `r (1/sin(θ/2) − 1)`, θ the interior angle of the two lines; at a tip the
 *   centre lies on the stringer and the tip retreats by the same formula.
 *   Tolerance 1e-12 × the board's length (a few dozen flops on 200 cm values).
 * - **Curved neighbours**: the arc meets each curve at a point where the
 *   radius is perpendicular to the curve's tangent and |P − c| = r (tangency,
 *   1e-9 relative: the solvers stop at `paramRel` in the parameter, times the
 *   curve's speed), and it stays off the curve (dense samples no closer to
 *   the centre than r, within the same tolerance).
 * - **The flat nose** of the shortboard: one arc through the tip centre
 *   (L, 0), centred on the stringer, tangent to the neighbouring segment.
 * - **Pieces** join within 1e-12 × scale with matching tangents (1e-9 rad), and
 *   every sample lies on its exact piece, about `lineSampleSpacing` apart.
 */
import { describe, expect, it } from 'vitest';
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import type { Spline } from '@openshaper/kernel';
import { cubicPoint, filletLine, filletOutline, piecePoint, samplePiece } from './outline';
import type { FilletedOutline, OutlinePiece } from './outline';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import { classicSample } from './test-support/samples';

type V2 = readonly [number, number];

/** Unit tangent of a piece at local t (central difference on the exact piece: an oracle, not the solver). */
function tangent(p: OutlinePiece, t: number): V2 {
  if (p.kind === 'arc') {
    const a = p.a0 + p.sweep * t;
    const s = Math.sign(p.sweep);
    return [-Math.sin(a) * s, Math.cos(a) * s];
  }
  const c = p.c;
  const u = p.t0 + (p.t1 - p.t0) * t;
  const [p0, p1, p2, p3] = c.p;
  const r = 1 - u;
  const d: V2 = [
    3 * r * r * (p1[0] - p0[0]) + 6 * r * u * (p2[0] - p1[0]) + 3 * u * u * (p3[0] - p2[0]),
    3 * r * r * (p1[1] - p0[1]) + 6 * r * u * (p2[1] - p1[1]) + 3 * u * u * (p3[1] - p2[1]),
  ];
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l];
}

function checkJoins(f: FilletedOutline, scale: number): void {
  for (let i = 0; i + 1 < f.pieces.length; i++) {
    const a = f.pieces[i]!;
    const b = f.pieces[i + 1]!;
    const pa = piecePoint(a, 1);
    const pb = piecePoint(b, 0);
    expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]), `join ${i}`).toBeLessThanOrEqual(
      1e-12 * scale,
    );
    // Only fillet joins are promised G1 (a smooth classic knot is the classic's own business).
    if (a.kind === 'arc' || b.kind === 'arc') {
      const ta = tangent(a, 1);
      const tb = tangent(b, 0);
      expect(
        Math.abs(Math.atan2(ta[0] * tb[1] - ta[1] * tb[0], ta[0] * tb[0] + ta[1] * tb[1])),
        `G1 at ${i}`,
      ).toBeLessThanOrEqual(1e-9);
    }
  }
}

describe('straight neighbours (polygonal synthetic outline)', () => {
  const board = classicSample('synthetic-clean-6x22x2-75.s3dx').load();
  const f = filletOutline(board.outline, O);
  const L = 182.88;
  const W = 27.94;

  it('fillets both tips and the side corner, radius cornerFilletRadius', () => {
    expect(f.fillets.map((x) => [x.x, x.y, x.tip])).toEqual([
      [0, 0, true],
      [91.44, W, false],
      [L, 0, true],
    ]);
    for (const x of f.fillets) expect(x.radius).toBe(O.cornerFilletRadius);
  });

  it('arcs are tangent to the lines; the corner deviation is r(1/sin(θ/2) − 1)', () => {
    const lines: [V2, V2][] = [
      [
        [0, 0],
        [91.44, W],
      ],
      [
        [91.44, W],
        [L, 0],
      ],
    ];
    const distToLine = (p: V2, [a, b]: [V2, V2]): number =>
      Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) /
      Math.hypot(b[0] - a[0], b[1] - a[1]);
    const theta = (a: V2, k: V2, b: V2): number => {
      const u: V2 = [a[0] - k[0], a[1] - k[1]];
      const v: V2 = [b[0] - k[0], b[1] - k[1]];
      return Math.acos((u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v));
    };
    const corners: { k: V2; theta: number; lines: [V2, V2][] }[] = [
      { k: [0, 0], theta: 2 * Math.atan2(W, 91.44), lines: [lines[0]!] },
      { k: [91.44, W], theta: theta([0, 0], [91.44, W], [L, 0]), lines },
      { k: [L, 0], theta: 2 * Math.atan2(W, L - 91.44), lines: [lines[1]!] },
    ];
    f.arcs.forEach(({ piece, fillet }, i) => {
      const arc = f.pieces[piece]! as Extract<OutlinePiece, { kind: 'arc' }>;
      const c: V2 = [arc.cx, arc.cy];
      const { k, theta: th, lines: ls } = corners[i]!;
      for (const l of ls) expect(Math.abs(distToLine(c, l) - arc.r)).toBeLessThanOrEqual(1e-12 * L);
      // Both arc ends lie on a line or the stringer.
      for (const t of [0, 1]) {
        const p = piecePoint(arc, t);
        const off = Math.min(...ls.map((l) => distToLine(p, l)), Math.abs(p[1]));
        expect(off).toBeLessThanOrEqual(1e-12 * L);
      }
      const predicted = arc.r * (1 / Math.sin(th / 2) - 1);
      expect(Math.abs(f.fillets[fillet]!.predictedDeviation - predicted)).toBeLessThanOrEqual(
        1e-12 * L,
      );
      expect(
        Math.abs(Math.hypot(k[0] - c[0], k[1] - c[1]) - arc.r - predicted),
      ).toBeLessThanOrEqual(1e-12 * L);
      if (f.fillets[fillet]!.tip) expect(arc.cy).toBe(0);
    });
    checkJoins(f, L);
  });

  it('samples lie on their pieces, at most lineSampleSpacing apart', () => {
    for (const p of f.pieces) {
      const s = samplePiece(p, O.lineSampleSpacing);
      for (let k = 1; k < s.length; k++) {
        const d = Math.hypot(s[k]![0] - s[k - 1]![0], s[k]![1] - s[k - 1]![1]);
        // Equal steps of a 64-chord table, each placed on the exact curve by its
        // chord from the table node: a step differs from the spacing by the chord
        // polygon's own error (measured below 1e-4 relative); 1e-3 allowed.
        expect(d).toBeLessThanOrEqual(O.lineSampleSpacing * (1 + 1e-3));
        if (p.kind === 'arc') {
          expect(Math.abs(Math.hypot(s[k]![0] - p.cx, s[k]![1] - p.cy) - p.r)).toBeLessThanOrEqual(
            1e-12 * L,
          );
        }
      }
    }
  });
});

describe('curved neighbours', () => {
  it('a smooth golden outline keeps its cubics and has no fillet', () => {
    const f = filletOutline(classicSample('golden/funboard.brd').load().outline, O);
    expect(f.fillets).toHaveLength(0);
    expect(f.pieces.every((p) => p.kind === 'bezier' && p.t0 === 0 && p.t1 === 1)).toBe(true);
  });

  it('the shortboard’s flat nose becomes one arc through the tip centre', () => {
    const board = classicSample('golden/shortboard.brd').load();
    const f = filletOutline(board.outline, O);
    const L = 187.96;
    expect(f.fillets).toHaveLength(1);
    const fl = f.fillets[0]!;
    expect([fl.x, fl.y, fl.tip]).toEqual([L, 0.5, true]);
    const arc = f.pieces.at(-1)! as Extract<OutlinePiece, { kind: 'arc' }>;
    expect(arc.kind).toBe('arc');
    expect(arc.cy).toBe(0);
    const end = piecePoint(arc, 1);
    expect(Math.abs(end[0] - L)).toBeLessThanOrEqual(1e-12 * L);
    expect(Math.abs(end[1])).toBeLessThanOrEqual(1e-12 * L);
    // Tangent to the neighbouring cubic where it meets it.
    const prev = f.pieces.at(-2)!;
    const p = piecePoint(prev, 1);
    const t = tangent(prev, 1);
    expect(Math.abs(Math.hypot(p[0] - arc.cx, p[1]) - arc.r)).toBeLessThanOrEqual(1e-9 * arc.r);
    expect(Math.abs((p[0] - arc.cx) * t[0] + p[1] * t[1])).toBeLessThanOrEqual(1e-9 * arc.r);
    // The corner's distance to the arc is the reported deviation.
    expect(
      Math.abs(Math.hypot(L - arc.cx, 0.5) - arc.r - fl.predictedDeviation),
    ).toBeLessThanOrEqual(1e-12 * L);
    checkJoins(f, L);
  });

  it('an interior corner between two curves: tangent arc that stays off both curves', () => {
    // Two bulging cubics meeting at (50, 20) with a 40° turn.
    const s: Spline = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(0, 15)),
      knot(vec2(50, 20), vec2(30, 25), vec2(70, 18), false),
      knot(vec2(100, 0), vec2(100, 15), vec2(100, 0)),
    ]);
    const f = filletOutline(s, O);
    const inner = f.fillets.filter((x) => !x.tip);
    expect(inner).toHaveLength(1);
    const arc = f.pieces[f.arcs.find((a) => !f.fillets[a.fillet]!.tip)!.piece]! as Extract<
      OutlinePiece,
      { kind: 'arc' }
    >;
    const c: V2 = [arc.cx, arc.cy];
    const idx = f.pieces.indexOf(arc);
    for (const [piece, t] of [
      [f.pieces[idx - 1]!, 1],
      [f.pieces[idx + 1]!, 0],
    ] as const) {
      const p = piecePoint(piece, t);
      const tg = tangent(piece, t);
      expect(Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - arc.r)).toBeLessThanOrEqual(
        1e-9 * arc.r,
      );
      expect(Math.abs((p[0] - c[0]) * tg[0] + (p[1] - c[1]) * tg[1])).toBeLessThanOrEqual(
        1e-9 * arc.r,
      );
      // No part of the classic segment comes closer to the centre than r.
      const seg = piece as Extract<OutlinePiece, { kind: 'bezier' }>;
      for (let k = 0; k <= 4000; k++) {
        const q = cubicPoint(seg.c, k / 4000);
        expect(Math.hypot(q[0] - c[0], q[1] - c[1])).toBeGreaterThanOrEqual(arc.r * (1 - 1e-9));
      }
    }
    checkJoins(f, 100);
  });
});

describe('stringer-line corners', () => {
  it('the polygonal synthetic deck loses its vertical ends and gets one fillet at its ridge', () => {
    const board = classicSample('synthetic-clean-6x22x2-75.s3dx').load();
    const L = 182.88;
    const f = filletLine(board.deck, [O.endGap, L - O.endGap], O);
    expect(f.fillets.map((x) => [x.x, x.y, x.tip])).toEqual([[91.44, 6.985, false]]);
    const th = Math.PI - 2 * Math.atan2(6.985, 91.44);
    expect(f.fillets[0]!.predictedDeviation).toBeCloseTo(
      O.cornerFilletRadius * (1 / Math.sin(th / 2) - 1),
      12,
    );
    checkJoins(f, L);
  });
});
