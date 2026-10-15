// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Edge-first watertight tessellation of a B-rep (`mesh.ts`; design §6.19, §11.5,
 * §16 `tessellate` row). Oracles:
 *
 * - **Closed 2-manifold.** Welding the vertices by `weld`, every directed edge
 *   of the triangle soup occurs once and its reverse once, and the Euler
 *   characteristic `V − E + F` is 2 (boxes, cylinder, zones) or 0 (torus): the
 *   mesh has no hole and no T-junction, even across edges shared by different
 *   surfaces.
 * - **Edge-first.** Vertices that coincide on an edge have bitwise identical
 *   positions; the B-rep vertices are exactly the vertex points.
 * - **Outward.** Every triangle's geometric normal agrees with the exact
 *   outward normal at its vertices (also for `sameSense = false` faces and for
 *   mirrored solids), and the mesh volume is positive.
 * - **Convergence.** The mesh volume differs from the closed form by at most
 *   `Σ area_f · maxChordError_f` (every point of an inscribed mesh is within
 *   the reported chord error of the surface), and shrinks as `chordTol` does:
 *   the error is O(chordTol), so a 4× tighter tolerance cuts it by 2.5 to 6×.
 */
import { describe, expect, it } from 'vitest';
import { isGeomError, makeBrep, tessellateBrep, transformBrep } from '../index';
import type { Affine3, Brep, BrepMesh, GeomErrorCode, TessellationOptions } from '../index';
import {
  boxSolid,
  cylinderSolid,
  MUTATIONS,
  plateWithHoleSolid,
  sphericalZoneSolid,
  torusSolid,
} from '../testing';
import { checksum } from '../testing';

const PI = Math.PI;
const OPTS = { chordTol: 0.01, angleTol: 0.2 };
const zoneVolume = (r: number, phi: number): number => {
  const h = 2 * r * Math.sin(phi);
  return PI * (r * r * h - (h * h * h) / 12);
};
const zoneArea = (r: number, phi: number): number =>
  2 * PI * r * 2 * r * Math.sin(phi) + 2 * PI * (r * Math.cos(phi)) ** 2;

const mirror: Affine3 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const SOLIDS: readonly {
  name: string;
  brep: () => Brep;
  volume: number;
  area: number;
  euler: number;
}[] = [
  { name: 'box', brep: () => boxSolid(2, 3, 5), volume: 30, area: 62, euler: 2 },
  {
    name: 'trimmed box',
    brep: () => boxSolid(2, 3, 5, { trimmed: true }),
    volume: 30,
    area: 62,
    euler: 2,
  },
  {
    name: 'cylinder',
    brep: () => cylinderSolid(1.5, 4),
    volume: PI * 1.5 * 1.5 * 4,
    area: 2 * PI * 1.5 * 4 + 2 * PI * 1.5 * 1.5,
    euler: 2,
  },
  {
    name: 'zone',
    brep: () => sphericalZoneSolid(2, 1),
    volume: zoneVolume(2, 1),
    area: zoneArea(2, 1),
    euler: 2,
  },
  {
    name: 'split zone',
    brep: () => sphericalZoneSolid(2, 1, { split: true }),
    volume: zoneVolume(2, 1),
    area: zoneArea(2, 1),
    euler: 2,
  },
  {
    name: 'torus',
    brep: () => torusSolid(3, 1),
    volume: 2 * PI * PI * 3,
    area: 4 * PI * PI * 3,
    euler: 0,
  },
  {
    // Genus 1, faces with hole loops: V − E + F = 0 and the closed forms
    // volume 60 − 2π, area 104 − 2π + 4π.
    name: 'plate with a hole',
    brep: () => plateWithHoleSolid(6, 5, 2, 1),
    volume: 60 - 2 * PI,
    area: 104 + 2 * PI,
    euler: 0,
  },
  {
    name: 'mirrored cylinder',
    brep: () => transformBrep(cylinderSolid(1.5, 4), mirror),
    volume: PI * 1.5 * 1.5 * 4,
    area: 2 * PI * 1.5 * 4 + 2 * PI * 1.5 * 1.5,
    euler: 2,
  },
  {
    name: 'mirrored zone',
    brep: () => transformBrep(sphericalZoneSolid(2, 1, { split: true }), mirror),
    volume: zoneVolume(2, 1),
    area: zoneArea(2, 1),
    euler: 2,
  },
];

function mesh(b: Brep, opts: TessellationOptions = OPTS): BrepMesh {
  const r = tessellateBrep(b, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

/** Signed volume of the triangle soup (divergence theorem). */
function volumeOf(m: BrepMesh): number {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]! * 3;
    const b = m.indices[t + 1]! * 3;
    const c = m.indices[t + 2]! * 3;
    v +=
      (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
      6;
  }
  return v;
}

/** Directed welded edges with their multiplicity. */
function directedEdges(m: BrepMesh): Map<string, number> {
  const out = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    const w = [0, 1, 2].map((k) => m.weld[m.indices[t + k]!]!);
    for (let e = 0; e < 3; e++) {
      const key = `${w[e]},${w[(e + 1) % 3]}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

describe('tessellateBrep: watertight by construction', () => {
  for (const s of SOLIDS) {
    it(`${s.name}: a closed 2-manifold with Euler characteristic ${s.euler}`, () => {
      const m = mesh(s.brep());
      const dir = directedEdges(m);
      for (const [key, n] of dir) {
        const [a, b] = key.split(',');
        expect(n, `edge ${key} occurs ${n} times`).toBe(1);
        expect(dir.get(`${b},${a}`), `edge ${key} has no opposite`).toBe(1);
      }
      const V = new Set(m.weld).size;
      const E = dir.size / 2;
      const F = m.indices.length / 3;
      expect(V - E + F).toBe(s.euler);
    });

    it(`${s.name}: vertices that coincide on an edge are bitwise identical`, () => {
      const b = s.brep();
      const m = mesh(b);
      const first = new Map<number, number>();
      let shared = 0;
      for (let v = 0; v < m.weld.length; v++) {
        const w = m.weld[v]!;
        const at = first.get(w);
        if (at === undefined) first.set(w, v);
        else {
          shared++;
          for (let k = 0; k < 3; k++) {
            expect(m.positions[3 * v + k], `weld ${w} component ${k}`).toBe(
              m.positions[3 * at + k],
            );
          }
        }
      }
      expect(shared).toBeGreaterThan(0);
      // The B-rep vertices are welded ids 0 …, at exactly the vertex points.
      b.vertices.forEach((p, i) => {
        const v = first.get(i)!;
        expect(m.positions[3 * v]).toBe(p.point.x);
        expect(m.positions[3 * v + 1]).toBe(p.point.y);
        expect(m.positions[3 * v + 2]).toBe(p.point.z);
      });
    });

    it(`${s.name}: every triangle is outward and the volume is positive`, () => {
      const m = mesh(s.brep());
      expect(volumeOf(m)).toBeGreaterThan(0);
      const p = m.positions;
      let checked = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const i = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
        const [a, b, c] = i.map((k) => 3 * k) as [number, number, number];
        const ux = p[b]! - p[a]!,
          uy = p[b + 1]! - p[a + 1]!,
          uz = p[b + 2]! - p[a + 2]!;
        const vx = p[c]! - p[a]!,
          vy = p[c + 1]! - p[a + 1]!,
          vz = p[c + 2]! - p[a + 2]!;
        const nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx;
        if (Math.hypot(nx, ny, nz) < 1e-12) continue; // a sliver has no direction
        let sx = 0,
          sy = 0,
          sz = 0;
        for (const k of i) {
          sx += m.normals[3 * k]!;
          sy += m.normals[3 * k + 1]!;
          sz += m.normals[3 * k + 2]!;
        }
        expect(nx * sx + ny * sy + nz * sz, `triangle ${t / 3} faces inward`).toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(10);
    });

    it(`${s.name}: layout is consistent (ranges, welded ids, frozen result)`, () => {
      const b = s.brep();
      const m = mesh(b);
      expect(m.faceRanges.length).toBe(b.faces.length + 1);
      expect(m.vertexRanges.length).toBe(b.faces.length + 1);
      expect(m.faceRanges[b.faces.length]).toBe(m.indices.length / 3);
      expect(m.vertexRanges[b.faces.length]).toBe(m.positions.length / 3);
      expect(m.weld.length).toBe(m.positions.length / 3);
      for (let f = 0; f < b.faces.length; f++) {
        expect(m.faceRanges[f + 1]!).toBeGreaterThan(m.faceRanges[f]!);
        // A face's triangles use only its own vertices.
        for (let t = m.faceRanges[f]!; t < m.faceRanges[f + 1]!; t++) {
          for (let k = 0; k < 3; k++) {
            const v = m.indices[3 * t + k]!;
            expect(v >= m.vertexRanges[f]! && v < m.vertexRanges[f + 1]!).toBe(true);
          }
        }
      }
      expect(Object.isFrozen(m)).toBe(true);
      expect(m.faces.length).toBe(b.faces.length);
    });
  }
});

describe('tessellateBrep: accuracy', () => {
  for (const s of SOLIDS) {
    it(`${s.name}: |mesh volume − closed form| ≤ Σ area · reported chord error`, () => {
      const m = mesh(s.brep());
      const bound = s.area * m.maxChordError + 1e-12 * s.volume;
      const err = Math.abs(volumeOf(m) - s.volume);
      expect(err, `mesh ${volumeOf(m)} vs ${s.volume}, bound ${bound}`).toBeLessThanOrEqual(bound);
      expect(m.maxChordError).toBeLessThanOrEqual(OPTS.chordTol * 1.0000001);
    });
  }

  it('the volume error shrinks with chordTol: 4× tighter cuts it by 2.5 to 6× (cylinder, torus)', () => {
    for (const [b, volume] of [
      [cylinderSolid(1.5, 4), PI * 1.5 * 1.5 * 4],
      [torusSolid(3, 1), 2 * PI * PI * 3],
    ] as const) {
      const errs = [0.04, 0.01, 0.0025].map((chordTol) =>
        Math.abs(volumeOf(mesh(b, { chordTol, angleTol: 0.5 })) - volume),
      );
      expect(errs[1]!).toBeLessThan(errs[0]!);
      expect(errs[2]!).toBeLessThan(errs[1]!);
      for (const k of [0, 1]) {
        const ratio = errs[k]! / errs[k + 1]!;
        expect(ratio, `ratio ${ratio}`).toBeGreaterThan(2.5);
        expect(ratio, `ratio ${ratio}`).toBeLessThan(6);
      }
    }
  });

  it('maxEdge bounds the shared edges: every triangle edge on the cylinder is at most maxEdge', () => {
    const maxEdge = 0.6;
    const m = mesh(cylinderSolid(1.5, 4), { chordTol: 0.05, angleTol: 0.5, maxEdge });
    const p = m.positions;
    let longest = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = 3 * m.indices[t + e]!;
        const b = 3 * m.indices[t + ((e + 1) % 3)]!;
        longest = Math.max(
          longest,
          Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!),
        );
      }
    }
    expect(longest).toBeLessThanOrEqual(maxEdge * (1 + 1e-9));
  });
});

describe('tessellateBrep: errors and purity', () => {
  it('does not write its input', () => {
    const b = cylinderSolid(1.5, 4);
    const before = checksum(b);
    mesh(b);
    expect(checksum(b)).toBe(before);
  });

  it('a face whose flags disagree with its loop is a located brep-invalid, not a bad mesh', () => {
    const b = cylinderSolid(1.5, 4);
    const made = makeBrep(MUTATIONS.find((m) => m.name === 'flip a face sense')!.apply(b));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const r = tessellateBrep(made.value, OPTS);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'brep-invalid', at: { face: 0 } });
  });

  it('options are validated', () => {
    const b = boxSolid(1, 1, 1);
    for (const bad of [
      { chordTol: 0, angleTol: 0.1 },
      { chordTol: 0.01, angleTol: -1 },
      { chordTol: 0.01, angleTol: 0.1, maxEdge: 0 },
      { chordTol: NaN, angleTol: 0.1 },
    ]) {
      try {
        tessellateBrep(b, bad);
        expect.unreachable('expected a GeomError');
      } catch (e) {
        expect(isGeomError(e, 'unsupported' as GeomErrorCode)).toBe(true);
      }
    }
  });
});
