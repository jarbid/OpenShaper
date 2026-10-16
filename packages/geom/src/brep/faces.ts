// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A B-rep face as a trimmed surface (design §6.19), internal helpers shared by
 * the checker, the mass properties, the STEP writer and the mesher.
 *
 * **Orientation convention** (design §4.7, §13; stated here once). A loop's
 * coedges are listed in *face orientation*: seen from outside the solid (along
 * the face's outward normal) the outer loop runs counter-clockwise and a hole
 * loop clockwise, material on the left. A coedge's `pcurve` is the edge's
 * curve in the face's (u, v), **parameterised like the edge curve** whatever
 * the coedge's `sense`; `sense` only says which way the loop runs along it.
 * With `sameSense` the face normal is `Su × Sv`, so the face-orientation loop
 * is also counter-clockwise in (u, v); without it the face normal is
 * `−Su × Sv`, and the loop appears clockwise in (u, v). Trim loops
 * (decision 30) keep the material on the left in (u, v), so a face's
 * (u, v) loop is its face-orientation loop traversed backwards when
 * `sameSense` is false.
 */
import { reverseCurve2 } from '../trim';
import { makeTrimLoop, makeTrimmedSurface } from '../trim';
import { fail } from '../errors';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type {
  Brep,
  BrepFace,
  BrepLoop,
  ClampedCurve,
  GeomIssue,
  NurbsSurface,
  TrimLoop,
  TrimmedSurface,
} from '../types';
import { clampSurface } from './clamp';

/** The face's loop as 2D curves in (u, v) with the material on the left (module comment). */
export function uvLoopCurves(face: BrepFace, loop: BrepLoop): ClampedCurve<2>[] {
  const forward = (i: number): ClampedCurve<2> => {
    const c = loop.coedges[i]!;
    return c.sense ? c.pcurve : reverseCurve2(c.pcurve);
  };
  const n = loop.coedges.length;
  const out: ClampedCurve<2>[] = [];
  if (face.sameSense) {
    for (let i = 0; i < n; i++) out.push(forward(i));
  } else {
    // Backwards: the last coedge first, each curve reversed.
    for (let i = n - 1; i >= 0; i--) out.push(reverseCurve2(forward(i)));
  }
  return out;
}

/** The (u, v) loop of one B-rep loop; `snap` makes joins within the parameter tolerance bitwise. */
export function uvLoop(
  face: BrepFace,
  loop: BrepLoop,
  tol?: Partial<Tolerances>,
): { loop: TrimLoop | null; issues: readonly GeomIssue[] } {
  const r = makeTrimLoop(uvLoopCurves(face, loop), { snap: true, tol });
  return r.ok ? { loop: r.value, issues: r.issues } : { loop: null, issues: r.issues };
}

/** The surface's parameter extent in one direction: `[t_0, t_0 + T]` for a periodic basis. */
export function extentOf(b: NurbsSurface['u']): readonly [number, number] {
  return b.kind === 'periodic' ? [b.domain[0], b.domain[0] + b.period] : b.domain;
}

/**
 * True when the face has no holes and its outer loop is exactly the domain
 * rectangle: four straight pcurves, one on each side, each spanning the whole
 * side (to `paramRel × extent`). Such a face is *untrimmed*: its trimmed surface
 * is the natural boundary, and its STEP edges need no pcurves (`pcurves:
 * 'trimmedOnly'`).
 */
export function isNaturalFace(face: BrepFace, tol?: Partial<Tolerances>): boolean {
  if (face.holes.length > 0 || face.outer.coedges.length !== 4) return false;
  const t = resolveTolerances(tol);
  const [u0, u1] = extentOf(face.surface.u);
  const [v0, v1] = extentOf(face.surface.v);
  const eu = t.paramRel * (u1 - u0);
  const ev = t.paramRel * (v1 - v0);
  const seen = new Set<string>();
  for (const c of face.outer.coedges) {
    const q = c.pcurve;
    if (q.basis.degree !== 1 || q.basis.count !== 2) return false;
    const pa = { u: q.cw[0]! / q.cw[2]!, v: q.cw[1]! / q.cw[2]! };
    const pb = { u: q.cw[3]! / q.cw[5]!, v: q.cw[4]! / q.cw[5]! };
    const near = (x: number, y: number, e: number): boolean => Math.abs(x - y) <= e;
    let side: string | null = null;
    if (near(pa.u, pb.u, eu)) {
      // A line of constant u spanning v.
      if (near(pa.u, u0, eu)) side = 'u0';
      else if (near(pa.u, u1, eu)) side = 'u1';
      const spans =
        (near(pa.v, v0, ev) && near(pb.v, v1, ev)) || (near(pa.v, v1, ev) && near(pb.v, v0, ev));
      if (!spans) return false;
    } else if (near(pa.v, pb.v, ev)) {
      if (near(pa.v, v0, ev)) side = 'v0';
      else if (near(pa.v, v1, ev)) side = 'v1';
      const spans =
        (near(pa.u, u0, eu) && near(pb.u, u1, eu)) || (near(pa.u, u1, eu) && near(pb.u, u0, eu));
      if (!spans) return false;
    } else return false;
    if (side === null || seen.has(side)) return false;
    seen.add(side);
  }
  return seen.size === 4;
}

/**
 * A face as a trimmed surface, or the issues that stop it. An untrimmed face
 * keeps its surface as it is with `outer = null` (periodic directions allowed,
 * decision 29); a trimmed one is converted to the exactly equal surface
 * clamped in both directions (`clamp.ts`) and gets its (u, v) loops. Loop
 * orientation errors are reported, not repaired.
 */
export function trimFace(
  face: BrepFace,
  tol?: Partial<Tolerances>,
): { ts: TrimmedSurface | null; issues: readonly GeomIssue[] } {
  const issues: GeomIssue[] = [];
  const outer = uvLoop(face, face.outer, tol);
  issues.push(...outer.issues);
  const holes: TrimLoop[] = [];
  for (const h of face.holes) {
    const r = uvLoop(face, h, tol);
    issues.push(...r.issues);
    if (r.loop !== null) holes.push(r.loop);
  }
  if (outer.loop === null || holes.length !== face.holes.length) return { ts: null, issues };
  // Orientation is the caller's data, not ours to fix (`makeTrimmedSurface` would
  // reverse a wrong loop and warn): report it as the error it is.
  const wrong: GeomIssue[] = [];
  if (!(outer.loop.signedArea > 0)) {
    wrong.push({
      code: 'trim-orientation',
      severity: 'error',
      message: `outer loop has (u, v) signed area ${outer.loop.signedArea}: it does not run counter-clockwise about the face's outward normal for sameSense = ${face.sameSense}`,
      value: outer.loop.signedArea,
    });
  }
  holes.forEach((h, i) => {
    if (!(h.signedArea < 0)) {
      wrong.push({
        code: 'trim-orientation',
        severity: 'error',
        message: `hole ${i} has (u, v) signed area ${h.signedArea}: it does not run clockwise about the face's outward normal for sameSense = ${face.sameSense}`,
        at: { index: i + 1 },
        value: h.signedArea,
      });
    }
  });
  if (wrong.length > 0) return { ts: null, issues: [...issues, ...wrong] };
  if (isNaturalFace(face, tol)) {
    const ts = Object.freeze({
      surface: face.surface,
      outer: null,
      holes: Object.freeze([]),
    }) as unknown as TrimmedSurface;
    return { ts, issues };
  }
  const made = makeTrimmedSurface(clampSurface(face.surface), outer.loop, holes, tol);
  if (!made.ok) return { ts: null, issues: [...issues, ...made.issues] };
  return { ts: made.value, issues: [...issues, ...made.issues] };
}

/**
 * The trimmed surface of one face. A periodic untrimmed face keeps its
 * periodic surface; a trimmed one is on the exactly equal clamped surface, so
 * (u, v) are the same. Throws `brep-invalid` if the loops do not form a valid
 * trimmed surface (use `checkBrep` for the full report).
 */
export function faceTrimmedSurface(b: Brep, face: number): TrimmedSurface {
  const f = b.faces[face];
  if (f === undefined) fail('brep-reference', `no face ${face}`, { face });
  const { ts, issues } = trimFace(f);
  if (ts === null) {
    const first = issues.find((i) => i.severity === 'error');
    fail('brep-invalid', `face ${face} is not a valid trimmed surface: ${first?.message}`, {
      face,
    });
  }
  return ts;
}
