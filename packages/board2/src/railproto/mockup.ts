// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A surface swept from the rail laws, for looking at (`docs/design/rail-laws-test.md`
 * §What I did not measure, "Continuity along the board"). Scratch module: the engine never
 * imports it.
 *
 * The study measured every station **in isolation**. This builds the other thing — one
 * surface, swept along the board from the two law curves — so that the question the tables
 * cannot answer can be asked of a picture: is a law-swept rail *fair* along x, or does it
 * ripple between the stations it was fitted at?
 *
 * What is law-driven and what is not, because the distinction is the whole point:
 *
 * - **The rails are law-driven.** At every swept station the tangent points come from the
 *   70-degree convention, rho comes from the fitted law curve at that x, and the two conics
 *   are built from those three numbers and the apex.
 * - **The panels are not.** The study never modelled them; they are taken from the as-built
 *   section, exactly as the study's fit took them. A station's panel is therefore identical
 *   on both surfaces and its deviation is zero *by construction*, not by merit.
 *
 * Both surfaces are sampled on **one grid** — the same rows (ξ), the same column schedule —
 * so a difference in shading between them is a difference in the surfaces and not in their
 * meshes. `meshBoard`'s own adaptive mesh is emitted alongside as the honest reference,
 * since a matched grid is a choice and not a neutral one.
 */
import { funcEval } from '../chain';
import { frameAt } from '../frame';
import { meshBoard } from '../mesh';
import { createChordFn, probeSection } from '../probe';
import { buildBoard, createEvaluator } from '../surface';
import type { BuiltBoard, SurfaceEvaluator } from '../surface';
import { blend, fitPinned, halfDeviation } from './rail-fit';
import type { Half } from './rail-fit';
import { conicPolyline, fromPolyline, sampleAt } from './rail-geom';
import type { P2, RealSection } from './rail-geom';
import { LAW_PENALTY, fitLaw, lawAt, optimiseLaws } from './rail-laws';
import type { Law } from './rail-laws';
import {
  MIN_CHORD,
  MIN_THICKNESS,
  MOCKUP_COLUMN_BIAS,
  MOCKUP_FIT_STATIONS,
  MOCKUP_HALF_COLUMNS,
  MOCKUP_LAW_DOF,
  MOCKUP_LAW_ITERS,
  MOCKUP_LAW_SWEEPS,
  MOCKUP_SWEEP_STATIONS,
  MOCKUP_TURN_PROBES,
  RHO_MAX,
  RHO_MIN,
  SECTION_SAMPLES,
  TURN_CEIL,
  TURN_FLOOR,
} from './rail-params';
import type { StudyBoard } from './rail-samples';

// ---------------------------------------------------------------------------
// Sections, and the lift back into three dimensions
// ---------------------------------------------------------------------------

/** The as-built section at ξ in the section editor's frame: the frame the study fits in. */
function probeReal(
  built: BuiltBoard,
  ev: SurfaceEvaluator,
  side: 0 | 1,
  xi: number,
  chord: number,
  thickness: number,
): RealSection {
  const n = SECTION_SAMPLES;
  const pts = Float64Array.from(probeSection(built, ev, side, xi, 2 * n + 1));
  return fromPolyline(pts, n, xi, chord, thickness);
}

/** `(y, z) -> (X, Y, Z)` at one station of one side, plus that station's chord and thickness. */
interface SectionLift {
  (y: number, z: number, out: Float64Array): void;
  readonly chord: number;
  readonly thickness: number;
}

/**
 * The inverse of what `probeSection` measured, which is the same arithmetic the surface
 * evaluator itself does (`X = ξ + u·a`, `Y = ±u·b`, `Z = R(X) + T(X)·v`). Using the engine's
 * own lift means a ripple seen in the result is the section model's, never the lift's.
 */
function liftAt(built: BuiltBoard, side: 0 | 1, xi: number): SectionLift {
  const P = new Float64Array(6);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  frameAt(built.sides[side].frame, xi, P);
  const a = P[0]! - xi;
  const b = P[1]!;
  const sign = built.sides[side].sign;
  const chord = Math.hypot(a, b);
  funcEval(built.rocker, xi, r, 0);
  funcEval(built.deck, xi, d, 0);
  const thickness = d[0]! - r[0]!;
  const fn = (y: number, z: number, out: Float64Array): void => {
    const u = chord > 0 ? y / chord : 0;
    const v = thickness > 0 ? z / thickness : 0;
    const X = xi + u * a;
    funcEval(built.rocker, X, r, 0);
    funcEval(built.deck, X, d, 0);
    out[0] = X;
    out[1] = sign === 1 ? u * b : 0 - u * b;
    out[2] = r[0]! + (d[0]! - r[0]!) * v;
  };
  return Object.assign(fn, { chord, thickness });
}

// ---------------------------------------------------------------------------
// Polyline helpers
// ---------------------------------------------------------------------------

/** Cumulative arc length of a `[y0, z0, y1, z1, …]` polyline. */
function arcTable(pts: Float64Array): Float64Array {
  const n = pts.length / 2;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] =
      arc[i - 1]! + Math.hypot(pts[2 * i]! - pts[2 * i - 2]!, pts[2 * i + 1]! - pts[2 * i - 1]!);
  }
  return arc;
}

/** The point at arc fraction `f` of a polyline, into `out`. */
function atFraction(pts: Float64Array, arc: Float64Array, f: number, out: Float64Array): void {
  const n = arc.length;
  const want = Math.max(0, Math.min(1, f)) * arc[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arc[mid]! <= want) lo = mid;
    else hi = mid;
  }
  const a = arc[lo]!;
  const b = arc[hi]!;
  const g = b > a ? (want - a) / (b - a) : 0;
  out[0] = pts[2 * lo]! + (pts[2 * hi]! - pts[2 * lo]!) * g;
  out[1] = pts[2 * lo + 1]! + (pts[2 * hi + 1]! - pts[2 * lo + 1]!) * g;
}

/**
 * Signed distance from `(y, z)` to a section polyline, cm, positive when the point is
 * outboard of it (along the section's outward normal `(t_z, -t_y)`).
 *
 * An exhaustive scan over segments. The rail region has several local minima in
 * distance-along-the-curve, and a marching search walks into the wrong one — the study's
 * yardstick carries that scar (`rail-geom.ts`), and this is a generator run once.
 */
function signedDistance(pts: Float64Array, y: number, z: number): number {
  const segs = pts.length / 2 - 1;
  let best = Infinity;
  let sign = 1;
  for (let k = 0; k < segs; k++) {
    const qy = pts[2 * k]!;
    const qz = pts[2 * k + 1]!;
    const ey = pts[2 * k + 2]! - qy;
    const ez = pts[2 * k + 3]! - qz;
    const ee = ey * ey + ez * ez;
    const wy = y - qy;
    const wz = z - qz;
    const f = ee > 0 ? Math.min(1, Math.max(0, (wy * ey + wz * ez) / ee)) : 0;
    const dy = wy - f * ey;
    const dz = wz - f * ez;
    const d = Math.hypot(dy, dz);
    if (d < best) {
      best = d;
      sign = dy * ez - dz * ey >= 0 ? 1 : -1;
    }
  }
  return best === Infinity ? 0 : sign * best;
}

const clampRho = (r: number): number => Math.max(RHO_MIN, Math.min(RHO_MAX, r));

// ---------------------------------------------------------------------------
// The law-built section
// ---------------------------------------------------------------------------

/** One half of a law-built section, written centre -> apex. */
interface LawHalf {
  readonly pts: Float64Array;
  /** Arc fraction of the half at which the conic takes over; 1 when it never does. */
  readonly tangentFraction: number;
  /** The tangent point, or `null` where no conic is tangent to both ends. */
  readonly tangentPoint: P2 | null;
  /** True when the model does not apply here and the section's own curve carries the half. */
  readonly fallback: boolean;
}

/** A section half reversed, so both halves can be written centre -> apex. */
function reversedHalf(s: RealSection): Float64Array {
  const n = s.count - s.apex;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const j = s.count - 1 - i;
    out[2 * i] = s.pts[2 * j]!;
    out[2 * i + 1] = s.pts[2 * j + 1]!;
  }
  return out;
}

/**
 * One half of a section as the laws build it: the section's own panel out to the 70-degree
 * tangent point, then a conic of shape `rho` to the apex.
 *
 * When no conic is tangent to both ends — the thin-wedge sections the study found below
 * x/L 0.45, where the panel tangent and the vertical apex tangent diverge — the half falls
 * back to the section's own curve and says so. That is a convention, not a fit, and the
 * viewer marks every station where it fires: where the model does not apply matters as much
 * as where it does.
 */
function lawHalf(s: RealSection, half: Half, rho: number): LawHalf {
  const b = blend(s, half, TURN_FLOOR, rho);
  if (b === null) {
    const pts = half === 'bottom' ? s.pts.slice(0, 2 * (s.apex + 1)) : reversedHalf(s);
    return { pts, tangentFraction: 1, tangentPoint: null, fallback: true };
  }
  // `blend` gives the conic from the tangent point to the apex on the bottom half and from
  // the apex to the tangent point on the deck half; both are wanted centre -> apex.
  const f = half === 'bottom' ? b.from : b.to;
  const conic = conicPolyline(b.conic);
  const nc = conic.length / 2;
  const panel: number[] = [];
  if (half === 'bottom') {
    for (let i = 0; i < f; i++) panel.push(s.pts[2 * i]!, s.pts[2 * i + 1]!);
  } else {
    for (let i = s.count - 1; i > f; i--) panel.push(s.pts[2 * i]!, s.pts[2 * i + 1]!);
  }
  const pts = new Float64Array(panel.length + conic.length);
  pts.set(panel, 0);
  if (half === 'bottom') {
    pts.set(conic, panel.length);
  } else {
    for (let i = 0; i < nc; i++) {
      pts[panel.length + 2 * i] = conic[2 * (nc - 1 - i)]!;
      pts[panel.length + 2 * i + 1] = conic[2 * (nc - 1 - i) + 1]!;
    }
  }
  const arc = arcTable(pts);
  const total = arc[arc.length - 1]!;
  return {
    pts,
    tangentFraction: total > 0 ? arc[panel.length / 2]! / total : 1,
    tangentPoint: sampleAt(s, f).p,
    fallback: false,
  };
}

// ---------------------------------------------------------------------------
// The column schedule
// ---------------------------------------------------------------------------

/**
 * Arc fractions of a section half's columns, centre (0) to apex (1).
 *
 * Spacing is exponential towards the apex, so most columns land in the rail band — the
 * blend is some 30 mm of a 250 mm half, and a uniform ladder would spend eight columns on
 * the thing being judged. The schedule is the **same at every station**, so the grid is
 * smooth along the board; anchoring it to the tangent point would kink the mesh wherever
 * the tangent point moved, and the mockup would then show a ripple it had made itself.
 */
export function columnFractions(h: number, bias: number): Float64Array {
  const out = new Float64Array(h + 1);
  const e = Math.exp(-bias);
  for (let j = 0; j <= h; j++) {
    out[j] = 1 - (Math.exp((-bias * j) / h) - e) / (1 - e);
  }
  out[0] = 0;
  out[h] = 1;
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface MockupStation {
  readonly x: number;
  /** Position along the swept range, 0 at the first station and 1 at the last. */
  readonly t: number;
  readonly chord: number;
  readonly thickness: number;
  readonly rhoTuck: number;
  readonly rhoRail: number;
  /** Arc fraction of each half at which its conic takes over; 1 where it does not. */
  readonly tangentTuck: number;
  readonly tangentRail: number;
  readonly fallbackTuck: boolean;
  readonly fallbackRail: boolean;
  /**
   * Smallest turn angle in `[TURN_FLOOR, TURN_CEIL]` at which that half has a blend at all,
   * or 0 when none does.
   *
   * This separates two very different failures at a fallback station. If the number is
   * above 70, a conic *exists* here and only the 70-degree convention cannot reach it —
   * a convention's cost, fixable by a convention. If it is 0, no conic is tangent to both
   * ends at any tangent point the study allows, and the station is outside the model.
   */
  readonly blendFromTuck: number;
  readonly blendFromRail: number;
  /** Largest |deviation| over this station's columns, cm. */
  readonly maxDev: number;
}

export interface MockupSide {
  readonly side: 0 | 1;
  readonly rows: number;
  readonly cols: number;
  /** Law-built surface, `x y z` per vertex, row-major, apex at column `(cols - 1) / 2`. */
  readonly law: Float32Array;
  /** The as-built surface on the same grid. */
  readonly engine: Float32Array;
  /** Signed deviation of the law surface from the as-built section, cm, per vertex. */
  readonly dev: Float32Array;
  /** `x y z` per row of the two tangent points and the apex: the model's own seams. */
  readonly tuckLine: Float32Array;
  readonly apexLine: Float32Array;
  readonly railLine: Float32Array;
  readonly stations: readonly MockupStation[];
  /** Mean |third difference along x, on the normal| per column, µm: the ripple measure. */
  readonly wobbleLaw: Float32Array;
  readonly wobbleEngine: Float32Array;
  /** Mean |second difference along x, on the normal| per column, µm: the curvature scale. */
  readonly sagLaw: Float32Array;
  readonly sagEngine: Float32Array;
  /**
   * Mean |third difference along x of the deviation| per column, µm — the ripple the law
   * surface *adds*. The board's own shape cancels, so this is the honest number: whatever
   * the two surfaces share, fair or not, is gone from it, and what is left is the law
   * surface moving off the smooth one at the row spacing.
   */
  readonly devWobble: Float32Array;
}

export interface MockupMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly volume: number;
  readonly triangleCount: number;
}

export interface MockupBoard {
  readonly name: string;
  readonly group: string;
  readonly length: number;
  readonly x0: number;
  readonly x1: number;
  readonly symmetry: string;
  readonly lawTuck: Law;
  readonly lawRail: Law;
  /** Worst station of the pinned per-station fit, cm: what the law is being compared with. */
  readonly perStationWorst: number;
  readonly sides: readonly MockupSide[];
  readonly engineMesh: MockupMesh;
}

// ---------------------------------------------------------------------------
// Fitting the two laws
// ---------------------------------------------------------------------------

/**
 * The law of one half, fitted on probed sections by coordinate descent against the sections
 * themselves — the study's own method, with the turn angle pinned at the convention
 * (`turnScale` 0 freezes its coefficients) so rho is the only thing a law carries.
 *
 * Stations with no blend at any rho are left out of the cost: no law value works there and
 * charging the law for them says nothing about laws. They come back as fallbacks in the
 * sweep, where they are marked.
 */
function fitHalfLaw(
  sections: readonly RealSection[],
  ts: readonly number[],
  half: Half,
  dof: number,
): { law: Law; perStation: readonly (number | null)[] } {
  const fits = sections.map((s) => fitPinned(s, half, TURN_FLOOR));
  const usable = fits.map((f) => f !== null);
  const found = fits.filter((f) => f !== null).map((f) => f!.rho);
  const fallbackRho = found.length > 0 ? [...found].sort((a, b) => a - b)[found.length >> 1]! : 0.5;
  const rhos = fits.map((f) => f?.rho ?? fallbackRho);
  const cost = (_turns: readonly number[], rs: readonly number[]): number => {
    let m = 0;
    let fails = 0;
    for (let i = 0; i < sections.length; i++) {
      if (!usable[i]) continue;
      const d = halfDeviation(sections[i]!, half, TURN_FLOOR, clampRho(rs[i]!));
      if (d === null) fails += 1;
      else m = Math.max(m, d.max);
    }
    // A flat plateau would stall the line search, so a failure's cost counts them.
    return m + LAW_PENALTY * fails;
  };
  const start = {
    turn: fitLaw(
      ts,
      ts.map(() => TURN_FLOOR),
      dof,
    ),
    rho: fitLaw(ts, rhos, dof),
  };
  const r = optimiseLaws(ts, start, cost, MOCKUP_LAW_SWEEPS, MOCKUP_LAW_ITERS, 0);
  return { law: r.rho, perStation: fits.map((f) => f?.max ?? null) };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface MockupOptions {
  readonly fitStations?: number;
  readonly sweepStations?: number;
  readonly halfColumns?: number;
  /**
   * Degrees of freedom per law curve, default {@link MOCKUP_LAW_DOF}. Lowering it is the
   * mockup's own control: a law too poor to follow the board should show as a ripple, and
   * if it does not, the mockup cannot see one and says nothing when it finds none.
   */
  readonly lawDof?: number;
  /**
   * A sine added to both rho laws along the board: the mockup's calibration.
   *
   * "I looked and saw no ripple" is worth nothing until the instrument has been shown a
   * ripple it should catch. This puts one in on purpose — `amplitude` in rho, `periods`
   * over the swept range — so the picture that comes out can be compared with the picture
   * the real laws give, and the honest claim becomes "a ripple of *this* size would have
   * been obvious, and there is none".
   */
  readonly rhoRipple?: { readonly amplitude: number; readonly periods: number };
}

/** Builds the law-swept surface, the matched as-built surface and the engine mesh of a board. */
export function buildMockup(b: StudyBoard, opts: MockupOptions = {}): MockupBoard {
  const built = buildBoard(b.doc, { check: false });
  if (!built.ok) throw new Error(`${b.name}: ${built.issues.map((i) => i.message).join('; ')}`);
  const board = built.value;
  const ev = createEvaluator(board);
  const fitN = opts.fitStations ?? MOCKUP_FIT_STATIONS;
  const sweepN = opts.sweepStations ?? MOCKUP_SWEEP_STATIONS;
  const h = opts.halfColumns ?? MOCKUP_HALF_COLUMNS;
  const asym = b.doc.symmetry !== 'mirror';
  const sideIds: (0 | 1)[] = asym ? [0, 1] : [0];
  const range = usableRange(board, b.doc);
  const sides: MockupSide[] = [];
  let perStationWorst = 0;
  let lawTuck: Law | null = null;
  let lawRail: Law | null = null;

  for (const side of sideIds) {
    const sectionAt = (xi: number): RealSection => {
      const lift = liftAt(board, side, xi);
      return probeReal(board, ev, side, xi, lift.chord, lift.thickness);
    };
    const fitXs = Array.from(
      { length: fitN },
      (_, i) => range.x0 + ((range.x1 - range.x0) * i) / (fitN - 1),
    );
    const fitSections = fitXs.map(sectionAt);
    const fitTs = fitXs.map((x) => (x - range.x0) / (range.x1 - range.x0));
    const dof = opts.lawDof ?? MOCKUP_LAW_DOF;
    const tuck = fitHalfLaw(fitSections, fitTs, 'bottom', dof);
    const rail = fitHalfLaw(fitSections, fitTs, 'deck', dof);
    for (const v of [...tuck.perStation, ...rail.perStation]) {
      if (v !== null) perStationWorst = Math.max(perStationWorst, v);
    }
    lawTuck ??= tuck.law;
    lawRail ??= rail.law;
    sides.push(
      sweepSide(board, side, range, tuck.law, rail.law, sweepN, h, sectionAt, opts.rhoRipple),
    );
  }

  const mesh = meshBoard(board);
  return {
    name: b.name,
    group: b.group,
    length: board.xiMax,
    x0: range.x0,
    x1: range.x1,
    symmetry: b.doc.symmetry,
    lawTuck: lawTuck!,
    lawRail: lawRail!,
    perStationWorst,
    sides,
    engineMesh: {
      positions: mesh.positions,
      indices: mesh.indices,
      volume: mesh.volume,
      triangleCount: mesh.triangleCount,
    },
  };
}

/** First and last stored station with a rail to model: the study's own range. */
function usableRange(
  board: BuiltBoard,
  doc: StudyBoard['doc'],
): { readonly x0: number; readonly x1: number } {
  const chordOf = createChordFn(doc);
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  const xs: number[] = [];
  for (const st of doc.stations) {
    funcEval(board.rocker, st.x, r, 0);
    funcEval(board.deck, st.x, d, 0);
    if (d[0]! - r[0]! >= MIN_THICKNESS && chordOf(st.x) >= MIN_CHORD) xs.push(st.x);
  }
  if (xs.length < 2) return { x0: board.xiMin, x1: board.xiMax };
  return { x0: Math.min(...xs), x1: Math.max(...xs) };
}

function sweepSide(
  board: BuiltBoard,
  side: 0 | 1,
  range: { readonly x0: number; readonly x1: number },
  lawT: Law,
  lawR: Law,
  rows: number,
  h: number,
  sectionAt: (xi: number) => RealSection,
  ripple?: { readonly amplitude: number; readonly periods: number },
): MockupSide {
  const cols = 2 * h + 1;
  const frac = columnFractions(h, MOCKUP_COLUMN_BIAS);
  const law = new Float32Array(3 * rows * cols);
  const engine = new Float32Array(3 * rows * cols);
  const dev = new Float32Array(rows * cols);
  const tuckLine = new Float32Array(3 * rows);
  const railLine = new Float32Array(3 * rows);
  const apexLine = new Float32Array(3 * rows);
  const stations: MockupStation[] = [];
  const out = new Float64Array(3);
  const p = new Float64Array(2);

  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const xi = range.x0 + (range.x1 - range.x0) * t;
    const s = sectionAt(xi);
    const lift = liftAt(board, side, xi);
    const wave =
      ripple === undefined ? 0 : ripple.amplitude * Math.sin(2 * Math.PI * ripple.periods * t);
    const rhoT = clampRho(lawAt(lawT, t) + wave);
    const rhoR = clampRho(lawAt(lawR, t) + wave);
    const hb = lawHalf(s, 'bottom', rhoT);
    const hd = lawHalf(s, 'deck', rhoR);
    const halves = [
      { lawPts: hb.pts, engPts: s.pts.slice(0, 2 * (s.apex + 1)), out: 1 },
      { lawPts: hd.pts, engPts: reversedHalf(s), out: -1 },
    ] as const;
    let maxDev = 0;
    for (const hf of halves) {
      const la = arcTable(hf.lawPts);
      const ea = arcTable(hf.engPts);
      for (let j = 0; j <= h; j++) {
        // Column h is the apex, shared by the halves; written once, from the bottom one.
        if (hf.out === -1 && j === h) continue;
        const col = hf.out === 1 ? j : 2 * h - j;
        const v = i * cols + col;
        atFraction(hf.lawPts, la, frac[j]!, p);
        const d = signedDistance(s.pts, p[0]!, p[1]!);
        dev[v] = d;
        if (Math.abs(d) > maxDev) maxDev = Math.abs(d);
        lift(p[0]!, p[1]!, out);
        law[3 * v] = out[0]!;
        law[3 * v + 1] = out[1]!;
        law[3 * v + 2] = out[2]!;
        atFraction(hf.engPts, ea, frac[j]!, p);
        lift(p[0]!, p[1]!, out);
        engine[3 * v] = out[0]!;
        engine[3 * v + 1] = out[1]!;
        engine[3 * v + 2] = out[2]!;
      }
    }
    const apex: P2 = [s.pts[2 * s.apex]!, s.pts[2 * s.apex + 1]!];
    writeLifted(lift, hb.tangentPoint ?? apex, out, tuckLine, i);
    writeLifted(lift, hd.tangentPoint ?? apex, out, railLine, i);
    writeLifted(lift, apex, out, apexLine, i);
    stations.push({
      x: xi,
      t,
      chord: lift.chord,
      thickness: lift.thickness,
      rhoTuck: rhoT,
      rhoRail: rhoR,
      tangentTuck: hb.tangentFraction,
      tangentRail: hd.tangentFraction,
      fallbackTuck: hb.fallback,
      fallbackRail: hd.fallback,
      blendFromTuck: lowestBlendTurn(s, 'bottom'),
      blendFromRail: lowestBlendTurn(s, 'deck'),
      maxDev,
    });
  }

  return {
    side,
    rows,
    cols,
    law,
    engine,
    dev,
    tuckLine,
    apexLine,
    railLine,
    stations,
    wobbleLaw: wobble(law, rows, cols, 3),
    wobbleEngine: wobble(engine, rows, cols, 3),
    sagLaw: wobble(law, rows, cols, 2),
    sagEngine: wobble(engine, rows, cols, 2),
    devWobble: scalarWobble(dev, rows, cols),
  };
}

/** Mean |third difference along x| of a per-vertex scalar, per column, in µm. */
function scalarWobble(v: Float32Array, rows: number, cols: number): Float32Array {
  const out = new Float32Array(cols);
  for (let j = 0; j < cols; j++) {
    let sum = 0;
    let n = 0;
    for (let i = 1; i + 2 < rows; i++) {
      sum += Math.abs(
        v[(i + 2) * cols + j]! -
          3 * v[(i + 1) * cols + j]! +
          3 * v[i * cols + j]! -
          v[(i - 1) * cols + j]!,
      );
      n += 1;
    }
    out[j] = n > 0 ? (sum / n) * 10000 : 0;
  }
  return out;
}

/**
 * The smallest turn angle at which a half has a blend, scanned over `[TURN_FLOOR,
 * TURN_CEIL]`, or 0 when none in that band does. Blend *existence* does not depend on rho —
 * it is `turnIndex` finding the tangent point and the two end tangents meeting — so one
 * scan answers it for every rho.
 */
function lowestBlendTurn(s: RealSection, half: Half): number {
  for (let i = 0; i <= MOCKUP_TURN_PROBES; i++) {
    const turn = TURN_FLOOR + ((TURN_CEIL - TURN_FLOOR) * i) / MOCKUP_TURN_PROBES;
    if (blend(s, half, turn, 0.5) !== null) return turn;
  }
  return 0;
}

function writeLifted(
  lift: SectionLift,
  p: P2,
  out: Float64Array,
  dst: Float32Array,
  i: number,
): void {
  lift(p[0], p[1], out);
  dst[3 * i] = out[0]!;
  dst[3 * i + 1] = out[1]!;
  dst[3 * i + 2] = out[2]!;
}

/**
 * Mean |`order`-th difference of position along x, projected on the surface normal| per
 * column, in µm: how much the surface moves off its own local trend along the board.
 *
 * Order 2 is the sagitta — a curvature scale, large wherever the board is simply curved.
 * Order 3 is the *change* in that curvature, which is what a ripple is and what zebra
 * stripes show. The rows are evenly spaced in ξ, so the differences are comparable along a
 * board and between the two surfaces, which share this grid.
 */
function wobble(pos: Float32Array, rows: number, cols: number, order: 2 | 3): Float32Array {
  const out = new Float32Array(cols);
  const at = (i: number, j: number): number => 3 * (i * cols + j);
  for (let j = 0; j < cols; j++) {
    const ja = Math.max(0, j - 1);
    const jb = Math.min(cols - 1, j + 1);
    let sum = 0;
    let n = 0;
    for (let i = 1; i + order - 1 < rows; i++) {
      const ax = pos[at(i + 1, j)]! - pos[at(i - 1, j)]!;
      const ay = pos[at(i + 1, j) + 1]! - pos[at(i - 1, j) + 1]!;
      const az = pos[at(i + 1, j) + 2]! - pos[at(i - 1, j) + 2]!;
      const bx = pos[at(i, jb)]! - pos[at(i, ja)]!;
      const by = pos[at(i, jb) + 1]! - pos[at(i, ja) + 1]!;
      const bz = pos[at(i, jb) + 2]! - pos[at(i, ja) + 2]!;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      if (len === 0) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      let dx: number;
      let dy: number;
      let dz: number;
      if (order === 2) {
        dx = pos[at(i + 1, j)]! - 2 * pos[at(i, j)]! + pos[at(i - 1, j)]!;
        dy = pos[at(i + 1, j) + 1]! - 2 * pos[at(i, j) + 1]! + pos[at(i - 1, j) + 1]!;
        dz = pos[at(i + 1, j) + 2]! - 2 * pos[at(i, j) + 2]! + pos[at(i - 1, j) + 2]!;
      } else {
        dx = pos[at(i + 2, j)]! - 3 * pos[at(i + 1, j)]! + 3 * pos[at(i, j)]! - pos[at(i - 1, j)]!;
        dy =
          pos[at(i + 2, j) + 1]! -
          3 * pos[at(i + 1, j) + 1]! +
          3 * pos[at(i, j) + 1]! -
          pos[at(i - 1, j) + 1]!;
        dz =
          pos[at(i + 2, j) + 2]! -
          3 * pos[at(i + 1, j) + 2]! +
          3 * pos[at(i, j) + 2]! -
          pos[at(i - 1, j) + 2]!;
      }
      sum += Math.abs(dx * nx + dy * ny + dz * nz);
      n += 1;
    }
    // cm -> µm
    out[j] = n > 0 ? (sum / n) * 10000 : 0;
  }
  return out;
}
