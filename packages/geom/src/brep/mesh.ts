// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Edge-first watertight tessellation of a B-rep (design §6.19, §11.5).
 *
 * Meshing each face against its own pcurves would leave the mesh open along
 * every edge shared by two *different surfaces*: each face evaluates its own
 * surface at the shared parameters, and the two points differ by the edge's
 * gap. So the edges are sampled first, once, and the faces are meshed against
 * those samples:
 *
 * 1. **Edges.** Each edge curve is sampled adaptively in 3D (chord deviation
 *    `chordTol`, end-tangent angle `angleTol` on chords longer than `minEdge`,
 *    length `maxEdge`; each knot span starts with `degree` parts), exactly as
 *    the face boundary sampler does. The sample parameters belong to the
 *    edge, so both of its uses see the same ones. Their 3D positions are the
 *    edge curve's, and the end samples are the B-rep vertices, so every edge
 *    meeting at a vertex shares one position, bitwise.
 * 2. **Faces.** A face's boundary samples are its coedges' pcurves evaluated
 *    at the edge's sample parameters, in the face's (u, v) loop order
 *    (material on the left), handed to `tessellateTrimmedSurface` as the
 *    `BoundarySamples`. A seam is two coedges with different (u, v) and the same
 *    samples, so a periodic face's two sides get the same 3D points.
 * 3. **Assembly.** The mesh vertices of boundary samples take the shared
 *    positions (the face's own evaluation, within the edge gap of them, is
 *    discarded). Faces whose `sameSense` is false have their triangles
 *    reversed and normals negated, so every triangle is outward. Vertices are
 *    stored per face (a crease keeps both faces' normals); `weld` maps each
 *    vertex to a welded id, equal for the vertices that coincide on an edge,
 *    so the welded mesh is a closed 2-manifold whatever the creases.
 */
import { errResult, okResult } from '../errors';
import { breakpoints } from '../basis';
import { curveDerivatives, curvePoint } from '../curve';
import { fail } from '../errors';
import { tessellateTrimmedSurface } from '../mesh/tessellate';
import type { FaceMesh, TessellationOptions } from '../mesh/tessellate';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type {
  Brep,
  BrepCoedge,
  BrepFace,
  BrepLoop,
  ClampedCurve,
  GeomIssue,
  Point3,
  Result,
} from '../types';
import { trimFace } from './faces';

/** A tessellated B-rep (module comment). */
export interface BrepMesh {
  /** The faces' own meshes, as the tessellator made them (positions not yet welded to the edges). */
  readonly faces: readonly FaceMesh[];
  /** Vertex positions, stride 3, per-face blocks; boundary vertices take the edge-first shared positions. */
  readonly positions: Float64Array;
  /** Outward unit normals (exact `±Su × Sv`; zero where degenerate), stride 3. */
  readonly normals: Float64Array;
  /** Outward counter-clockwise triangles, three vertex indices each. */
  readonly indices: Uint32Array;
  /** `faces + 1` entries: face `f` owns triangles `faceRanges[f] … faceRanges[f + 1] − 1`. */
  readonly faceRanges: Uint32Array;
  /** `faces + 1` entries: face `f` owns vertices `vertexRanges[f] … vertexRanges[f + 1] − 1`. */
  readonly vertexRanges: Uint32Array;
  /** Per vertex: its welded id. Vertices that coincide on an edge share one. */
  readonly weld: Uint32Array;
  /** Largest chord error reported by any face's tessellation (cm). */
  readonly maxChordError: number;
}

function checkOptions(o: TessellationOptions): {
  chordTol: number;
  angleTol: number;
  maxEdge: number;
  minEdge: number;
} {
  if (!(Number.isFinite(o.chordTol) && o.chordTol > 0)) {
    fail('unsupported', `chordTol must be a finite number > 0; got ${o.chordTol}`, {
      value: o.chordTol,
    });
  }
  if (!(Number.isFinite(o.angleTol) && o.angleTol > 0)) {
    fail('unsupported', `angleTol must be a finite number > 0; got ${o.angleTol}`, {
      value: o.angleTol,
    });
  }
  const maxEdge = o.maxEdge ?? Infinity;
  if (!(maxEdge > 0))
    fail('unsupported', `maxEdge must be > 0; got ${maxEdge}`, { value: maxEdge });
  const minEdge = o.minEdge ?? o.chordTol;
  if (!(minEdge >= 0))
    fail('unsupported', `minEdge must be ≥ 0; got ${minEdge}`, { value: minEdge });
  return { chordTol: o.chordTol, angleTol: o.angleTol, maxEdge, minEdge };
}

const dist = (a: Point3, b: Point3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Parameters of an adaptively sampled edge curve, ascending, ends included (module comment, item 1). */
function sampleEdge(
  c: ClampedCurve<3>,
  o: ReturnType<typeof checkOptions>,
  t: Tolerances,
): Float64Array {
  const [a, b] = c.basis.domain;
  const minWidth = t.paramRel * (b - a);
  const breaks = Array.from(breakpoints(c.basis));
  const out: number[] = [];
  const parts = Math.max(1, c.basis.degree);
  const tangent = (x: number): Point3 => curveDerivatives(c, x, 1)[1]!;
  const needsSplit = (t0: number, t1: number): boolean => {
    const mid = 0.5 * (t0 + t1);
    if (!(mid > t0 && mid < t1) || t1 - t0 <= minWidth) return false;
    const p0 = curvePoint(c, t0);
    const p1 = curvePoint(c, t1);
    const pm = curvePoint(c, mid);
    const dev = dist(pm, {
      x: 0.5 * (p0.x + p1.x),
      y: 0.5 * (p0.y + p1.y),
      z: 0.5 * (p0.z + p1.z),
    });
    const len = dist(p0, p1);
    if (dev > o.chordTol || len > o.maxEdge) return true;
    if (len <= o.minEdge) return false;
    const u = tangent(t0);
    const v = tangent(t1);
    const nu = Math.hypot(u.x, u.y, u.z);
    const nv = Math.hypot(v.x, v.y, v.z);
    if (!(nu > 0 && nv > 0)) return false;
    const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / (nu * nv);
    return Math.acos(Math.max(-1, Math.min(1, cos))) > o.angleTol;
  };
  out.push(a);
  for (let i = 0; i + 1 < breaks.length; i++) {
    // Depth-first over [lo, hi], emitting right ends in ascending order.
    const stack: [number, number][] = [];
    const lo0 = breaks[i]!;
    const hi0 = breaks[i + 1]!;
    for (let k = parts - 1; k >= 0; k--) {
      stack.push([
        lo0 + ((hi0 - lo0) * k) / parts,
        k === parts - 1 ? hi0 : lo0 + ((hi0 - lo0) * (k + 1)) / parts,
      ]);
    }
    while (stack.length > 0) {
      const [t0, t1] = stack.pop()!;
      if (needsSplit(t0, t1)) {
        const mid = 0.5 * (t0 + t1);
        stack.push([mid, t1], [t0, mid]);
      } else out.push(t1);
    }
  }
  out[out.length - 1] = b;
  return Float64Array.from(out);
}

/** The loop's coedges in (u, v) order (material on the left) with whether each runs along its edge's parameter. */
function uvOrder(face: BrepFace, loop: BrepLoop): { c: BrepCoedge; forward: boolean }[] {
  const n = loop.coedges.length;
  const out: { c: BrepCoedge; forward: boolean }[] = [];
  if (face.sameSense) {
    for (let i = 0; i < n; i++) out.push({ c: loop.coedges[i]!, forward: loop.coedges[i]!.sense });
  } else {
    for (let i = n - 1; i >= 0; i--)
      out.push({ c: loop.coedges[i]!, forward: !loop.coedges[i]!.sense });
  }
  return out;
}

/**
 * Tessellates the B-rep edge-first (module comment). Errors: `brep-invalid`
 * for a face that is not a valid trimmed surface, `tessellation-failure`
 * (located at the face) when a face's boundary cannot be triangulated. Every
 * warning of the face tessellations is passed on, located at its face.
 */
export function tessellateBrep(b: Brep, opts: TessellationOptions): Result<BrepMesh> {
  const o = checkOptions(opts);
  const tol = resolveTolerances();
  const samples = b.edges.map((e) => sampleEdge(e.curve, o, tol));
  const nVertices = b.vertices.length;
  // Welded ids: the B-rep vertices first, then each edge's interior samples.
  const base: number[] = [];
  let nWelded = nVertices;
  for (const s of samples) {
    base.push(nWelded);
    nWelded += s.length - 2;
  }
  const weldedId = (e: number, k: number): number => {
    const n = samples[e]!.length - 1;
    if (k === 0) return b.edges[e]!.start;
    if (k === n) return b.edges[e]!.end;
    return base[e]! + k - 1;
  };
  const weldedPos = new Float64Array(3 * nWelded);
  b.vertices.forEach((v, i) => {
    weldedPos[3 * i] = v.point.x;
    weldedPos[3 * i + 1] = v.point.y;
    weldedPos[3 * i + 2] = v.point.z;
  });
  b.edges.forEach((e, ei) => {
    const s = samples[ei]!;
    for (let k = 1; k < s.length - 1; k++) {
      const p = curvePoint(e.curve, s[k]!);
      const at = 3 * (base[ei]! + k - 1);
      weldedPos[at] = p.x;
      weldedPos[at + 1] = p.y;
      weldedPos[at + 2] = p.z;
    }
  });

  const issues: GeomIssue[] = [];
  const faceMeshes: FaceMesh[] = [];
  const blocks: {
    mesh: FaceMesh;
    boundaryIds: number[];
    sameSense: boolean;
  }[] = [];
  for (let fi = 0; fi < b.faces.length; fi++) {
    const f = b.faces[fi]!;
    const { ts, issues: trimIssues } = trimFace(f);
    if (ts === null) {
      const first = trimIssues.find((i) => i.severity === 'error');
      return errResult([
        {
          code: 'brep-invalid',
          severity: 'error',
          message: `face ${fi} is not a valid trimmed surface: ${first?.message}`,
          at: { face: fi },
        },
      ]);
    }
    const uv: number[] = [];
    const ids: number[] = [];
    const loopStarts: number[] = [0];
    for (const loop of [f.outer, ...f.holes]) {
      for (const { c, forward } of uvOrder(f, loop)) {
        const s = samples[c.edge]!;
        const n = s.length - 1;
        for (let j = 0; j < n; j++) {
          const k = forward ? j : n - j;
          const p = curvePoint(c.pcurve, s[k]!);
          uv.push(p.x, p.y);
          ids.push(weldedId(c.edge, k));
        }
      }
      loopStarts.push(ids.length);
    }
    const r = tessellateTrimmedSurface(ts, opts, { uv, loopStarts, edges: ids });
    if (!r.ok) {
      return errResult([...r.issues.map((i) => ({ ...i, at: { ...i.at, face: fi } }))]);
    }
    for (const w of r.issues) issues.push({ ...w, at: { ...w.at, face: fi } });
    faceMeshes.push(r.value);
    blocks.push({ mesh: r.value, boundaryIds: ids, sameSense: f.sameSense });
  }

  // Assembly.
  let nv = 0;
  let nt = 0;
  for (const blk of blocks) {
    nv += blk.mesh.uv.length / 2;
    nt += blk.mesh.triangles.length / 3;
  }
  const positions = new Float64Array(3 * nv);
  const normals = new Float64Array(3 * nv);
  const indices = new Uint32Array(3 * nt);
  const faceRanges = new Uint32Array(blocks.length + 1);
  const vertexRanges = new Uint32Array(blocks.length + 1);
  const weld = new Uint32Array(nv);
  let nextInterior = nWelded;
  let vAt = 0;
  let tAt = 0;
  let maxChordError = 0;
  blocks.forEach((blk, fi) => {
    const m = blk.mesh;
    const count = m.uv.length / 2;
    const sign = blk.sameSense ? 1 : -1;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        positions[3 * (vAt + i) + k] = m.position[3 * i + k]!;
        normals[3 * (vAt + i) + k] = sign * m.normal[3 * i + k]!;
      }
    }
    const inBoundary = new Uint8Array(count);
    m.loopVertices.forEach((mv, s) => {
      const id = blk.boundaryIds[s]!;
      inBoundary[mv] = 1;
      weld[vAt + mv] = id;
      for (let k = 0; k < 3; k++) positions[3 * (vAt + mv) + k] = weldedPos[3 * id + k]!;
    });
    for (let i = 0; i < count; i++) if (inBoundary[i] === 0) weld[vAt + i] = nextInterior++;
    const tris = m.triangles.length / 3;
    for (let t = 0; t < tris; t++) {
      const a = m.triangles[3 * t]! + vAt;
      const bb = m.triangles[3 * t + 1]! + vAt;
      const c = m.triangles[3 * t + 2]! + vAt;
      indices[3 * (tAt + t)] = a;
      indices[3 * (tAt + t) + 1] = blk.sameSense ? bb : c;
      indices[3 * (tAt + t) + 2] = blk.sameSense ? c : bb;
    }
    vAt += count;
    tAt += tris;
    faceRanges[fi + 1] = tAt;
    vertexRanges[fi + 1] = vAt;
    maxChordError = Math.max(maxChordError, m.maxChordError);
  });
  return okResult(
    Object.freeze({
      faces: Object.freeze(faceMeshes),
      positions,
      normals,
      indices,
      faceRanges,
      vertexRanges,
      weld,
      maxChordError,
    }),
    issues,
  );
}
