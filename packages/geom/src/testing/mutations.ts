// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The defect-injection catalogue (design §13, §15.3): mutations of a valid
 * B-rep, each a plausible way for a producer to go wrong, returned as an
 * unvalidated `BrepSpec` so a test can see which layer catches it. The
 * structural ones fail `makeBrep`; the geometric ones build fine and must fail
 * `checkBrep`. Test-only.
 *
 * Every mutation applies to any solid of the corpus (face 0, its first outer
 * coedge, vertex 0, edge 0 are always there). Sizes are chosen two orders above
 * the `fit` tolerance where a geometric size matters, so a detected defect is
 * not a matter of tolerance luck.
 */
import { surfaceFromHomogeneous } from '../surface';
import { DEFAULT_TOLERANCES } from '../tolerance';
import { transformCurve } from '../curve';
import { reverseCurve2 } from '../trim';
import type { Affine3, Brep, BrepFace, BrepLoop, BrepSpec } from '../types';

export interface Mutation {
  readonly name: string;
  /** Which layer must reject the result of applying it to `b`. */
  readonly caughtBy: (b: Brep) => 'makeBrep' | 'checkBrep';
  readonly apply: (b: Brep) => BrepSpec;
}

const spec = (b: Brep): { -readonly [K in keyof BrepSpec]: BrepSpec[K] } => ({
  vertices: b.vertices,
  edges: b.edges,
  faces: b.faces,
  shells: b.shells,
  solids: b.solids,
});

const withFace = (b: Brep, i: number, f: (face: BrepFace) => BrepFace): BrepSpec => ({
  ...spec(b),
  faces: b.faces.map((face, k) => (k === i ? f(face) : face)),
});

const reverseLoop = (l: BrepLoop): BrepLoop => ({
  coedges: l.coedges
    .slice()
    .reverse()
    .map((c) => ({ ...c, sense: !c.sense })),
});

/** Two orders above `fit` (cm). */
const BIG = 100 * DEFAULT_TOLERANCES.fit;

export const MUTATIONS: readonly Mutation[] = [
  {
    name: 'flip a face sense',
    caughtBy: () => 'checkBrep',
    apply: (b) => withFace(b, 0, (f) => ({ ...f, sameSense: !f.sameSense })),
  },
  {
    name: 'flip a coedge',
    caughtBy: () => 'makeBrep',
    apply: (b) =>
      withFace(b, 0, (f) => ({
        ...f,
        outer: {
          coedges: f.outer.coedges.map((c, i) => (i === 0 ? { ...c, sense: !c.sense } : c)),
        },
      })),
  },
  {
    name: 'reverse one loop',
    // With one face (the torus) reversing its loop reverses the whole shell: still coherent,
    // but inside-out, so only the measured volume catches it.
    caughtBy: (b) => (b.faces.length === 1 ? 'checkBrep' : 'makeBrep'),
    apply: (b) => withFace(b, 0, (f) => ({ ...f, outer: reverseLoop(f.outer) })),
  },
  {
    name: 'drop a face',
    caughtBy: () => 'makeBrep',
    apply: (b) => ({
      ...spec(b),
      faces: b.faces.slice(1),
      shells: [{ faces: b.faces.slice(1).map((_, i) => i), closed: true }],
    }),
  },
  {
    name: 'move a vertex',
    caughtBy: () => 'checkBrep',
    apply: (b) => ({
      ...spec(b),
      vertices: b.vertices.map((v, i) =>
        i === 0 ? { point: { x: v.point.x + BIG, y: v.point.y, z: v.point.z } } : v,
      ),
    }),
  },
  {
    name: 'corrupt a weight',
    caughtBy: () => 'checkBrep',
    apply: (b) =>
      withFace(b, 0, (f) => {
        // Scale the last control point in both directions, which lies on two edges whatever
        // the bases: the far corner of a clamped net, the seam row and column of a periodic one
        // (a periodic curve passes through its *last* control point at the seam). Homogeneous:
        // the Euclidean point stays, the weight changes, so the edges' parameterisations
        // change. A weight inside the net moves no edge, and no edge check could see it.
        const cw = Float64Array.from(f.surface.cw);
        const last = (f.surface.u.count * f.surface.v.count - 1) * 4;
        for (let k = 0; k < 4; k++) cw[last + k]! *= 1.1;
        return { ...f, surface: surfaceFromHomogeneous({ u: f.surface.u, v: f.surface.v, cw }) };
      }),
  },
  {
    name: 'offset an edge curve',
    caughtBy: () => 'checkBrep',
    apply: (b) => {
      const m: Affine3 = [1, 0, 0, BIG, 0, 1, 0, 0, 0, 0, 1, 0];
      return {
        ...spec(b),
        edges: b.edges.map((e, i) => (i === 0 ? { ...e, curve: transformCurve(e.curve, m) } : e)),
      };
    },
  },
  {
    name: 'reverse a pcurve',
    caughtBy: () => 'checkBrep',
    apply: (b) =>
      withFace(b, 0, (f) => ({
        ...f,
        outer: {
          coedges: f.outer.coedges.map((c, i) =>
            i === 0 ? { ...c, pcurve: reverseCurve2(c.pcurve) } : c,
          ),
        },
      })),
  },
  {
    name: 'declare a wrong genus',
    caughtBy: () => 'checkBrep',
    apply: (b) => ({ ...spec(b), solids: [{ outer: 0, genus: (b.solids[0]!.genus ?? 0) + 1 }] }),
  },
];
