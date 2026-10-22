// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `fitField` when a geom solve fails for a reason other than an undetermined
 * net (review of S6): such a failure at one fairness ratio must not discard a
 * fit found at another. geom's `approximateSurface` is wrapped so that chosen
 * calls fail with `inconsistent-constraints` (the error geom returns when the
 * stringer constraints contradict each other to more than `constraint`); every
 * other call is geom's own. Oracles: the result is a fit, it meets
 * `surfaceTol` on the judged samples re-evaluated through `heightSampler`
 * (plus 1e-12 cm rounding: z ≤ 3 cm, a few dozen flops), and its ratio is below
 * the failing ones.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as geom from '@openshaper/geom';
import { resolveTolerances } from '@openshaper/geom';
import type { ClampedCurve } from '@openshaper/geom';
import { heightFieldSurface, heightSampler } from '../height-field';
import { fitField } from './fields';
import type { FieldData, FieldFit } from './fields';
import { fitStringerLine } from './lines';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';

const hook = vi.hoisted(() => ({
  /** Whether the call (1-based) with this bend weight fails. */
  fail: (_bend: number, _call: number): boolean => false,
  calls: 0,
  bends: [] as number[],
}));

vi.mock('@openshaper/geom', async (importOriginal) => {
  const m = await importOriginal<typeof geom>();
  return {
    ...m,
    approximateSurface: (...args: Parameters<typeof m.approximateSurface>) => {
      hook.calls++;
      const bend = args[2].fairness?.bend ?? 0;
      hook.bends.push(bend);
      if (hook.fail(bend, hook.calls)) {
        return {
          ok: false,
          issues: [
            {
              code: 'inconsistent-constraints',
              severity: 'error',
              message: 'injected by the test',
            },
          ],
        };
      }
      return m.approximateSurface(...args);
    },
  };
});

const tol = resolveTolerances();
const EX = [-2, 62] as const;
const EY = [-14, 14] as const;
const ROUNDING = 1e-12;
const smooth = (x: number, y: number): number =>
  0.0015 * (x - 30) ** 2 + 0.3 * (y / 12) ** 2 + 0.2 * Math.sin(x / 7) * Math.cos(y / 9);

function inputs(): { data: FieldData; line: ClampedCurve<1> } {
  const pts: number[] = [];
  for (let i = 0; i <= 120; i++)
    for (let j = -24; j <= 24; j++) pts.push(i * 0.5, j * 0.5, smooth(i * 0.5, j * 0.5));
  const data: FieldData = {
    points: Float64Array.from(pts),
    judged: new Uint8Array(pts.length / 3).fill(1),
  };
  const xs = Float64Array.from({ length: 1201 }, (_, k) => k * 0.05);
  const zs = xs.map((x) => smooth(x, 0));
  const lf = fitStringerLine(xs, zs, EX, O.lineTol, O.surfaceKnotSpacing.x, tol);
  if (!('curve' in lf)) throw new Error(lf.message);
  return { data, line: lf.curve };
}

function expectMeets(data: FieldData, fit: FieldFit): void {
  expect(fit.meets).toBe(true);
  const at = heightSampler(heightFieldSurface(fit.field, 'mirror-y', tol), fit.field, tol);
  let worst = 0;
  for (let k = 0; k < data.judged.length; k++) {
    const p = data.points;
    worst = Math.max(worst, Math.abs(at(p[3 * k]!, p[3 * k + 1]!).z - p[3 * k + 2]!));
  }
  expect(worst).toBeLessThanOrEqual(O.surfaceTol + ROUNDING);
}

describe('fitField with failing solves', () => {
  const { data, line } = inputs();
  afterEach(() => {
    hook.fail = () => false;
    hook.calls = 0;
    hook.bends = [];
  });

  it('a failure at the high ratios of the search keeps the best fit below them', () => {
    // Every solve with more than 1e4 × the smallest weight so far fails: the
    // bracket's top and the upper half of the bisection (ratios 1e-10 … 1).
    hook.fail = (bend) => bend > 1e4 * Math.min(...hook.bends);
    const r = fitField(data, EX, EY, line, O, tol);
    if ('message' in r) throw new Error(`a fit was expected: ${r.message}`);
    expectMeets(data, r);
    expect(r.ratio).toBeLessThan(1e4 * O.fairnessRatioBracket[0] * 10);
    expect(hook.calls).toBeGreaterThan(r.fits - 1);
  });

  it('a failure at the first solve does not end the fit', () => {
    hook.fail = (_bend, call) => call === 1;
    const r = fitField(data, EX, EY, line, O, tol);
    if ('message' in r) throw new Error(`a fit was expected: ${r.message}`);
    expectMeets(data, r);
  });

  it('a failure at every ratio is returned', () => {
    hook.fail = () => true;
    const r = fitField(data, EX, EY, line, O, tol);
    expect('message' in r && r.cause?.code).toBe('inconsistent-constraints');
  });
});
