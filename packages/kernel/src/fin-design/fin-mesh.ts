// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Triangle meshes of a fin for the 3D preview and STL: step 7 of
 * docs/design/fin-designer.md. Two closed shells, blade and tab, in the frame of
 * blade.ts and fin-step.ts (cm; the STL writer scales to mm).
 *
 * The blade is meshed straight from the smooth blade's rows, not from the STEP surface:
 * rings of {@link sectionLoop} along the fin, joined by quads, the root capped and the
 * last row closed. The tab is its profile (arcs sampled to
 * {@link FinMeshOptions.arcTolerance}) extruded across its thickness.
 *
 * Closed by construction: neighbouring triangles share vertex indices, so every edge
 * belongs to exactly two triangles, and each face group is wound against its
 * measured outward direction.
 */
import { meshWithNormals } from '../fins';
import type { BoardMesh } from '../tessellate';
import { vec2, type Vec2 } from '../vec2';
import type { Vert3 } from '../loft';
import { cosineStations, type FinLaminate, NO_LAMINATE } from './blade';
import { sectionLoop } from './blade-surface';
import { FIN_MIN_THICKNESS, type FinDesign } from './fin-design';
import { smoothBlade } from './smooth-blade';
import { finTabOutline } from './fin-tab';
import { tabCentreY, tabFacesY } from './fin-placement';
import type { TabSegment } from './futures-tab';
import { triangulate, triangulateWithHoles } from './triangulate';

export interface FinMeshOptions {
  /** Rings up the blade. */
  readonly rows?: number;
  /** Chord stations per face in each ring. */
  readonly stations?: number;
  /** How far below the tip the rings stop at most (cm); see `bladeTop`. */
  readonly tipGap?: number;
  /** Largest gap between a tab arc and its chords (cm). */
  readonly arcTolerance?: number;
  /** Mesh the blade as the core under this laminate (blade.ts), and the tab if it wraps it. */
  readonly laminate?: FinLaminate;
  /** Thinnest the blade gets (cm); the design minimum by default (blade.ts). */
  readonly minThickness?: number;
}

/** Light enough to rebuild on every edit. */
export const FIN_MESH_PREVIEW = {
  rows: 40,
  stations: 32,
  tipGap: 0.01,
  arcTolerance: 0.002,
  laminate: NO_LAMINATE,
  minThickness: FIN_MIN_THICKNESS,
};

/** For STL: rings about 0.5 mm apart on a 100 mm fin. */
export const FIN_MESH_FINE = {
  rows: 200,
  stations: 120,
  tipGap: 0.01,
  arcTolerance: 0.0005,
  laminate: NO_LAMINATE,
  minThickness: FIN_MIN_THICKNESS,
};

export interface FinMesh {
  readonly blade: BoardMesh;
  readonly tab: BoardMesh;
}

const sub = (a: Vert3, b: Vert3): Vert3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const crossV = (a: Vert3, b: Vert3): Vert3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vert3, b: Vert3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Collects vertices and triangles; `tri` winds each triangle about `outward`. */
const builder = () => {
  const positions: number[] = [];
  const indices: number[] = [];
  const pts: Vert3[] = [];
  return {
    add(p: Vert3): number {
      pts.push(p);
      positions.push(p.x, p.y, p.z);
      return pts.length - 1;
    },
    tri(a: number, b: number, c: number, outward: Vert3): void {
      const n = crossV(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
      if (dot(n, outward) >= 0) indices.push(a, b, c);
      else indices.push(a, c, b);
    },
    done: (): BoardMesh => meshWithNormals(positions, indices),
  };
};

/** Fill a flat ring (vertex ids, positions in the plane) facing `outward`. */
const cap = (
  m: ReturnType<typeof builder>,
  ids: readonly number[],
  flat: readonly Vec2[],
  outward: Vert3,
): void => {
  for (const [a, b, c] of triangulate(flat)) m.tri(ids[a]!, ids[b]!, ids[c]!, outward);
};

/**
 * The smooth blade's mesh (smooth-blade.ts): rings along its rows (s), each a section
 * loop from edge to edge, gathered toward the tip edge where the tip rounds over fastest;
 * the root ring capped flat, and the last row, at the tip edge, closed as a strip across
 * its minimum thickness.
 */
const smoothBladeMesh = (d: FinDesign, o: Required<FinMeshOptions>): BoardMesh => {
  const sb = smoothBlade(d, o.laminate, o.minThickness);
  const us = cosineStations(o.stations);
  // Gathered toward the tip edge (s = 1), even near the base.
  const ss = Array.from({ length: o.rows + 1 }, (_, i) => Math.sin((Math.PI / 2) * (i / o.rows)));
  const rows = ss.map((s) => {
    const outside: Vert3[] = [];
    const inside: Vert3[] = [];
    for (const u of us) {
      const f = sb.faces(s, u);
      outside.push(f.outside);
      inside.push(f.inside);
    }
    return { outside, inside };
  });
  const rings = rows.map((r) => sectionLoop(r).slice(0, -1));
  const m = builder();
  const ids = rings.map((ring) => ring.map((p) => m.add(p)));
  const n = rings[0]!.length;
  // Every quad is wound the same way round, as the rings all run the same way: which way
  // is outward is settled once, on the outside face halfway along the first row, where it
  // faces the outside. (Judged quad by quad from the ring's direction seen from above, as
  // the sweep's horizontal rings are, it flipped wherever a row runs up and down, round a
  // hook's tip.)
  const normal = (a: Vert3, b: Vert3, c: Vert3) => crossV(sub(b, a), sub(c, a));
  const ref = (() => {
    const j = Math.floor(us.length / 2);
    return normal(rings[0]![j]!, rings[0]![j + 1]!, rings[1]![j + 1]!);
  })();
  const sign = ref.y * sb.blade.outward >= 0 ? 1 : -1;
  /**
   * A triangle kept in its own order, or reversed with all the rest: never judged on its
   * own (an edge cap's triangles have no area to judge by).
   */
  const keep = (a: number, b: number, c: number, pa: Vert3, pb: Vert3, pc: Vert3) => {
    if (sign > 0) m.tri(a, b, c, normal(pa, pb, pc));
    else m.tri(a, c, b, normal(pa, pc, pb));
  };
  for (let k = 0; k < rings.length - 1; k++) {
    const r0 = rings[k]!;
    const r1 = rings[k + 1]!;
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      keep(ids[k]![j]!, ids[k]![j1]!, ids[k + 1]![j1]!, r0[j]!, r0[j1]!, r1[j1]!);
      keep(ids[k]![j]!, ids[k + 1]![j1]!, ids[k + 1]![j]!, r0[j]!, r1[j1]!, r1[j]!);
    }
  }
  const flat = (ring: readonly Vert3[]) => ring.map((p) => vec2(p.x, p.y));
  cap(m, ids[0]!, flat(rings[0]!), { x: 0, y: 0, z: -1 });
  // The tip edge: the last ring is the outside face's row, the trailing-edge cap, the inside
  // face's row back, and the leading-edge cap; close it face to face, across the minimum.
  // Each triangle is listed in the ring's own order round it, so it runs the ring's edges
  // the other way to the quads below (a closed shell), and takes the same outward choice.
  const top = ids[ids.length - 1]!;
  const ring = rings[rings.length - 1]!;
  const last = us.length - 1;
  const caps = (n - 2 * us.length) / 2;
  const outAt = (j: number) => j;
  const inAt = (j: number) => last + caps + 1 + (last - j);
  const close = (a: number, b: number, c: number) =>
    keep(top[a]!, top[b]!, top[c]!, ring[a]!, ring[b]!, ring[c]!);
  for (let j = 0; j < last; j++) {
    close(outAt(j), outAt(j + 1), inAt(j + 1));
    close(outAt(j), inAt(j + 1), inAt(j));
  }
  // The ends of the strip: each edge cap's points fanned from its first.
  const teCap = [outAt(last), ...Array.from({ length: caps }, (_, k) => last + 1 + k), inAt(last)];
  const leCap = [inAt(0), ...Array.from({ length: caps }, (_, k) => n - caps + k), outAt(0)];
  for (const fan of [teCap, leCap]) {
    for (let k = 1; k < fan.length - 1; k++) close(fan[0]!, fan[k]!, fan[k + 1]!);
  }
  return m.done();
};

/** The tab profile as a polygon (tab frame, counter-clockwise), arcs sampled to `tolerance` cm. */
export const tabProfilePoints = (segments: readonly TabSegment[], tolerance: number): Vec2[] =>
  segments.flatMap((s) => {
    if (s.kind === 'line') return [s.from];
    const a = Math.atan2(s.from.y - s.center.y, s.from.x - s.center.x);
    let sweep = Math.atan2(s.to.y - s.center.y, s.to.x - s.center.x) - a;
    if (s.ccw && sweep <= 0) sweep += 2 * Math.PI;
    if (!s.ccw && sweep >= 0) sweep -= 2 * Math.PI;
    // Chord sag r(1 − cos(step/2)) within tolerance.
    const step = 2 * Math.acos(Math.max(-1, 1 - tolerance / s.radius));
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / step));
    return Array.from({ length: n }, (_, i) =>
      vec2(
        s.center.x + s.radius * Math.cos(a + (sweep * i) / n),
        s.center.y + s.radius * Math.sin(a + (sweep * i) / n),
      ),
    );
  });

const tabMesh = (d: FinDesign, o: Required<FinMeshOptions>): BoardMesh => {
  const tab = finTabOutline(d.base, d.outline);
  const { height: H } = tab;
  const [yLo, yHi] = tabFacesY(d, o.laminate);
  // Bores are centred on the tab's own mid-plane, whatever a laminate takes off its faces.
  const yc = tabCentreY(d);
  const m = builder();
  // Each tab its own closed shell (FCS 1 has two).
  for (const part of tab.parts) {
    const profile = tabProfilePoints(part.segments, o.arcTolerance);
    const holes = part.holes.map((h) => tabProfilePoints(h, o.arcTolerance));
    // Tab frame (x, y up from the bottom) to the fin frame: z = y − H.
    const side = (ring: readonly Vec2[], y: number) =>
      ring.map((p) => m.add({ x: p.x, y, z: p.y - H }));
    const rings = [profile, ...holes];
    const lo = rings.map((r) => side(r, yLo));
    const hi = rings.map((r) => side(r, yHi));
    // The two sides: the profile less its holes.
    const flatIds = (ids: number[][]) => ids.flat();
    const tris = triangulateWithHoles(profile, holes);
    for (const [a, b, c] of tris) {
      const l = flatIds(lo);
      const h = flatIds(hi);
      m.tri(l[a]!, l[b]!, l[c]!, { x: 0, y: -1, z: 0 });
      m.tri(h[a]!, h[b]!, h[c]!, { x: 0, y: 1, z: 0 });
    }
    // Holes straight down (the US box screw hole): a ring where each bore leaves a flat
    // horizontal wall, shared with the bore's own wall.
    const bores = (part.bores ?? []).map((b) => {
      const n = Math.max(
        16,
        Math.ceil((2 * Math.PI * b.radius) / (2 * Math.sqrt(2 * b.radius * o.arcTolerance))),
      );
      const ring = (y: number) =>
        Array.from({ length: n }, (_, j) => {
          const a = (2 * Math.PI * j) / n;
          return { x: b.x + b.radius * Math.cos(a), y: yc + b.radius * Math.sin(a), z: y - H };
        });
      const bottom = ring(b.from);
      const top = ring(b.to);
      return {
        b,
        bottom,
        top,
        bottomIds: bottom.map((q) => m.add(q)),
        topIds: top.map((q) => m.add(q)),
      };
    });
    // The walls round the profile and through each hole. Outward is right of travel for
    // both: the profile runs counter-clockwise, each hole clockwise.
    rings.forEach((ring, r) => {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        const dx = ring[i1]!.x - ring[i]!.x;
        const dz = ring[i1]!.y - ring[i]!.y;
        const out = { x: dz, y: 0, z: -dx };
        // A flat horizontal wall a bore passes through: the wall with the bore's ring cut out.
        const level = r === 0 && dz === 0 ? ring[i]!.y : null;
        const lo0 = Math.min(ring[i]!.x, ring[i1]!.x);
        const hi0 = Math.max(ring[i]!.x, ring[i1]!.x);
        const cut = bores.filter(
          ({ b }) =>
            level !== null &&
            (b.from === level || b.to === level) &&
            b.x - b.radius > lo0 &&
            b.x + b.radius < hi0,
        );
        if (cut.length) {
          const corners = [lo[r]![i]!, lo[r]![i1]!, hi[r]![i1]!, hi[r]![i]!];
          const flat = (q: Vert3) => vec2(q.x, q.y);
          const cornerPts = [
            vec2(ring[i]!.x, yLo),
            vec2(ring[i1]!.x, yLo),
            vec2(ring[i1]!.x, yHi),
            vec2(ring[i]!.x, yHi),
          ];
          const holes = cut.map((c) => (c.b.from === level ? c.bottom : c.top));
          const holeIds = cut.map((c) => (c.b.from === level ? c.bottomIds : c.topIds));
          const ids = [...corners, ...holeIds.flat()];
          for (const [a, b2, c] of triangulateWithHoles(
            cornerPts,
            holes.map((h) => h.map(flat)),
          )) {
            m.tri(ids[a]!, ids[b2]!, ids[c]!, out);
          }
          continue;
        }
        m.tri(lo[r]![i]!, lo[r]![i1]!, hi[r]![i1]!, out);
        m.tri(lo[r]![i]!, hi[r]![i1]!, hi[r]![i]!, out);
      }
    });
    // Each bore's wall faces in, toward its axis.
    for (const { b, bottom, bottomIds, topIds } of bores) {
      const n = bottomIds.length;
      for (let j = 0; j < n; j++) {
        const j1 = (j + 1) % n;
        const q = bottom[j]!;
        const inward = { x: b.x - q.x, y: yc - q.y, z: 0 };
        m.tri(bottomIds[j]!, bottomIds[j1]!, topIds[j1]!, inward);
        m.tri(bottomIds[j]!, topIds[j1]!, topIds[j]!, inward);
      }
    }
  }
  return m.done();
};

/** Blade and tab meshes of a valid design (see `validateFinDesign`). */
export const finMesh = (d: FinDesign, opts: FinMeshOptions = {}): FinMesh => {
  const o = { ...FIN_MESH_PREVIEW, ...opts };
  return { blade: smoothBladeMesh(d, o), tab: tabMesh(d, o) };
};
