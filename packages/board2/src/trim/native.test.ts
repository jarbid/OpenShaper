// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails engine's build and mesh (`native.ts`) on the made boards, converted from their
 * sections: built without issues, closed at view and draft quality, volume within 1.5% of
 * the sections engine's, the loop reused across an edit that leaves the outline alone, an STL
 * face size giving a finer closed mesh, the refusals, the bottom features as a relief that
 * leaves the rail and the deck where they were, and the time budget.
 */
import { describe, expect, it } from 'vitest';
import { meshBoard } from '../mesh';
import { TRIM } from '../params';
import { buildBoard } from '../surface';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import type { RailsBoard } from './board';
import { convertSections } from './convert';
import { buildRails, meshRails, trimMeshOf } from './native';
import type { BuiltRails } from './native';
import { FACE, buildTrimMesh, checkClosed, sliceX } from './solid';
import type { TrimMesh } from './solid';

const BOARDS: { readonly [name: string]: () => BoardDoc } = {
  analytic: analyticBoard,
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
};

/** Volume against the sections engine's, as a fraction. */
const VOLUME_TOL = 0.015;
/** Volume at a coarse panel grid against a 0.25 cm grid's, as a fraction: the aim of docs/design/trim-blend-engine.md, "Cost". */
const GRID_VOLUME_TOL = 2e-4;

function railsOf(doc: BoardDoc): RailsBoard {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
}

function built(board: RailsBoard, previous?: BuiltRails): BuiltRails {
  const r = buildRails(board, previous === undefined ? {} : { previous });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

describe.each(Object.keys(BOARDS))('buildRails and meshRails: %s', (name) => {
  // features off: the relief is checked on its own
  const doc = { ...BOARDS[name]!(), features: [] };
  const board = railsOf(doc);

  it('builds without issues', () => {
    const r = buildRails(board);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    if (!r.ok) return;
    expect(r.value.xiMin).toBe(0);
    const knots = board.outline.plus.knots;
    expect(r.value.xiMax).toBe(knots[knots.length - 1]!.p[0]);
    expect(r.value.report.model).toBe('rails');
    expect(r.value.report.sectionSpans).toEqual([]);
  });

  it('is closed at view and draft quality', () => {
    const b = built(board);
    expect(checkClosed(trimMeshOf(b)).openEdges).toBe(0);
    expect(checkClosed(trimMeshOf(b, { draft: true })).openEdges).toBe(0);
  });

  it("has positive measures, and a volume within 1.5% of the sections engine's", () => {
    const m = meshRails(built(board));
    expect(m.volume).toBeGreaterThan(0);
    expect(m.planArea).toBeGreaterThan(0);
    expect(m.surfaceArea).toBeGreaterThan(0);
    expect(m.vertexCount).toBe(m.positions.length / 3);
    expect(m.k1).toBeUndefined();
    const old = buildBoard(doc);
    if (!old.ok) throw new Error('the sections engine did not build');
    const ref = meshBoard(old.value).volume;
    expect(Math.abs(m.volume / ref - 1)).toBeLessThan(VOLUME_TOL);
    // the volume read here is the closed mesh's own plus the panels' gap to their triangles
    const mesh = trimMeshOf(built(board));
    expect(m.volume).toBeCloseTo(checkClosed(mesh).volume + mesh.panelGap, 6);
  });

  it('has a volume that does not depend on the panel grid', () => {
    // against a 0.25 cm grid, the reference of the grid study
    const b = built(board);
    const rows = { deckRows: TRIM.deckRows, tuckRows: TRIM.tuckRows };
    const solid = (grid: number): number => {
      const mesh = buildTrimMesh(b.loop, b.laws, b.panels, grid, rows);
      return checkClosed(mesh).volume + mesh.panelGap;
    };
    const ref = solid(0.25);
    for (const grid of [0.7, TRIM.viewGrid]) {
      expect(Math.abs(solid(grid) / ref - 1), `grid ${grid}`).toBeLessThan(GRID_VOLUME_TOL);
    }
  });

  it('fills k1 and k2 with curvature on, one finite value a vertex, k1 >= k2, a convex deck', () => {
    const b = built(board);
    expect(meshRails(b).k2).toBeUndefined();
    const m = meshRails(b, { curvature: true });
    expect(m.k1).toBeDefined();
    expect(m.k2).toBeDefined();
    const { k1, k2 } = m;
    expect(k1!.length).toBe(m.vertexCount);
    expect(k2!.length).toBe(m.vertexCount);
    for (let i = 0; i < m.vertexCount; i++) {
      expect(Number.isFinite(k1![i]!) && Number.isFinite(k2![i]!)).toBe(true);
      expect(k1![i]!).toBeGreaterThanOrEqual(k2![i]!);
    }
    // the deck's centre line at mid-length: the highest vertex within one panel grid cell of the stringer
    const mid = (b.xiMin + b.xiMax) / 2;
    let best = -1;
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[3 * i]!;
      const y = m.positions[3 * i + 1]!;
      if (Math.abs(y) > TRIM.viewGrid || Math.abs(x - mid) > 5) continue;
      if (best < 0 || m.positions[3 * i + 2]! > m.positions[3 * best + 2]!) best = i;
    }
    expect(best).toBeGreaterThanOrEqual(0);
    expect(Math.max(k1![best]!, k2![best]!)).toBeGreaterThan(0);
  });

  it('reuses the loop when the outline is unchanged, and gives the same mesh', () => {
    const first = built(board);
    const edited: RailsBoard = { ...board, deck: { knots: [...board.deck.knots] } };
    const again = built(edited, first);
    expect(again.loop).toBe(first.loop);
    const fresh = built(edited);
    expect(fresh.loop).not.toBe(first.loop);
    const a = meshRails(again);
    const b = meshRails(fresh);
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
    expect(a.normals).toEqual(b.normals);
  });

  it('reuses the loop and the laws for a board equal by value, as a fresh copy is', () => {
    const first = built(board);
    const copy = structuredClone(board);
    const again = built(copy, first);
    expect(again.loop).toBe(first.loop);
    expect(again.laws).toBe(first.laws);
    expect(again.halfWidth).toEqual(first.halfWidth);
    // reused in sequence: each build reuses the last
    const third = built(structuredClone(board), again);
    expect(third.loop).toBe(first.loop);
  });

  it('builds a new loop for a moved outline knot or a changed radius, new laws for a changed key', () => {
    const first = built(board);
    const knots = board.outline.plus.knots.map((k, i) =>
      i === 1 ? { ...k, p: [k.p[0], k.p[1] + 0.1] as const } : k,
    );
    const moved = built({ ...board, outline: { ...board.outline, plus: { knots } } }, first);
    expect(moved.loop).not.toBe(first.loop);
    const radius = built(
      { ...board, corners: { ...board.corners, nose: board.corners.nose + 0.1 } },
      first,
    );
    expect(radius.loop).not.toBe(first.loop);
    const keys = board.rails.plus.map((k, i) =>
      i === 0 ? { ...k, rail: { ...k.rail, band: k.rail.band + 0.1 } } : k,
    );
    const keyed = built({ ...board, rails: { ...board.rails, plus: keys } }, first);
    expect(keyed.loop).toBe(first.loop);
    expect(keyed.laws).not.toBe(first.laws);
  });

  it('an STL face size of 0.3 gives a finer closed mesh', () => {
    const b = built(board);
    const view = meshRails(b);
    const stl = trimMeshOf(b, { maxEdge: 0.3 });
    expect(stl.positions.length / 3).toBeGreaterThan(view.vertexCount);
    expect(checkClosed(stl).openEdges).toBe(0);
  });
});

describe('buildRails refuses a board it cannot build', () => {
  const board = railsOf({ ...swallowBoard(), features: [] });
  const asym = railsOf({ ...asymmetricBoard(), features: [] });
  const codes = (b: RailsBoard): string[] => {
    const r = buildRails(b);
    expect(r.ok).toBe(false);
    return r.issues.map((i) => i.code);
  };

  it('with no station', () => {
    expect(codes({ ...board, stations: [] })).toContain('too-few-sections');
  });
  it('with a side with no rail key', () => {
    expect(codes({ ...board, rails: { plus: [] } })).toContain('too-few-sections');
    expect(codes({ ...asym, rails: { plus: asym.rails.plus } })).toContain('too-few-sections');
  });
  it('with stations out of order', () => {
    expect(codes({ ...board, stations: [...board.stations].reverse() })).toContain('station-order');
  });
  it('with an asymmetric station that has no minus side', () => {
    const stations = asym.stations.map((s) => ({ id: s.id, x: s.x, plus: s.plus }));
    expect(codes({ ...asym, stations })).toContain('symmetry-fields');
  });
  it('with an outline the loop cannot be built from', () => {
    const knots = board.outline.plus.knots.map((k, i) =>
      i === 2 ? { ...k, p: [Number.NaN, k.p[1]] as const } : k,
    );
    expect(codes({ ...board, outline: { plus: { knots } } })).toContain('geom');
  });
  it('builds anyway with check off', () => {
    expect(buildRails({ ...board, rails: { plus: board.rails.plus } }, { check: false }).ok).toBe(
      true,
    );
  });
});

/** Normals across the band edge, degrees; a mesh vertex's height against the relief, cm (single precision). */
const SEAM_DEG = 1;
const HEIGHT_TOL = 1e-4;

/** The asymmetric board with its channels moved out to the rail, so they reach past the band edge. */
const railChannels = (): BoardDoc => {
  const d = asymmetricBoard();
  return {
    ...d,
    features: d.features.map((f) => (f.kind === 'channels' ? { ...f, railInset: 0.3 } : f)),
  };
};

describe.each([
  ['fish (concave)', fishBoard],
  ['asymmetric (channels at the rail)', railChannels],
] as const)('the relief on the mesh: %s', (_name, make) => {
  const withF = built(railsOf(make()));
  const without = built(railsOf({ ...make(), features: [] }));
  const a = trimMeshOf(withF);
  const b = trimMeshOf(without);
  const per = a.deckRows + a.tuckRows + 1;
  const vertices = (m: TrimMesh, ids: number[]): number[] =>
    ids.flatMap((v) => [m.positions[3 * v]!, m.positions[3 * v + 1]!, m.positions[3 * v + 2]!]);

  it('leaves the rail and the deck where they were', () => {
    expect(withF.panels.relief).toBeDefined();
    expect(a.wallTop).toEqual(b.wallTop);
    expect(a.wallBottom).toEqual(b.wallBottom);
    expect(a.apex).toEqual(b.apex);
    expect(a.positions.length).toBe(b.positions.length);
    const deck: number[] = [];
    for (let i = 0; i < a.loop.n; i++) {
      for (let j = 0; j < a.deckRows; j++) deck.push(per * i + j);
      deck.push(per * i + per - 1);
    }
    for (let v = 0; v < a.vertexFace.length; v++) if (a.vertexFace[v] === FACE.deck) deck.push(v);
    expect(vertices(a, deck)).toEqual(vertices(b, deck));
  });

  it('is closed', () => {
    expect(checkClosed(a).openEdges).toBe(0);
  });

  it('has a volume, relief included, that does not depend on the panel grid', () => {
    const rows = { deckRows: TRIM.deckRows, tuckRows: TRIM.tuckRows };
    const solid = (grid: number): number => {
      const mesh = buildTrimMesh(withF.loop, withF.laws, withF.panels, grid, rows);
      return checkClosed(mesh).volume + mesh.panelGap;
    };
    expect(Math.abs(solid(TRIM.viewGrid) / solid(0.25) - 1)).toBeLessThan(GRID_VOLUME_TOL);
  });

  it('lowers or raises the bottom panel by the relief at full value', () => {
    const r = new Float64Array(3);
    let worst = 0;
    let deepest = 0;
    for (let v = 0; v < a.vertexFace.length; v++) {
      if (a.vertexFace[v] !== FACE.bottom) continue;
      const x = a.positions[3 * v]!;
      const y = a.positions[3 * v + 1]!;
      withF.panels.relief!(x, y, r);
      worst = Math.max(worst, Math.abs(a.positions[3 * v + 2]! - b.positions[3 * v + 2]! - r[0]!));
      deepest = Math.max(deepest, Math.abs(r[0]!));
    }
    expect(worst).toBeLessThan(HEIGHT_TOL);
    // the deepest point is the feature's full depth: 0.35 for the concave, 0.3 for the channels
    expect(deepest).toBeGreaterThan(0.29);
  });

  it('is sliced with its relief', () => {
    const seg = sliceX(a, a.panels, 100);
    const r = new Float64Array(3);
    let n = 0;
    for (let q = 0; q < seg.length; q += 5) {
      if (seg[q + 4] !== FACE.bottom) continue;
      const y = seg[q]!;
      withF.panels.relief!(100, y, r);
      expect(seg[q + 1]).toBeCloseTo(a.panels.bottom(100, y) + r[0]!, 12);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });

  it("has the bottom's normal and the tuck's first-row normal agree across the band edge", () => {
    const key = (v: number): string =>
      `${a.positions[3 * v]},${a.positions[3 * v + 1]},${a.positions[3 * v + 2]}`;
    const rim = new Map<string, number>();
    for (let v = 0; v < a.vertexFace.length; v++)
      if (a.vertexFace[v] === FACE.bottom) rim.set(key(v), v);
    let worst = 0;
    for (let i = 0; i < a.loop.n; i++) {
      const t = per * i + a.deckRows;
      const r = rim.get(key(t));
      expect(r).toBeDefined();
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += a.normals[3 * t + k]! * a.normals[3 * r! + k]!;
      worst = Math.max(worst, (Math.acos(Math.min(1, dot)) * 180) / Math.PI);
    }
    expect(worst).toBeLessThan(SEAM_DEG);
  });
});

it('the channels at the rail reach past the band edge', () => {
  const b = built(railsOf(railChannels()));
  const m = trimMeshOf(b);
  const per = m.deckRows + m.tuckRows + 1;
  const r = new Float64Array(3);
  let most = 0;
  for (let i = 0; i < m.loop.n; i++) {
    const t = per * i + m.deckRows;
    b.panels.relief!(m.positions[3 * t]!, m.positions[3 * t + 1]!, r);
    most = Math.max(most, Math.abs(r[0]!));
  }
  expect(most).toBeGreaterThan(0.1);
});

/** Budgets (ms) of docs/design/trim-blend-engine.md, "Cost", times this factor: an order-of-magnitude guard. */
const FACTOR = 8;
const BUDGET = { view: 30, draft: 20 } as const;
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]!;

describe('the swallow within the rails engine budgets (x8)', () => {
  it('builds with the loop reused and meshes, at view and draft quality', () => {
    const board = railsOf(swallowBoard());
    const first = built(board);
    const view: number[] = [];
    const draft: number[] = [];
    for (let k = 0; k < 5; k++) {
      let t = performance.now();
      meshRails(built(board, first));
      view.push(performance.now() - t);
      t = performance.now();
      meshRails(built(board, first), { draft: true });
      draft.push(performance.now() - t);
    }
    expect(median(view)).toBeLessThan(BUDGET.view * FACTOR);
    expect(median(draft)).toBeLessThan(BUDGET.draft * FACTOR);
  });
});
