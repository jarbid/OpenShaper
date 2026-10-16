// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The geometric B-rep check (design §13) and orientation by measurement.
 *
 * `makeBrep` has already settled the topology (ids, loop closure, every edge
 * used twice in opposite directions). `checkBrep` measures what a topology
 * cannot say:
 *
 * 1. **Joins.** Consecutive pcurves of a loop meet in (u, v) to the parameter
 *    tolerance, and every pcurve end maps (through its surface) to the vertex
 *    the edge names, and the edge curve's ends are at its vertices.
 * 2. **Same parameter.** `|C(t) − S(p(t))|` per coedge: sampled with `samplesPerSpan`
 *    Gauss–Legendre points on every piece (knots of the curve, of the pcurve,
 *    and the parameters where the pcurve crosses a surface knot line, so each
 *    piece is smooth), plus its ends, then a golden-section refinement round
 *    the largest sample. The per-edge maximum over its coedges is `edgeGaps[e]`.
 *    A gap above `Tolerances.fit` is an error; below it the number flows into the
 *    STEP uncertainty (`step/write.ts`).
 * 3. **Domain.** The sampled pcurve points lie inside the surface's domain
 *    (one period `[t_0, t_0 + T]` for a periodic direction) to `paramRel`.
 * 4. **Trim loops.** Each face's loops form a valid trimmed surface
 *    (`checkTrimLoops`): orientation in particular. With the coherence
 *    `makeBrep` established (neighbours traverse a shared edge in opposite
 *    directions), a face whose `sameSense` disagrees with its loop is caught
 *    here (wrong (u, v) orientation) or by coherence (flipped together with its
 *    loop).
 * 5. **Euler–Poincaré**, `V − E + F − (L − F) = 2(S − G)`; the genus `G` is
 *    checked against the declared one or derived (and must then be a
 *    non-negative integer).
 * 6. **Outward.** `signedVolume > 0`. For a connected, coherently oriented
 *    closed shell the sign decides the global orientation, so this settles every
 *    face's `sameSense` and loop direction together; it is the measurement the
 *    STEP writer relies on instead of assuming handedness.
 */
import { breakpoints } from '../basis';
import { curvePoint } from '../curve';
import { fail } from '../errors';
import { bezierPieces, crossings } from '../pieces';
import { gaussLegendre } from '../quadrature';
import { surfacePoint } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import { checkTrimLoops } from '../trim';
import type { Brep, BrepFace, ClampedCurve, GeomIssue, Point3, ReadonlyF64 } from '../types';
import { flipBrep, loopsOf } from './brep';
import { extentOf, trimFace, uvLoopCurves } from './faces';
import { signedVolume } from './mass';

/** Sampling of the same-parameter check (module comment, item 2). */
export interface BrepCheckSampling {
  /**
   * Gauss–Legendre points per smooth piece. Default (absent): the composed
   * degree of the gap function, `max(deg C, (deg_u + deg_v) · deg p) + 1`, at
   * least 2: a polynomial pair of that degree is resolved by that many points,
   * a rational one converges rapidly beyond it.
   */
  readonly samplesPerSpan?: number;
  /** Golden-section steps round the largest sample (default 40: the bracket shrinks by 0.618⁴⁰, about 4 × 10⁻⁹). */
  readonly refineSteps?: number;
}

/** The documented default of {@link BrepCheckSampling.refineSteps}. */
export const DEFAULT_BREP_CHECK_SAMPLING: { readonly refineSteps: 40 } = Object.freeze({
  refineSteps: 40,
});

/** Euler–Poincaré counts (module comment, item 5). */
export interface BrepEuler {
  readonly V: number;
  readonly E: number;
  readonly F: number;
  /** All loops, outer and inner. */
  readonly L: number;
  readonly S: number;
  /** The declared genus, else the derived one (may be non-integer when the topology is wrong). */
  readonly G: number;
  readonly holds: boolean;
}

export interface BrepReport {
  readonly ok: boolean;
  readonly issues: readonly GeomIssue[];
  /** Measured per edge: the largest same-parameter deviation over its coedges. */
  readonly edgeGaps: ReadonlyF64;
  readonly maxEdgeGap: number;
  /** Largest distance between a vertex and the edge-curve or surface point at an end it names. */
  readonly maxVertexGap: number;
  readonly euler: BrepEuler;
  /** Positive when outward; `0` if it could not be computed (an issue says why). */
  readonly signedVolume: number;
}

function err(
  code: GeomIssue['code'],
  message: string,
  at?: GeomIssue['at'],
  value?: number,
): GeomIssue {
  return {
    code,
    severity: 'error',
    message,
    ...(at === undefined ? {} : { at }),
    ...(value === undefined ? {} : { value }),
  };
}

const dist = (a: Point3, b: Point3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Surface point at `(u, v)` clamped into the surface's extent (a periodic end maps to the start). */
function surfaceAt(f: BrepFace, u: number, v: number): Point3 {
  const [u0, u1] = extentOf(f.surface.u);
  const [v0, v1] = extentOf(f.surface.v);
  return surfacePoint(f.surface, Math.min(u1, Math.max(u0, u)), Math.min(v1, Math.max(v0, v)));
}

/** Smooth-piece breaks of a coedge over its parameter domain (module comment, item 2). */
function pieceBreaks(f: BrepFace, c: ClampedCurve<3>, q: ClampedCurve<2>, t: Tolerances): number[] {
  const [a, b] = c.basis.domain;
  const out: number[] = [a, b];
  for (const x of breakpoints(c.basis)) out.push(x);
  for (const x of breakpoints(q.basis)) out.push(x);
  const minWidth = t.paramRel * (b - a);
  const ub = Array.from(breakpoints(f.surface.u));
  const vb = Array.from(breakpoints(f.surface.v));
  for (const pc of bezierPieces(q)) {
    for (const x of ub) crossings(pc, 0, x, minWidth, out);
    for (const y of vb) crossings(pc, 1, y, minWidth, out);
  }
  const sorted = out.filter((x) => x >= a && x <= b).sort((x, y) => x - y);
  return sorted.filter((x, i) => i === 0 || x - sorted[i - 1]! > minWidth);
}

interface CoedgeMeasure {
  readonly gap: number;
  /** Largest distance a sampled pcurve point lies outside the surface extent, in parameter units. */
  readonly outside: number;
}

/** Same-parameter deviation and domain excursion of one coedge (module comment, items 2 and 3). */
function measureCoedge(
  f: BrepFace,
  c: ClampedCurve<3>,
  q: ClampedCurve<2>,
  t: Tolerances,
  sampling: BrepCheckSampling | undefined,
): CoedgeMeasure {
  const [u0, u1] = extentOf(f.surface.u);
  const [v0, v1] = extentOf(f.surface.v);
  let outside = 0;
  const g = (x: number): number => {
    const p = curvePoint(q, x);
    outside = Math.max(outside, u0 - p.x, p.x - u1, v0 - p.y, p.y - v1);
    return dist(curvePoint(c, x), surfaceAt(f, p.x, p.y));
  };
  const composed = Math.max(
    c.basis.degree,
    (f.surface.u.degree + f.surface.v.degree) * q.basis.degree,
  );
  const n = Math.max(2, sampling?.samplesPerSpan ?? composed + 1);
  const rule = gaussLegendre(n);
  const breaks = pieceBreaks(f, c, q, t);
  let best = 0;
  let bestAt = breaks[0]!;
  let bestLo = breaks[0]!;
  let bestHi = breaks[breaks.length - 1]!;
  const consider = (x: number, lo: number, hi: number): void => {
    const y = g(x);
    if (y > best) {
      best = y;
      bestAt = x;
      bestLo = lo;
      bestHi = hi;
    }
  };
  for (let k = 0; k + 1 < breaks.length; k++) {
    const lo = breaks[k]!;
    const hi = breaks[k + 1]!;
    consider(lo, lo, hi);
    const m = 0.5 * (lo + hi);
    const h = 0.5 * (hi - lo);
    for (let i = 0; i < rule.nodes.length; i++) consider(m + h * rule.nodes[i]!, lo, hi);
  }
  consider(breaks[breaks.length - 1]!, bestLo, bestHi);
  // Golden-section search for the maximum round the best sample, within its piece.
  const steps = sampling?.refineSteps ?? DEFAULT_BREP_CHECK_SAMPLING.refineSteps;
  const width = (bestHi - bestLo) / Math.max(1, rule.nodes.length);
  let lo = Math.max(bestLo, bestAt - width);
  let hi = Math.min(bestHi, bestAt + width);
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let y1 = g(x1);
  let y2 = g(x2);
  for (let i = 0; i < steps; i++) {
    if (y1 < y2) {
      lo = x1;
      x1 = x2;
      y1 = y2;
      x2 = lo + phi * (hi - lo);
      y2 = g(x2);
    } else {
      hi = x2;
      x2 = x1;
      y2 = y1;
      x1 = hi - phi * (hi - lo);
      y1 = g(x1);
    }
  }
  best = Math.max(best, y1, y2);
  return { gap: best, outside };
}

/**
 * The geometric report (module comment). Never throws on data: every problem is an issue
 * with a location. `tol.fit` is the largest gap accepted, `tol.point` the join
 * tolerance of vertices, `tol.paramRel` the parameter tolerance.
 */
export function checkBrep(
  b: Brep,
  tol?: Partial<Tolerances>,
  sampling?: BrepCheckSampling,
): BrepReport {
  const t = resolveTolerances(tol);
  if (
    sampling?.samplesPerSpan !== undefined &&
    !(Number.isInteger(sampling.samplesPerSpan) && sampling.samplesPerSpan >= 1)
  ) {
    fail('unsupported', `samplesPerSpan must be an integer ≥ 1; got ${sampling.samplesPerSpan}`);
  }
  const issues: GeomIssue[] = [];
  const edgeGaps = new Float64Array(b.edges.length);
  let maxVertexGap = 0;

  // Edge curves end at their vertices.
  b.edges.forEach((e, ei) => {
    const [a, z] = e.curve.basis.domain;
    for (const [param, vi] of [
      [a, e.start],
      [z, e.end],
    ] as const) {
      const d = dist(curvePoint(e.curve, param), b.vertices[vi]!.point);
      maxVertexGap = Math.max(maxVertexGap, d);
      if (d > t.fit) {
        issues.push(
          err(
            'brep-invalid',
            `edge ${ei}: its curve ends ${d} from vertex ${vi} (limit fit = ${t.fit})`,
            { edge: ei, vertex: vi },
            d,
          ),
        );
      }
    }
  });

  b.faces.forEach((f, fi) => {
    loopsOf(f).forEach((loop, li) => {
      // pcurves: vertex joins, same parameter, domain.
      loop.coedges.forEach((c, ci) => {
        const e = b.edges[c.edge]!;
        const at = { face: fi, edge: c.edge, coedge: [fi, li, ci] as const };
        const [a, z] = c.pcurve.basis.domain;
        for (const [param, vi] of [
          [a, e.start],
          [z, e.end],
        ] as const) {
          const p = curvePoint(c.pcurve, param);
          const d = dist(surfaceAt(f, p.x, p.y), b.vertices[vi]!.point);
          maxVertexGap = Math.max(maxVertexGap, d);
          if (d > t.fit) {
            issues.push(
              err(
                'brep-invalid',
                `face ${fi} loop ${li} coedge ${ci}: the pcurve end maps ${d} from vertex ${vi} (limit fit = ${t.fit})`,
                { ...at, vertex: vi },
                d,
              ),
            );
          }
        }
        const m = measureCoedge(f, e.curve, c.pcurve, t, sampling);
        if (m.gap > edgeGaps[c.edge]!) edgeGaps[c.edge] = m.gap;
        if (m.gap > t.fit) {
          issues.push(
            err(
              'brep-invalid',
              `face ${fi} loop ${li} coedge ${ci}: the pcurve image deviates ${m.gap} from edge ${c.edge}'s curve (limit fit = ${t.fit})`,
              at,
              m.gap,
            ),
          );
        }
        const [u0, u1] = extentOf(f.surface.u);
        const [v0, v1] = extentOf(f.surface.v);
        const slack = t.paramRel * Math.max(u1 - u0, v1 - v0);
        if (m.outside > slack) {
          issues.push(
            err(
              'trim-outside-domain',
              `face ${fi} loop ${li} coedge ${ci}: the pcurve leaves the surface's domain by ${m.outside}`,
              at,
              m.outside,
            ),
          );
        }
      });
      // (u, v) joins in traversal order.
      const curves = uvLoopCurves(f, loop);
      const [u0, u1] = extentOf(f.surface.u);
      const [v0, v1] = extentOf(f.surface.v);
      const uvTol = t.paramRel * Math.max(u1 - u0, v1 - v0);
      for (let k = 0; k < curves.length; k++) {
        const x = curves[k]!;
        const y = curves[(k + 1) % curves.length]!;
        const pe = curvePoint(x, x.basis.domain[1]);
        const ps = curvePoint(y, y.basis.domain[0]);
        const d = Math.hypot(pe.x - ps.x, pe.y - ps.y);
        if (d > uvTol) {
          issues.push(
            err(
              'trim-not-closed',
              `face ${fi} loop ${li}: pcurve ${k} ends ${d} (u, v) from the start of the next (limit ${uvTol})`,
              { face: fi, coedge: [fi, li, k] },
              d,
            ),
          );
        }
      }
    });
    // Trim-loop validity (orientation first) of the face as a trimmed surface.
    const r = trimFace(f, t);
    for (const i of r.issues) {
      if (i.severity === 'error') issues.push({ ...i, at: { ...i.at, face: fi } });
    }
    if (r.ts !== null) {
      for (const i of checkTrimLoops(r.ts, t)) {
        if (i.severity === 'error') issues.push({ ...i, at: { ...i.at, face: fi } });
      }
    }
  });

  let maxEdgeGap = 0;
  for (const g of edgeGaps) maxEdgeGap = Math.max(maxEdgeGap, g);

  // Euler–Poincaré.
  const V = b.vertices.length;
  const E = b.edges.length;
  const F = b.faces.length;
  const L = b.faces.reduce((n, f) => n + 1 + f.holes.length, 0);
  const S = b.shells.length;
  const chi = V - E + F - (L - F);
  const declared = b.solids[0]?.genus;
  const derived = (2 * S - chi) / 2;
  const G = declared ?? derived;
  const holds = Number.isInteger(G) && G >= 0 && chi === 2 * (S - G);
  if (!holds) {
    issues.push(
      err(
        'brep-invalid',
        declared === undefined
          ? `Euler–Poincaré: V − E + F − (L − F) = ${chi} gives genus ${derived}, which is not a non-negative integer`
          : `Euler–Poincaré: V − E + F − (L − F) = ${chi} but the declared genus ${declared} needs ${2 * (S - declared)}`,
        undefined,
        chi,
      ),
    );
  }

  // Outward orientation by measurement. A face that is not a valid trimmed surface
  // already has its issue above; the volume then cannot be computed.
  let volume = 0;
  try {
    volume = signedVolume(b, t).value;
  } catch (e) {
    if (issues.length === 0) {
      issues.push(
        err('brep-invalid', `the signed volume could not be computed: ${(e as Error).message}`),
      );
    }
  }
  if (volume < 0) {
    issues.push(
      err(
        'brep-invalid',
        `the shell is inside-out: signed volume ${volume} < 0 (orientBrep flips it)`,
        undefined,
        volume,
      ),
    );
  } else if (volume === 0 && issues.length === 0) {
    issues.push(err('brep-invalid', 'the shell encloses no volume'));
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    edgeGaps,
    maxEdgeGap,
    maxVertexGap,
    euler: Object.freeze({ V, E, F, L, S, G, holds }),
    signedVolume: volume,
  });
}

/**
 * The B-rep with outward orientation, by the sign of the measured enclosed
 * volume: an inside-out one is returned flipped (`sameSense` toggled, loops
 * reversed), an outward one comes back as it is (same object). For a
 * coherently oriented closed shell (what `makeBrep` guarantees) the sign
 * decides every face. Throws `brep-invalid` for a shell that cannot be
 * integrated or encloses no volume.
 */
export function orientBrep(b: Brep, tol?: Partial<Tolerances>): Brep {
  const v = signedVolume(b, tol).value;
  if (!Number.isFinite(v) || v === 0) {
    fail('brep-invalid', `cannot orient a shell enclosing volume ${v}`, { value: v });
  }
  return v < 0 ? flipBrep(b) : b;
}
