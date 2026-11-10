// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * STEP export of a designed fin: step 5 of docs/design/fin-designer.md.
 *
 * The blade and each tab as solids in one file, touching on the tab-top plane (z = 0).
 * Two solids on a one-tab base; three on FCS 1 (`tab-rear`, `tab-front`):
 *
 * ```
 * blade  MANIFOLD_SOLID_BREP, 3 faces
 *   side    B_SPLINE_SURFACE_WITH_KNOTS, closed in u on a seam (fitBladeSurface)
 *   root    PLANE z = 0
 *   tip     PLANE z = topZ, a sliver just under the tip
 * tab    MANIFOLD_SOLID_BREP, 14 faces: the Futures tab profile extruded across its
 *        thickness. Two PLANE sides, then one face per profile segment: PLANE for a
 *        line, CYLINDRICAL_SURFACE for the slot end and the corner fillet.
 * ```
 *
 * They touch rather than overlap. The root foil is wider than the 6.35 mm tab and
 * often longer, so sinking the blade into the tab would leave a lip below the base
 * outside the tab, and the fin would not seat. In CAD, Combine / Join merges two
 * bodies that share a face.
 *
 * Watertight the board's way (see step.ts and docs/design/step-export.md): every edge
 * is shared by entity id, and the blade's edges are its surface's own boundary
 * curves. Orientation is measured from the geometry, not assumed.
 *
 * Frame (kernel cm, scaled on output): X along the tab toward the nose, Z up the
 * blade from the tab top, Y across; see blade.ts for which side is which.
 */
import {
  evalCurve,
  evalSurfaceDeriv,
  fitBladeSurface,
  finTabOutline,
  knotMultiplicities,
  surfaceBoundaryCurve,
  tabCentreY,
  tabFacesY,
  type BSplineCurve,
  type BSplineSurface,
  type BladeSurfaceModel,
  type FinDesign,
  type FinLaminate,
  type FinTabPart,
  type TabSegment,
  type Vert3,
} from '@openshaper/kernel';
import type { SheetUnit } from './construction/units';
import {
  cross,
  direction,
  emitCurve,
  emitSurface,
  face,
  finishShape,
  header,
  oriented,
  p21,
  productDefinition,
  real,
  ref,
  refs,
  unitContext,
  writerFor,
  type Writer,
} from './step-writer';
import { FIN_BRAND } from './brand';
import { SHEET_UNIT } from './construction/units';

export interface FinStepOptions {
  /** Output unit written into the file. Default 'mm'. */
  unit?: SheetUnit;
  /** `PRODUCT` name. Default 'fin'. */
  name?: string;
  /** `FILE_NAME` timestamp; set it for byte-reproducible output. Defaults to now. */
  timestamp?: string;
  /** How closely the blade surface follows the design (cm). */
  tolerance?: number;
  /** Write the blade, and the tab if it wraps it, as the core under this laminate (cm per face). */
  laminate?: FinLaminate;
  /**
   * Thicken the edges and tip to at least this (cm) in the file only, e.g. 0.1 for a
   * 1 mm printable edge. Never under the design minimum, which is the default.
   */
  minThickness?: number;
}

const sub = (a: Vert3, b: Vert3): Vert3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vert3, b: Vert3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Newell normal of a polygon: its area-weighted normal, by the right-hand rule. */
const newell = (pts: readonly Vert3[]): Vert3 => {
  const n = { x: 0, y: 0, z: 0 };
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length]!;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  });
  return n;
};

/** One oriented edge of a loop, with the vertex it starts from. */
interface LoopEdge {
  readonly edge: number;
  readonly sense: boolean;
  readonly from: Vert3;
}

/**
 * A face whose loop runs counter-clockwise about `outward`. The loop's vertices give
 * its winding (Newell), so the edge list can be built in either direction; it is
 * reversed here if it runs the wrong way.
 */
const faceAbout = (
  w: Writer,
  surface: number,
  sameSense: boolean,
  loop: readonly LoopEdge[],
  outward: Vert3,
): number => {
  const ccw = dot(newell(loop.map((e) => e.from)), outward);
  const walk = ccw > 0 ? loop : [...loop].reverse().map((e) => ({ ...e, sense: !e.sense }));
  return face(
    w,
    surface,
    walk.map((e) => oriented(w, e.edge, e.sense)),
    sameSense,
  );
};

/**
 * A planar face with holes: the outer loop counter-clockwise about `outward`, each hole
 * clockwise, whichever way they were given.
 */
const faceWithHoles = (
  w: Writer,
  surface: number,
  sameSense: boolean,
  outer: readonly LoopEdge[],
  holes: readonly (readonly LoopEdge[])[],
  outward: Vert3,
): number => {
  const walk = (loop: readonly LoopEdge[], ccw: boolean) => {
    const turns = dot(newell(loop.map((e) => e.from)), outward) > 0;
    const l = turns === ccw ? loop : [...loop].reverse().map((e) => ({ ...e, sense: !e.sense }));
    return l.map((e) => oriented(w, e.edge, e.sense));
  };
  return face(
    w,
    surface,
    walk(outer, true),
    sameSense,
    holes.map((h) => walk(h, false)),
  );
};

const placement = (w: Writer, origin: Vert3, axis: Vert3, refDir: Vert3): number =>
  w.emit(
    `AXIS2_PLACEMENT_3D('',${ref(w.point(origin))},${ref(direction(w, axis.x, axis.y, axis.z))},` +
      `${ref(direction(w, refDir.x, refDir.y, refDir.z))})`,
  );

const plane = (w: Writer, origin: Vert3, normal: Vert3, refDir: Vert3): number =>
  w.emit(`PLANE('',${ref(placement(w, origin, normal, refDir))})`);

// --- blade ---

/** Parameter in the middle of the k-th strip between u-creases (0-based). */
const stripMid = (s: BSplineSurface, k: number): number => {
  const { values } = knotMultiplicities(s.uKnots);
  const { mults } = knotMultiplicities(s.uKnots);
  const bounds = values.filter(
    (_, i) => i === 0 || i === values.length - 1 || mults[i] === s.uDegree,
  );
  return (bounds[k]! + bounds[k + 1]!) / 2;
};

/**
 * Whether the side surface's own normal (S_u × S_v) points out of the blade. Sampled
 * half-way up, mid-chord on the outside face: the inside face's point across from it
 * is inward, whatever the hand or cant.
 */
const bladeNormalPointsOut = (s: BSplineSurface): boolean => {
  const { point, du, dv } = evalSurfaceDeriv(s, stripMid(s, 0), 0.5);
  const across = evalSurfaceDeriv(s, stripMid(s, 2), 0.5).point;
  return dot(cross(du, dv), sub(point, across)) > 0;
};

/** Signed area of a closed boundary curve projected on z: > 0 counter-clockwise about +Z. */
const zWinding = (c: BSplineCurve): number => {
  const n = 400;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = evalCurve(c, i / n);
    const b = evalCurve(c, (i + 1) / n);
    area += a.x * b.y - b.x * a.y;
  }
  return area;
};

const emitBlade = (w: Writer, m: BladeSurfaceModel): number => {
  const s = m.surface;
  const side = emitSurface(w, s, 'blade');
  const seam = surfaceBoundaryCurve(s, 'u0');
  const root = surfaceBoundaryCurve(s, 'v0');
  const top = surfaceBoundaryCurve(s, 'v1');

  const p0 = seam.ctrl[0]!;
  const p1 = seam.ctrl[seam.ctrl.length - 1]!;
  const v0 = w.emit(`VERTEX_POINT('',${ref(w.point(p0))})`);
  const v1 = w.emit(`VERTEX_POINT('',${ref(w.point(p1))})`);
  const edge = (a: number, b: number, c: BSplineCurve, label: string): number =>
    w.emit(`EDGE_CURVE('',${ref(a)},${ref(b)},${ref(emitCurve(w, c, label))},.T.)`);
  const eSeam = edge(v0, v1, seam, 'seam');
  const eRoot = edge(v0, v0, root, 'root');
  const eTop = edge(v1, v1, top, 'tip');

  // Side: counter-clockwise in (u, v) is counter-clockwise about S_u × S_v. If that
  // normal points inward, the face is reversed and so is its loop.
  const out = bladeNormalPointsOut(s);
  const walk: readonly [number, boolean][] = out
    ? [
        [eRoot, true], // v = 0, u rising
        [eSeam, true], // u = 1, v rising
        [eTop, false], // v = 1, u falling
        [eSeam, false], // u = 0, v falling
      ]
    : [
        [eSeam, true],
        [eTop, true],
        [eSeam, false],
        [eRoot, false],
      ];
  const sideFace = face(
    w,
    side,
    walk.map(([e, sense]) => oriented(w, e, sense)),
    out,
  );

  // Caps: a one-edge loop, run counter-clockwise about the cap's outward normal.
  const cap = (e: number, c: BSplineCurve, z: number, up: boolean): number => {
    const surf = plane(
      w,
      { x: p0.x, y: p0.y, z },
      { x: 0, y: 0, z: up ? 1 : -1 },
      { x: 1, y: 0, z: 0 },
    );
    const ccwAboutZ = zWinding(c) > 0;
    return face(w, surf, [oriented(w, e, ccwAboutZ === up)], true);
  };
  const rootFace = cap(eRoot, root, m.rootZ, false);
  const topFace = cap(eTop, top, m.topZ, true);

  const shell = w.emit(`CLOSED_SHELL('',${refs([sideFace, rootFace, topFace])})`);
  return w.emit(`MANIFOLD_SOLID_BREP(${p21('blade')},${ref(shell)})`);
};

// --- tab ---

/** Each of the base's tabs as a solid: `tab`, or `tab-rear` and `tab-front` on FCS 1. */
const emitTabs = (
  w: Writer,
  d: FinDesign,
  factor: number,
  laminate: FinLaminate | undefined,
): number[] => {
  const tab = finTabOutline(d.base, d.outline);
  const names =
    tab.parts.length === 1
      ? ['tab']
      : tab.parts.map((_, i) => (i === 0 ? 'tab-rear' : 'tab-front'));
  return tab.parts.map((part, i) => emitTabPart(w, d, part, names[i]!, factor, laminate));
};

const emitTabPart = (
  w: Writer,
  d: FinDesign,
  part: FinTabPart,
  name: string,
  factor: number,
  laminate: FinLaminate | undefined,
): number => {
  const { height: H } = finTabOutline(d.base, d.outline);
  const sides = tabFacesY(d, laminate);
  // Tab frame (x, y up from the tab bottom) to the fin frame: z = y − H.
  const at = (p: { x: number; y: number }, y: number): Vert3 => ({ x: p.x, y, z: p.y - H });
  const segs = part.segments;

  const vertex = new Map<string, number>();
  const vtx = (p: Vert3): number => {
    const id = w.point(p);
    const key = String(id);
    const hit = vertex.get(key);
    if (hit !== undefined) return hit;
    const v = w.emit(`VERTEX_POINT('',${ref(id)})`);
    vertex.set(key, v);
    return v;
  };

  const lineEdge = (a: Vert3, b: Vert3): number => {
    const d3 = sub(b, a);
    const len = Math.hypot(d3.x, d3.y, d3.z);
    const dir = direction(w, d3.x / len, d3.y / len, d3.z / len);
    const vec = w.emit(`VECTOR('',${ref(dir)},${real(len, factor)})`);
    const line = w.emit(`LINE('',${ref(w.point(a))},${ref(vec)})`);
    return w.emit(`EDGE_CURVE('',${ref(vtx(a))},${ref(vtx(b))},${ref(line)},.T.)`);
  };

  /**
   * A profile arc on one side face. The profile runs counter-clockwise in (x, z),
   * which is clockwise about +Y (rotating +X toward +Z turns about −Y). A circle runs
   * counter-clockwise about its axis, so a ccw arc takes axis −Y, a cw one +Y.
   */
  const arcEdge = (s: Extract<TabSegment, { kind: 'arc' }>, y: number): number => {
    const a = at(s.from, y);
    const b = at(s.to, y);
    const c = at(s.center, y);
    const axis = { x: 0, y: s.ccw ? -1 : 1, z: 0 };
    const refDir = sub(a, c);
    const r = Math.hypot(refDir.x, refDir.z);
    const circle = w.emit(
      `CIRCLE('',${ref(placement(w, c, axis, { x: refDir.x / r, y: 0, z: refDir.z / r }))},${real(s.radius, factor)})`,
    );
    return w.emit(`EDGE_CURVE('',${ref(vtx(a))},${ref(vtx(b))},${ref(circle)},.T.)`);
  };

  // The profile and each weight-saving hole: closed rings of segments, the profile
  // counter-clockwise and each hole clockwise, so material is always on the left.
  const rings = [segs, ...part.holes];
  // Ring edges on each side, and the straight edge across the tab at each vertex.
  const edgesOn = rings.map((ring) =>
    sides.map((y) =>
      ring.map((s) => (s.kind === 'line' ? lineEdge(at(s.from, y), at(s.to, y)) : arcEdge(s, y))),
    ),
  );
  const acrossOf = rings.map((ring) =>
    ring.map((s) => lineEdge(at(s.from, sides[0]), at(s.from, sides[1]))),
  );

  // Holes straight down (the US box screw hole), centred on the tab's own mid-plane.
  // Each is a cylinder in four quarters, so every loop has corners to wind by.
  const yc = tabCentreY(d);
  const boreRings = (part.bores ?? []).map((bore) => {
    const quarter = [0, 1, 2, 3].map((j) => (j * Math.PI) / 2);
    const ringAt = (y: number) => {
      const z = y - H;
      const c = { x: bore.x, y: yc, z };
      const pts = quarter.map((a) => ({
        x: bore.x + bore.radius * Math.cos(a),
        y: yc + bore.radius * Math.sin(a),
        z,
      }));
      const circle = w.emit(
        `CIRCLE('',${ref(placement(w, c, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }))},${real(bore.radius, factor)})`,
      );
      // Counter-clockwise about +z, as the circle runs.
      const edges = pts.map((p, k) => {
        const q = pts[(k + 1) % 4]!;
        return w.emit(`EDGE_CURVE('',${ref(vtx(p))},${ref(vtx(q))},${ref(circle)},.T.)`);
      });
      return { pts, edges, loop: pts.map((p, k) => ({ edge: edges[k]!, sense: true, from: p })) };
    };
    const bottom = ringAt(bore.from);
    const top = ringAt(bore.to);
    return { bore, bottom: bottom.loop, top: top.loop, b: bottom, t: top };
  });

  const faces: number[] = [];

  // The two side faces: the profile, less the holes.
  sides.forEach((y, k) => {
    const normal = { x: 0, y: k === 0 ? -1 : 1, z: 0 };
    const surf = plane(w, at({ x: 0, y: 0 }, y), normal, { x: 1, y: 0, z: 0 });
    const loops = rings.map((ring, r) =>
      ring.map((s, i) => ({ edge: edgesOn[r]![k]![i]!, sense: true, from: at(s.from, y) })),
    );
    faces.push(faceWithHoles(w, surf, true, loops[0]!, loops.slice(1), normal));
  });

  // One face per segment of each ring, across the thickness.
  rings.forEach((ring, r) => {
    const profile = edgesOn[r]!;
    const across = acrossOf[r]!;
    ring.forEach((s, i) => {
      const next = (i + 1) % ring.length;
      const a0 = at(s.from, sides[0]);
      const b0 = at(s.to, sides[0]);
      const b1 = at(s.to, sides[1]);
      const a1 = at(s.from, sides[1]);
      const loop: LoopEdge[] = [
        { edge: profile[0]![i]!, sense: true, from: a0 },
        { edge: across[next]!, sense: true, from: b0 },
        { edge: profile[1]![i]!, sense: false, from: b1 },
        { edge: across[i]!, sense: false, from: a1 },
      ];
      if (s.kind === 'line') {
        // Outward is to the right of travel, round the profile and through a hole alike.
        const dx = s.to.x - s.from.x;
        const dz = s.to.y - s.from.y;
        const len = Math.hypot(dx, dz);
        const normal = { x: dz / len, y: 0, z: -dx / len };
        const surf = plane(w, a0, normal, { x: dx / len, y: 0, z: dz / len });
        // A flat horizontal wall a bore passes through gets the bore's ring as a hole.
        const level = r === 0 && dz === 0 ? s.from.y : null;
        const lo = Math.min(s.from.x, s.to.x);
        const hi = Math.max(s.from.x, s.to.x);
        const cut = boreRings.filter(
          (b) =>
            level !== null &&
            (b.bore.from === level || b.bore.to === level) &&
            b.bore.x - b.bore.radius > lo &&
            b.bore.x + b.bore.radius < hi,
        );
        if (cut.length) {
          const holes = cut.map((b) => (b.bore.from === level ? b.bottom : b.top));
          faces.push(faceWithHoles(w, surf, true, loop, holes, normal));
        } else {
          faces.push(faceAbout(w, surf, true, loop, normal));
        }
      } else {
        // Material is inside a ccw arc (the fillet) and outside a cw one (the slot, a
        // hole's round end), so the outward normal points away from the axis for ccw
        // and toward it for cw.
        const c = at(s.center, sides[0]);
        const ref0 = sub(a0, c);
        const rr = Math.hypot(ref0.x, ref0.z);
        const surf = w.emit(
          `CYLINDRICAL_SURFACE('',${ref(placement(w, c, { x: 0, y: 1, z: 0 }, { x: ref0.x / rr, y: 0, z: ref0.z / rr }))},${real(s.radius, factor)})`,
        );
        // Outward at the middle of the arc, found by angle: a semicircle's chord
        // midpoint is its centre, so the chord can't say which way it bulges.
        const a = Math.atan2(s.from.y - s.center.y, s.from.x - s.center.x);
        let sweep = Math.atan2(s.to.y - s.center.y, s.to.x - s.center.x) - a;
        if (s.ccw && sweep <= 0) sweep += 2 * Math.PI;
        if (!s.ccw && sweep >= 0) sweep -= 2 * Math.PI;
        const m = a + sweep / 2;
        const sgn = s.ccw ? 1 : -1;
        const normal = { x: sgn * Math.cos(m), y: 0, z: sgn * Math.sin(m) };
        faces.push(faceAbout(w, surf, s.ccw, loop, normal));
      }
    });
  });

  // Each bore's wall: four quarter cylinders, facing in toward the axis.
  for (const { bore, b, t: top } of boreRings) {
    const up = b.pts.map((p, k) => lineEdge(p, top.pts[k]!));
    const axis = placement(
      w,
      { x: bore.x, y: yc, z: bore.from - H },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
    );
    const surf = w.emit(`CYLINDRICAL_SURFACE('',${ref(axis)},${real(bore.radius, factor)})`);
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      const loop: LoopEdge[] = [
        { edge: b.edges[k]!, sense: true, from: b.pts[k]! },
        { edge: up[k1]!, sense: true, from: b.pts[k1]! },
        { edge: top.edges[k]!, sense: false, from: top.pts[k1]! },
        { edge: up[k]!, sense: false, from: top.pts[k]! },
      ];
      const m = ((k + 0.5) * Math.PI) / 2;
      // Material is outside the cylinder: outward points at the axis.
      faces.push(faceAbout(w, surf, false, loop, { x: -Math.cos(m), y: -Math.sin(m), z: 0 }));
    }
  }

  const shell = w.emit(`CLOSED_SHELL('',${refs(faces)})`);
  return w.emit(`MANIFOLD_SOLID_BREP(${p21(name)},${ref(shell)})`);
};

/**
 * Encode a valid fin design (see `validateFinDesign`) as a STEP part-21 file: the
 * blade and each tab as solids. Pure: the same inputs, including `timestamp`, give
 * byte-identical output.
 */
export const exportFinStep = (d: FinDesign, opts: FinStepOptions = {}): string => {
  const unit: SheetUnit = opts.unit ?? 'mm';
  const name = opts.name ?? 'fin';
  const timestamp = opts.timestamp ?? new Date().toISOString().slice(0, 19);
  const model = fitBladeSurface(d, {
    ...(opts.tolerance === undefined ? {} : { tolerance: opts.tolerance }),
    ...(opts.laminate ? { laminate: opts.laminate } : {}),
    ...(opts.minThickness === undefined ? {} : { minThickness: opts.minThickness }),
  });

  const w = writerFor(unit);
  header(w, 'Surf fin as B-spline surfaces', `${name}.step`, timestamp, FIN_BRAND);
  const defShape = productDefinition(w, name);
  const context = unitContext(w, unit);
  const blade = emitBlade(w, model);
  const tabs = emitTabs(w, d, SHEET_UNIT[unit].factor, opts.laminate);
  return finishShape(w, defShape, context, [blade, ...tabs]);
};
