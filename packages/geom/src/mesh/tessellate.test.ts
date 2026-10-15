// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tessellation (design §11.5, §16 "tessellate").
 *
 * Oracles and tolerances:
 * - **chord error** at every triangle centroid and edge midpoint, measured as
 *   the true distance to the surface: analytic for the sphere and torus,
 *   `closestPointOnSurface` for a bicubic. Bound: `chordTol` plus `1e-9` cm
 *   for the rounding of the distance computation itself (positions of size
 *   ~10 cm, ~10⁻¹⁵ relative; the projection converges to `paramRel`);
 * - **exact normals and curvatures**: on the sphere `n = (P − c)/r` and
 *   `k1 = k2 = −1/r` (§4.7 signs), within 1e-12 and 1e-9 relative (rational
 *   evaluation rounding; curvature from second derivatives);
 * - **topology**: every triangle counter-clockwise in (u, v) (exact
 *   `orient2d`); a doubly periodic torus welded along its bitwise-identical
 *   seam vertices has Euler characteristic 0; boundary vertices lie exactly on
 *   their trim curves at their stored parameters;
 * - **watertight shared edges**: two faces on one surface sharing a trim
 *   circle, the second given the first's boundary samples reversed: the
 *   shared vertices' positions are bitwise equal and every shared edge is used
 *   once by each face in opposite directions;
 * - **creases and folds** (normal discontinuities, where no refinement can
 *   meet `angleTol`): across a C0 knot line no triangle straddles the crease
 *   (edges are compared with one-sided normals and split on the knot line);
 *   across a fold every straddling edge is at most `minEdge` long, and the
 *   mesh stays bounded (it would otherwise refine to rounding);
 * - **convergence**: the enclosed volume of the sphere mesh converges to
 *   `4/3 πr³` at O(h²): halving `maxEdge` (with chord and angle tolerances out
 *   of the way) divides the error by 3.5–4.5 (design §16).
 */
import { describe, expect, it } from 'vitest';
import { transformCurve2 } from '../curve';
import { closestPointOnSurface } from '../project';
import { clampedBasis } from '../basis';
import { bezierSurface, circle2, sphere, torus } from '../primitives';
import { makeSurface } from '../surface';
import { DEFAULT_TOLERANCES } from '../tolerance';
import { makeTrimLoop, makeTrimmedSurface } from '../trim';
import type { ClampedCurve, NurbsSurface, Result, TrimmedSurface } from '../types';
import { curveEvalInto } from '../curve';
import { createScratch } from '../array';
import { orient2d } from './predicates';
import { DEFAULT_TESSELLATION, retargetTessellation, tessellateTrimmedSurface } from './tessellate';
import type { FaceMesh } from './tessellate';

function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const natural = (s: NurbsSurface): TrimmedSurface =>
  ok(makeTrimmedSurface(s, null)) as TrimmedSurface;

/** Rounding allowance of the distance measurement (see the module comment). */
const MEASURE = 1e-9;

/** Every edge midpoint and centroid of the mesh, as 3D points. */
function probes(m: FaceMesh): number[][] {
  const P = m.position;
  const T = m.triangles;
  const out: number[][] = [];
  const at = (v: number): number[] => [P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!];
  for (let i = 0; i < T.length; i += 3) {
    const a = at(T[i]!);
    const b = at(T[i + 1]!);
    const c = at(T[i + 2]!);
    out.push([0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]!) / 3));
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      out.push([0, 1, 2].map((k) => 0.5 * (p[k]! + q[k]!)));
    }
  }
  return out;
}

function allCCW(m: FaceMesh): boolean {
  const U = m.uv;
  const T = m.triangles;
  for (let i = 0; i < T.length; i += 3) {
    const [a, b, c] = [T[i]!, T[i + 1]!, T[i + 2]!];
    if (
      !(orient2d(U[2 * a]!, U[2 * a + 1]!, U[2 * b]!, U[2 * b + 1]!, U[2 * c]!, U[2 * c + 1]!) > 0)
    )
      return false;
  }
  return true;
}

/** Signed volume of a closed (or seam-split) triangle mesh: Σ det(a, b, c)/6. */
function meshVolume(m: FaceMesh): number {
  const P = m.position;
  const T = m.triangles;
  let v = 0;
  for (let i = 0; i < T.length; i += 3) {
    const [a, b, c] = [3 * T[i]!, 3 * T[i + 1]!, 3 * T[i + 2]!];
    v +=
      (P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
        P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
        P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)) /
      6;
  }
  return v;
}

describe('tessellateTrimmedSurface: closed surfaces', () => {
  const r = 10;
  const C = { x: 1, y: -2, z: 3 };
  const S = sphere(C, r);

  it('sphere: chord error, exact normals and curvatures, counter-clockwise triangles', () => {
    const m = ok(tessellateTrimmedSurface(natural(S), DEFAULT_TESSELLATION));
    expect(allCCW(m)).toBe(true);
    expect(m.maxChordError).toBeLessThanOrEqual(DEFAULT_TESSELLATION.chordTol);
    let worst = 0;
    for (const p of probes(m)) {
      const d = Math.abs(Math.hypot(p[0]! - C.x, p[1]! - C.y, p[2]! - C.z) - r);
      if (d > worst) worst = d;
    }
    expect(worst).toBeLessThanOrEqual(DEFAULT_TESSELLATION.chordTol + MEASURE);
    // The bound is used: the mesh is not needlessly fine.
    expect(worst).toBeGreaterThan(0.25 * DEFAULT_TESSELLATION.chordTol);
    const n = m.uv.length / 2;
    let nErr = 0;
    let kErr = 0;
    for (let i = 0; i < n; i++) {
      if (m.flags[i]! & 1) continue; // poles
      const q = [
        m.position[3 * i]! - C.x,
        m.position[3 * i + 1]! - C.y,
        m.position[3 * i + 2]! - C.z,
      ];
      for (let k = 0; k < 3; k++) nErr = Math.max(nErr, Math.abs(m.normal[3 * i + k]! - q[k]! / r));
      kErr = Math.max(
        kErr,
        Math.abs(m.curvature[2 * i]! * r + 1),
        Math.abs(m.curvature[2 * i + 1]! * r + 1),
      );
    }
    expect(nErr).toBeLessThanOrEqual(1e-12);
    expect(kErr).toBeLessThanOrEqual(1e-9);
  });

  it('torus: welded along its bitwise-identical seams, Euler characteristic 0', () => {
    const R = 10;
    const rr = 3;
    const T = torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, R, rr);
    const m = ok(tessellateTrimmedSurface(natural(T), { chordTol: 0.02, angleTol: 0.2 }));
    expect(allCCW(m)).toBe(true);
    let worst = 0;
    for (const p of probes(m)) {
      const rho = Math.hypot(p[0]!, p[1]!);
      const d = Math.abs(Math.hypot(rho - R, p[2]!) - rr);
      if (d > worst) worst = d;
    }
    expect(worst).toBeLessThanOrEqual(0.02 + MEASURE);
    // Weld vertices with bitwise-equal positions (the seams u = 0 ≡ 1, v = 0 ≡ 1 wrap exactly).
    const key = (i: number): string =>
      `${m.position[3 * i]},${m.position[3 * i + 1]},${m.position[3 * i + 2]}`;
    const id = new Map<string, number>();
    const map: number[] = [];
    for (let i = 0; i < m.uv.length / 2; i++) {
      const k = key(i);
      if (!id.has(k)) id.set(k, id.size);
      map.push(id.get(k)!);
    }
    const edges = new Map<string, number>();
    const tri = m.triangles;
    for (let i = 0; i < tri.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = map[tri[i + k]!]!;
        const b = map[tri[i + ((k + 1) % 3)]!]!;
        const e = `${a}>${b}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
    // Closed and oriented: every directed edge once, its reverse once.
    for (const [e, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = e.split('>');
      expect(edges.get(`${b}>${a}`)).toBe(1);
    }
    const V = id.size;
    const E = edges.size / 2;
    const F = tri.length / 3;
    expect(V - E + F).toBe(0);
    // Enclosed volume is close (the chord error bounds it): 2π²Rr².
    expect(Math.abs(meshVolume(m) / (2 * Math.PI ** 2 * R * rr * rr) - 1)).toBeLessThan(0.01);
  });

  it('sphere mesh volume converges at O(h²) as maxEdge halves', () => {
    const V = (4 / 3) * Math.PI * r ** 3;
    const errs: number[] = [];
    for (const maxEdge of [4, 2, 1]) {
      const m = ok(
        tessellateTrimmedSurface(natural(S), { chordTol: 1e3, angleTol: Math.PI, maxEdge }),
      );
      errs.push(Math.abs(meshVolume(m) - V));
    }
    for (let k = 1; k < errs.length; k++) {
      const ratio = errs[k - 1]! / errs[k]!;
      expect(ratio).toBeGreaterThanOrEqual(3.5);
      expect(ratio).toBeLessThanOrEqual(4.5);
    }
  });
});

/** A doubly curved bicubic patch over [0, 20]² with heights up to ~6. */
function bump(): NurbsSurface {
  const pts: number[] = [];
  const h = [
    [0, 1, 2, 0],
    [1, 6, 4, 1],
    [2, 3, 6, 2],
    [0, 2, 1, 0],
  ];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) pts.push((20 * i) / 3, (20 * j) / 3, h[i]![j]!);
  return bezierSurface(pts, 4, 4);
}

const cwCircle = (cu: number, cv: number, rr: number): ClampedCurve<2> =>
  transformCurve2(circle2({ x: cu, y: cv }, rr), [1, 0, 0, 0, -1, 2 * cv]);

/** Triangles with vertices on both sides of `u = k` and the 3D lengths of their edges crossing it. */
function straddling(m: FaceMesh, k: number): { count: number; maxCrossing: number } {
  let count = 0;
  let maxCrossing = 0;
  const T = m.triangles;
  const P = m.position;
  for (let i = 0; i < T.length; i += 3) {
    const us = [0, 1, 2].map((j) => m.uv[2 * T[i + j]!]!);
    if (!(Math.min(...us) < k && Math.max(...us) > k)) continue;
    count++;
    for (let j = 0; j < 3; j++) {
      const a = T[i + j]!;
      const b = T[i + ((j + 1) % 3)]!;
      if ((m.uv[2 * a]! - k) * (m.uv[2 * b]! - k) >= 0) continue;
      const d = Math.hypot(
        P[3 * a]! - P[3 * b]!,
        P[3 * a + 1]! - P[3 * b + 1]!,
        P[3 * a + 2]! - P[3 * b + 2]!,
      );
      maxCrossing = Math.max(maxCrossing, d);
    }
  }
  return { count, maxCrossing };
}

describe('tessellateTrimmedSurface: normal discontinuities', () => {
  it('a crease at a C0 knot line is meshed along the line, not refined into', () => {
    // Degree 1 in u with a full-multiplicity knot at 0.5: a roof whose faces
    // meet at ~53°, curved in v; trimmed by a circle crossing the crease.
    const pts: number[] = [];
    const ridge = [0, 5, 0];
    const sag = [0, 3, 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) pts.push(10 * i, 10 * j, ridge[i]! + sag[j]!);
    }
    const roof = makeSurface({
      u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
      v: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: pts,
    });
    for (const outer of [null, ok(makeTrimLoop([circle2({ x: 0.5, y: 0.5 }, 0.35)]))]) {
      const r = tessellateTrimmedSurface(ok(makeTrimmedSurface(roof, outer)), DEFAULT_TESSELLATION);
      expect(r.issues).toEqual([]);
      const m = ok(r);
      expect(allCCW(m)).toBe(true);
      // Exact: every triangle lies on one side of the crease.
      expect(straddling(m, 0.5).count).toBe(0);
      // Bounded: two-sided normals at the ridge vertices made it ~13k (trimmed).
      expect(m.triangles.length / 3).toBeLessThan(1000);
    }
  });

  it('a fold stops refining at minEdge', () => {
    // x(u) = 40u − 30u² folds back at u = 2/3 (S_u = 0 there, normal flips).
    const fold = bezierSurface([0, 0, 0, 0, 10, 0, 20, 0, 0, 20, 10, 0, 10, 0, 0, 10, 10, 0], 3, 2);
    const counts: number[] = [];
    for (const minEdge of [0.02, 0.01]) {
      const m = ok(tessellateTrimmedSurface(natural(fold), { ...DEFAULT_TESSELLATION, minEdge }));
      const s = straddling(m, 2 / 3);
      expect(s.count).toBeGreaterThan(0);
      // An unconstrained edge is split for the angle only while longer than minEdge.
      expect(s.maxCrossing).toBeLessThanOrEqual(minEdge);
      counts.push(m.triangles.length / 3);
    }
    // The fold costs O(length / minEdge) triangles: halving minEdge about doubles it.
    expect(counts[1]! / counts[0]!).toBeGreaterThan(1.5);
    expect(counts[1]! / counts[0]!).toBeLessThan(2.5);
  });
});

describe('tessellateTrimmedSurface: trimmed faces', () => {
  const S = bump();
  const disc = ok(makeTrimmedSurface(S, ok(makeTrimLoop([circle2({ x: 0.45, y: 0.5 }, 0.3)]))));

  it('chord error by projection; boundary vertices exactly on their trim curves', () => {
    const tol = { chordTol: 0.005, angleTol: 0.05 };
    const m = ok(tessellateTrimmedSurface(disc, tol));
    expect(allCCW(m)).toBe(true);
    let worst = 0;
    for (const p of probes(m)) {
      const pr = closestPointOnSurface(S, { x: p[0]!, y: p[1]!, z: p[2]! });
      expect(pr.converged).toBe(true);
      worst = Math.max(worst, pr.distance);
    }
    expect(worst).toBeLessThanOrEqual(tol.chordTol + MEASURE);
    const c = disc.outer!.curves[0]!;
    const sc = createScratch({ maxDegree: 3 });
    const out = new Float64Array(2);
    expect(m.loopVertices.length).toBeGreaterThan(16);
    for (let k = 0; k < m.loopVertices.length; k++) {
      const v = m.loopVertices[k]!;
      expect(m.boundaryEdge[v]).toBe(0);
      curveEvalInto(c, m.boundaryParam[v]!, 0, out, 0, sc);
      if (m.boundaryParam[v] === 0) {
        expect([m.uv[2 * v], m.uv[2 * v + 1]]).toEqual([c.cw[0]! / c.cw[2]!, c.cw[1]! / c.cw[2]!]);
      } else expect([m.uv[2 * v], m.uv[2 * v + 1]]).toEqual([out[0], out[1]]);
    }
    // Interior vertices are marked −1.
    expect(Array.from(m.boundaryEdge).filter((e) => e === -1).length).toBe(
      m.uv.length / 2 - m.loopVertices.length,
    );
  });

  it('two faces sharing a trim circle are watertight', () => {
    const tol = { chordTol: 0.01, angleTol: 0.1 };
    const inner = ok(tessellateTrimmedSurface(disc, tol));
    const ring = ok(makeTrimmedSurface(S, null, [ok(makeTrimLoop([cwCircle(0.45, 0.5, 0.3)]))]));
    // The ring's outer loop is natural (sampled by the tessellator); its hole
    // takes the disc's samples in reverse, as a B-rep edge shared by both.
    const own = ok(tessellateTrimmedSurface(ring, tol));
    const nOuter = own.loopStarts[1]!;
    const uv: number[] = [];
    for (let k = 0; k < nOuter; k++) {
      const v = own.loopVertices[k]!;
      uv.push(own.uv[2 * v]!, own.uv[2 * v + 1]!);
    }
    const lv = inner.loopVertices;
    for (let k = lv.length - 1; k >= 0; k--)
      uv.push(inner.uv[2 * lv[k]!]!, inner.uv[2 * lv[k]! + 1]!);
    const outer = ok(
      tessellateTrimmedSurface(ring, tol, { uv, loopStarts: [0, nOuter, nOuter + lv.length] }),
    );
    expect(outer.boundarySource).toBe('caller');
    // Shared vertices: bitwise equal positions.
    const posKey = (m: FaceMesh, v: number): string =>
      `${m.position[3 * v]},${m.position[3 * v + 1]},${m.position[3 * v + 2]}`;
    const hole = Array.from(outer.loopVertices).slice(nOuter);
    expect(hole.map((v) => posKey(outer, v))).toEqual(
      Array.from(lv)
        .reverse()
        .map((v) => posKey(inner, v)),
    );
    // Every shared edge is used once by each face, in opposite directions.
    const directed = (m: FaceMesh): Set<string> => {
      const s = new Set<string>();
      for (let i = 0; i < m.triangles.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          s.add(`${posKey(m, m.triangles[i + k]!)}>${posKey(m, m.triangles[i + ((k + 1) % 3)]!)}`);
        }
      }
      return s;
    };
    const dIn = directed(inner);
    const dOut = directed(outer);
    for (let k = 0; k < lv.length; k++) {
      const a = posKey(inner, lv[k]!);
      const b = posKey(inner, lv[(k + 1) % lv.length]!);
      expect(dIn.has(`${a}>${b}`)).toBe(true);
      expect(dOut.has(`${b}>${a}`)).toBe(true);
      expect(dOut.has(`${a}>${b}`)).toBe(false);
    }
  });

  it('retargets while the trim moves a little, and refuses a flip', () => {
    const tol = { chordTol: 0.01, angleTol: 0.1 };
    const m = ok(tessellateTrimmedSurface(disc, tol));
    const moved = ok(makeTrimmedSurface(S, ok(makeTrimLoop([circle2({ x: 0.452, y: 0.5 }, 0.3)]))));
    const rm = retargetTessellation(m, moved);
    expect(rm).not.toBeNull();
    expect(rm!.triangles).toBe(m.triangles);
    expect(allCCW(rm!)).toBe(true);
    const v = m.loopVertices[3]!;
    const c = moved.outer!.curves[0]!;
    const out = new Float64Array(2);
    curveEvalInto(c, m.boundaryParam[v]!, 0, out, 0, createScratch({ maxDegree: 2 }));
    expect([rm!.uv[2 * v], rm!.uv[2 * v + 1]]).toEqual([out[0], out[1]]);
    // Positions follow the plan.
    expect(rm!.position[3 * v]).not.toBe(m.position[3 * v]);
    const far = ok(makeTrimmedSurface(S, ok(makeTrimLoop([circle2({ x: 0.45, y: 0.5 }, 0.05)]))));
    expect(retargetTessellation(m, far)).toBeNull();
  });

  it('fails on crossing caller boundaries', () => {
    const r = tessellateTrimmedSurface(disc, DEFAULT_TESSELLATION, {
      uv: [0.1, 0.1, 0.9, 0.9, 0.1, 0.9, 0.9, 0.1],
      loopStarts: [0, 4],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('tessellation-failure');
    expect(DEFAULT_TOLERANCES.paramRel).toBeGreaterThan(0);
  });
});
