// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Path A of the OCCT protocol (design §15.3): a B-rep as OpenCascade's native
 * BREP text ("CASCADE Topology V3"), read by `BRepTools::Read` (`occt-wasm`'s
 * `fromBREP`). Unlike the STEP reader, that path runs **no shape healing**: a
 * face flipped in its shell or an edge flipped in its wire stays flipped, so
 * `BRepCheck_Analyzer` judges the orientation exactly as we built it. This is
 * the only OCCT check that can see an orientation error (§15.2), and it judges
 * `checkBrep` independently. Test-only: nothing in the main entry uses it.
 *
 * ## The mapping
 *
 * - Geometry is written as B-splines (curve type 7, surface type 9) with
 *   Euclidean poles and, when rational, the weights; knots as stored, grouped
 *   into distinct values and multiplicities by exact equality. Periodic
 *   surfaces go through the exact clamped conversion `writeStep` uses
 *   (`clampSurface`, same parameter domain), so pcurves are unchanged. Lengths
 *   are scaled from `modelUnit` to `unit`; parameters, weights and pcurves never
 *   are. Numbers are the shortest decimal that reads back as the same double.
 * - One surface entry per face (never shared): OCCT keys an edge's pcurves by
 *   surface, so two faces on one surface object would look like a seam.
 * - A face's wires are its loops in **surface orientation** (OCCT's TFace
 *   frame: the outer wire counterclockwise in (u, v)): our loops are in face
 *   orientation, so they are written as they are when `sameSense` and reversed
 *   (coedges backwards, senses toggled) when not; the face then enters the
 *   shell `+` when `sameSense`, `-` when not. Composing the two gives every
 *   edge its face-orientation direction in the shell, which is how OCCT checks
 *   that a closed shell uses each edge once each way.
 * - An edge is its whole curve, `SameParameter` and `SameRange` (makeBrep
 *   checks that the pcurves run over the edge's domain), with one pcurve per
 *   face (representation 2) or, on a seam, the two pcurves of a curve on a
 *   closed surface (representation 3): the first for the use that runs
 *   forward in the surface-oriented wire, the second for the reversed one
 *   (`BRep_Tool::CurveOnSurface`'s rule). Its start vertex is `+`, its end `-`.
 * - Tolerances: every vertex, edge and face gets the uncertainty `writeStep`
 *   declares for the same B-rep and options (`declaredUncertainty`: twice the
 *   measured gaps, floored at `Tolerances.point`), so the two paths are
 *   compared on equal terms.
 *
 * The format is the one `toBREP` emits for our own STEP imports (record
 * layout, flags and the reversed sub-shape numbering: the k-th of N shapes
 * written is referenced as `N − k + 1`); the `Checked` flag is written 0 so
 * nothing claims an analysis that never ran. Collapsed (degenerate) edges are
 * outside the B-rep scope (`makeBrep`) and are not encoded.
 */
import { clampSurface } from '../brep/clamp';
import { checkBrep } from '../brep/check';
import type { BrepReport } from '../brep/check';
import { fail } from '../errors';
import { declaredUncertainty, writerTolerances } from '../step/write';
import type { Tolerances } from '../tolerance';
import type { Brep, BrepLoop, ClampedCurve, NurbsSurface } from '../types';

export interface OcctBrepOptions {
  /** Unit of the written coordinates (default `'mm'`, as `writeStep`'s file unit). */
  readonly unit?: 'mm' | 'cm';
  /** Unit of the B-rep's coordinates (default `'cm'`, the kernel's unit). */
  readonly modelUnit?: 'mm' | 'cm';
  /** Overrides for the tolerances of the check, lengths in `modelUnit` (as `writeStep`). */
  readonly tol?: Partial<Tolerances>;
}

export interface OcctBrepUncheckedOptions extends OcctBrepOptions {
  /**
   * The tolerance to write on every shape, in `unit` (default `Tolerances.point`
   * scaled to `unit`). A negative control passes the one {@link toOcctBrepText}
   * declared for the intact solid, so the defect is the only difference.
   */
  readonly tolerance?: number;
}

export interface OcctBrepResult {
  readonly text: string;
  /** The tolerance written on every vertex, edge and face, in `unit`. */
  readonly tolerance: number;
}

/** Millimetres per unit. */
const MM: Readonly<Record<'mm' | 'cm', number>> = { mm: 1, cm: 10 };

/** The shortest decimal that reads back as `x` (`-0` as `0`); non-finite numbers throw. */
function num(x: number): string {
  if (!Number.isFinite(x)) fail('non-finite', `cannot write a non-finite number: ${x}`);
  return String(x === 0 ? 0 : x);
}

/** Distinct knots with their multiplicities (exact equality), as `k m k m …`. */
function knotPairs(knots: ArrayLike<number>): { readonly count: number; readonly pairs: string[] } {
  const values: number[] = [];
  const mults: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const k = knots[i]!;
    if (values.length > 0 && values[values.length - 1] === k) mults[mults.length - 1]!++;
    else {
      values.push(k);
      mults.push(1);
    }
  }
  return { count: values.length, pairs: values.map((k, i) => `${num(k)} ${mults[i]}`) };
}

/** A clamped curve (2D or 3D) as `Geom(2d)_BSplineCurve` (type 7); 3D lengths scaled. */
function curveRecord(c: ClampedCurve<2> | ClampedCurve<3>, scale: number): string {
  const dim = c.dim;
  const h = dim + 1;
  const n = c.basis.count;
  const poles: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = c.cw[i * h + dim]!;
    const xs: string[] = [];
    for (let k = 0; k < dim; k++) xs.push(num((c.cw[i * h + k]! / w) * scale));
    if (c.rational) xs.push(num(w));
    poles.push(xs.join(' '));
  }
  const k = knotPairs(c.basis.knots);
  return `7 ${c.rational ? 1 : 0} 0  ${c.basis.degree} ${n} ${k.count}  ${poles.join('  ')}\n ${k.pairs.join(' ')}\n`;
}

/** A surface, clamped both ways, as `Geom_BSplineSurface` (type 9), poles u-major. */
function surfaceRecord(input: NurbsSurface, scale: number): string {
  const s = clampSurface(input);
  if (s.u.kind !== 'clamped' || s.v.kind !== 'clamped') {
    fail('unsupported', 'clampSurface must return a surface clamped in both directions');
  }
  const nu = s.u.count;
  const nv = s.v.count;
  const r = s.rational ? 1 : 0;
  const rows: string[] = [];
  for (let i = 0; i < nu; i++) {
    const row: string[] = [];
    for (let j = 0; j < nv; j++) {
      const o = (i * nv + j) * 4;
      const w = s.cw[o + 3]!;
      const p = [0, 1, 2].map((k) => num((s.cw[o + k]! / w) * scale));
      if (s.rational) p.push(num(w));
      row.push(p.join(' '));
    }
    rows.push(row.join('  '));
  }
  const ku = knotPairs(s.u.knots);
  const kv = knotPairs(s.v.knots);
  return (
    `9 ${r} ${r} 0 0 ${s.u.degree} ${s.v.degree} ${nu} ${nv} ${ku.count} ${kv.count}  ` +
    `${rows.join('\n')}\n\n${ku.pairs.join('\n')}\n\n${kv.pairs.join('\n')}\n\n`
  );
}

/** A loop in surface orientation (module comment): reversed when the face's sense is not the surface's. */
function surfaceLoop(
  l: BrepLoop,
  sameSense: boolean,
): { edge: number; sense: boolean; use: number }[] {
  const out = l.coedges.map((c, i) => ({ edge: c.edge, sense: c.sense, use: i }));
  return sameSense ? out : out.reverse().map((c) => ({ ...c, sense: !c.sense }));
}

interface Shape {
  /** Type line, geometry and flags, each line ending in `\n`. */
  readonly head: string;
  /** Sub-shapes: orientation and 1-based position in write order. */
  readonly subs: readonly { readonly forward: boolean; readonly at: number }[];
}

/**
 * The text of `b` with `tolerance` (output units) on every shape. No gate:
 * {@link toOcctBrepText} checks first; {@link toOcctBrepTextUnchecked} does not.
 */
function encode(b: Brep, scale: number, tolerance: number): string {
  const tol = num(tolerance);
  const curve2d: string[] = [];
  const curves: string[] = [];
  const surfaces: string[] = [];
  const shapes: Shape[] = [];
  const push = (s: Shape): number => shapes.push(s);

  // One surface per face (module comment).
  const surfaceOf = b.faces.map((f) => surfaces.push(surfaceRecord(f.surface, scale)));

  // Each edge use, with its face, pcurve and direction in the surface-oriented wire.
  const uses: { face: number; forward: boolean; pcurve: number }[][] = b.edges.map(() => []);
  const wiresOf = b.faces.map((f, fi) =>
    [f.outer, ...f.holes].map((l) =>
      surfaceLoop(l, f.sameSense).map((c) => {
        const pcurve = curve2d.push(curveRecord(l.coedges[c.use]!.pcurve, 1));
        uses[c.edge]!.push({ face: fi, forward: c.sense, pcurve });
        return { edge: c.edge, forward: c.sense };
      }),
    ),
  );

  const vertexAt = b.vertices.map((v) =>
    push({
      head: `Ve\n${tol}\n${num(v.point.x * scale)} ${num(v.point.y * scale)} ${num(v.point.z * scale)}\n0 0\n\n0101101\n`,
      subs: [],
    }),
  );

  const edgeAt = b.edges.map((e, ei) => {
    const [a, z] = e.curve.basis.domain;
    const range = `${num(a)} ${num(z)}`;
    const c3 = curves.push(curveRecord(e.curve, scale));
    const u = uses[ei]!;
    const lines = [`1  ${c3} 0 ${range}`];
    if (u.length === 2 && u[0]!.face === u[1]!.face) {
      const fwd = u.find((x) => x.forward);
      const rev = u.find((x) => !x.forward);
      if (fwd === undefined || rev === undefined) {
        fail('brep-invalid', `seam edge ${ei} is used twice in the same direction`, { edge: ei });
      }
      lines.push(`3  ${fwd.pcurve} ${rev.pcurve} C0 ${surfaceOf[fwd.face]} 0 ${range}`);
    } else {
      for (const x of u) lines.push(`2  ${x.pcurve} ${surfaceOf[x.face]} 0 ${range}`);
    }
    const closed = e.start === e.end;
    return push({
      head: `Ed\n ${tol} 1 1 0\n${lines.join('\n')}\n0\n\n${closed ? '0101100' : '0101000'}\n`,
      subs: [
        { forward: true, at: vertexAt[e.start]! },
        { forward: false, at: vertexAt[e.end]! },
      ],
    });
  });

  const faceAt = b.faces.map((_, fi) => {
    const wires = wiresOf[fi]!.map((w) =>
      push({
        head: 'Wi\n\n0101100\n',
        subs: w.map((c) => ({ forward: c.forward, at: edgeAt[c.edge]! })),
      }),
    );
    return push({
      head: `Fa\n0  ${tol} ${surfaceOf[fi]} 0\n\n0101000\n`,
      subs: wires.map((at) => ({ forward: true, at })),
    });
  });

  const shell = push({
    head: 'Sh\n\n0101100\n',
    subs: b.shells[0]!.faces.map((f) => ({ forward: b.faces[f]!.sameSense, at: faceAt[f]! })),
  });
  const solid = push({ head: 'So\n\n0100000\n', subs: [{ forward: true, at: shell }] });

  const n = shapes.length;
  const ref = (forward: boolean, at: number): string => `${forward ? '+' : '-'}${n - at + 1} 0`;
  const tshapes = shapes.map(
    (s) => `${s.head}${[...s.subs.map((x) => ref(x.forward, x.at)), '*'].join(' ')}\n`,
  );
  return [
    '',
    'CASCADE Topology V3, (c) Open Cascade',
    'Locations 0',
    `Curve2ds ${curve2d.length}`,
    curve2d.join('').trimEnd(),
    `Curves ${curves.length}`,
    curves.join('').trimEnd(),
    'Polygon3D 0',
    'PolygonOnTriangulations 0',
    `Surfaces ${surfaces.length}`,
    surfaces.join('').trimEnd(),
    'Triangulations 0',
    '',
    `TShapes ${n}`,
    tshapes.join('').trimEnd(),
    '',
    `${ref(true, solid)}`,
    '',
  ].join('\n');
}

function units(opts: OcctBrepOptions | undefined): { scale: number; modelUnit: 'mm' | 'cm' } {
  const unit = opts?.unit ?? 'mm';
  const modelUnit = opts?.modelUnit ?? 'cm';
  if (!(unit in MM) || !(modelUnit in MM)) {
    fail('unsupported', `units must be 'mm' or 'cm'; got ${String(unit)}, ${String(modelUnit)}`);
  }
  return { scale: MM[modelUnit] / MM[unit], modelUnit };
}

/**
 * The B-rep as OCCT native BREP text (module comment), for `fromBREP`. Runs
 * `checkBrep` with `writeStep`'s tolerances and throws `brep-invalid` (the
 * report in `details.report`) on an invalid B-rep, as `writeStep` does; the
 * tolerance written is the uncertainty `writeStep` would declare.
 */
export function toOcctBrepText(b: Brep, opts?: OcctBrepOptions): OcctBrepResult {
  const { scale, modelUnit } = units(opts);
  const tol = writerTolerances(modelUnit, opts?.tol);
  const report: BrepReport = checkBrep(b, tol);
  if (!report.ok) {
    fail('brep-invalid', `refusing to write an invalid B-rep: ${report.issues[0]!.message}`, {
      report,
    });
  }
  const tolerance = declaredUncertainty(report, tol) * scale;
  return Object.freeze({ text: encode(b, scale, tolerance), tolerance });
}

/**
 * {@link toOcctBrepText} without `checkBrep`, for negative controls: it writes
 * whatever it is given, with `opts.tolerance` or else the floor
 * (`Tolerances.point`), since gaps are not measured.
 */
export function toOcctBrepTextUnchecked(b: Brep, opts?: OcctBrepUncheckedOptions): OcctBrepResult {
  const { scale, modelUnit } = units(opts);
  const tolerance = opts?.tolerance ?? writerTolerances(modelUnit, opts?.tol).point * scale;
  if (!(tolerance > 0 && Number.isFinite(tolerance))) {
    fail('unsupported', `the tolerance must be positive and finite; got ${tolerance}`);
  }
  return Object.freeze({ text: encode(b, scale, tolerance), tolerance });
}
