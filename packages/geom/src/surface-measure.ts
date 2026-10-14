// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Surface measures: unit normal, first and second fundamental forms, principal
 * curvatures and directions, mean and Gaussian curvature, normal curvature in
 * a direction, and the limit normal on a collapsed edge (design §6.7).
 *
 * Conventions (design §4.7):
 *
 * - **Normal.** `n = Su × Sv / |Su × Sv|`. A surface built by geom's primitives
 *   with the right-hand rule has `n` pointing out of a closed solid (sphere,
 *   torus, cylinder).
 * - **Degenerate.** The normal is undefined where
 *   `|Su × Sv| ≤ degenerateRel · |Su| · |Sv|` (tangents parallel) or where a
 *   partial is rounding noise, `|Su| ≤ degenerateRel · M / L_u` (likewise v),
 *   with `M` the magnitude of the control points that affect the point (their
 *   largest absolute Euclidean coordinate, `max |x_i| / w_i`) and `L_u` the u
 *   domain length (period). The second test is the curves' rule
 *   (`Tolerances.degenerateRel`, same `M`): at a pole, `Su` is a sum of
 *   identical points times basis derivatives that cancel, so it is a few
 *   ε·M/L rather than exactly zero, and the scale-free test alone would accept
 *   it.
 * - **Forms.** `E = Su·Su`, `F = Su·Sv`, `G = Sv·Sv`; `L = Suu·n`, `M = Suv·n`,
 *   `N = Svv·n`. `EG − F²` is computed as `|Su × Sv|²` (the same quantity
 *   without cancellation).
 * - **Curvature signs.** A normal curvature `k = II/I` is positive where the
 *   surface bends **towards** `n`: a sphere with outward `n` has
 *   `k₁ = k₂ = −1/r`. `K = (LN − M²)/(EG − F²)`, `H = (EN − 2FM + GL)/(2(EG − F²))`,
 *   `k₁,₂ = H ± √(H² − K)` with `k₁ ≥ k₂`.
 * - **How they are computed.** The shape operator is written in the orthonormal
 *   tangent frame `e₁ = Su/|Su|`, `e₂ = n × e₁` as the symmetric matrix
 *   `[[a, b], [b, c]]` (`a = L/E`, `b = (EM − FL)/(E·|Su × Sv|)`,
 *   `c = (E²N − 2EFM + F²L)/(E·(EG − F²))`). Then `H = (a + c)/2`,
 *   `K = ac − b²` and `√(H² − K) = √(((a − c)/2)² + b²)`, a sum of squares: the
 *   textbook `√(H² − K)` cancels catastrophically near an umbilic (the sphere
 *   would lose half its digits, `k` off by `√ε ≈ 1.5·10⁻⁸`). The principal
 *   direction of `k₁` is at angle `½·atan2(2b, a − c)` from `e₁`.
 * - **Umbilics.** Where `H² − K ≤ umbilicRel · H²`, or where `√(H² − K)` is
 *   below the rounding floor of the second derivatives,
 *   `degenerateRel · M / (L_u · L_v · |Su| · |Sv|)` (a plane whose `II` is
 *   rounding noise), every direction is principal: the directions are `null`
 *   (plane, sphere, paraboloid apex). `k₁` and `k₂` are reported as computed.
 * - **Principal directions.** Unit tangent vectors; `d₂ = n × d₁`, so
 *   `(d₁, d₂, n)` is right-handed. The sign of `d₁` is not meaningful.
 *
 * The per-point kernel {@link surfaceMeasureAt} is shared with the sample plans,
 * so a plan's normals and curvatures equal these functions' bit for bit.
 */
import type { Scratch, ScratchImpl } from './array';
import { checkOut } from './array';
import { checkParam, sanitizeParam, spanOf } from './basis';
import { fail } from './errors';
import {
  checkSurfaceShape,
  evalSurfaceSpan,
  localMagnitude,
  ownScratch,
  surfaceScratch,
} from './surface';
import type { SurfaceSide } from './surface';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type { NurbsSurface, Point3, SurfaceEdge } from './types';

/** The normal at a point, or `degenerate` where it is undefined (a pole, a cusp, parallel tangents). */
export type NormalResult =
  | { readonly kind: 'regular'; readonly n: Point3 }
  | { readonly kind: 'degenerate' };

/** First (`E, F, G`) and second (`L, M, N`) fundamental form coefficients. */
export interface FundamentalForms {
  readonly E: number;
  readonly F: number;
  readonly G: number;
  readonly L: number;
  readonly M: number;
  readonly N: number;
}

/** Principal curvatures `k1 ≥ k2`, Gaussian `K`, mean `H`, the normal and the principal directions (`null` at umbilics). */
export interface Curvatures {
  readonly k1: number;
  readonly k2: number;
  readonly K: number;
  readonly H: number;
  readonly n: Point3;
  readonly d1: Point3 | null;
  readonly d2: Point3 | null;
}

/** Flag: the normal is undefined (outputs read 0). */
export const SAMPLE_DEGENERATE = 1;
/** Flag: an umbilic, every direction is principal. */
export const SAMPLE_UMBILIC = 2;

/** Offsets of the results of {@link surfaceMeasureAt} inside its region. */
export const MEASURE_N = 0;
export const MEASURE_FORMS = 3;
export const MEASURE_K = 9;
export const MEASURE_HK = 11;
/** The shape operator `[[a, b], [b, c]]` in the frame `(e₁, e₂)`: `a, b, c`. */
export const MEASURE_ABC = 13;

/**
 * The measure kernel. From `SKL` at `f[o …]` (6 slots of stride 3, to order
 * `nDer ≥ 1`) writes to `f[m …]`: the normal (3 values; zero when degenerate),
 * `E, F, G, L, M, N` (6; `L, M, N` only for `nDer = 2`, zero when degenerate),
 * `k1, k2` (2), `H, K` (2) and the shape operator `a, b, c` (3) (all only for
 * `nDer = 2`, zero when degenerate). Returns the flags. `scale` is
 * `degenerateRel · M`; `lu`, `lv` are the domain lengths: they set the
 * rounding floors of the module comment. Never NaN.
 */
export function surfaceMeasureAt(
  f: Float64Array,
  o: number,
  nDer: number,
  scale: number,
  lu: number,
  lv: number,
  degenerateRel: number,
  umbilicRel: number,
  m: number,
): number {
  const ux = f[o + 3]!;
  const uy = f[o + 4]!;
  const uz = f[o + 5]!;
  const vx = f[o + 6]!;
  const vy = f[o + 7]!;
  const vz = f[o + 8]!;
  const E = ux * ux + uy * uy + uz * uz;
  const F = ux * vx + uy * vy + uz * vz;
  const G = vx * vx + vy * vy + vz * vz;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const det = cx * cx + cy * cy + cz * cz;
  const c = Math.sqrt(det);
  const su = Math.sqrt(E);
  const sv = Math.sqrt(G);
  f[m + MEASURE_FORMS] = E;
  f[m + MEASURE_FORMS + 1] = F;
  f[m + MEASURE_FORMS + 2] = G;
  for (let k = MEASURE_FORMS + 3; k < MEASURE_ABC + 3; k++) f[m + k] = 0;
  if (!(su > scale / lu) || !(sv > scale / lv) || !(c > degenerateRel * su * sv)) {
    f[m] = 0;
    f[m + 1] = 0;
    f[m + 2] = 0;
    return SAMPLE_DEGENERATE;
  }
  const nx = cx / c;
  const ny = cy / c;
  const nz = cz / c;
  f[m] = nx;
  f[m + 1] = ny;
  f[m + 2] = nz;
  if (nDer < 2) return 0;
  const L = f[o + 9]! * nx + f[o + 10]! * ny + f[o + 11]! * nz;
  const M = f[o + 12]! * nx + f[o + 13]! * ny + f[o + 14]! * nz;
  const N = f[o + 15]! * nx + f[o + 16]! * ny + f[o + 17]! * nz;
  // The shape operator in the orthonormal frame (e1, e2) (module comment).
  const a = L / E;
  const b = (E * M - F * L) / (E * c);
  const d = (E * E * N - 2 * E * F * M + F * F * L) / (E * det);
  const H = 0.5 * (a + d);
  const half = 0.5 * (a - d);
  const root = Math.sqrt(half * half + b * b);
  f[m + MEASURE_FORMS + 3] = L;
  f[m + MEASURE_FORMS + 4] = M;
  f[m + MEASURE_FORMS + 5] = N;
  f[m + MEASURE_K] = H + root;
  f[m + MEASURE_K + 1] = H - root;
  f[m + MEASURE_HK] = H;
  f[m + MEASURE_HK + 1] = a * d - b * b;
  f[m + MEASURE_ABC] = a;
  f[m + MEASURE_ABC + 1] = b;
  f[m + MEASURE_ABC + 2] = d;
  const umbilic = root * root <= umbilicRel * H * H || root <= scale / (lu * lv * su * sv);
  return umbilic ? SAMPLE_UMBILIC : 0;
}

/**
 * Evaluates `SKL` at a sanitized point and runs {@link surfaceMeasureAt} into
 * `sc.f[sc.oM …]`; returns the flags. `M` for the floors is taken from the
 * span pair's control points (whose offsets the evaluation left in scratch).
 */
export function measureAt(
  s: NurbsSurface,
  u: number,
  v: number,
  nDer: number,
  sc: ScratchImpl,
  t: Tolerances,
  side?: SurfaceSide,
): number {
  evalSurfaceSpan(
    s,
    u,
    v,
    spanOf(s.u, u, side?.u === 'left'),
    spanOf(s.v, v, side?.v === 'left'),
    nDer,
    sc,
  );
  const Mloc = localMagnitude(s.cw, s.u.degree, s.v.degree, sc.iw, 0, sc.iw, sc.maxDegree + 1);
  return surfaceMeasureAt(
    sc.f,
    sc.oS,
    nDer,
    t.degenerateRel * Mloc,
    s.u.domain[1] - s.u.domain[0],
    s.v.domain[1] - s.v.domain[0],
    t.degenerateRel,
    t.umbilicRel,
    sc.oM,
  );
}

/** Validates `(u, v)` and measures there (allocating entry points). */
function measure(
  s: NurbsSurface,
  u: number,
  v: number,
  nDer: number,
  t: Tolerances,
  side?: SurfaceSide,
): { sc: ScratchImpl; flags: number } {
  checkSurfaceShape(s);
  const uu = checkParam(s.u, u, side?.u, t);
  const vv = checkParam(s.v, v, side?.v, t);
  const sc = ownScratch(s, nDer);
  return { sc, flags: measureAt(s, uu, vv, nDer, sc, t, side) };
}

const p3 = (f: Float64Array, o: number): Point3 => ({ x: f[o]!, y: f[o + 1]!, z: f[o + 2]! });

/** The unit normal `Su × Sv / |Su × Sv|` at `(u, v)`, or `degenerate` (module comment). */
export function surfaceNormal(
  s: NurbsSurface,
  u: number,
  v: number,
  tol?: Partial<Tolerances>,
): NormalResult {
  const { sc, flags } = measure(s, u, v, 1, resolveTolerances(tol));
  if (flags & SAMPLE_DEGENERATE) return Object.freeze({ kind: 'degenerate' });
  return Object.freeze({ kind: 'regular', n: p3(sc.f, sc.oM + MEASURE_N) });
}

function formsOf(f: Float64Array, o: number): FundamentalForms {
  return Object.freeze({
    E: f[o]!,
    F: f[o + 1]!,
    G: f[o + 2]!,
    L: f[o + 3]!,
    M: f[o + 4]!,
    N: f[o + 5]!,
  });
}

/** `E, F, G, L, M, N` at `(u, v)`, or `null` where the normal (hence `II`) is undefined. */
export function fundamentalForms(
  s: NurbsSurface,
  u: number,
  v: number,
  tol?: Partial<Tolerances>,
): FundamentalForms | null {
  const { sc, flags } = measure(s, u, v, 2, resolveTolerances(tol));
  if (flags & SAMPLE_DEGENERATE) return null;
  return formsOf(sc.f, sc.oM + MEASURE_FORMS);
}

/**
 * `E, F, G, L, M, N` at `(u, v)` into `out[o …]` (6 values); returns the flags
 * (`SAMPLE_DEGENERATE`: `L = M = N = 0`; `SAMPLE_UMBILIC`). Clamps or wraps the
 * parameters and never throws on them; allocates nothing. Default tolerances.
 */
export function fundamentalFormsInto(
  s: NurbsSurface,
  u: number,
  v: number,
  out: Float64Array,
  o: number,
  sc: Scratch,
): number {
  checkSurfaceShape(s);
  const impl = surfaceScratch(s, sc, 2);
  checkOut(out, o, 6, 'fundamentalFormsInto');
  const t = resolveTolerances();
  const flags = measureAt(s, sanitizeParam(s.u, u), sanitizeParam(s.v, v), 2, impl, t);
  const f = impl.f;
  for (let k = 0; k < 6; k++) out[o + k] = f[impl.oM + MEASURE_FORMS + k]!;
  return flags;
}

/**
 * Principal curvatures `k1 ≥ k2`, `K`, `H`, the normal and the principal
 * directions at `(u, v)`; `null` where the normal is degenerate. Signs and
 * umbilics as in the module comment.
 */
export function principalCurvatures(
  s: NurbsSurface,
  u: number,
  v: number,
  tol?: Partial<Tolerances>,
): Curvatures | null {
  const { sc, flags } = measure(s, u, v, 2, resolveTolerances(tol));
  if (flags & SAMPLE_DEGENERATE) return null;
  const f = sc.f;
  const m = sc.oM;
  const n = p3(f, m + MEASURE_N);
  const k1 = f[m + MEASURE_K]!;
  const k2 = f[m + MEASURE_K + 1]!;
  let d1: Point3 | null = null;
  let d2: Point3 | null = null;
  if (!(flags & SAMPLE_UMBILIC)) {
    // d1 = cos θ e1 + sin θ e2 with e1 = Su/|Su|, e2 = n × e1; d2 = n × d1.
    const Su = p3(f, sc.oS + 3);
    const su = Math.sqrt(f[m + MEASURE_FORMS]!);
    const e1 = { x: Su.x / su, y: Su.y / su, z: Su.z / su };
    const e2 = {
      x: n.y * e1.z - n.z * e1.y,
      y: n.z * e1.x - n.x * e1.z,
      z: n.x * e1.y - n.y * e1.x,
    };
    const a = f[m + MEASURE_ABC]!;
    const th = 0.5 * Math.atan2(2 * f[m + MEASURE_ABC + 1]!, a - f[m + MEASURE_ABC + 2]!);
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    d1 = { x: cs * e1.x + sn * e2.x, y: cs * e1.y + sn * e2.y, z: cs * e1.z + sn * e2.z };
    d2 = { x: cs * e2.x - sn * e1.x, y: cs * e2.y - sn * e1.y, z: cs * e2.z - sn * e1.z };
  }
  return Object.freeze({
    k1,
    k2,
    K: f[m + MEASURE_HK + 1]!,
    H: f[m + MEASURE_HK]!,
    n,
    d1,
    d2,
  });
}

/**
 * The normal curvature `II(t)/I(t)` in the tangent direction `t` that is the
 * projection of `direction` onto the tangent plane (sign as in the module
 * comment). `null` where the normal is degenerate or `direction` is within
 * `angle` of the normal (no tangent component).
 */
export function normalCurvature(
  s: NurbsSurface,
  u: number,
  v: number,
  direction: Point3,
  tol?: Partial<Tolerances>,
): number | null {
  const t = resolveTolerances(tol);
  if (
    !Number.isFinite(direction.x) ||
    !Number.isFinite(direction.y) ||
    !Number.isFinite(direction.z)
  ) {
    fail('non-finite', 'direction is not finite');
  }
  const { sc, flags } = measure(s, u, v, 2, t);
  if (flags & SAMPLE_DEGENERATE) return null;
  const f = sc.f;
  const fo = sc.oM + MEASURE_FORMS;
  const [E, F, G, L, M, N] = [f[fo]!, f[fo + 1]!, f[fo + 2]!, f[fo + 3]!, f[fo + 4]!, f[fo + 5]!];
  const Su = p3(f, sc.oS + 3);
  const Sv = p3(f, sc.oS + 6);
  const du = direction.x * Su.x + direction.y * Su.y + direction.z * Su.z;
  const dv = direction.x * Sv.x + direction.y * Sv.y + direction.z * Sv.z;
  // EG − F² as |Su × Sv|², without cancellation (as in the kernel).
  const cx = Su.y * Sv.z - Su.z * Sv.y;
  const cy = Su.z * Sv.x - Su.x * Sv.z;
  const cz = Su.x * Sv.y - Su.y * Sv.x;
  const det = cx * cx + cy * cy + cz * cz;
  const a = (G * du - F * dv) / det;
  const b = (E * dv - F * du) / det;
  const I = E * a * a + 2 * F * a * b + G * b * b;
  const dn = Math.sqrt(
    direction.x * direction.x + direction.y * direction.y + direction.z * direction.z,
  );
  // |t| = √I; the tangent component is |d|·sin(angle to n).
  if (!(Math.sqrt(I) > Math.sin(t.angle) * dn)) return null;
  return (L * a * a + 2 * M * a * b + N * b * b) / I;
}

/**
 * The normal on the edge `edge` at parameter `t` along it. Where the normal is
 * regular this is {@link surfaceNormal}. On a **collapsed** edge (a pole: the
 * edge curve is a point, so the partial along it vanishes) it is the limit
 * from inside the surface: on `v0` / `v1`, `Su ≈ (v − v_edge)·Suv` near the
 * edge, so `n → ±(Suv × Sv)/|Suv × Sv|` (`+` on `v0`, `−` on `v1`); on
 * `u0` / `u1`, `n → ±(Su × Suv)/|Su × Suv|`. `null` if that is degenerate too.
 * The edge's fixed direction must be clamped.
 */
export function limitNormal(
  s: NurbsSurface,
  edge: SurfaceEdge,
  t: number,
  tol?: Partial<Tolerances>,
): Point3 | null {
  checkSurfaceShape(s);
  if (edge !== 'u0' && edge !== 'u1' && edge !== 'v0' && edge !== 'v1') {
    fail('unsupported', `edge must be u0, u1, v0 or v1; got ${String(edge)}`);
  }
  const fixedU = edge[0] === 'u';
  const fixed = fixedU ? s.u : s.v;
  if (fixed.kind !== 'clamped') {
    fail(
      'unsupported',
      `edge ${edge} crosses the periodic ${edge[0]} direction: no natural boundary`,
    );
  }
  const at = edge[1] === '0' ? fixed.domain[0] : fixed.domain[1];
  const tl = resolveTolerances(tol);
  const { sc, flags } = fixedU ? measure(s, at, t, 2, tl) : measure(s, t, at, 2, tl);
  const f = sc.f;
  if (!(flags & SAMPLE_DEGENERATE)) return p3(f, sc.oM + MEASURE_N);
  const o = sc.oS;
  // a × b with a = Suv, b = Sv (v edges) or a = Su, b = Suv (u edges).
  const a = fixedU ? p3(f, o + 3) : p3(f, o + 12);
  const b = fixedU ? p3(f, o + 12) : p3(f, o + 6);
  const sign = edge[1] === '0' ? 1 : -1;
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  const c = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const na = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const nb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  if (!(c > tl.degenerateRel * na * nb) || !(c > 0)) return null;
  return { x: (sign * cx) / c, y: (sign * cy) / c, z: (sign * cz) / c };
}
