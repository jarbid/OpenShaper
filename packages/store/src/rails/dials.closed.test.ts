// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The dials never break a board: every corner of the three ranges, held along a whole board, is a
 * board the engine accepts and meshes closed, on each test board.
 */
import { describe, expect, it } from 'vitest';
import { DIAL_RANGES, applyDials } from './dials';
import { railsBoards } from './test-support/boards';
import { closedVerdict, withRailAlong } from './test-support/closed';
import { rail } from './test-support/zone-kit';

describe.each(railsBoards)('the dial corners on the %s board', (_name, make) => {
  const board = make();

  it('are all closed boards, at view quality', () => {
    const problems: string[] = [];
    for (const apex of DIAL_RANGES.apex) {
      for (const tuck of DIAL_RANGES.tuck) {
        for (const edge of DIAL_RANGES.edge) {
          const r = applyDials(rail(), { apex, tuck, edge });
          expect([r.apex, r.tuck, r.bottomEdge]).toEqual([apex, tuck, edge]);
          const v = closedVerdict(withRailAlong(board, r));
          if (!v.ok) problems.push(`apex ${apex}, tuck ${tuck}, edge ${edge}: ${v.why}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});
