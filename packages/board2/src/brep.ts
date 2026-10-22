// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board's B-rep and STEP (docs/design/board2.md §4, §7; stage 13 of §6.3).
 *
 * Three faces, three edges, two vertices: the V5 puck's topology, which geom's
 * `checkBrep`, `writeStep` and the OCCT protocol already accept (geom §15.5).
 *
 * | Face     | Surface                      | Loop (face orientation)                         | `sameSense` |
 * | -------- | ---------------------------- | ----------------------------------------------- | ----------- |
 * | `deck`   | deck height field            | deck edge forward (its exact plan pcurve)       | true        |
 * | `band`   | band, u periodic, v clamped  | seam ↓, tuck forward, seam ↑, deck edge back    | false       |
 * | `bottom` | bottom with its features     | tuck backwards (its exact plan pcurve)          | false       |
 *
 * - **Edges.** `deckEdge` and `tuck` are closed edges whose 3D curves are the
 *   band's boundary rows 0 and 6 (exact on the band) clamped at the band's
 *   domain start `t0`; on each height field the pcurve is the row's plan curve
 *   mapped affinely (§3.4), exact, so the edge gap is the boundary row's z-fit
 *   (§5.5), measured by `checkBrep` and declared by the STEP writer. `seam` is
 *   the band's iso-curve `u = t0` from the deck-edge vertex (v = 0) to the tuck
 *   vertex (v = 1), used twice by the band with the pcurves `u = t0` and
 *   `u = t0 + 1`.
 * - **Orientation.** The band's `Su × Sv` points into the board (u runs
 *   counter-clockwise seen from +z, v downwards from the deck edge), the
 *   height fields' upwards, so the outward faces are the deck as built and the
 *   band and bottom reversed. The loops follow geom's convention (faces.ts:
 *   counter-clockwise seen from outside, so a `sameSense: false` face's (u, v)
 *   loop is its loop backwards). `checkBrep` confirms the orientation by the
 *   sign of the measured volume (an inside-out shell is one of its errors, so a
 *   wrong sense here fails the build instead of being flipped) and measures
 *   the rest: gaps, trims, Euler–Poincaré `V − E + F − (L − F) = 2 − 3 + 3 − 0
 *   = 2`. `orientBrep` is not called (step S7): it integrated the same signed
 *   volume a second time, about half the B-rep's cost, to confirm what
 *   `checkBrep` already refuses.
 *
 * Nothing here slices by x: the faces come from the loop parameter, so the
 * notched loop of §3.8 assembles the same way (tested, bypassing the validator).
 */
import {
  checkBrep,
  clampedBasis,
  isoCurve,
  makeBrep,
  makeCurve,
  toClamped,
  writeStep,
} from '@openshaper/geom';
import type {
  Brep,
  BrepCoedge,
  BrepReport,
  ClampedCurve,
  NurbsSurface,
  PeriodicCurve,
  StepResult,
  StepWriteOptions,
  Tolerances,
} from '@openshaper/geom';
import { bandLine, fieldPcurve, geomIssue } from './band/band';
import { board2Err, board2Ok, makeIssue } from './issues';
import type { Board2Issue, Board2Result, BoardFace, BuiltBoard, HeightFieldJSON } from './types';

/** What the B-rep is assembled from (stage 13 inputs). */
export interface BoardBrepParts {
  readonly band: NurbsSurface;
  readonly deck: NurbsSurface;
  /** The bottom with its features. */
  readonly bottom: NurbsSurface;
  /** Band rows 0 and 6 (on the band's u basis). */
  readonly deckEdge: PeriodicCurve<3>;
  readonly tuck: PeriodicCurve<3>;
  /** The height fields' plan extents (their affine (u, v) maps). */
  readonly deckField: Pick<HeightFieldJSON, 'x' | 'y'>;
  readonly bottomField: Pick<HeightFieldJSON, 'x' | 'y'>;
  readonly tol: Tolerances;
}

/** The assembled and checked B-rep (outward by construction; `checkBrep` refuses inside-out). */
export interface BoardBrep {
  readonly brep: Brep;
  /** Face indices in `brep.faces`. */
  readonly faces: { readonly [F in BoardFace]: number };
  /** Edge indices in `brep.edges`. */
  readonly edges: { readonly deckEdge: number; readonly tuck: number; readonly seam: number };
  /** `checkBrep` of `brep` under the document's tolerances. */
  readonly check: BrepReport;
}

/** Face and edge order of the board's B-rep. */
export const BOARD_FACES: { readonly [F in BoardFace]: number } = Object.freeze({
  deck: 0,
  band: 1,
  bottom: 2,
});
const EDGE = Object.freeze({ deckEdge: 0, tuck: 1, seam: 2 });

/** The constant-u line `u = at` over v ∈ [0, 1], parameterised like the seam (by v). */
function seamLine(at: number): ClampedCurve<2> {
  return makeCurve({
    dim: 2,
    basis: clampedBasis(1, [0, 0, 1, 1]),
    points: [at, 0, at, 1],
  }) as ClampedCurve<2>;
}

/**
 * The board's B-rep (module comment): assembled with `makeBrep` in the designed
 * orientation and judged by `checkBrep` under `parts.tol`. Errors: geom's
 * structural refusal, or each `checkBrep` issue, as `geom` issues with the
 * cause; never throws.
 */
export function boardBrep(parts: BoardBrepParts): Board2Result<BoardBrep> {
  try {
    const { band, tol } = parts;
    if (band.u.kind !== 'periodic') throw new Error('the band must be periodic in u');
    const t0 = band.u.domain[0];
    const period = band.u.period;
    const deckEdge = toClamped(parts.deckEdge, t0, tol) as ClampedCurve<3>;
    const tuck = toClamped(parts.tuck, t0, tol) as ClampedCurve<3>;
    const seam = isoCurve(band, 'u', t0) as ClampedCurve<3>;
    const coedge = (edge: number, sense: boolean, pcurve: ClampedCurve<2>): BrepCoedge => ({
      edge,
      sense,
      pcurve,
      master: 'curve3d',
    });
    const faces = [
      {
        surface: parts.deck,
        sameSense: true,
        outer: {
          coedges: [coedge(EDGE.deckEdge, true, fieldPcurve(parts.deckEdge, parts.deckField, tol))],
        },
        holes: [],
        label: 'deck',
      },
      {
        surface: band,
        sameSense: false,
        outer: {
          coedges: [
            coedge(EDGE.seam, true, seamLine(t0)),
            coedge(EDGE.tuck, true, bandLine(t0, 1)),
            coedge(EDGE.seam, false, seamLine(t0 + period)),
            coedge(EDGE.deckEdge, false, bandLine(t0, 0)),
          ],
        },
        holes: [],
        label: 'band',
      },
      {
        surface: parts.bottom,
        sameSense: false,
        outer: {
          coedges: [coedge(EDGE.tuck, false, fieldPcurve(parts.tuck, parts.bottomField, tol))],
        },
        holes: [],
        label: 'bottom',
      },
    ];
    const made = makeBrep({
      vertices: [{ point: curveStart(seam) }, { point: curveEnd(seam) }],
      edges: [
        { curve: deckEdge, start: 0, end: 0 },
        { curve: tuck, start: 1, end: 1 },
        { curve: seam, start: 0, end: 1 },
      ],
      faces,
      shells: [{ faces: [0, 1, 2], closed: true }],
      solids: [{ outer: 0, genus: 0 }],
    });
    if (!made.ok) {
      return board2Err(
        made.issues.map((cause) => makeIssue('geom', `board B-rep: ${cause.message}`, { cause })),
      );
    }
    const check = checkBrep(made.value, tol);
    if (!check.ok) {
      return board2Err(
        check.issues.map((cause) =>
          makeIssue('geom', `board B-rep: ${cause.message}`, {
            cause,
            ...(cause.value === undefined ? {} : { value: cause.value }),
          }),
        ),
      );
    }
    return board2Ok(
      Object.freeze({
        brep: made.value,
        faces: BOARD_FACES,
        edges: EDGE,
        check,
      }),
    );
  } catch (e) {
    const issue: Board2Issue = geomIssue(e, 'board B-rep');
    return board2Err([issue]);
  }
}

/** First and last point of a clamped curve (its end control points). */
function curveStart(c: ClampedCurve<3>) {
  const w = c.cw[3]!;
  return { x: c.cw[0]! / w, y: c.cw[1]! / w, z: c.cw[2]! / w };
}
function curveEnd(c: ClampedCurve<3>) {
  const k = 4 * (c.basis.count - 1);
  const w = c.cw[k + 3]!;
  return { x: c.cw[k]! / w, y: c.cw[k + 1]! / w, z: c.cw[k + 2]! / w };
}

/**
 * The built board as a STEP file: geom's `writeStep` on its B-rep, with its
 * gate (`checkBrep`), measured uncertainty and options (§7). The document's
 * tolerances are the check's unless `opts.tol` overrides them.
 */
export function writeBoardStep(b: BuiltBoard, opts?: StepWriteOptions): StepResult {
  const tol = b.doc.build.tolerances;
  return writeStep(b.brep, {
    name: b.doc.meta.name,
    ...opts,
    tol: { ...tol, ...opts?.tol },
  });
}
