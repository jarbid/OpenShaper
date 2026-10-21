// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Analytic solids with exact edges and pcurves (design §15.3 corpus V1–V4), for
 * the B-rep, STEP and OCCT oracles. Each is a valid, outward-oriented B-rep
 * built from primitives only, so every volume and area has a closed form:
 *
 * | builder                | solid                                                        | volume                    |
 * | ---------------------- | ------------------------------------------------------------ | ------------------------- |
 * | `boxSolid`             | box of degree-1 faces, optionally with oversize trimmed ends | `x·y·z`                   |
 * | `cylinderSolid`        | periodic rational band, two caps trimmed by circles          | `π r² h`                  |
 * | `sphericalZoneSolid`   | `|latitude| ≤ φ` zone of a sphere (one or two bands), caps   | `π (r² h − h³/12)`, `h = 2 r sin φ` |
 * | `torusSolid`           | one doubly periodic face, two seams, one vertex              | `2 π² R r²`               |
 * | `plateWithHoleSolid`   | box with a cylindrical through-hole: two holed planar faces  | `x·y·z − π r² z`          |
 * | `ellipticPuckSolid`    | elliptic band, planar bottom, planar or fitted-bicubic deck  | `π a b h`                 |
 *
 * Orientation follows `faces.ts`: loops in face orientation (counter-clockwise
 * seen from outside), a coedge's pcurve parameterised like its edge curve.
 * Caps with `sameSense = false` (a plane whose own normal points into the
 * solid) are deliberate: they put both flags and both loop directions under
 * test.
 */
import {
  bezierSurface,
  circle,
  circle2,
  circleArc,
  cylinder,
  line,
  line2,
  planeSurface,
  revolve,
  ruled,
  torus,
} from '../primitives';
import { fail } from '../errors';
import { controlPoint, transformCurve, transformCurve2 } from '../curve';
import { projectCurveToSurface } from '../edge-fit';
import type { EdgeFitSampling } from '../edge-fit';
import type { Tolerances } from '../tolerance';
import { makeBrep, unwrapBrep } from '../brep/brep';
import type {
  Brep,
  BrepCoedge,
  BrepEdge,
  BrepFace,
  ClampedCurve,
  NurbsSurface,
  Point2,
  Point3,
} from '../types';

const X: Point3 = { x: 1, y: 0, z: 0 };
const Y: Point3 = { x: 0, y: 1, z: 0 };
const Z: Point3 = { x: 0, y: 0, z: 1 };

const coedge = (
  edge: number,
  sense: boolean,
  pcurve: ClampedCurve<2>,
  master: BrepCoedge['master'] = 'curve3d',
): BrepCoedge => ({ edge, sense, pcurve, master });

const startPoint = (c: ClampedCurve<3>): Point3 => controlPoint(c, 0);

/** A plane `c + u·X + v·Y` on `[−half, half]²` (unit axes: `(u, v)` are lengths about `c`). */
function capPlane(c: Point3, half: number): NurbsSurface {
  return planeSurface(c, X, Y, { u: [-half, half], v: [-half, half] });
}

/**
 * Box `[0, x] × [0, y] × [0, z]` from degree-1 faces: eight vertices, twelve
 * line edges, six faces. Default: each face a bilinear patch over exactly its
 * rectangle (untrimmed). With `trimmed`, the top and bottom faces are
 * oversize planes (domain `[−x, 2x] × [−y, 2y]`) trimmed to the rectangle by
 * four straight pcurves; the bottom plane's own normal is `+z`, so that face
 * has `sameSense = false`.
 */
export function boxSolid(
  x: number,
  y: number,
  z: number,
  opts?: { readonly trimmed?: boolean },
): Brep {
  return buildBox(x, y, z, opts?.trimmed === true, undefined);
}

/**
 * Box `[0, x] × [0, y] × [0, z]` with a cylindrical through-hole of radius `r`
 * along z through the centre `(x/2, y/2)` (`0 < r < min(x, y)/2`), genus 1: the
 * corpus solid with **holes** in its faces. The top and bottom planes are
 * oversize trimmed faces, each with a rectangular outer loop and the hole's
 * circle as a `FACE_BOUND` hole loop; the bottom plane's own normal points into
 * the solid (`sameSense = false`), so the hole sense is tested both ways. The
 * hole's wall is the cylinder band of `cylinderSolid` with its material on the
 * outside: `sameSense = false` and its loop reversed. Ten vertices, fifteen
 * edges (twelve box lines, two hole circles, the hole's seam), seven faces and
 * nine loops. Volume `x·y·z − π r² z`.
 */
export function plateWithHoleSolid(x: number, y: number, z: number, r: number): Brep {
  return buildBox(x, y, z, true, r);
}

function buildBox(
  x: number,
  y: number,
  z: number,
  trimmed: boolean,
  holeRadius: number | undefined,
): Brep {
  const P = (i: number, j: number, k: number): Point3 => ({ x: i * x, y: j * y, z: k * z });
  const corner = (id: number): Point3 => P(id & 1, (id >> 1) & 1, (id >> 2) & 1);
  const vertices: { point: Point3 }[] = Array.from({ length: 8 }, (_, id) => ({
    point: corner(id),
  }));
  // Edge (a, b), a < b: a line from a to b.
  const edgeId = new Map<string, number>();
  const edges: BrepEdge[] = [];
  const edgeOf = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo},${hi}`;
    let id = edgeId.get(key);
    if (id === undefined) {
      id = edges.length;
      edgeId.set(key, id);
      edges.push({ curve: line(corner(lo), corner(hi)), start: lo, end: hi });
    }
    return id;
  };
  // A face from corners in counter-clockwise order seen from outside. `uvOf`
  // maps a corner vertex to its (u, v) on the face's surface.
  const face = (
    ids: readonly [number, number, number, number],
    surface: NurbsSurface,
    sameSense: boolean,
    uvOf: (id: number) => Point2,
  ): BrepFace => {
    const coedges = ids.map((from, i) => {
      const to = ids[(i + 1) % 4]!;
      const e = edgeOf(from, to);
      const edge = edges[e]!;
      // pcurve in the edge's own direction (start → end).
      return coedge(e, edge.start === from, line2(uvOf(edge.start), uvOf(edge.end)));
    });
    return { surface, sameSense, outer: { coedges }, holes: [] };
  };
  const unit =
    (ids: readonly number[]) =>
    (id: number): Point2 =>
      UNIT_CORNERS[ids.indexOf(id)]!;
  const patch = (ids: readonly [number, number, number, number]): NurbsSurface =>
    // origin = corner 0; u along corner 1, v along corner 3: n = u × v is outward.
    planeSurface(
      corner(ids[0]),
      sub(corner(ids[1]), corner(ids[0])),
      sub(corner(ids[3]), corner(ids[0])),
    );
  const natural = (ids: readonly [number, number, number, number]): BrepFace =>
    face(ids, patch(ids), true, unit(ids));
  // Corner ids are `i + 2j + 4k`.
  const bottomIds = [0, 2, 3, 1] as const; // (0,0,0) (0,y,0) (x,y,0) (x,0,0): normal −z
  const topIds = [4, 5, 7, 6] as const; //    (0,0,z) (x,0,z) (x,y,z) (0,y,z): normal +z
  const faces: BrepFace[] = [];
  if (trimmed) {
    const plane = (zz: number): NurbsSurface =>
      planeSurface({ x: 0, y: 0, z: zz }, X, Y, { u: [-x, 2 * x], v: [-y, 2 * y] });
    const xy = (id: number): Point2 => ({ x: corner(id).x, y: corner(id).y });
    faces.push(face(bottomIds, plane(0), false, xy));
    faces.push(face(topIds, plane(z), true, xy));
  } else {
    faces.push(natural(bottomIds));
    faces.push(natural(topIds));
  }
  faces.push(natural([0, 1, 5, 4])); // y = 0, normal −y
  faces.push(natural([2, 6, 7, 3])); // y = y, normal +y
  faces.push(natural([0, 4, 6, 2])); // x = 0, normal −x
  faces.push(natural([1, 3, 7, 5])); // x = x, normal +x
  if (holeRadius !== undefined) {
    // The through-hole: circles about the axis (x/2, y/2), vertices at (cx + r, cy), and
    // the wall band, the `cylinderSolid` band reversed (material outside it).
    const cx = x / 2;
    const cy = y / 2;
    const eBottom = circle({ x: cx, y: cy, z: 0 }, X, Y, holeRadius);
    const eTop = circle({ x: cx, y: cy, z }, X, Y, holeRadius);
    const vb = vertices.length;
    vertices.push({ point: startPoint(eBottom) }, { point: startPoint(eTop) });
    const ebId = edges.length;
    edges.push({ curve: eBottom, start: vb, end: vb });
    const etId = edges.length;
    edges.push({ curve: eTop, start: vb + 1, end: vb + 1 });
    const esId = edges.length;
    edges.push({ curve: line(startPoint(eBottom), startPoint(eTop)), start: vb, end: vb + 1 });
    // The circle edges run counter-clockwise seen from above. A hole runs clockwise seen from
    // outside: from above on the top face (sense false), from below on the bottom face (true).
    const ring = circle2({ x: cx, y: cy }, holeRadius);
    faces[0] = { ...faces[0]!, holes: [{ coedges: [coedge(ebId, true, ring)] }] };
    faces[1] = { ...faces[1]!, holes: [{ coedges: [coedge(etId, false, ring)] }] };
    const wall = cylinder({ x: cx, y: cy, z: 0 }, Z, holeRadius, z);
    faces.push({
      surface: wall,
      sameSense: false,
      outer: {
        coedges: [
          coedge(esId, true, line2({ x: 0, y: 0 }, { x: 0, y: 1 })),
          coedge(etId, true, line2({ x: 0, y: 1 }, { x: 1, y: 1 })),
          coedge(esId, false, line2({ x: 1, y: 0 }, { x: 1, y: 1 })),
          coedge(ebId, false, line2({ x: 0, y: 0 }, { x: 1, y: 0 })),
        ],
      },
      holes: [],
    });
  }
  return unwrapBrep(
    makeBrep({
      vertices,
      edges,
      faces,
      shells: [{ faces: faces.map((_, i) => i), closed: true }],
      solids: [{ outer: 0, genus: holeRadius === undefined ? 0 : 1 }],
    }),
  );
}

const UNIT_CORNERS: readonly Point2[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/**
 * Right circular cylinder of radius `r` and height `h` on the z axis from
 * `z = 0`: a periodic rational band (u turns about +z from +x, so the seam is
 * at `(r, 0)`), two planar caps trimmed by the rational circle `circle2`, three
 * edges (two circles and the seam line) and two vertices. The seam edge is used
 * twice by the band, with pcurves at `u = 1` and `u = 0`. The bottom cap's plane
 * normal is `+z` (into the solid): `sameSense = false`.
 */
export function cylinderSolid(r: number, h: number): Brep {
  const side = cylinder({ x: 0, y: 0, z: 0 }, Z, r, h);
  const eBottom = circle({ x: 0, y: 0, z: 0 }, X, Y, r);
  const eTop = circle({ x: 0, y: 0, z: h }, X, Y, r);
  const vb = startPoint(eBottom);
  const vt = startPoint(eTop);
  const eSeam = line(vb, vt);
  const edges: BrepEdge[] = [
    { curve: eBottom, start: 0, end: 0 },
    { curve: eTop, start: 1, end: 1 },
    { curve: eSeam, start: 0, end: 1 },
  ];
  const bottomLine = line2({ x: 0, y: 0 }, { x: 1, y: 0 });
  const topLine = line2({ x: 0, y: 1 }, { x: 1, y: 1 });
  const seamAt1 = line2({ x: 1, y: 0 }, { x: 1, y: 1 });
  const seamAt0 = line2({ x: 0, y: 0 }, { x: 0, y: 1 });
  const band: BrepFace = {
    surface: side,
    sameSense: true,
    outer: {
      coedges: [
        coedge(0, true, bottomLine),
        coedge(2, true, seamAt1),
        coedge(1, false, topLine),
        coedge(2, false, seamAt0),
      ],
    },
    holes: [],
  };
  const half = 2 * r;
  const circ = circle2({ x: 0, y: 0 }, r);
  const bottom: BrepFace = {
    surface: capPlane({ x: 0, y: 0, z: 0 }, half),
    sameSense: false,
    outer: { coedges: [coedge(0, false, circ)] },
    holes: [],
  };
  const top: BrepFace = {
    surface: capPlane({ x: 0, y: 0, z: h }, half),
    sameSense: true,
    outer: { coedges: [coedge(1, true, circ)] },
    holes: [],
  };
  const faces = [band, bottom, top];
  return unwrapBrep(
    makeBrep({
      vertices: [{ point: vb }, { point: vt }],
      edges,
      faces,
      shells: [{ faces: [0, 1, 2], closed: true }],
      solids: [{ outer: 0, genus: 0 }],
    }),
  );
}

/**
 * The zone `|z| ≤ r sin φ` of the sphere of radius `r` about the origin
 * (`0 < φ < π/2`, `latitude` in radians): the revolution of an exact
 * circular arc, two trimmed planar caps, no poles. With `split`, two bands meet
 * along the equator (a circle edge shared by two curved faces, four faces in
 * all). Volume `π (r² h − h³/12)` with `h = 2 r sin φ`.
 */
export function sphericalZoneSolid(
  r: number,
  latitude: number,
  opts?: { readonly split?: boolean },
): Brep {
  const split = opts?.split === true;
  const o: Point3 = { x: 0, y: 0, z: 0 };
  const zTop = r * Math.sin(latitude);
  const rho = r * Math.cos(latitude);
  const arc = (a0: number, a1: number): ClampedCurve<3> => circleArc(o, X, Z, r, a0, a1);
  const ringAt = (z: number, radius: number): ClampedCurve<3> =>
    circle({ x: 0, y: 0, z }, X, Y, radius);
  const bottomRing = ringAt(-zTop, rho);
  const topRing = ringAt(zTop, rho);
  const equator = ringAt(0, r);
  const seams = split ? [arc(-latitude, 0), arc(0, latitude)] : [arc(-latitude, latitude)];
  const band = (seam: ClampedCurve<3>): NurbsSurface => revolve(seam, o, Z);
  const vertices = [
    { point: startPoint(bottomRing) },
    { point: startPoint(topRing) },
    ...(split ? [{ point: startPoint(equator) }] : []),
  ];
  // Edge ids: 0 bottom ring, 1 top ring, then (split) equator, then the seams.
  const edges: BrepEdge[] = [
    { curve: bottomRing, start: 0, end: 0 },
    { curve: topRing, start: 1, end: 1 },
  ];
  const seamEdge: number[] = [];
  let ringEq = -1;
  if (split) {
    ringEq = edges.length;
    edges.push({ curve: equator, start: 2, end: 2 });
    seamEdge.push(edges.length);
    edges.push({ curve: seams[0]!, start: 0, end: 2 });
    seamEdge.push(edges.length);
    edges.push({ curve: seams[1]!, start: 2, end: 1 });
  } else {
    seamEdge.push(edges.length);
    edges.push({ curve: seams[0]!, start: 0, end: 1 });
  }
  const along = (u: number): ClampedCurve<2> => line2({ x: u, y: 0 }, { x: u, y: 1 });
  const across = (v: number): ClampedCurve<2> => line2({ x: 0, y: v }, { x: 1, y: v });
  /** A band bounded below by ring `lo` and above by ring `hi`, with its seam edge. */
  const bandFace = (surface: NurbsSurface, lo: number, hi: number, seam: number): BrepFace => ({
    surface,
    sameSense: true,
    outer: {
      coedges: [
        coedge(lo, true, across(0)),
        coedge(seam, true, along(1)),
        coedge(hi, false, across(1)),
        coedge(seam, false, along(0)),
      ],
    },
    holes: [],
  });
  const faces: BrepFace[] = split
    ? [
        bandFace(band(seams[0]!), 0, ringEq, seamEdge[0]!),
        bandFace(band(seams[1]!), ringEq, 1, seamEdge[1]!),
      ]
    : [bandFace(band(seams[0]!), 0, 1, seamEdge[0]!)];
  const half = 2 * r;
  const circ = circle2({ x: 0, y: 0 }, rho);
  faces.push({
    surface: capPlane({ x: 0, y: 0, z: -zTop }, half),
    sameSense: false,
    outer: { coedges: [coedge(0, false, circ)] },
    holes: [],
  });
  faces.push({
    surface: capPlane({ x: 0, y: 0, z: zTop }, half),
    sameSense: true,
    outer: { coedges: [coedge(1, true, circ)] },
    holes: [],
  });
  return unwrapBrep(
    makeBrep({
      vertices,
      edges,
      faces,
      shells: [{ faces: faces.map((_, i) => i), closed: true }],
      solids: [{ outer: 0, genus: 0 }],
    }),
  );
}

/**
 * The ring torus about the z axis (centre circle radius `R`, tube radius `r`,
 * `R > r`): one doubly periodic face whose boundary is both seams (the outer
 * equator circle and the tube circle at `u = 0`), one vertex, genus 1.
 * Volume `2 π² R r²`.
 */
export function torusSolid(R: number, r: number): Brep {
  const surface = torus({ x: 0, y: 0, z: 0 }, Z, R, r);
  const equator = circle({ x: 0, y: 0, z: 0 }, X, Y, R + r);
  const tube = circle({ x: R, y: 0, z: 0 }, X, Z, r);
  const v = startPoint(equator);
  const edges: BrepEdge[] = [
    { curve: equator, start: 0, end: 0 },
    { curve: tube, start: 0, end: 0 },
  ];
  const face: BrepFace = {
    surface,
    sameSense: true,
    outer: {
      coedges: [
        coedge(0, true, line2({ x: 0, y: 0 }, { x: 1, y: 0 })),
        coedge(1, true, line2({ x: 1, y: 0 }, { x: 1, y: 1 })),
        coedge(0, false, line2({ x: 0, y: 1 }, { x: 1, y: 1 })),
        coedge(1, false, line2({ x: 0, y: 0 }, { x: 0, y: 1 })),
      ],
    },
    holes: [],
  };
  return unwrapBrep(
    makeBrep({
      vertices: [{ point: v }],
      edges,
      faces: [face],
      shells: [{ faces: [0], closed: true }],
      solids: [{ outer: 0, genus: 1 }],
    }),
  );
}

/**
 * The deck's control-net fractions along each parameter: a monotone but
 * **non-uniform** spacing, so `x(u)` and `y(v)` are genuinely cubic and the
 * pcurve of the deck's boundary is not an affine image of the ellipse.
 */
const DECK_U_FRACTIONS = [0, 0.15, 0.8, 1] as const;
const DECK_V_FRACTIONS = [0, 0.35, 0.6, 1] as const;
/** How far past the ellipse's bounding box the deck's domain reaches, as a fraction of a semi-axis. */
const DECK_MARGIN = 0.25;

/**
 * The elliptic puck (design §15.3 corpus V5): the solid with the board's
 * three-patch topology (a side band, a bottom, a deck) and one analytic volume.
 *
 * - The **band** is the ruled surface between the bottom ellipse (semi-axes
 *   `a` along x and `b` along y, in the plane `z = 0`) and the top ellipse, a
 *   rational biquadratic-by-linear patch, exact.
 * - The **bottom** is the plane `z = 0`, trimmed by the ellipse (its pcurve an
 *   exact affine image of `circle2`).
 * - The **deck**, flat by default (`z = h`, an exact rational pcurve), or with
 *   `bicubicDeck` a **bicubic Bézier patch** that is geometrically the tilted
 *   plane `z = h + tilt · x` but parameterised non-uniformly in both
 *   directions (`DECK_*_FRACTIONS`), so its trim is the genuine product of the
 *   edge fitter: the top edge is the exact 3D ellipse `(a cos θ, b sin θ, h +
 *   tilt · a cos θ)`, and its **pcurve on the deck is fitted**
 *   ({@link projectCurveToSurface}), so the coedge's pcurve image differs from
 *   the edge curve by up to the fit tolerance `tol.fit`, and the B-rep's
 *   `edgeGaps` and the STEP uncertainty report exactly that.
 *
 * The volume is `π a b h` in both variants: a tilt about the plane's centroid
 * (`x = 0`, by symmetry the mean of `x` over the ellipse is zero) does not
 * change it. Seven loops: three faces, three edges (two ellipses and the seam
 * line), two vertices.
 *
 * `tol` and `sampling` go to the pcurve fit. Throws `GeomError` when the fit
 * fails and `brep-invalid` when the result does not check.
 */
export function ellipticPuckSolid(
  a: number,
  b: number,
  h: number,
  opts?: {
    readonly bicubicDeck?: boolean;
    /** Slope `dz/dx` of the bicubic deck (default 0.1); ignored for the flat deck. */
    readonly tilt?: number;
    readonly tol?: Partial<Tolerances>;
    readonly sampling?: Partial<EdgeFitSampling>;
  },
): Brep {
  const bicubic = opts?.bicubicDeck === true;
  const tilt = bicubic ? (opts?.tilt ?? 0.1) : 0;
  const unitCircle = circle({ x: 0, y: 0, z: 0 }, X, Y, 1);
  // Row-major 3×4: x' = a x, y' = b y, z' = tilt · a x + z + h (the unit circle is flat).
  const bottomEllipse = transformCurve(unitCircle, [a, 0, 0, 0, 0, b, 0, 0, 0, 0, 1, 0]);
  const topEllipse = transformCurve(unitCircle, [a, 0, 0, 0, 0, b, 0, 0, tilt * a, 0, 1, h]);
  const vb = startPoint(bottomEllipse);
  const vt = startPoint(topEllipse);
  const edges: BrepEdge[] = [
    { curve: bottomEllipse, start: 0, end: 0 },
    { curve: topEllipse, start: 1, end: 1 },
    { curve: line(vb, vt), start: 0, end: 1 },
  ];
  const band: BrepFace = {
    surface: ruled(bottomEllipse, topEllipse),
    sameSense: true,
    outer: {
      coedges: [
        coedge(0, true, line2({ x: 0, y: 0 }, { x: 1, y: 0 })),
        coedge(2, true, line2({ x: 1, y: 0 }, { x: 1, y: 1 })),
        coedge(1, false, line2({ x: 0, y: 1 }, { x: 1, y: 1 })),
        coedge(2, false, line2({ x: 0, y: 0 }, { x: 0, y: 1 })),
      ],
    },
    holes: [],
  };
  const half = 2 * Math.max(a, b);
  const planarPcurve = transformCurve2(circle2({ x: 0, y: 0 }, 1), [a, 0, 0, 0, b, 0]);
  const bottom: BrepFace = {
    surface: capPlane({ x: 0, y: 0, z: 0 }, half),
    sameSense: false,
    outer: { coedges: [coedge(0, false, planarPcurve)] },
    holes: [],
  };
  let deck: BrepFace;
  if (bicubic) {
    const xs = DECK_U_FRACTIONS.map((f) => -a * (1 + DECK_MARGIN) + 2 * a * (1 + DECK_MARGIN) * f);
    const ys = DECK_V_FRACTIONS.map((f) => -b * (1 + DECK_MARGIN) + 2 * b * (1 + DECK_MARGIN) * f);
    const points: number[] = [];
    for (const x of xs) for (const y of ys) points.push(x, y, h + tilt * x);
    const surface = bezierSurface(points, 4, 4);
    const fit = projectCurveToSurface(topEllipse, surface, opts?.tol, opts?.sampling);
    if (!fit.ok || !fit.value.withinTolerance) {
      // Better a refused solid than one whose gaps are bigger than its caller asked for.
      fail('not-converged', `ellipticPuckSolid: the deck's pcurve did not fit within tolerance`, {
        issues: fit.issues,
        ...(fit.ok ? { value: fit.value.maxDeviation } : {}),
      });
    }
    deck = {
      surface,
      sameSense: true,
      outer: { coedges: [coedge(1, true, fit.value.pcurve)] },
      holes: [],
    };
  } else {
    deck = {
      surface: capPlane({ x: 0, y: 0, z: h }, half),
      sameSense: true,
      outer: { coedges: [coedge(1, true, planarPcurve)] },
      holes: [],
    };
  }
  const faces = [band, bottom, deck];
  return unwrapBrep(
    makeBrep({
      vertices: [{ point: vb }, { point: vt }],
      edges,
      faces,
      shells: [{ faces: [0, 1, 2], closed: true }],
      solids: [{ outer: 0, genus: 0 }],
    }),
  );
}

/**
 * The closed forms of {@link ellipticPuckSolid} (semi-axes `a`, `b`, height `h`,
 * deck slope `tilt` along x; `tilt = 0` for the flat deck): the independent
 * oracle of its volume, area and centroid.
 *
 * - volume `π a b h`; the tilt changes the height by `tilt · x`, whose mean over
 *   the ellipse is zero;
 * - area: bottom `π a b`, deck `π a b · √(1 + tilt²)` (a plane inclined by
 *   `tilt`), band `∮ (h + tilt · a cos θ) · |E′(θ)| dθ` with `|E′| =
 *   √(a² sin²θ + b² cos²θ)` (the ruled band's normal is `H(θ) · E₀′ × ẑ`), evaluated by
 *   the trapezoidal rule with `bandSamples` points: spectrally accurate for a smooth
 *   periodic integrand, so rounding-limited long before 4096;
 * - centroid `x = tilt · a² / (4h)`, `y = 0`, `z = h/2 + tilt² a² / (8h)`, from the
 *   first moments `∬ x (h + tilt x) dA = tilt · π a³ b / 4` and `½ ∬ (h + tilt x)² dA`.
 */
export function ellipticPuckExact(
  a: number,
  b: number,
  h: number,
  tilt = 0,
  bandSamples = 4096,
): { readonly volume: number; readonly area: number; readonly centroid: Point3 } {
  let band = 0;
  for (let i = 0; i < bandSamples; i++) {
    const t = (2 * Math.PI * i) / bandSamples;
    band += (h + tilt * a * Math.cos(t)) * Math.hypot(a * Math.sin(t), b * Math.cos(t));
  }
  band *= (2 * Math.PI) / bandSamples;
  const ellipse = Math.PI * a * b;
  return Object.freeze({
    volume: ellipse * h,
    area: ellipse + ellipse * Math.sqrt(1 + tilt * tilt) + band,
    centroid: Object.freeze({
      x: (tilt * a * a) / (4 * h),
      y: 0,
      z: h / 2 + (tilt * tilt * a * a) / (8 * h),
    }),
  });
}
