// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Degenerate edges (poles): a lens of two biquadratic faces whose ends u = 0 and u = 1 collapse to one point
 * each, joined along their v = 0 and v = 1 rows. Each face closes its loop through a degenerate edge at each
 * pole (used once, `start === end`, a constant curve). `makeBrep` accepts it and refuses misuse, `checkBrep`
 * passes it (Euler–Poincaré without the degenerate edges: V 2, E 2, F 2) and refuses a degenerate curve away
 * from its vertex, and the STEP writer writes no edge for a pole: each loop is the two real edges.
 */
import { describe, expect, it } from 'vitest';
import { clampedBasis } from '../basis';
import { makeCurve } from '../curve';
import { line2 } from '../primitives';
import { boundaryCurve, makeSurface } from '../surface';
import { writeStep } from '../step/write';
import type { BrepEdge, BrepFace, BrepSpec, ClampedCurve, NurbsSurface } from '../types';
import { makeBrep } from './brep';
import { checkBrep, orientBrep } from './check';

const quad = clampedBasis(2, [0, 0, 0, 1, 1, 1]);

/** A side of the lens: poles at x = 0 and x = 2, bulging to y = ±1 at the middle row. */
const side = (sign: 1 | -1): NurbsSurface =>
  makeSurface({
    u: quad,
    v: quad,
    // prettier-ignore
    points: [
      0, 0, 0,  0, 0, 0,  0, 0, 0,
      1, 0, -1, 1, sign, 0, 1, 0, 1,
      2, 0, 0,  2, 0, 0,  2, 0, 0,
    ],
  });

const coedge = (edge: number, sense: boolean, pcurve: ClampedCurve<2>) => ({
  edge,
  sense,
  pcurve,
  master: 'curve3d' as const,
});

function lensSpec(opts: { shareTip?: boolean; bentPole?: boolean } = {}): BrepSpec {
  const plus = side(1);
  const minus = side(-1);
  const c = (s: NurbsSurface, e: 'u0' | 'u1' | 'v0' | 'v1') =>
    boundaryCurve(s, e) as ClampedCurve<3>;
  const bent = makeCurve({ dim: 3, basis: clampedBasis(1, [0, 0, 1, 1]), points: [2, 0, 0, 2, 0.1, 0] }) as ClampedCurve<3>; // prettier-ignore
  const edges: BrepEdge[] = [
    { curve: c(plus, 'v0'), start: 0, end: 1 },
    { curve: c(plus, 'v1'), start: 0, end: 1 },
    { curve: c(plus, 'u0'), start: 0, end: 0, degenerate: true },
    { curve: opts.bentPole ? bent : c(plus, 'u1'), start: 1, end: 1, degenerate: true },
    { curve: c(minus, 'u0'), start: 0, end: 0, degenerate: true },
    { curve: c(minus, 'u1'), start: 1, end: 1, degenerate: true },
  ];
  const pB = line2({ x: 0, y: 0 }, { x: 1, y: 0 });
  const pD = line2({ x: 0, y: 1 }, { x: 1, y: 1 });
  const p0 = line2({ x: 0, y: 0 }, { x: 0, y: 1 });
  const p1 = line2({ x: 1, y: 0 }, { x: 1, y: 1 });
  // same (u, v) orientation on both: the minus face's Su × Sv points out (−y), the plus face's in
  const face = (s: NurbsSurface, same: boolean, e0: number, e1: number): BrepFace => ({
    surface: s,
    sameSense: same,
    outer: {
      coedges: same
        ? [coedge(0, true, pB), coedge(e1, true, p1), coedge(1, false, pD), coedge(e0, false, p0)]
        : [coedge(e0, true, p0), coedge(1, true, pD), coedge(e1, false, p1), coedge(0, false, pB)],
    },
    holes: [],
  });
  return {
    vertices: [{ point: { x: 0, y: 0, z: 0 } }, { point: { x: 2, y: 0, z: 0 } }],
    edges,
    faces: [face(plus, false, 2, 3), face(minus, true, 4, opts.shareTip ? 3 : 5)],
    shells: [{ faces: [0, 1], closed: true }],
    solids: [{ outer: 0 }],
  };
}

describe('degenerate edges (poles)', () => {
  it('a lens with a pole at each end is a valid closed solid', () => {
    const made = makeBrep(lensSpec());
    expect(made.ok && made.issues).toEqual([]);
    if (!made.ok) return;
    const b = orientBrep(made.value);
    const r = checkBrep(b);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.euler).toMatchObject({ V: 2, E: 2, F: 2, G: 0, holds: true });
    expect(r.signedVolume).toBeGreaterThan(0);
    expect(b.edges[2]!.degenerate).toBe(true);
  });

  it('a degenerate edge is used once and at one vertex', () => {
    const shared = makeBrep(lensSpec({ shareTip: true }));
    expect(shared.ok).toBe(false);
    if (!shared.ok) expect(shared.issues.map((i) => i.message).join(' ')).toContain('a pole belongs to one face'); // prettier-ignore
    const spec = lensSpec();
    const open = makeBrep({
      ...spec,
      edges: spec.edges.map((e, i) => (i === 2 ? { ...e, end: 1 } : e)),
    });
    expect(open.ok).toBe(false);
  });

  it('checkBrep refuses a degenerate edge whose curve leaves its vertex', () => {
    const made = makeBrep(lensSpec({ bentPole: true }));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const r = checkBrep(made.value);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.startsWith('degenerate edge 3'))).toBe(true);
  });

  it('the STEP file has no edge for a pole: each loop is the two real edges', () => {
    const made = makeBrep(lensSpec());
    if (!made.ok) throw new Error('lens refused');
    const out = writeStep(orientBrep(made.value), { pcurves: 'trimmedOnly' });
    expect(out.text.match(/EDGE_CURVE\(/g)?.length).toBe(2);
    expect(out.text.match(/ORIENTED_EDGE\(/g)?.length).toBe(4);
    expect(out.text.match(/VERTEX_POINT\(/g)?.length).toBe(2);
    expect(out.stats.edges).toBe(2);
  });
});
