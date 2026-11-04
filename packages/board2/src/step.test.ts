// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The STEP solid (docs/design/m3-exports.md, step 2) on seven boards: the three goldens, a swallow, a fish,
 * an asymmetric board and a swallow with every kind of bottom feature. Each solid passes geom's `checkBrep`
 * and its surfaces are within 0.5 mm of the evaluator at an independent dense grid (offsets the fit never
 * sampled); the sides share their stringer exactly; the file starts with the Part 21 header.
 */
import {
  checkBrep,
  surfaceDerivatives,
  surfacePoint,
  surfaceEvalGridInto,
  createScratch,
} from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { STEP_TOLERANCE } from './params';
import { boardSolid, boardStep, StepFitError } from './step';
import type { BoardSolid } from './step';
import { createEvaluator } from './surface';
import type { BuiltBoard } from './surface';
import { asymmetricBoard, swallowBoard } from './testing';
import { boardSet, buildOrThrow, convertOrThrow } from './test-support/board-set';
import { SAMPLES } from './test-support/classic-samples';
import type { BoardDoc } from './types';

/** The swallow with the asymmetric board's channels added: vee, double concave and channels in one. */
const everyFeature = (): BoardDoc => {
  const swallow = swallowBoard();
  const channels = asymmetricBoard().features.filter((f) => f.kind === 'channels');
  return { ...swallow, features: [...swallow.features, ...channels] };
};

/** The swallow made asymmetric: the minus sections' apex raised by `dv` (the review's R2 case at 0.06). */
const asymmetricSwallow = (dv: number): BoardDoc => {
  const d = swallowBoard();
  const stations = d.stations.map((st) => {
    const m = structuredClone(st.plus) as unknown as { chain: { knots: { p: [number, number]; in: [number, number]; out: [number, number] }[] }; apex: number }; // prettier-ignore
    const k = m.chain.knots[m.apex]!;
    for (const q of [k.p, k.in, k.out]) q[1] += dv;
    return { ...st, minus: m as unknown as typeof st.plus };
  });
  return { ...d, symmetry: 'asymmetric', outline: { plus: d.outline.plus, minus: d.outline.plus }, stations }; // prettier-ignore
};

/** A classic sample whose deck meets the rocker at both ends: a pole at each end. */
const poles = (): BoardDoc =>
  convertOrThrow(SAMPLES.find((s) => s.name.includes('synthetic-clean-6x22x2-75'))!.load());

const BOARDS: readonly { name: string; doc: BoardDoc }[] = [
  ...boardSet().filter((b) => !b.name.startsWith('classic')),
  { name: 'every feature', doc: everyFeature() },
  { name: 'poles', doc: poles() },
];

/** The largest distance from a solid's sides to the evaluator on a grid offset from the fit's and the check's. */
function independentDeviation(built: BuiltBoard, solid: BoardSolid): number {
  const ev = createEvaluator(built);
  const sc = createScratch({ maxDegree: 3 });
  const out = new Float64Array(3);
  let worst = 0;
  const grid = (b: Float64Array, per: number): number[] => {
    const breaks = [...new Set(b)];
    const pts: number[] = [];
    for (let i = 0; i + 1 < breaks.length; i++) {
      for (let k = 0; k < per; k++) {
        pts.push(breaks[i]! + ((k + 0.37) / per) * (breaks[i + 1]! - breaks[i]!));
      }
    }
    return pts;
  };
  const mirror = built.doc.symmetry === 'mirror';
  const { tail, nose } = solid.report;
  const warped = (u: number): boolean =>
    (u < 0.1 && tail === 'edge') || (u > 0.9 && nose === 'edge');
  for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
    const surf = side === 0 ? solid.plus : solid.minus;
    const us = grid(surf.u.knots as Float64Array, 7);
    const vs = grid(surf.v.knots as Float64Array, 7);
    const F = new Float64Array(us.length * vs.length * 3);
    surfaceEvalGridInto(surf, Float64Array.from(us), Float64Array.from(vs), 0, F, sc);
    for (let i = 0; i < us.length; i++) {
      ev.row(side, solid.xiOf(us[i]!), 0);
      for (let j = 0; j < vs.length; j++) {
        ev.eval(vs[j]!, 0, out, 0);
        const o = (i * vs.length + j) * 3;
        let d = Math.hypot(out[0]! - F[o]!, out[1]! - F[o + 1]!, out[2]! - F[o + 2]!);
        // beside an asymmetric collapsed end the minus side is a reparametrisation of the evaluator's:
        // the distance there is to its section at the same s, wherever along t
        if (side === 1 && warped(us[i]!)) {
          for (let k = 0; k <= 800; k++) {
            ev.eval(k / 800, 0, out, 0);
            d = Math.min(d, Math.hypot(out[0]! - F[o]!, out[1]! - F[o + 1]!, out[2]! - F[o + 2]!));
          }
        }
        worst = Math.max(worst, d);
      }
    }
  }
  // the rows the snap moves (R8): the stringer, the apex and both ends, at offsets of their own
  for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
    const surf = side === 0 ? solid.plus : solid.minus;
    const ts = Array.from({ length: 211 }, (_, k) => (k + 0.31) / 211);
    const rows: [number, number][] = [];
    for (const t of ts) for (const v of [0, 0.5, 1]) rows.push([t, v]);
    for (const t of ts) for (const u of [0, 1]) rows.push([u, t]);
    for (const [u, v] of rows) {
      const F = new Float64Array(3);
      surfaceEvalGridInto(surf, Float64Array.from([u]), Float64Array.from([v]), 0, F, sc);
      ev.row(side, solid.xiOf(u), 0);
      let d: number;
      if (side === 1 && warped(u)) {
        // beside an asymmetric collapsed end: the distance to the evaluator's section at the same s
        d = Infinity;
        for (let k = 0; k <= 800; k++) {
          ev.eval(k / 800, 0, out, 0);
          d = Math.min(d, Math.hypot(out[0]! - F[0]!, out[1]! - F[1]!, out[2]! - F[2]!));
        }
      } else {
        ev.eval(v, 0, out, 0);
        d = Math.hypot(out[0]! - F[0]!, out[1]! - F[1]!, out[2]! - F[2]!);
      }
      worst = Math.max(worst, d);
    }
  }
  return worst;
}

/** Angle (degrees) between two vectors. */
const angleDeg = (a: [number, number, number], b: [number, number, number]): number => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c = dot / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

/**
 * How far the fold of the two faces along a stringer row (v = 0 the bottom, 1 the deck) is from the
 * evaluator's own fold, worst over s in [from, to]. Fold = angle between the plus face's cross tangent and
 * the reversed minus face's: 0 where the board is smooth through the stringer.
 */
function foldExcess(
  built: BuiltBoard,
  solid: BoardSolid,
  v: 0 | 1,
  from: number,
  to: number,
): number {
  const ev = createEvaluator(built);
  const mirror = built.doc.symmetry === 'mirror';
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const evDir = (side: 0 | 1, s: number): [number, number, number] => {
    ev.row(side, solid.xiOf(s), 0);
    ev.eval(v, 0, a);
    ev.eval(v === 0 ? 1e-6 : 1 - 1e-6, 0, b);
    const k = v === 0 ? 1 : -1;
    return [k * (b[0]! - a[0]!), k * (b[1]! - a[1]!), k * (b[2]! - a[2]!)];
  };
  let worst = 0;
  for (let k = 0; k <= 300; k++) {
    const s = from + ((to - from) * k) / 300;
    const p = surfaceDerivatives(solid.plus, s, v, 1).Sv;
    const m = surfaceDerivatives(solid.minus, s, v, 1).Sv;
    const step = angleDeg([p.x, p.y, p.z], [-m.x, -m.y, -m.z]);
    const ep = evDir(0, s);
    const em = evDir(mirror ? 0 : 1, s);
    const emm: [number, number, number] = mirror ? [em[0], -em[1], em[2]] : em;
    const exact = angleDeg(ep, [-emm[0], -emm[1], -emm[2]]);
    worst = Math.max(worst, Math.abs(step - exact));
  }
  return worst;
}

/**
 * The angle (degrees) between the two faces across a collapsed end (s = 0 or 1), worst over t, and how far it
 * is from the evaluator's own: the plan parts of the plus face's ∂S/∂s and of the reversed minus face's
 * (the tip edge is vertical, so the plan part sets the angle; a pole keeps all three components). Round tips
 * are 0 by construction; a pinned tip or a notch bottom has the evaluator's crease.
 */
function tipFold(built: BuiltBoard, solid: BoardSolid, e: 0 | 1): { fold: number; excess: number } {
  const ev = createEvaluator(built);
  const mirror = built.doc.symmetry === 'mirror';
  const pole = (e === 0 ? solid.report.tail : solid.report.nose) === 'pole';
  const plan = (v: [number, number, number]): [number, number, number] =>
    pole ? v : [v[0], v[1], 0];
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const evDir = (side: 0 | 1, t: number): [number, number, number] => {
    ev.row(side, solid.xiOf(e), 0);
    ev.eval(t, 0, a);
    ev.row(side, solid.xiOf(e === 0 ? 1e-7 : 1 - 1e-7), 0);
    ev.eval(t, 0, b);
    return [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  };
  // an asymmetric board's minus side meets the edge at its own t, the evaluator's point of the same height,
  // where the minus side's height rises along the edge (else both sides share t there)
  ev.row(1, solid.xiOf(e), 0);
  let rising = true;
  for (let k = 1, prev = -Infinity; k <= 200; k++) {
    ev.eval(k / 200, 0, b);
    rising &&= b[2]! >= prev;
    prev = b[2]!;
  }
  const sameHeight = (t: number): number => {
    if (!rising) return t;
    ev.row(0, solid.xiOf(e), 0);
    ev.eval(t, 0, a);
    const z = a[2]!;
    ev.row(1, solid.xiOf(e), 0);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const m = 0.5 * (lo + hi);
      ev.eval(m, 0, b);
      if (b[2]! < z) lo = m;
      else hi = m;
    }
    return pole ? t : 0.5 * (lo + hi);
  };
  let fold = 0;
  let excess = 0;
  for (let k = 1; k < 100; k++) {
    const t = k / 100;
    const p = surfaceDerivatives(solid.plus, e, t, 1).Su;
    const m = surfaceDerivatives(solid.minus, e, t, 1).Su;
    const step = angleDeg(plan([p.x, p.y, p.z]), plan([-m.x, -m.y, -m.z]));
    const ep = evDir(0, t);
    const em = evDir(mirror ? 0 : 1, mirror ? t : sameHeight(t));
    const exact = angleDeg(
      plan(ep),
      plan(mirror ? [-em[0], em[1], -em[2]] : [-em[0], -em[1], -em[2]]),
    );
    fold = Math.max(fold, step);
    excess = Math.max(excess, Math.abs(step - exact));
  }
  return { fold, excess };
}

const solved = new Map<BoardDoc, { built: BuiltBoard; solid: BoardSolid }>();
const solve = (doc: BoardDoc): { built: BuiltBoard; solid: BoardSolid } => {
  let r = solved.get(doc);
  if (!r) {
    const built = buildOrThrow(doc);
    solved.set(doc, (r = { built, solid: boardSolid(built) }));
  }
  return r;
};

describe('the STEP solid of a built board', () => {
  for (const { name, doc } of BOARDS) {
    it(`${name}: a valid closed solid within 0.5 mm of the surface`, () => {
      const { built, solid } = solve(doc);
      const check = checkBrep(solid.brep);
      expect(check.issues).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.signedVolume).toBeGreaterThan(0);
      expect(solid.report.withinTolerance).toBe(true);
      expect(independentDeviation(built, solid)).toBeLessThanOrEqual(STEP_TOLERANCE);
      // the sides share their ξ and t knots and their stringer rows exactly
      const { plus, minus } = solid;
      expect(Array.from(minus.u.knots)).toEqual(Array.from(plus.u.knots));
      expect(Array.from(minus.v.knots)).toEqual(Array.from(plus.v.knots));
      const nv = plus.v.count;
      for (let i = 0; i < plus.u.count; i++) {
        for (const j of [0, nv - 1]) {
          for (let c = 0; c < 4; c++) {
            expect(minus.cw[(i * nv + j) * 4 + c]).toBe(plus.cw[(i * nv + j) * 4 + c]);
          }
          expect(plus.cw[(i * nv + j) * 4 + 1]).toBe(0);
        }
      }
      // a symmetric board's minus side is the plus side mirrored
      if (doc.symmetry === 'mirror') {
        for (let k = 0; k < plus.cw.length; k += 4) {
          expect(minus.cw[k]).toBe(plus.cw[k]);
          expect(minus.cw[k + 1]).toBe(0 - plus.cw[k + 1]!);
          expect(minus.cw[k + 2]).toBe(plus.cw[k + 2]);
        }
      }
      // the shell: two hulls and a cap at a blunt end only; tips and notch bottoms are shared edges
      const caps = [solid.report.tail, solid.report.nose].filter((e) => e === 'cap').length;
      expect(solid.brep.faces.length).toBe(2 + caps);
    }, 60_000);
  }

  it.each(BOARDS.map((b) => [b.name, b.doc] as const))(
    "%s: runs to both tips, tangent across a round one, with the evaluator's crease elsewhere",
    (name, doc) => {
      const { built, solid } = solve(doc);
      // no length lost: the surface spans the stations and a collapsed end row is on the tip edge
      expect(solid.report.range).toEqual([built.xiMin, built.xiMax]);
      for (const e of [0, 1] as const) {
        const kind = e === 0 ? solid.report.tail : solid.report.nose;
        if (kind === 'cap') continue;
        const x = e === 0 ? built.xiMin : built.xiMax;
        for (const t of [0, 0.3, 0.5, 0.8, 1]) {
          const p = surfacePoint(solid.plus, e, t);
          expect(p.x).toBeCloseTo(x, 9);
          expect(Math.abs(p.y)).toBeLessThan(1e-12);
        }
        const f = tipFold(built, solid, e);
        if (solid.report.round[e]) expect(f.fold, `${name} end ${e}`).toBeLessThanOrEqual(0.05);
        else expect(f.excess, `${name} end ${e}`).toBeLessThanOrEqual(0.15);
      }
    },
    60_000,
  );

  it('the round tips, pinned tips, poles and caps of the test boards', () => {
    const ends = (name: string) => {
      const r = solve(BOARDS.find((b) => b.name === name)!.doc).solid.report;
      return [r.tail, r.nose, ...r.round];
    };
    expect(ends('shortboard')).toEqual(['edge', 'cap', true, false]); // round tail, 1 cm transom nose
    expect(ends('longboard')).toEqual(['edge', 'edge', true, true]);
    expect(ends('swallow')).toEqual(['edge', 'edge', false, true]); // notch bottom, round nose
    expect(ends('asymmetric')).toEqual(['edge', 'edge', false, true]); // pinned tail
    expect(ends('poles')).toEqual(['pole', 'pole', false, false]);
  }, 120_000);

  it('writes a Part 21 file in the requested unit', () => {
    const built = buildOrThrow(swallowBoard());
    const out = boardStep(built, { name: 'swallow', unit: 'cm', timestamp: '2026-01-01T00:00:00' });
    expect(out.text.startsWith('ISO-10303-21;')).toBe(true);
    expect(out.text).toContain('END-ISO-10303-21;');
    expect(out.text).toContain('.CENTI.');
    expect(out.text).toContain('MANIFOLD_SOLID_BREP');
  }, 60_000);

  it.each(BOARDS.map((b) => [b.name, b.doc] as const))(
    '%s: the faces meet tangent-continuously along both stringer rows, as the evaluator does',
    (name, doc) => {
      const { built, solid } = solve(doc);
      // into the tips; a notched tail's fan chords are followed within a fraction of a degree
      const bound = built.sides[0].frame.notch === null ? 0.1 : 0.2;
      for (const v of [0, 1] as const) {
        expect(foldExcess(built, solid, v, 0.001, 0.999), `${name} v=${v}`).toBeLessThanOrEqual(
          bound,
        );
      }
    },
    60_000,
  );

  it('an asymmetric swallow with a raised minus apex exports within the budget and 0.5 mm', () => {
    const built = buildOrThrow(asymmetricSwallow(0.06));
    const t0 = performance.now();
    const solid = boardSolid(built);
    expect(performance.now() - t0).toBeLessThan(60_000);
    expect(solid.report.withinTolerance).toBe(true);
    expect(solid.report.overBudget).toBe(false);
    expect(solid.report.tail).toBe('edge');
    const check = checkBrep(solid.brep);
    expect(check.issues).toEqual([]);
    expect(check.ok).toBe(true);
    expect(independentDeviation(built, solid)).toBeLessThanOrEqual(STEP_TOLERANCE);
    // the two sides meet the shared notch edge at their own t, with the evaluator's crease; the nose is round
    expect(tipFold(built, solid, 0).excess).toBeLessThanOrEqual(0.15);
    expect(tipFold(built, solid, 1).fold).toBeLessThanOrEqual(0.05);
  }, 120_000);

  it('a fit over its control budget fails quickly with a clear message', () => {
    const built = buildOrThrow(swallowBoard());
    const solid = boardSolid(built, { maxControls: 2500 });
    expect(solid.report.overBudget).toBe(true);
    expect(solid.report.withinTolerance).toBe(false);
    expect(() => boardStep(built, { maxControls: 2500 })).toThrowError(StepFitError);
    try {
      boardStep(built, { maxControls: 2500 });
    } catch (e) {
      expect((e as StepFitError).kind).toBe('budget');
      expect((e as Error).message).toContain('more detail');
    }
  }, 60_000);
});
