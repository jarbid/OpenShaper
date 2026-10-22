// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Law extraction and the offset factorisation (`extract.ts`, §9.7 items 4–6,
 * step S7) on their own.
 *
 * - **Factorisation identity on the crowned stadium** (deck slope at the edge
 *   not zero, so every component of τ̂_d counts): a band displaced along every
 *   structural direction the offset layer has (rows 1, 2, 4, 5; seeded,
 *   `mulberry32`, seed printed) is factorised against the law-only band, and the
 *   document with that layer builds into the displaced band within 1e-12 cm
 *   (rounding of the profile construction and of the offset interpolation on a
 *   200 cm board; the identity is exact in exact arithmetic).
 * - **Apex bounds** (§5.3): inside the interval both corner heights `H_u` and
 *   `H_l` (the construction's own formulas) are positive; at the unrestricted
 *   ends `lo`, `hi` they vanish (to 1e-12 relative); outside they are not.
 * - **Adaptive apex law**: against a smooth target over σ, every target is
 *   met within the tolerance, with keys added only where needed (none when the
 *   start keys already meet it).
 */
import { describe, expect, it } from 'vitest';
import { resolveTolerances } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { bandContext, bandPass } from '../band/band';
import { bandColumns, stationBasis } from '../band/stations';
import { lawEvaluator } from '../law';
import { stadiumBoard } from '../testing';
import { bandFitFrame, expandDisplacements, netOf } from './band-fit';
import { adaptiveLaw, apexBounds, columnInputs, offsetLayer } from './extract';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import { netOf as surfaceNet } from './rail';

const SEED = 9119;
const tol = resolveTolerances();

describe('the offset factorisation', () => {
  it(`reproduces a displaced stadium band (seed ${SEED})`, () => {
    // A crowned deck, so the deck slope s_d at the deck edge (the z part of τ̂_d) is not zero.
    const doc = stadiumBoard({ thickness: 6, crown: 1.5 });
    const ctx = bandContext(doc);
    const b = stationBasis(ctx.plan, ctx.arc, doc.build, true, tol);
    const columns = bandColumns(b, ctx.arc);
    const lawNet = surfaceNet(bandPass(ctx, b).band);
    const inp = columnInputs(ctx, b, columns);
    // Every master its own unknown (no interpolation), so every column moves independently.
    const frame = bandFitFrame(b, columns, lawNet, inp, doc.build.fullnessRange[0], tol.point, 0);
    const rnd = mulberry32(SEED);
    const c = new Float64Array(frame.kept * frame.free.length);
    for (let k = 0; k < c.length; k++) c[k] = 0.2 * (rnd() - 0.5);
    const fitted = netOf(frame, expandDisplacements(frame, c));
    const offsets = offsetLayer(columns, inp, fitted, lawNet, true, tol);
    const doc2 = { ...doc, offsets };
    const ctx2 = bandContext(doc2);
    const b2 = stationBasis(ctx2.plan, ctx2.arc, doc2.build, true, tol);
    expect(b2.basis.count).toBe(b.basis.count);
    const built = surfaceNet(bandPass(ctx2, b2).band);
    let worst = 0;
    let moved = 0;
    for (let k = 0; k < built.length; k++) {
      worst = Math.max(worst, Math.abs(built[k]! - fitted[k]!));
      moved = Math.max(moved, Math.abs(fitted[k]! - lawNet[k]!));
    }
    expect(moved).toBeGreaterThan(0.05);
    expect(worst).toBeLessThanOrEqual(1e-12 * 200);
  });
});

describe('apexBounds', () => {
  it('bounds the apex height where both corner triangles have positive height', () => {
    const rnd = mulberry32(SEED + 1);
    const build = { apexHeightRange: [0.05, 0.95] as const };
    for (let t = 0; t < 200; t++) {
      const tz = rnd();
      const ez = tz + 1 + 3 * rnd();
      const sd = 2 * (rnd() - 0.5);
      const sb = 0.5 * (rnd() - 0.5);
      const wd = 0.5 + 5 * rnd();
      const wt = 0.2 + 2 * rnd();
      const h = ez - tz;
      const hu = (a: number): number => ez + sd * wd - (tz + a * h);
      const hl = (a: number): number => tz + a * h - (tz + sb * wt);
      const lo = (sb * wt) / h;
      const hi = 1 + (sd * wd) / h;
      expect(Math.abs(hl(lo))).toBeLessThanOrEqual(1e-12 * (1 + Math.abs(ez)));
      expect(Math.abs(hu(hi))).toBeLessThanOrEqual(1e-12 * (1 + Math.abs(ez)));
      const r = apexBounds(ez, tz, sd, sb, wd, wt, build);
      if (r === null) {
        // Empty: the range's fractions of (lo, hi) do not overlap the range itself.
        expect(Math.max(0.05, lo + 0.05 * (hi - lo))).toBeGreaterThanOrEqual(
          Math.min(0.95, lo + 0.95 * (hi - lo)),
        );
        continue;
      }
      for (const a of [r[0], 0.5 * (r[0] + r[1]), r[1]]) {
        expect(hu(a)).toBeGreaterThan(0);
        expect(hl(a)).toBeGreaterThan(0);
        expect(a).toBeGreaterThanOrEqual(0.05);
        expect(a).toBeLessThanOrEqual(0.95);
      }
      expect(hl(lo - 1e-6 * (hi - lo))).toBeLessThan(0);
      expect(hu(hi + 1e-6 * (hi - lo))).toBeLessThan(0);
    }
  });
});

describe('adaptiveLaw', () => {
  const target = (s: number): number => 0.4 + 0.1 * Math.sin(6 * Math.PI * s);
  const sigmas = Array.from({ length: 199 }, (_, k) => (k + 1) / 400);
  const targets = sigmas.map((sigma) => ({ sigma, value: target(sigma) }));
  const start = [0, 0.25, 0.5].map((s) => ({ s, value: target(s) }));
  const TOL = 0.002;

  it('meets every target within its tolerance', () => {
    const r = adaptiveLaw(start, targets, TOL);
    const at = lawEvaluator(r.law);
    for (const t of targets) expect(Math.abs(at(t.sigma) - t.value)).toBeLessThanOrEqual(TOL);
    expect(r.worst).toBeLessThanOrEqual(TOL);
    expect(r.added).toBeGreaterThan(0);
    expect(r.law.keys.length).toBe(start.length + r.added);
  });

  it('adds nothing when the start keys meet it', () => {
    const flat = targets.map((t) => ({ sigma: t.sigma, value: 0.4 }));
    const r = adaptiveLaw(
      [0, 0.25, 0.5].map((s) => ({ s, value: 0.4 })),
      flat,
      TOL,
    );
    expect(r.added).toBe(0);
  });
});

describe('the data-scale unknowns', () => {
  it('keep masters at least minSigma apart and interpolate the rest', () => {
    // A crowned deck, so the deck slope s_d at the deck edge (the z part of τ̂_d) is not zero.
    const doc = stadiumBoard({ thickness: 6, crown: 1.5 });
    const ctx = bandContext(doc);
    const b = stationBasis(ctx.plan, ctx.arc, doc.build, true, tol);
    const columns = bandColumns(b, ctx.arc);
    const lawNet = surfaceNet(bandPass(ctx, b).band);
    const inp = columnInputs(ctx, b, columns);
    const minSigma = (4 * O.sampleSpacingX) / ctx.arc.total;
    const f = bandFitFrame(b, columns, lawNet, inp, 0.05, tol.point, minSigma);
    const M = f.masters.length;
    expect(f.kept).toBeLessThan(M);
    let last = -Infinity;
    for (let m = 0; m < M; m++) {
      const s = columns[f.masters[m]!]!.sigma;
      if (f.t[m] === 0 && f.j0[m] === f.j1[m]) {
        if (m > 0 && m < M - 1) expect(s - last).toBeGreaterThanOrEqual(minSigma);
        last = s;
      } else {
        expect(f.j1[m]).toBe(f.j0[m]! + 1);
        expect(f.t[m]).toBeGreaterThan(0);
        expect(f.t[m]).toBeLessThan(1);
      }
    }
  });
});
