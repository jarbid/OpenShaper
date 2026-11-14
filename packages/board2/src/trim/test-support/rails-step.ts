// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test only: rails boards for the rails STEP export's tests (`trim/step*.test.ts`), and the checks of a
 * rails solid that do not use the fit's own measure.
 */
import { closestPointOnCurve, surfacePoint } from '@openshaper/geom';
import type { Brep, ClampedCurve } from '@openshaper/geom';
import type { BoardDoc } from '../../types';
import type { RailsBoard } from '../board';
import { convertSections } from '../convert';
import { buildRails, trimMeshOf } from '../native';
import type { BuiltRails } from '../native';
import { railPlace, railStrips } from '../solid';
import type { RailsSolid } from '../step';

/** A sections document converted to a rails board, throwing with the reasons if it is refused. */
export function railsBoardOf(doc: BoardDoc): RailsBoard {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
}

/** Builds a rails board, throwing with the reasons if it is refused. */
export function builtRails(board: RailsBoard): BuiltRails {
  const r = buildRails(board);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

/**
 * The board with a hard edge in the tail: every rail key aft of `to` (cm) leaves the bottom at `degrees`
 * and has the narrowest tuck the kernel builds, so the tuck there is a crease and a sliver.
 */
export function hardTail(board: RailsBoard, to: number, degrees: number): RailsBoard {
  const harden = (keys: RailsBoard['rails']['plus']) =>
    keys.map((k) => (k.x < to ? { ...k, rail: { ...k.rail, bottomEdge: degrees, tuck: 0 } } : k));
  return {
    ...board,
    rails: {
      plus: harden(board.rails.plus),
      ...(board.rails.minus === undefined ? {} : { minus: harden(board.rails.minus) }),
    },
  };
}

/** The deck panel face and the bottom panel face. */
const panelFaces = (solid: RailsSolid): [number, number] => [
  solid.brep.faces.findIndex((f) => f.surface === solid.deck),
  solid.brep.faces.findIndex((f) => f.surface === solid.bottom),
];

const edgesOf = (b: Brep, face: number): ClampedCurve<3>[] =>
  b.faces[face]!.outer.coedges.map((c) => b.edges[c.edge]!.curve);

/** The control-point box of a curve, grown by `m`. */
function near(c: ClampedCurve<3>, p: { x: number; y: number; z: number }, m: number): boolean {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < c.basis.count; i++) {
    const w = c.cw[4 * i + 3]!;
    x0 = Math.min(x0, c.cw[4 * i]! / w);
    x1 = Math.max(x1, c.cw[4 * i]! / w);
    y0 = Math.min(y0, c.cw[4 * i + 1]! / w);
    y1 = Math.max(y1, c.cw[4 * i + 1]! / w);
  }
  return p.x >= x0 - m && p.x <= x1 + m && p.y >= y0 - m && p.y <= y1 + m;
}

/**
 * Independent of the fit's own measure: the largest distance from the kernel's band edges (with the
 * kernel's panel heights) and apex line, at every `every`-th loop sample, to the nearest band edge or
 * edge curve of the solid; and the largest vertical distance from the kernel mesh's panel vertices to
 * the panel faces.
 */
export function independentDeviation(
  built: BuiltRails,
  solid: RailsSolid,
  every: number,
): { rows: number; panels: number } {
  const mesh = trimMeshOf(built);
  const strips = railStrips(mesh.panels);
  const [df, bf] = panelFaces(solid);
  const deckEdges = edgesOf(solid.brep, df);
  const bottomEdges = edgesOf(solid.brep, bf);
  const all = solid.brep.edges.map((e) => e.curve);
  const lift = new Float64Array(3);
  const distance = (curves: readonly ClampedCurve<3>[], p: { x: number; y: number; z: number }) => {
    let d = Infinity;
    for (const c of curves) {
      if (!near(c, p, 1)) continue;
      d = Math.min(d, closestPointOnCurve(c, p).distance);
    }
    return d;
  };
  let rows = 0;
  for (let i = 0; i < built.loop.n; i += every) {
    const at = railPlace(built.loop, built.laws, i);
    const s = strips.section(at);
    let bz = s.tuck.z;
    if (mesh.panels.relief !== undefined) {
      mesh.panels.relief(s.tuck.qx, s.tuck.qy, lift);
      bz += lift[0]!;
    }
    rows = Math.max(
      rows,
      distance(deckEdges, { x: s.deck.qx, y: s.deck.qy, z: s.deck.z }),
      distance(bottomEdges, { x: s.tuck.qx, y: s.tuck.qy, z: bz }),
      distance(all, { x: at.x, y: at.y, z: s.apex }),
    );
  }
  // the kernel mesh's panel vertices (faces 0 and 1), against the panel faces straight above or below
  let panels = 0;
  const p = mesh.positions;
  for (let v = 0; v < mesh.vertexFace.length; v++) {
    const f = mesh.vertexFace[v]!;
    if (f > 1) continue;
    const surface = f === 0 ? solid.deck : solid.bottom;
    const q = surfacePoint(surface, p[3 * v]!, p[3 * v + 1]!);
    panels = Math.max(panels, Math.abs(q.z - p[3 * v + 2]!));
  }
  return { rows, panels };
}
