// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The minimal B-rep (design §13, §6.19): index-based, immutable records.
 * `makeBrep` is the cheap structural validation; the expensive geometric one
 * is `checkBrep` (`check.ts`).
 *
 * **Scope.** One solid bounded by one closed shell of manifold faces; faces
 * with an outer loop and holes; closed edges (`start === end`); seam edges (an
 * edge used twice by one face). Out of scope: collapsed edges and poles, voids,
 * open shells, non-manifold topology, disconnected shells.
 *
 * **Conventions** (`faces.ts` states the loop and pcurve ones). An edge is the
 * whole of its curve, from `start` (parameter `a`) to `end` (parameter `b`). A
 * coedge with `sense` runs from the edge's `start` vertex to its `end` vertex,
 * without it the other way. A manifold edge has two uses running in opposite
 * directions (one `sense` true, one false); a seam is such an edge whose two
 * uses are in the same face, with its pcurves on opposite sides of the
 * periodic domain (`u = t_0` and `u = t_0 + T`).
 */
import { checkBasisShape, transformCurve } from '../curve';
import { fail, errResult, okResult } from '../errors';
import { checkSurfaceShape, transformSurface } from '../surface';
import { resolveTolerances } from '../tolerance';
import { affineDeterminant, applyAffine3 } from '../vec';
import type {
  Affine3,
  Brep,
  BrepCoedge,
  BrepEdge,
  BrepFace,
  BrepLoop,
  BrepShell,
  BrepSolid,
  BrepSpec,
  BrepVertex,
  ClampedCurve,
  GeomErrorCode,
  GeomIssue,
  Result,
} from '../types';

function issue(
  code: GeomErrorCode,
  message: string,
  at?: GeomIssue['at'],
  value?: number,
): GeomIssue {
  return {
    code,
    severity: 'error',
    message,
    ...(at === undefined ? {} : { at }),
    ...(value === undefined ? {} : { value }),
  };
}

const isId = (x: unknown, n: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < n;

/** A frozen copy of a spec's records (the arrays are copied; geometry is shared by reference). */
function freezeSpec(spec: BrepSpec): Brep {
  const vertices = spec.vertices.map((v) =>
    Object.freeze({ point: Object.freeze({ x: v.point.x, y: v.point.y, z: v.point.z }) }),
  );
  const edges = spec.edges.map((e) =>
    Object.freeze({ curve: e.curve, start: e.start, end: e.end }),
  );
  const loop = (l: BrepLoop): BrepLoop =>
    Object.freeze({
      coedges: Object.freeze(
        l.coedges.map((c) =>
          Object.freeze({ edge: c.edge, sense: c.sense, pcurve: c.pcurve, master: c.master }),
        ),
      ),
    });
  const faces = spec.faces.map((f) =>
    Object.freeze({
      surface: f.surface,
      sameSense: f.sameSense,
      outer: loop(f.outer),
      holes: Object.freeze(f.holes.map(loop)),
      ...(f.label === undefined ? {} : { label: f.label }),
    }),
  );
  const shells = spec.shells.map((s) =>
    Object.freeze({ faces: Object.freeze(s.faces.slice()), closed: s.closed }),
  );
  const solids = spec.solids.map((s) =>
    Object.freeze({ outer: s.outer, ...(s.genus === undefined ? {} : { genus: s.genus }) }),
  );
  return Object.freeze({
    vertices: Object.freeze(vertices),
    edges: Object.freeze(edges),
    faces: Object.freeze(faces),
    shells: Object.freeze(shells),
    solids: Object.freeze(solids),
  }) as unknown as Brep;
}

/** The vertices a coedge runs from and to. */
export function coedgeEnds(
  edges: readonly BrepEdge[],
  c: BrepCoedge,
): { readonly from: number; readonly to: number } {
  const e = edges[c.edge]!;
  return c.sense ? { from: e.start, to: e.end } : { from: e.end, to: e.start };
}

/** Every loop of a face, outer first. */
export function loopsOf(f: BrepFace): readonly BrepLoop[] {
  return [f.outer, ...f.holes];
}

/**
 * The structural validation (cheap, no geometry beyond array shapes): ids in
 * range, non-empty loops, each loop closing in vertex order respecting `sense`,
 * pcurves on the edge's parameter domain, every edge used exactly twice and in
 * opposite directions (a seam twice by one face), every vertex used, one solid
 * with one closed shell holding every face, the faces connected through shared
 * edges (one piece). Returns every problem found as an
 * issue (`brep-reference` for ids, `brep-invalid` for topology, `unsupported`
 * outside the scope above). Contract violations (not a B-rep spec at all)
 * throw. Geometric consistency is {@link checkBrep}'s job, not this function's.
 */
export function makeBrep(spec: BrepSpec): Result<Brep> {
  if (
    typeof spec !== 'object' ||
    spec === null ||
    !Array.isArray(spec.vertices) ||
    !Array.isArray(spec.edges) ||
    !Array.isArray(spec.faces) ||
    !Array.isArray(spec.shells) ||
    !Array.isArray(spec.solids)
  ) {
    fail('size-mismatch', 'a B-rep spec needs vertices, edges, faces, shells and solids arrays');
  }
  const t = resolveTolerances();
  const issues: GeomIssue[] = [];
  const nV = spec.vertices.length;
  const nE = spec.edges.length;
  const nF = spec.faces.length;

  spec.vertices.forEach((v, i) => {
    const p = (v as Partial<BrepVertex>).point;
    if (
      p === undefined ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      !Number.isFinite(p.z)
    ) {
      issues.push(issue('non-finite', `vertex ${i} is not a finite point`, { vertex: i }));
    }
  });

  let edgesOk = true;
  spec.edges.forEach((e, i) => {
    if (!isId(e.start, nV) || !isId(e.end, nV)) {
      issues.push(
        issue('brep-reference', `edge ${i} refers to a vertex outside 0…${nV - 1}`, { edge: i }),
      );
      edgesOk = false;
    }
    const c = e.curve as ClampedCurve<3> | undefined;
    if (
      c === undefined ||
      c === null ||
      c.dim !== 3 ||
      !(c.cw instanceof Float64Array) ||
      c.basis === undefined
    ) {
      issues.push(issue('dimension-mismatch', `edge ${i} needs a 3D curve`, { edge: i }));
      edgesOk = false;
    } else {
      checkBasisShape(c.basis);
      if (c.basis.kind !== 'clamped') {
        issues.push(
          issue('unsupported', `edge ${i}: the curve must be clamped (convert periodic ones)`, {
            edge: i,
          }),
        );
        edgesOk = false;
      }
    }
  });

  const uses: { face: number; loop: number; index: number; sense: boolean }[][] = Array.from(
    { length: nE },
    () => [],
  );
  let facesOk = true;
  spec.faces.forEach((f, fi) => {
    try {
      checkSurfaceShape(f.surface);
    } catch {
      issues.push(issue('size-mismatch', `face ${fi} has no valid surface`, { face: fi }));
      facesOk = false;
    }
    if (typeof f.sameSense !== 'boolean') {
      issues.push(issue('brep-invalid', `face ${fi}: sameSense must be a boolean`, { face: fi }));
    }
    loopsOf(f).forEach((l, li) => {
      if (!Array.isArray(l?.coedges) || l.coedges.length === 0) {
        issues.push(
          issue('brep-invalid', `face ${fi} loop ${li} has no coedges`, {
            face: fi,
            coedge: [fi, li, 0],
          }),
        );
        facesOk = false;
        return;
      }
      let refsOk = true;
      l.coedges.forEach((c, ci) => {
        const at = { face: fi, coedge: [fi, li, ci] as const };
        if (!isId(c.edge, nE)) {
          issues.push(
            issue('brep-reference', `face ${fi} loop ${li} coedge ${ci}: no edge ${c.edge}`, at),
          );
          refsOk = false;
          return;
        }
        if (typeof c.sense !== 'boolean') {
          issues.push(issue('brep-invalid', `coedge sense must be a boolean`, at));
        }
        if (c.master !== 'curve3d' && c.master !== 'pcurve') {
          issues.push(issue('brep-invalid', `coedge master must be 'curve3d' or 'pcurve'`, at));
        }
        const q = c.pcurve;
        if (
          q === undefined ||
          q === null ||
          q.dim !== 2 ||
          !(q.cw instanceof Float64Array) ||
          q.basis === undefined ||
          q.basis.kind !== 'clamped'
        ) {
          issues.push(issue('dimension-mismatch', `coedge pcurve must be a clamped 2D curve`, at));
          refsOk = false;
          return;
        }
        // Same parameter: the pcurve runs over the edge curve's domain.
        const e = spec.edges[c.edge]!;
        const dom = e.curve?.basis?.domain;
        if (dom !== undefined) {
          const eps = t.paramRel * (dom[1] - dom[0]);
          const pd = q.basis.domain;
          if (Math.abs(pd[0] - dom[0]) > eps || Math.abs(pd[1] - dom[1]) > eps) {
            issues.push(
              issue(
                'brep-invalid',
                `face ${fi} loop ${li} coedge ${ci}: pcurve domain [${pd[0]}, ${pd[1]}] differs from edge ${c.edge}'s [${dom[0]}, ${dom[1]}] (pcurves are same-parameter)`,
                at,
              ),
            );
          }
        }
        if (typeof c.sense === 'boolean') {
          uses[c.edge]!.push({ face: fi, loop: li, index: ci, sense: c.sense });
        }
      });
      if (!refsOk || !edgesOk) return;
      // Closure in vertex order, respecting sense.
      const n = l.coedges.length;
      for (let ci = 0; ci < n; ci++) {
        const a = coedgeEnds(spec.edges, l.coedges[ci]!);
        const b = coedgeEnds(spec.edges, l.coedges[(ci + 1) % n]!);
        if (a.to !== b.from) {
          issues.push(
            issue(
              'brep-invalid',
              `face ${fi} loop ${li}: coedge ${ci} ends at vertex ${a.to} but coedge ${(ci + 1) % n} starts at vertex ${b.from}`,
              { face: fi, coedge: [fi, li, ci] },
            ),
          );
        }
      }
    });
  });

  // Manifold: every edge twice, in opposite directions.
  spec.edges.forEach((_, ei) => {
    const u = uses[ei]!;
    if (u.length !== 2) {
      issues.push(
        issue(
          'brep-invalid',
          `edge ${ei} is used ${u.length} times; a closed manifold shell uses each twice`,
          {
            edge: ei,
          },
          u.length,
        ),
      );
    } else if (u[0]!.sense === u[1]!.sense) {
      issues.push(
        issue(
          'brep-invalid',
          `edge ${ei} is used twice in the same direction (faces ${u[0]!.face} and ${u[1]!.face}): the shell is not coherently oriented`,
          { edge: ei },
        ),
      );
    }
  });

  // One connected shell: faces joined through shared edges. A disconnected "shell" (a torus
  // beside an inside-out box, say) passes every per-edge test and Euler–Poincaré with a
  // compensating genus, and its summed signed volume hides a flipped smaller component, so
  // `checkBrep`'s single-sign orientation test would be fooled. Refused here, not guessed at.
  if (facesOk && nF > 1) {
    const parent = Array.from({ length: nF }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    for (const u of uses) {
      if (u.length === 2) parent[find(u[0]!.face)] = find(u[1]!.face);
    }
    const roots = new Set<number>();
    for (let f = 0; f < nF; f++) roots.add(find(f));
    if (roots.size > 1) {
      issues.push(
        issue(
          'unsupported',
          `the faces form ${roots.size} edge-connected components; a Phase 1 shell is one connected piece (separate components cannot share one orientation measurement)`,
          undefined,
          roots.size,
        ),
      );
    }
  }

  // Every vertex belongs to an edge.
  if (edgesOk) {
    const used = new Uint8Array(nV);
    for (const e of spec.edges) {
      used[e.start] = 1;
      used[e.end] = 1;
    }
    used.forEach((u, vi) => {
      if (u === 0)
        issues.push(issue('brep-invalid', `vertex ${vi} belongs to no edge`, { vertex: vi }));
    });
  }

  // One solid, one closed shell, every face in it.
  if (spec.solids.length !== 1 || spec.shells.length !== 1) {
    issues.push(
      issue(
        'unsupported',
        `Phase 1 B-reps have exactly one solid bounded by one shell; got ${spec.solids.length} solids and ${spec.shells.length} shells`,
      ),
    );
  } else {
    const sh = spec.shells[0]!;
    const so = spec.solids[0]!;
    if (so.outer !== 0) {
      issues.push(
        issue('brep-reference', `solid refers to shell ${so.outer}; there is only shell 0`),
      );
    }
    if (so.genus !== undefined && !(Number.isInteger(so.genus) && so.genus >= 0)) {
      issues.push(
        issue('brep-invalid', `solid genus must be a non-negative integer; got ${so.genus}`),
      );
    }
    if (!sh.closed) {
      issues.push(issue('unsupported', 'open shells are outside the Phase 1 scope'));
    }
    const seen = new Set<number>();
    for (const f of sh.faces) {
      if (!isId(f, nF)) {
        issues.push(issue('brep-reference', `shell refers to face ${f} outside 0…${nF - 1}`));
      } else if (seen.has(f)) {
        issues.push(issue('brep-invalid', `face ${f} appears twice in the shell`, { face: f }));
      } else seen.add(f);
    }
    for (let f = 0; f < nF; f++) {
      if (!seen.has(f)) issues.push(issue('brep-invalid', `face ${f} is in no shell`, { face: f }));
    }
  }
  if (nF === 0) issues.push(issue('brep-invalid', 'a solid needs at least one face'));

  if (issues.length > 0 || !facesOk) return errResult(issues);
  return okResult(freezeSpec(spec));
}

/** Throws `brep-invalid` with the first issue; for builders that construct valid B-reps by design. */
export function unwrapBrep(r: Result<Brep>): Brep {
  if (r.ok) return r.value;
  const first = r.issues[0]!;
  return fail('brep-invalid', `invalid B-rep: ${first.message}`, { issues: r.issues });
}

function reverseLoop(l: BrepLoop): BrepLoop {
  return {
    coedges: l.coedges
      .slice()
      .reverse()
      .map((c) => ({ edge: c.edge, sense: !c.sense, pcurve: c.pcurve, master: c.master })),
  };
}

/**
 * The same solid with the opposite orientation convention on every face: each
 * face's `sameSense` flipped and each loop reversed (coedges in reverse order,
 * senses toggled; pcurves are parameterised like the edge curve, so they do not
 * change). A coherently oriented B-rep stays coherent; an outward one becomes
 * inward. Internal: `orientBrep` and `transformBrep` use it.
 */
export function flipBrep(b: Brep): Brep {
  const faces: BrepFace[] = b.faces.map((f) => ({
    surface: f.surface,
    sameSense: !f.sameSense,
    outer: reverseLoop(f.outer),
    holes: f.holes.map(reverseLoop),
    ...(f.label === undefined ? {} : { label: f.label }),
  }));
  return unwrapBrep(makeBrep({ ...b, faces }));
}

/**
 * The image of the B-rep under a row-major 3×4 affine map (vertices, edge
 * curves and surfaces; pcurves live in the surfaces' parameters and do not
 * change). A map with negative determinant mirrors: it reverses the handedness
 * of every surface's `(Su, Sv, Su × Sv)` frame relative to the material, so the
 * image would be inside-out under the unchanged flags. It is therefore returned
 * flipped (`flipBrep`): every `sameSense` toggled and every loop reversed, and
 * the result is outward again (docs/design/step-export.md: mirroring flips
 * handedness, so mirrored patches take opposite `same_sense` flags). A map with
 * zero determinant throws.
 */
export function transformBrep(b: Brep, m: Affine3): Brep {
  const det = affineDeterminant(m);
  if (!Number.isFinite(det) || det === 0) {
    fail('unsupported', `transformBrep needs an invertible map; determinant ${det}`, {
      value: det,
    });
  }
  const moved: BrepSpec = {
    vertices: b.vertices.map((v) => ({ point: applyAffine3(m, v.point) })),
    edges: b.edges.map((e) => ({ curve: transformCurve(e.curve, m), start: e.start, end: e.end })),
    faces: b.faces.map((f) => ({ ...f, surface: transformSurface(f.surface, m) })),
    shells: b.shells as readonly BrepShell[],
    solids: b.solids as readonly BrepSolid[],
  };
  const out = unwrapBrep(makeBrep(moved));
  return det < 0 ? flipBrep(out) : out;
}
