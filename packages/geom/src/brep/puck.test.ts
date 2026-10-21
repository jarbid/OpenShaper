// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The elliptic puck (design §15.3, corpus V5), the integration milestone: a
 * B-rep whose deck is a **bicubic patch with a fitted pcurve**, so edge gaps
 * are not rounding but the fit's measured error, and that error must flow,
 * honestly, through the geometric check, the mass properties, the mesh and the
 * STEP file.
 *
 * Oracles (none of them the code under test):
 *
 * - **Closed forms** (`ellipticPuckExact`): volume `π a b h` (flat or tilted
 *   deck), the area of three analytic faces, the centroid from first moments.
 *   The flat puck is exact (rational faces, adaptive quadrature at `quadRel`).
 * - **A bound for the fitted deck.** The deck's trim boundary differs from the
 *   edge by `g = maxEdgeGap ≤ tol.fit`. Moving a boundary by `g` changes the
 *   deck's area by at most `g · P` (`P` the boundary length) and the volume
 *   integral `⅓ ∬ (S − c) · n dA` by at most `g · P · R / 3` with `R` the
 *   largest distance from the reference corner to the solid; the centroid by
 *   `g · P · R² / (2 V)`. Those bounds, not guessed numbers, are what the fitted
 *   solid is held to, and they must shrink with the fit (convergence).
 * - **Honesty.** The reported gap is at least the deviation measured
 *   independently at seeded random parameters, and at most `tol.fit`; the STEP
 *   uncertainty is the writer's rule `max(2 · gap, point)` in file units, so a
 *   fitted deck declares more than the exact one.
 * - **Round trip.** `readStepSubset(writeStep(b))` is bitwise the same B-rep
 *   (pcurve control points of the fit included) and rewrites to the same text.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBrep,
  curveEvalInto,
  curveOnSurfaceEvalInto,
  createScratch,
  massProperties,
  tessellateBrep,
  transformBrep,
  writeStep,
  DEFAULT_TOLERANCES,
} from '../index';
import type { Affine3, Brep, BrepMesh } from '../index';
import {
  checksum,
  ellipticPuckExact,
  ellipticPuckSolid,
  mulberry32,
  readStepSubset,
} from '../testing';

const EPS = Number.EPSILON;

/** Semi-axes 30 × 10 cm and 5 cm high: a board-sized puck, so the fit's absolute 1e-4 cm matters. */
const A = 30;
const B = 10;
const H = 5;
const TILT = 0.1;

/** Largest distance of a point of `b` from its lowest corner of control points (the mass reference). */
const reach = (a: number, bb: number, h: number, tilt: number): number =>
  Math.hypot(2.5 * a, 2.5 * bb, h + 2.5 * tilt * a);

/** Boundary length of the deck: the ellipse's perimeter by the periodic trapezoid rule, times √(1 + tilt²) at most. */
function perimeter(a: number, b: number): number {
  const n = 4096;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    p += Math.hypot(a * Math.sin(t), b * Math.cos(t));
  }
  return (p * 2 * Math.PI) / n;
}

/** `|E(t) − S(P(t))|` of the deck's coedge at `n` seeded random parameters. */
function independentDeckGap(b: Brep, seed: number, n = 997): number {
  const deck = b.faces[2]!;
  const coedge = deck.outer.coedges[0]!;
  const edge = b.edges[coedge.edge]!;
  const rng = mulberry32(seed);
  const [t0, t1] = edge.curve.basis.domain;
  const sc = createScratch({ maxDegree: 5, maxDerivs: 2 });
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + rng() * (t1 - t0);
    curveEvalInto(edge.curve, t, 0, p, 0, sc);
    curveOnSurfaceEvalInto({ surface: deck.surface, pcurve: coedge.pcurve }, t, 0, q, 0, sc);
    worst = Math.max(worst, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!));
  }
  return worst;
}

describe('the flat puck is exact', () => {
  const b = ellipticPuckSolid(A, B, H);
  const ex = ellipticPuckExact(A, B, H);

  it('checks clean with rounding-sized gaps and the exact volume', () => {
    const r = checkBrep(b);
    expect(r.issues).toEqual([]);
    expect(r.euler).toMatchObject({ V: 2, E: 3, F: 3, holds: true });
    // Exact edges and pcurves of one rational parameterisation: rounding only.
    expect(r.maxEdgeGap).toBeLessThan(64 * EPS * A);
    expect(Math.abs(r.signedVolume / ex.volume - 1)).toBeLessThan(1e-9);
  });

  it('has the closed-form volume, area and centroid (quadRel 1e-10 per integral: 1e-9)', () => {
    const m = massProperties(b);
    expect(Math.abs(m.volume.value / ex.volume - 1)).toBeLessThan(1e-9);
    expect(Math.abs(m.area.value / ex.area - 1)).toBeLessThan(1e-9);
    expect(Math.abs(m.centroid.x)).toBeLessThan(1e-9 * A);
    expect(Math.abs(m.centroid.y)).toBeLessThan(1e-9 * A);
    expect(Math.abs(m.centroid.z - ex.centroid.z)).toBeLessThan(1e-9 * H);
  });

  it('is the zero-tilt case of the closed forms: the tilted area is larger, the volume equal', () => {
    const t = ellipticPuckExact(A, B, H, TILT);
    expect(t.volume).toBe(ex.volume);
    expect(t.area).toBeGreaterThan(ex.area);
    // A circle of radius r (a = b): bottom + top + 2πrh exactly.
    const c = ellipticPuckExact(4, 4, 3);
    expect(Math.abs(c.area - (2 * Math.PI * 16 + 2 * Math.PI * 4 * 3))).toBeLessThan(
      1e-12 * c.area,
    );
  });
});

describe('the fitted bicubic deck', () => {
  const b = ellipticPuckSolid(A, B, H, { bicubicDeck: true, tilt: TILT });
  const ex = ellipticPuckExact(A, B, H, TILT);
  const fit = DEFAULT_TOLERANCES.fit;

  it('has a deck that is a bicubic patch with a polynomial fitted pcurve', () => {
    const deck = b.faces[2]!;
    expect([deck.surface.u.degree, deck.surface.v.degree]).toEqual([3, 3]);
    expect(deck.surface.rational).toBe(false);
    const pc = deck.outer.coedges[0]!.pcurve;
    expect(pc.rational).toBe(false);
    // Not a single Bézier span: the fit needed knots to follow the non-uniform parameterisation.
    expect(pc.basis.count).toBeGreaterThan(4);
    // The edge keeps its exact rational 3D curve.
    expect(b.edges[1]!.curve.rational).toBe(true);
  });

  it('reports the gap honestly: positive, within the fit, and at least what independent samples see', () => {
    const r = checkBrep(b);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    // Edge 1 is the deck's edge; the other two stay exact.
    expect(r.edgeGaps[0]!).toBeLessThan(64 * EPS * A);
    expect(r.edgeGaps[2]!).toBeLessThan(64 * EPS * A);
    expect(r.edgeGaps[1]!).toBeGreaterThan(1e-9);
    expect(r.edgeGaps[1]!).toBeLessThanOrEqual(fit);
    // The check samples the coedge densely; independent samples (none of its) agree within 5%.
    for (const seed of [1, 2, 3]) {
      expect(independentDeckGap(b, seed)).toBeLessThanOrEqual(1.05 * r.edgeGaps[1]! + 64 * EPS * A);
    }
  });

  it('holds the closed forms within the bounds the gap implies, and the bounds are not slack by luck', () => {
    const r = checkBrep(b);
    const g = r.maxEdgeGap;
    const P = perimeter(A, B) * Math.sqrt(1 + TILT * TILT);
    const R = reach(A, B, H, TILT);
    const m = massProperties(b);
    // Quadrature error estimates are far below the gap bound; the bound is the gap's.
    const vBound = (g * P * R) / 3 + 1e-9 * ex.volume;
    const aBound = g * P + 1e-9 * ex.area;
    const cBound = (g * P * R * R) / (2 * ex.volume) + 1e-9 * A;
    expect(Math.abs(m.volume.value - ex.volume)).toBeLessThanOrEqual(vBound);
    expect(Math.abs(m.area.value - ex.area)).toBeLessThanOrEqual(aBound);
    expect(Math.abs(m.centroid.x - ex.centroid.x)).toBeLessThanOrEqual(cBound);
    expect(Math.abs(m.centroid.z - ex.centroid.z)).toBeLessThanOrEqual(cBound);
    expect(Math.abs(m.centroid.y)).toBeLessThanOrEqual(cBound);
    // The signed volume of the check (same integrals) agrees with the mass volume bitwise-ish.
    expect(Math.abs(r.signedVolume - m.volume.value)).toBeLessThanOrEqual(1e-9 * ex.volume);
    // The tilt is in the centroid: x = tilt a² / 4h is 4.5 cm here, 5 orders above the bound's floor.
    expect(ex.centroid.x).toBeCloseTo(4.5, 12);
    expect(Math.abs(m.centroid.x - 4.5)).toBeLessThan(1e-3);
  });

  it('converges as the fit tightens: the gap tracks tol.fit and the volume error shrinks within its bound', () => {
    const gaps: number[] = [];
    const counts: number[] = [];
    for (const f of [1e-3, 1e-5, 1e-7]) {
      const s = ellipticPuckSolid(A, B, H, { bicubicDeck: true, tilt: TILT, tol: { fit: f } });
      // The solid is judged by checkBrep at the default fit unless the caller passes the same.
      const r = checkBrep(s, { fit: Math.max(f, DEFAULT_TOLERANCES.fit) });
      expect(r.issues).toEqual([]);
      expect(r.maxEdgeGap).toBeLessThanOrEqual(f);
      const m = massProperties(s);
      const vb = (r.maxEdgeGap * perimeter(A, B) * 1.01 * reach(A, B, H, TILT)) / 3;
      expect(Math.abs(m.volume.value - ex.volume)).toBeLessThanOrEqual(vb + 1e-9 * ex.volume);
      gaps.push(r.maxEdgeGap);
      counts.push(s.faces[2]!.outer.coedges[0]!.pcurve.basis.count);
    }
    expect(gaps[1]!).toBeLessThan(gaps[0]!);
    expect(gaps[2]!).toBeLessThan(gaps[1]!);
    expect(counts[1]!).toBeGreaterThan(counts[0]!);
    expect(counts[2]!).toBeGreaterThan(counts[1]!);
  });

  it('is deterministic and frozen', () => {
    const again = ellipticPuckSolid(A, B, H, { bicubicDeck: true, tilt: TILT });
    expect(checksum(again)).toBe(checksum(b));
    expect(Object.isFrozen(b)).toBe(true);
  });
});

describe('the fitted deck flows into STEP', () => {
  const flat = ellipticPuckSolid(A, B, H);
  const fitted = ellipticPuckSolid(A, B, H, { bicubicDeck: true, tilt: TILT });

  it('declares the measured gap: the floor for the exact puck, 2 × the gap (in mm) for the fitted one', () => {
    const a = writeStep(flat);
    const b = writeStep(fitted);
    // Defaults: model cm, file mm. The floor is `point` = 1e-6 cm = 1e-5 mm.
    expect(a.stats.uncertainty).toBeCloseTo(DEFAULT_TOLERANCES.point * 10, 15);
    const gapMm = checkBrep(fitted).maxEdgeGap * 10;
    expect(b.stats.maxEdgeGap).toBeCloseTo(gapMm, 9);
    expect(b.stats.uncertainty).toBeCloseTo(2 * gapMm, 9);
    expect(b.stats.uncertainty).toBeGreaterThan(a.stats.uncertainty);
    // Declared accuracy must cover what was measured: the gap is under the uncertainty.
    expect(b.stats.maxEdgeGap).toBeLessThan(b.stats.uncertainty);
  });

  it('round-trips: the fit is bitwise (polynomial), the gap unchanged to rounding', () => {
    const w = writeStep(fitted, { fileUnit: 'cm' });
    const back = readStepSubset(w.text);
    const was = fitted.faces[2]!.outer.coedges[0]!.pcurve;
    const now = back.faces[2]!.outer.coedges[0]!.pcurve;
    expect(Array.from(now.basis.knots)).toEqual(Array.from(was.basis.knots));
    expect(Array.from(now.cw)).toEqual(Array.from(was.cw));
    expect(Array.from(back.faces[2]!.surface.cw)).toEqual(Array.from(fitted.faces[2]!.surface.cw));
    // Rational edge curves pass through x = cw / w and w · x: 4 ε relative on A-sized coordinates.
    expect(Math.abs(checkBrep(back).maxEdgeGap - checkBrep(fitted).maxEdgeGap)).toBeLessThan(
      64 * EPS * A,
    );
  });
});

describe('the fitted puck, meshed and moved', () => {
  const fitted = ellipticPuckSolid(A, B, H, { bicubicDeck: true, tilt: TILT });
  const ex = ellipticPuckExact(A, B, H, TILT);

  function volumeOf(m: BrepMesh): number {
    const p = m.positions;
    let v = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]! * 3;
      const b = m.indices[t + 1]! * 3;
      const c = m.indices[t + 2]! * 3;
      v +=
        (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
          p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
          p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
        6;
    }
    return v;
  }

  it('meshes watertight, and the volume is within area · (chord error + gap) of the closed form', () => {
    const r = tessellateBrep(fitted, { chordTol: 0.05, angleTol: 0.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    const dir = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
      const w = [0, 1, 2].map((k) => m.weld[m.indices[t + k]!]!);
      for (let e = 0; e < 3; e++) {
        const key = `${w[e]},${w[(e + 1) % 3]}`;
        dir.set(key, (dir.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of dir) {
      const [a, b] = key.split(',');
      expect(n, `edge ${key}`).toBe(1);
      expect(dir.get(`${b},${a}`), `opposite of ${key}`).toBe(1);
    }
    const V = new Set(m.weld).size;
    expect(V - dir.size / 2 + m.indices.length / 3).toBe(2);
    // Boundary vertices come from the exact edge curves while the deck's interior comes from the
    // surface: they differ by the edge gap, which adds to the chord error (mesh error ≤ area × both).
    const gap = checkBrep(fitted).maxEdgeGap;
    expect(m.maxChordError).toBeLessThanOrEqual(0.05 * 1.0000001);
    expect(Math.abs(volumeOf(m) - ex.volume)).toBeLessThanOrEqual(
      ex.area * (m.maxChordError + gap) + 1e-12 * ex.volume,
    );
  });

  it('a mirror and a rigid motion keep it valid with the same volume and the gap unchanged', () => {
    const mirror: Affine3 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const move: Affine3 = [0, -1, 0, 20, 1, 0, 0, -7, 0, 0, 1, 3];
    const g = checkBrep(fitted).maxEdgeGap;
    for (const t of [mirror, move]) {
      const moved = transformBrep(fitted, t);
      const r = checkBrep(moved);
      expect(r.issues).toEqual([]);
      expect(r.signedVolume).toBeGreaterThan(0);
      // Isometries: distances are preserved, so the gap is (to rounding at the new offsets).
      expect(Math.abs(r.maxEdgeGap - g)).toBeLessThanOrEqual(64 * EPS * 60);
    }
  });
});
