// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The height-field fit on its own (docs/design/board2.md §9.6, §9.8), on an
 * analytic field small enough to check every property directly; the sample
 * files are the exit tests' (`convert.*.exit.test.ts`).
 *
 * Data: a symmetric smooth field `f(x, y)` sampled on a grid, plus a narrow
 * Gaussian bump of 0.05 cm at x = 30, |y| = 6 (widths 0.4 and 0.8 cm, far
 * below `minKnotSpacing`: a classic crease's role) whose window
 * `|x − 30| ≤ creaseWindow` is not judged. Oracles, each independent of the fit:
 * - **Residual**: the returned field re-evaluated through `heightFieldSurface`
 *   and `heightSampler` at every judged sample is within `surfaceTol` (plus a
 *   1e-12 cm rounding allowance: z ≤ 3 cm, a few dozen flops); the window's bump
 *   is not followed (the residual over all samples exceeds `surfaceTol`), so
 *   only judged samples drive the fit.
 * - **Discrepancy principle (maximality)**: on the returned bases, a fit at the
 *   next ratio of the bisection's resolution, `ratio · (r1/r0)^(1/2^steps)`, made
 *   here with geom's `approximateSurface` directly, misses `surfaceTol` on the
 *   judged samples (the residual grows with the weight, P. C. Hansen's
 *   discrepancy curve), unless the ratio is the bracket's top.
 * - **Stringer identity** (§3.4): the field's iso-curve at y = 0 equals the line
 *   at 200 seeded random parameters within geom's `constraint` (1e-9 cm).
 * - **Symmetry**: `checkHeightFieldSymmetry` finds nothing (bitwise pairs).
 * - **Bases**: every knot of the line is a knot of the field; the u knots the
 *   refinement added are at least `minKnotSpacing` apart from their neighbours
 *   except where the line's own knots are closer.
 */
import { describe, expect, it } from 'vitest';
import {
  approximateSurface,
  clampedBasis,
  createScratch,
  curveEvalInto,
  resolveTolerances,
  surfaceEvalInto,
} from '@openshaper/geom';
import type { ClampedCurve } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import {
  heightFieldSurface,
  heightSampler,
  stringerConstraints,
  stringerLines,
} from '../height-field';
import { checkHeightFieldSymmetry } from '../symmetry';
import { dataTrace, thinPlateTrace } from './fairness';
import { fitField } from './fields';
import type { FieldData, FieldFit } from './fields';
import { fitStringerLine, lineOnKnots } from './lines';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';

const tol = resolveTolerances();
const EX = [-2, 62] as const;
const EY = [-14, 14] as const;
const ROUNDING = 1e-12;

const smooth = (x: number, y: number): number =>
  0.0015 * (x - 30) ** 2 + 0.3 * (y / 12) ** 2 + 0.2 * Math.sin(x / 7) * Math.cos(y / 9);
const inWindow = (x: number): boolean => Math.abs(x - 30) <= O.creaseWindow;
const bump = (x: number, y: number): number =>
  0.05 * Math.exp(-(((x - 30) / 0.4) ** 2) - ((Math.abs(y) - 6) / 0.8) ** 2);

function setup(): { data: FieldData; line: ClampedCurve<1>; fit: FieldFit } {
  const pts: number[] = [];
  const judged: number[] = [];
  for (let i = 0; i <= 120; i++) {
    const x = i * 0.5;
    for (let j = -24; j <= 24; j++) {
      const y = j * 0.5;
      pts.push(x, y, smooth(x, y) + bump(x, y));
      judged.push(inWindow(x) ? 0 : 1);
    }
  }
  const data: FieldData = { points: Float64Array.from(pts), judged: Uint8Array.from(judged) };
  const lx: number[] = [];
  const lz: number[] = [];
  for (let k = 0; k <= 1200; k++) {
    lx.push(k * 0.05);
    lz.push(smooth(k * 0.05, 0));
  }
  const lf = fitStringerLine(
    Float64Array.from(lx),
    Float64Array.from(lz),
    EX,
    O.lineTol,
    O.surfaceKnotSpacing.x,
    tol,
  );
  if (!('curve' in lf)) throw new Error(lf.message);
  const r = fitField(data, EX, EY, lf.curve, O, tol);
  if ('message' in r) throw new Error(r.message);
  return { data, line: lf.curve, fit: r };
}

describe('fitField (§9.6, §9.8)', () => {
  const { data, line, fit } = setup();
  const hf = fit.field;
  const surface = heightFieldSurface(hf, 'mirror-y', tol);
  const at = heightSampler(surface, hf, tol);
  const n = data.judged.length;

  it('meets surfaceTol on the judged samples and ignores the window', () => {
    expect(fit.meets).toBe(true);
    let judgedMax = 0;
    let allMax = 0;
    for (let k = 0; k < n; k++) {
      const p = data.points;
      const e = Math.abs(at(p[3 * k]!, p[3 * k + 1]!).z - p[3 * k + 2]!);
      allMax = Math.max(allMax, e);
      if (data.judged[k] === 1) judgedMax = Math.max(judgedMax, e);
    }
    expect(judgedMax).toBeLessThanOrEqual(O.surfaceTol + ROUNDING);
    expect(Math.abs(judgedMax - fit.maxResidual)).toBeLessThanOrEqual(ROUNDING);
    expect(allMax).toBeGreaterThan(O.surfaceTol);
  });

  it('takes the largest fairness that meets surfaceTol (the next bisection ratio misses)', () => {
    const [r0, r1] = O.fairnessRatioBracket;
    expect(fit.ratio).toBeGreaterThanOrEqual(r0);
    expect(fit.ratio).toBeLessThan(r1);
    const step = Math.exp(Math.log(r1 / r0) / 2 ** O.fairnessSearchSteps);
    const bu = clampedBasis(3, hf.knotsU, tol);
    const bv = clampedBasis(3, hf.knotsV, tol);
    const uv = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
      uv[2 * k] = (data.points[3 * k]! - EX[0]) / (EX[1] - EX[0]);
      uv[2 * k + 1] = (data.points[3 * k + 1]! - EY[0]) / (EY[1] - EY[0]);
    }
    const beta = dataTrace(bu, bv, uv) / thinPlateTrace(bu, bv);
    const residualAt = (ratio: number): number => {
      const r = approximateSurface(
        data.points,
        { uv },
        {
          u: bu,
          v: bv,
          constraints: stringerConstraints(hf, lineOnKnots(line, hf.knotsU, tol), tol),
          fairness: { bend: ratio * beta, metric: 'parametric' },
          tol,
        },
      );
      if (!r.ok) throw new Error(r.issues[0]!.message);
      const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
      const q = new Float64Array(3);
      let worst = 0;
      for (let k = 0; k < n; k++) {
        if (data.judged[k] !== 1) continue;
        surfaceEvalInto(r.value.surface, uv[2 * k]!, uv[2 * k + 1]!, 0, q, 0, sc);
        worst = Math.max(worst, Math.abs(q[2]! - data.points[3 * k + 2]!));
      }
      return worst;
    };
    expect(residualAt(fit.ratio)).toBeLessThanOrEqual(O.surfaceTol + ROUNDING);
    expect(residualAt(fit.ratio * step)).toBeGreaterThan(O.surfaceTol);
  });

  it('keeps the stringer identity: the iso-curve at y = 0 is the line', () => {
    const iso = stringerLines({ deck: surface, bottom: surface }).deck;
    const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
    const a = new Float64Array(3);
    const b = new Float64Array(1);
    const rng = mulberry32(17);
    for (let k = 0; k < 200; k++) {
      const u = rng();
      curveEvalInto(iso, u, 0, a, 0, sc);
      curveEvalInto(line, u, 0, b, 0, sc);
      expect(Math.abs(a[2]! - b[0]!), `seed 17: u = ${u}`).toBeLessThanOrEqual(tol.constraint);
    }
  });

  it('is exactly symmetric and its u knots contain the line’s', () => {
    expect(checkHeightFieldSymmetry(hf, 'deck')).toEqual([]);
    const lineKnots = Array.from(line.basis.knots).slice(4, -4);
    const inner = hf.knotsU.slice(4, -4);
    for (const k of lineKnots) expect(inner).toContain(k);
    const span = EX[1] - EX[0];
    const added = inner.filter((k) => !lineKnots.includes(k));
    const all = [0, ...inner, 1];
    for (const k of added) {
      const i = all.indexOf(k);
      const gap = Math.min(all[i]! - all[i - 1]!, all[i + 1]! - all[i]!) * span;
      const lineNeighbour = lineKnots.includes(all[i - 1]!) || lineKnots.includes(all[i + 1]!);
      if (!lineNeighbour) expect(gap).toBeGreaterThanOrEqual(O.minKnotSpacing * (1 - 1e-12));
    }
  });
});
