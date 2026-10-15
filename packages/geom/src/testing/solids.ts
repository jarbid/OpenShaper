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
 *
 * Orientation follows `faces.ts`: loops in face orientation (counter-clockwise
 * seen from outside), a coedge's pcurve parameterised like its edge curve.
 * Caps with `sameSense = false` (a plane whose own normal points into the
 * solid) are deliberate: they put both flags and both loop directions under
 * test.
 */
import {
  circle,
  circle2,
  circleArc,
  cylinder,
  line,
  line2,
  planeSurface,
  revolve,
  torus,
} from '../primitives';
import { controlPoint } from '../curve';
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
  const trimmed = opts?.trimmed === true;
  const P = (i: number, j: number, k: number): Point3 => ({ x: i * x, y: j * y, z: k * z });
  const corner = (id: number): Point3 => P(id & 1, (id >> 1) & 1, (id >> 2) & 1);
  const vertices = Array.from({ length: 8 }, (_, id) => ({ point: corner(id) }));
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
