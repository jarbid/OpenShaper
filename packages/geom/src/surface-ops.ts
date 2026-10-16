// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Surface operations per parameter direction (design §6.8): knot insertion
 * (P&T A5.3) and refinement (A5.5), degree elevation (A5.9 row-wise),
 * splitting, reversal, swapping u and v, affine reparameterisation and
 * periodic → clamped conversion.
 *
 * A tensor-product surface is a curve in one direction whose "points" are the
 * rows (or columns) of the net, so every operation runs the curve kernels of
 * `curve-ops.ts` on those rows: A5.1 on rows is A5.3, A5.4 on rows is A5.5
 * (their alphas are computed once and applied across a row). The net is
 * u-major, so a u row (`v.count · 4` doubles) is already contiguous; the v
 * direction transposes the net, runs the kernel and transposes back. The other
 * direction's basis is kept by reference. All operations are exact (convex
 * combinations); a polynomial surface keeps its weights exactly 1.
 */
import type { DirNet } from './curve-ops';
import {
  elevateDir,
  insertDir,
  refineDir,
  reparamBasis,
  reverseDir,
  splitDir,
  subDir,
} from './curve-ops';
import { fail } from './errors';
import { checkSurfaceShape, surfaceFromHomogeneous } from './surface';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type { Basis, Interval, NurbsSurface, ParamDir, ReadonlyF64 } from './types';

function checkDir(dir: ParamDir): void {
  if (dir !== 'u' && dir !== 'v') fail('unsupported', `dir must be 'u' or 'v'; got ${String(dir)}`);
}

/** The net with u and v swapped: point `(i, j)` moves to `(j, i)` (v-major ↔ u-major). */
function transpose(cw: ReadonlyF64, nu: number, nv: number): Float64Array {
  const out = new Float64Array(nu * nv * 4);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const src = (i * nv + j) * 4;
      const dst = (j * nu + i) * 4;
      for (let c = 0; c < 4; c++) out[dst + c] = cw[src + c]!;
    }
  }
  return out;
}

/** Builds a surface from new bases and a u-major net; a polynomial `s` keeps weights exactly 1. */
function build(s: NurbsSurface, u: Basis, v: Basis, cw: Float64Array): NurbsSurface {
  if (!s.rational) for (let i = 3; i < cw.length; i += 4) cw[i] = 1;
  return surfaceFromHomogeneous({ u, v, cw });
}

/**
 * Runs a per-direction kernel on the rows of `dir` and rebuilds the surface
 * from each result (one for most operations, two for a split).
 */
function along(
  s: NurbsSurface,
  dir: ParamDir,
  op: (b: Basis, Pw: ReadonlyF64, h: number) => readonly DirNet[],
): NurbsSurface[] {
  checkSurfaceShape(s);
  checkDir(dir);
  const nu = s.u.count;
  const nv = s.v.count;
  if (dir === 'u') return op(s.u, s.cw, nv * 4).map((r) => build(s, r.basis, s.v, r.Pw));
  return op(s.v, transpose(s.cw, nu, nv), nu * 4).map((r) =>
    build(s, s.u, r.basis, transpose(r.Pw, r.basis.count, nu)),
  );
}

const one = (s: NurbsSurface[]): NurbsSurface => s[0]!;

/** P&T A5.3: inserts `t` `times` times (default 1) in direction `dir`. Rules as `insertKnot`. */
export function insertKnotSurface(
  s: NurbsSurface,
  dir: ParamDir,
  t: number,
  times = 1,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  const tl = resolveTolerances(tol);
  return one(along(s, dir, (b, Pw, h) => [insertDir(b, Pw, h, t, times, tl)]));
}

/** P&T A5.5: inserts all of `x` in direction `dir` in one pass. Rules as `refineKnots`. */
export function refineKnotsSurface(
  s: NurbsSurface,
  dir: ParamDir,
  x: ArrayLike<number>,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  const tl = resolveTolerances(tol);
  return one(along(s, dir, (b, Pw, h) => [refineDir(b, Pw, h, x, tl)]));
}

/** P&T A5.9 applied to every row: degree in `dir` raised by `by ≥ 0`. */
export function elevateDegreeSurface(
  s: NurbsSurface,
  dir: ParamDir,
  by: number,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  const tl = resolveTolerances(tol);
  return one(along(s, dir, (b, Pw, h) => [elevateDir(b, Pw, h, by, tl)]));
}

/**
 * Splits along a clamped direction at `t` into the pieces before and after
 * (domains kept); they share the join row bit for bit. `unsupported` for a
 * periodic direction (use {@link toClampedSurface}).
 */
export function splitSurface(
  s: NurbsSurface,
  dir: ParamDir,
  t: number,
  tol?: Partial<Tolerances>,
): readonly [NurbsSurface, NurbsSurface] {
  const tl = resolveTolerances(tol);
  const [a, b] = along(s, dir, (bs, Pw, h) => splitDir(bs, Pw, h, t, tl));
  return Object.freeze([a!, b!] as const);
}

/** Reverses direction `dir`: `S′(u, v) = S(a + b − u, v)` (likewise v; periodic as `reverseCurve`). */
export function reverseSurface(
  s: NurbsSurface,
  dir: ParamDir,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  const tl = resolveTolerances(tol);
  return one(along(s, dir, (b, Pw, h) => [reverseDir(b, Pw, h, tl)]));
}

/**
 * Swaps the parameters: `S′(v, u) = S(u, v)`, bases exchanged by reference.
 * The normal `S′u × S′v = −(Su × Sv)` flips, as any odd permutation must.
 */
export function swapUV(s: NurbsSurface): NurbsSurface {
  checkSurfaceShape(s);
  return surfaceFromHomogeneous({ u: s.v, v: s.u, cw: transpose(s.cw, s.u.count, s.v.count) });
}

/** Direction `dir` mapped affinely onto `domain` (as `reparameterize`); the net is shared. */
export function reparameterizeSurface(
  s: NurbsSurface,
  dir: ParamDir,
  domain: Interval,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  checkSurfaceShape(s);
  checkDir(dir);
  const b = reparamBasis(dir === 'u' ? s.u : s.v, domain, resolveTolerances(tol));
  return Object.freeze({
    ...s,
    u: dir === 'u' ? b : s.u,
    v: dir === 'v' ? b : s.v,
  }) as NurbsSurface;
}

/** Both directions onto `[0, 1]` (periodic: period 1). */
export function normalizeSurfaceDomain(s: NurbsSurface, tol?: Partial<Tolerances>): NurbsSurface {
  return reparameterizeSurface(reparameterizeSurface(s, 'u', [0, 1], tol), 'v', [0, 1], tol);
}

/**
 * A periodic direction as the identical clamped one on `[seam, seam + T]`
 * (default `t_0`), as `toClamped` does for curves; `unsupported` for a clamped
 * direction.
 */
export function toClampedSurface(
  s: NurbsSurface,
  dir: ParamDir,
  seam?: number,
  tol?: Partial<Tolerances>,
): NurbsSurface {
  const tl = resolveTolerances(tol);
  return one(
    along(s, dir, (b, Pw, h) => {
      if (b.kind !== 'periodic') fail('unsupported', `direction ${dir} is already clamped`);
      const x = seam ?? b.domain[0];
      return [subDir(b, Pw, h, x, x, tl)];
    }),
  );
}
