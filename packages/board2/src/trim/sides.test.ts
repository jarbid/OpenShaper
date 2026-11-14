// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What a side's rail and an outline's ends are, apart from the board's symmetry: the minus side's
 * rail keys are read wherever a board gives it any (a mirror board too), and a notch wall or a
 * piece that runs across the board is marked as a tail edge in the mesh.
 */
import { checkBrep } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { analyticBoard, swallowBoard } from '../testing';
import { boardSet } from '../test-support/board-set';
import type { BoardDoc } from '../types';
import type { RailsBoard } from './board';
import { convertSections } from './convert';
import { railsToJson, reviveRails } from './doc';
import { buildRails, trimMeshOf } from './native';
import type { BuiltRails } from './native';
import { loopDefOf } from './outline';
import { probeRails } from './probe';
import { FACE, checkClosed } from './solid';
import { railsSolid } from './step';

const railsOf = (doc: BoardDoc): RailsBoard => {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
};
const built = (board: RailsBoard): BuiltRails => {
  const r = buildRails(board);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
};

/** The board with its minus side's rail changed: a mirror board whose two rails differ. */
const withOwnMinus = (board: RailsBoard): RailsBoard => ({
  ...board,
  rails: {
    plus: board.rails.plus,
    minus: board.rails.plus.map((k) => ({ x: k.x, rail: { ...k.rail, apex: k.rail.apex + 0.1 } })),
  },
});

describe('a mirror board whose two sides have their own rails', () => {
  const plain = railsOf(analyticBoard());
  const split = withOwnMinus(plain);

  it('is a mirror board with rail keys on the minus side, and builds closed', () => {
    expect(split.symmetry).toBe('mirror');
    expect(split.rails.minus).toBeDefined();
    const b = built(split);
    expect(checkClosed(trimMeshOf(b)).openEdges).toBe(0);
  });

  it('leaves the plus side as it was and changes the minus side', () => {
    const a = trimMeshOf(built(plain));
    const b = trimMeshOf(built(split));
    expect(b.positions.length).toBe(a.positions.length);
    let plusMoved = 0;
    let minusMoved = 0;
    for (let i = 0; i < a.positions.length; i += 3) {
      const d = Math.hypot(
        a.positions[i]! - b.positions[i]!,
        a.positions[i + 1]! - b.positions[i + 1]!,
        a.positions[i + 2]! - b.positions[i + 2]!,
      );
      if (a.positions[i + 1]! > 1e-6) plusMoved = Math.max(plusMoved, d);
      if (a.positions[i + 1]! < -1e-6) minusMoved = Math.max(minusMoved, d);
    }
    expect(plusMoved).toBe(0);
    expect(minusMoved).toBeGreaterThan(0.01);
  });

  it('is probed with each side its own rail', () => {
    const x = (plain.stations[0]!.x + plain.stations.at(-1)!.x) / 2;
    const bp = built(plain);
    const bs = built(split);
    const mirrorOfPlus = probeRails(bp, 1, x, 40);
    const own = probeRails(bs, 1, x, 40);
    expect(probeRails(bs, 0, x, 40)).toEqual(probeRails(bp, 0, x, 40));
    expect(own).not.toEqual(mirrorOfPlus);
  });

  it('is refused when the minus keys are empty or out of order', () => {
    const board = railsOf(swallowBoard());
    expect(board.rails.plus.length).toBeGreaterThan(1);
    expect(buildRails({ ...board, rails: { plus: board.rails.plus, minus: [] } }).ok).toBe(false);
    const reversed = [...board.rails.plus].reverse();
    expect(buildRails({ ...board, rails: { plus: board.rails.plus, minus: reversed } }).ok).toBe(
      false,
    );
  });

  it('keeps its minus keys through its text', () => {
    const back = reviveRails(JSON.parse(railsToJson(split)));
    expect(back.ok && back.value.rails.minus).toEqual(split.rails.minus);
  });

  it('exports one closed STEP solid that is not a mirror', () => {
    const solid = railsSolid(built(split));
    expect(checkBrep(solid.brep).ok).toBe(true);
  }, 60_000);
});

describe('the pieces of an outline that are ends', () => {
  const kinds = (board: RailsBoard): number[] =>
    loopDefOf(board.outline, board.corners).pieces.map((p) => p.kind);

  it('are the notch walls of a notched tail, and no other piece', () => {
    const board = railsOf(swallowBoard());
    const k = kinds(board);
    expect(k.filter((v) => v === 1)).toHaveLength(2);
    // the pieces run from the nose down the plus side, then up the minus side: one wall at the tail of each
    expect(k[k.length / 2 - 1]).toBe(1);
    expect(k[k.length / 2]).toBe(1);
  });

  it('are none on a round tail', () => {
    expect(kinds(railsOf(analyticBoard()))).not.toContain(1);
  });

  it('are the straight tail edge of a squash tail', () => {
    const squash = boardSet().find((b) => b.name === 'shortboard')!;
    expect(kinds(railsOf(squash.doc))).toContain(1);
  });

  it('are tagged in the mesh, at the tail, and the shape does not change', () => {
    const board = railsOf(swallowBoard());
    const m = trimMeshOf(built(board));
    const notch = board.outline.plus.knots[0]!.p[0];
    let tail = 0;
    let farthest = 0;
    for (let v = 0; v < m.vertexFace.length; v++) {
      if (m.vertexFace[v] !== FACE.tail && m.vertexFace[v] !== FACE.tail + FACE.tuck) continue;
      tail++;
      farthest = Math.max(farthest, m.positions[3 * v]!);
    }
    expect(tail).toBeGreaterThan(0);
    // a wall runs from the tip (x = 0) to the notch bottom, and its corners round past both
    expect(farthest).toBeLessThan(notch + 2);
  });
});
