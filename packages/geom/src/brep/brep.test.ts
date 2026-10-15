// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The minimal B-rep (`brep.ts`, `faces.ts`, `continuity.ts`; design §13, §6.19).
 *
 * - **Valid solids.** Boxes, a cylinder, sphere zones and a torus build, are
 *   frozen, and have the topology counts of their closed forms.
 * - **Structural defects.** `makeBrep` reports each way of getting the
 *   topology wrong, with its code and where; the defect-injection catalogue
 *   (`testing/mutations.ts`) is run against every solid.
 * - **Transforms.** A rigid motion leaves the volume alone and moves the
 *   centroid; a mirror (negative determinant) flips every `sameSense` and
 *   reverses every loop, which is what keeps it outward (the naive mirror is
 *   inside-out: the test builds it and shows it); `orientBrep` repairs the
 *   inside-out one by the sign of the measured volume.
 * - **Faces as trimmed surfaces** (areas of the closed forms) and
 *   **continuity across edges** (a box's 90° edges, a sphere's G¹ equator).
 *
 * Tolerances are stated where they appear.
 */
import { describe, expect, it } from 'vitest';
import {
  brepEdgeContinuity,
  checkBrep,
  faceTrimmedSurface,
  isGeomError,
  makeBrep,
  massProperties,
  orientBrep,
  surfaceArea,
  transformBrep,
} from '../index';
import type { Affine3, Brep, BrepSpec, GeomErrorCode } from '../index';
import { boxSolid, cylinderSolid, MUTATIONS, sphericalZoneSolid, torusSolid } from '../testing';
import { checksum } from '../testing';

const SOLIDS: readonly (readonly [string, () => Brep])[] = [
  ['box', () => boxSolid(2, 3, 5)],
  ['trimmed box', () => boxSolid(2, 3, 5, { trimmed: true })],
  ['cylinder', () => cylinderSolid(1.5, 4)],
  ['zone', () => sphericalZoneSolid(2, 1)],
  ['split zone', () => sphericalZoneSolid(2, 1, { split: true })],
  ['torus', () => torusSolid(3, 1)],
];

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected GeomError '${code}'`);
}

const spec = (b: Brep): { -readonly [K in keyof BrepSpec]: BrepSpec[K] } => ({
  vertices: b.vertices,
  edges: b.edges,
  faces: b.faces,
  shells: b.shells,
  solids: b.solids,
});

describe('valid solids', () => {
  const counts: Record<string, [number, number, number]> = {
    box: [8, 12, 6],
    'trimmed box': [8, 12, 6],
    cylinder: [2, 3, 3],
    zone: [2, 3, 3],
    'split zone': [3, 5, 4],
    torus: [1, 2, 1],
  };
  for (const [name, build] of SOLIDS) {
    it(`${name}: vertices, edges, faces as the topology says; frozen; Euler holds`, () => {
      const b = build();
      const [V, E, F] = counts[name]!;
      expect([b.vertices.length, b.edges.length, b.faces.length]).toEqual([V, E, F]);
      for (const x of [b, b.vertices, b.edges, b.faces, b.shells, b.solids, b.faces[0]!.outer]) {
        expect(Object.isFrozen(x)).toBe(true);
      }
      const r = checkBrep(b);
      expect(r.issues).toEqual([]);
      expect(r.euler.holds).toBe(true);
      expect(r.euler).toMatchObject({ V, E, F });
    });
    it(`${name}: every edge is used twice, in opposite directions`, () => {
      const b = build();
      const uses = b.edges.map(() => [] as boolean[]);
      for (const f of b.faces) {
        for (const l of [f.outer, ...f.holes])
          for (const c of l.coedges) uses[c.edge]!.push(c.sense);
      }
      uses.forEach((u, e) => {
        expect(u.length, `edge ${e}`).toBe(2);
        expect(u[0], `edge ${e}`).not.toBe(u[1]);
      });
    });
  }

  it('a seam is an edge used twice by one face (cylinder, zone, torus)', () => {
    for (const b of [cylinderSolid(1.5, 4), sphericalZoneSolid(2, 1), torusSolid(3, 1)]) {
      const seams = b.edges.filter((_, e) =>
        b.faces.some((f) => f.outer.coedges.filter((c) => c.edge === e).length === 2),
      );
      expect(seams.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('does not write its input spec (the spec is copied)', () => {
    const b = boxSolid(2, 3, 5);
    const s = spec(b);
    const before = checksum(s);
    const r = makeBrep(s);
    expect(r.ok).toBe(true);
    expect(checksum(s)).toBe(before);
    expect(r.ok && r.value).not.toBe(b);
  });
});

describe('makeBrep: structural defects, with their codes and places', () => {
  const box = boxSolid(2, 3, 5);
  const firstIssue = (s: BrepSpec): { code: string; at?: unknown; message: string } => {
    const r = makeBrep(s);
    expect(r.ok, 'expected the defect to be reported').toBe(false);
    return r.issues[0]!;
  };

  it('an edge naming a missing vertex: brep-reference at the edge', () => {
    const s = spec(box);
    s.edges = s.edges.map((e, i) => (i === 3 ? { ...e, end: 99 } : e));
    const i = firstIssue(s);
    expect(i.code).toBe('brep-reference');
    expect(i.at).toMatchObject({ edge: 3 });
  });

  it('a coedge naming a missing edge: brep-reference at the coedge', () => {
    const s = spec(box);
    s.faces = s.faces.map((f, k) =>
      k === 2
        ? {
            ...f,
            outer: { coedges: f.outer.coedges.map((c, j) => (j === 1 ? { ...c, edge: 77 } : c)) },
          }
        : f,
    );
    const i = firstIssue(s);
    expect(i.code).toBe('brep-reference');
    expect(i.at).toMatchObject({ face: 2, coedge: [2, 0, 1] });
  });

  it('a loop that does not close in vertex order: brep-invalid at the coedge', () => {
    const s = spec(box);
    s.faces = s.faces.map((f, k) =>
      k === 4
        ? {
            ...f,
            outer: {
              coedges: f.outer.coedges.map((c, j) => (j === 2 ? { ...c, sense: !c.sense } : c)),
            },
          }
        : f,
    );
    const r = makeBrep(s);
    expect(r.ok).toBe(false);
    const hit = r.issues.find((x) => x.code === 'brep-invalid' && x.at?.face === 4);
    expect(hit, JSON.stringify(r.issues)).toBeDefined();
  });

  it('a dropped face leaves edges used once: brep-invalid at those edges', () => {
    const m = MUTATIONS.find((x) => x.name === 'drop a face')!;
    const r = makeBrep(m.apply(box));
    expect(r.ok).toBe(false);
    const once = r.issues.filter((x) => x.message.includes('used 1 times'));
    expect(once.length).toBe(4); // the four edges of the dropped rectangle
  });

  it('two uses in the same direction: the shell is not coherently oriented', () => {
    const m = MUTATIONS.find((x) => x.name === 'reverse one loop')!;
    const r = makeBrep(m.apply(box));
    expect(r.ok).toBe(false);
    expect(r.issues.some((x) => x.message.includes('same direction'))).toBe(true);
  });

  it('a pcurve over another parameter range than its edge: brep-invalid', () => {
    const s = spec(box);
    // Replace the first coedge's pcurve by one built on a [0, 2] domain.
    const wide = cylinderSolid(1, 1).faces[1]!.outer.coedges[0]!.pcurve; // circle2 on [0, 1]
    const stretched = { ...wide, basis: { ...wide.basis, domain: [0, 2] as const } };
    s.faces = s.faces.map((f, k) =>
      k === 0
        ? {
            ...f,
            outer: {
              coedges: f.outer.coedges.map((c, j) =>
                j === 0 ? { ...c, pcurve: stretched as typeof c.pcurve } : c,
              ),
            },
          }
        : f,
    );
    const r = makeBrep(s);
    expect(r.ok).toBe(false);
    expect(r.issues.some((x) => x.message.includes('same-parameter'))).toBe(true);
  });

  it('a vertex that belongs to no edge: brep-invalid', () => {
    const s = spec(box);
    s.vertices = [...s.vertices, { point: { x: 9, y: 9, z: 9 } }];
    const i = firstIssue(s);
    expect(i.code).toBe('brep-invalid');
    expect(i.at).toMatchObject({ vertex: 8 });
  });

  it('a non-finite vertex: non-finite', () => {
    const s = spec(box);
    s.vertices = s.vertices.map((v, k) => (k === 0 ? { point: { x: NaN, y: 0, z: 0 } } : v));
    expect(firstIssue(s).code).toBe('non-finite');
  });

  it('out-of-scope structure is reported as unsupported: open shell, two solids', () => {
    const open = spec(box);
    open.shells = [{ faces: box.shells[0]!.faces, closed: false }];
    expect(firstIssue(open).code).toBe('unsupported');
    const two = spec(box);
    two.solids = [...box.solids, ...box.solids];
    expect(firstIssue(two).code).toBe('unsupported');
  });

  it('a face in no shell: brep-invalid at the face', () => {
    const s = spec(box);
    s.shells = [{ faces: box.shells[0]!.faces.slice(1), closed: true }];
    const r = makeBrep(s);
    expect(r.ok).toBe(false);
    expect(r.issues.some((x) => x.at?.face === 0 && x.message.includes('in no shell'))).toBe(true);
  });

  it('a spec that is not a B-rep spec at all is a contract violation (throws)', () => {
    expectCode(() => makeBrep({} as unknown as BrepSpec), 'size-mismatch');
  });

  it('every structural mutation of the catalogue is rejected, on every solid', () => {
    for (const [name, build] of SOLIDS) {
      const b = build();
      for (const m of MUTATIONS.filter((x) => x.caughtBy(b) === 'makeBrep')) {
        expect(makeBrep(m.apply(b)).ok, `${m.name} on ${name} must fail makeBrep`).toBe(false);
      }
    }
  });

  it('the geometric mutations build (they are structurally valid): checkBrep must catch them', () => {
    for (const [name, build] of SOLIDS) {
      const b = build();
      for (const m of MUTATIONS.filter((x) => x.caughtBy(b) === 'checkBrep')) {
        const made = makeBrep(m.apply(b));
        expect(made.ok, `${m.name} on ${name} should build: ${JSON.stringify(made.issues)}`).toBe(
          true,
        );
        if (!made.ok) continue;
        const r = checkBrep(made.value);
        expect(r.ok, `${m.name} on ${name} must fail checkBrep`).toBe(false);
      }
    }
  });
});

describe('transformBrep and orientBrep', () => {
  const translate: Affine3 = [1, 0, 0, 100, 0, 1, 0, -50, 0, 0, 1, 20];
  const mirror: Affine3 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

  it('a translation by 100 cm leaves the volume unchanged (polynomial: exact rules)', () => {
    const b = boxSolid(2, 3, 5);
    const t = transformBrep(b, translate);
    const v = massProperties(t);
    // Exact rules, 3 flops of cancellation on coordinates 100 times the size: ≤ 1e-12 relative.
    expect(Math.abs(v.volume.value / 30 - 1)).toBeLessThan(1e-12);
    expect(v.centroid.x).toBeCloseTo(101, 9);
    expect(v.centroid.y).toBeCloseTo(-48.5, 9);
    expect(v.centroid.z).toBeCloseTo(22.5, 9);
    expect(checkBrep(t).ok).toBe(true);
  });

  it('a mirror flips every sameSense and reverses every loop, and stays outward', () => {
    for (const [name, build] of SOLIDS) {
      const b = build();
      const m = transformBrep(b, mirror);
      const r = checkBrep(m);
      expect(r.issues, name).toEqual([]);
      expect(r.signedVolume, name).toBeGreaterThan(0);
      m.faces.forEach((f, i) => {
        expect(f.sameSense, `${name} face ${i}`).toBe(!b.faces[i]!.sameSense);
        const was = b.faces[i]!.outer.coedges;
        f.outer.coedges.forEach((c, k) => {
          const w = was[was.length - 1 - k]!;
          expect(c.edge).toBe(w.edge);
          expect(c.sense).toBe(!w.sense);
        });
      });
      // The mirrored solid has the same volume and area.
      const a = massProperties(b);
      const z = massProperties(m);
      expect(Math.abs(z.volume.value / a.volume.value - 1), name).toBeLessThan(1e-9);
      expect(Math.abs(z.area.value / a.area.value - 1), name).toBeLessThan(1e-9);
      expect(z.centroid.x, name).toBeCloseTo(-a.centroid.x, 8);
    }
  });

  it('the naive mirror (flags and loops unchanged) is inside-out; orientBrep repairs it', () => {
    const b = cylinderSolid(1.5, 4);
    // The naive mirror: the mirrored geometry with the original flags and loops, i.e. the
    // correct result with the flip undone (the flip is an involution).
    const good = transformBrep(b, mirror);
    const inside = makeBrep({
      ...spec(good),
      faces: good.faces.map((f) => ({
        ...f,
        sameSense: !f.sameSense,
        outer: {
          coedges: f.outer.coedges
            .slice()
            .reverse()
            .map((c) => ({ ...c, sense: !c.sense })),
        },
      })),
    });
    expect(inside.ok).toBe(true);
    if (!inside.ok) return;
    const report = checkBrep(inside.value);
    expect(report.ok).toBe(false);
    expect(report.signedVolume).toBeLessThan(0);
    expect(report.issues.some((i) => i.message.includes('inside-out'))).toBe(true);
    const fixed = orientBrep(inside.value);
    expect(checkBrep(fixed).ok).toBe(true);
    expect(fixed.faces.map((f) => f.sameSense)).toEqual(good.faces.map((f) => f.sameSense));
  });

  it('orientBrep returns an outward B-rep as it is (same object)', () => {
    const b = sphericalZoneSolid(2, 1);
    expect(orientBrep(b)).toBe(b);
  });

  it('a singular map throws', () => {
    expectCode(
      () => transformBrep(boxSolid(1, 1, 1), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      'unsupported',
    );
  });

  it('does not write its input', () => {
    const b = cylinderSolid(1.5, 4);
    const before = checksum(b);
    transformBrep(b, mirror);
    orientBrep(b);
    expect(checksum(b)).toBe(before);
  });
});

describe('faceTrimmedSurface', () => {
  it('an untrimmed face is its natural boundary; a periodic surface is kept periodic', () => {
    const b = cylinderSolid(1.5, 4);
    const ts = faceTrimmedSurface(b, 0);
    expect(ts.outer).toBeNull();
    expect(ts.surface).toBe(b.faces[0]!.surface);
    expect(ts.surface.u.kind).toBe('periodic');
  });

  it('a trimmed face has its loop in (u, v) with the material on the left, whatever sameSense', () => {
    const b = cylinderSolid(1.5, 4);
    for (const i of [1, 2]) {
      const ts = faceTrimmedSurface(b, i);
      expect(ts.outer, `cap ${i}`).not.toBeNull();
      // The cap's (u, v) are lengths: the loop is the circle, area πr² (rational: adaptive
      // Green, quadRel 1e-10 per integral → 1e-9 relative).
      expect(Math.abs(ts.outer!.signedArea / (Math.PI * 1.5 * 1.5) - 1)).toBeLessThan(1e-9);
      expect(ts.surface.u.kind).toBe('clamped');
    }
    // The bottom cap has sameSense false and a one-coedge loop running against its curve.
    expect(b.faces[1]!.sameSense).toBe(false);
  });

  it('areas of the closed forms: box faces, cylinder, zone', () => {
    const box = boxSolid(2, 3, 5, { trimmed: true });
    const areas = box.faces.map((_, i) => surfaceArea(faceTrimmedSurface(box, i)).value);
    // Polynomial faces: exact rules, rounding only (1e-13 relative).
    const expected = [6, 6, 10, 10, 15, 15]; // z, z, y-faces (2×5), x-faces (3×5)
    areas.forEach((a, i) =>
      expect(Math.abs(a / expected[i]! - 1), `face ${i}`).toBeLessThan(1e-13),
    );

    const cyl = cylinderSolid(1.5, 4);
    const ca = cyl.faces.map((_, i) => surfaceArea(faceTrimmedSurface(cyl, i)).value);
    expect(Math.abs(ca[0]! / (2 * Math.PI * 1.5 * 4) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(ca[1]! / (Math.PI * 1.5 * 1.5) - 1)).toBeLessThan(1e-9);
  });

  it('a face whose sameSense disagrees with its loop is not a valid trimmed surface', () => {
    const m = MUTATIONS.find((x) => x.name === 'flip a face sense')!;
    const r = makeBrep(m.apply(cylinderSolid(1.5, 4)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectCode(() => faceTrimmedSurface(r.value, 0), 'brep-invalid');
  });

  it('an unknown face is a reference error', () => {
    expectCode(() => faceTrimmedSurface(boxSolid(1, 1, 1), 9), 'brep-reference');
  });
});

describe('brepEdgeContinuity', () => {
  it('every edge of a box is a 90° crease with no gap', () => {
    const b = boxSolid(2, 3, 5);
    for (let e = 0; e < b.edges.length; e++) {
      const p = brepEdgeContinuity(b, e);
      // atan2 angles are good to 1e-16; rational-free planes: 1e-12 is generous.
      expect(Math.abs(p.max.normalAngle - Math.PI / 2), `edge ${e}`).toBeLessThan(1e-12);
      expect(p.max.gap, `edge ${e}`).toBeLessThan(1e-12);
      expect(p.max.curvatureMismatch, `edge ${e}`).toBeLessThan(1e-12);
    }
  });

  it('the equator shared by two sphere bands is G¹ (angle 0) and G² (same curvature)', () => {
    const b = sphericalZoneSolid(2, 1, { split: true });
    // Edge 2 is the equator (0 bottom ring, 1 top ring, 2 equator).
    const p = brepEdgeContinuity(b, 2);
    expect(p.max.gap).toBeLessThan(1e-12);
    expect(p.max.normalAngle).toBeLessThan(1e-9); // normals of a rational sphere: ~1e-15; 1e-9 sees a wrong side
    expect(p.max.curvatureMismatch).toBeLessThan(1e-9);
  });

  it('the cylinder meets its caps at 90°', () => {
    const b = cylinderSolid(1.5, 4);
    for (const e of [0, 1]) {
      const p = brepEdgeContinuity(b, e);
      expect(Math.abs(p.max.normalAngle - Math.PI / 2)).toBeLessThan(1e-9);
      expect(p.max.gap).toBeLessThan(1e-12);
    }
  });

  it('a seam (one face on both sides) is smooth: the pcurves wrap round the period', () => {
    for (const [b, e] of [
      [cylinderSolid(1.5, 4), 2],
      [sphericalZoneSolid(2, 1), 2],
      [torusSolid(3, 1), 0],
      [torusSolid(3, 1), 1],
    ] as const) {
      const p = brepEdgeContinuity(b, e);
      expect(p.max.gap).toBeLessThan(1e-12);
      expect(p.max.normalAngle).toBeLessThan(1e-9);
    }
  });

  it('an unknown edge is a reference error', () => {
    expectCode(() => brepEdgeContinuity(boxSolid(1, 1, 1), 99), 'brep-reference');
  });
});
