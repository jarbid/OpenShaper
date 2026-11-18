// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Closed boards: after each kind of edit on each test board the engine accepts the board and its
 * mesh is closed (view quality), on both sides together and on the minus side alone; and every tenth
 * edit of a random sequence does the same at draft quality.
 */
import type { RailsBoard } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { railsBoards } from './test-support/boards';
import { closedVerdict } from './test-support/closed';
import { EDIT_KINDS, deepFreeze, randomEdit, rail, seeded } from './test-support/zone-kit';
import type { RailKey } from './types';
import {
  editSides,
  moveZone,
  moveZoneEnd,
  railZones,
  removeZone,
  setZoneNumber,
  setZoneRail,
  splitZoneAt,
  tidyRails,
} from './zones';

const HARD = rail({
  band: 1,
  hardness: 0.6,
  tuck: 0.3,
  tuckShape: 0.8,
  bottomEdge: 35,
  deckEdge: 0,
  apex: 0.35,
});

const lengthOf = (b: RailsBoard): number => b.outline.plus.knots.at(-1)!.p[0];

/** The index of the zone in the middle of the list. */
const mid = (keys: readonly RailKey[]): number => Math.floor(railZones(keys).zones.length / 2);

type Script = (keys: readonly RailKey[], length: number) => readonly RailKey[];

/** Scripts that may leave a board's keys as they are: a tidy that joins nothing on that board. */
const MAY_BE_IDLE = new Set(['tidyRails (tolerance 0.3)']);

/** One edit of each kind, each a harsh one: where it can, to a rail a long way from its neighbours'. */
const SCRIPTS: readonly [string, Script][] = [
  ['setZoneRail', (k) => setZoneRail(k, mid(k), HARD)],
  ['setZoneNumber', (k) => setZoneNumber(k, mid(k), 'bottomEdge', 60)],
  [
    'moveZoneEnd (draws a zone of no length out)',
    (k, len) => moveZoneEnd(k, mid(k), 'to', railZones(k).zones[mid(k)]!.to + 25, len),
  ],
  ['moveZone', (k, len) => moveZone(k, mid(k), 15, len)],
  [
    'splitZoneAt (in a blend, with a rail)',
    (k, len) => splitZoneAt(k, (k[1]!.x + k[2]!.x) / 2, len, HARD),
  ],
  [
    'splitZoneAt (inside a zone, with a rail)',
    (k, len) => {
      const drawn = moveZoneEnd(k, 1, 'to', k[1]!.x + 20, len);
      return splitZoneAt(drawn, k[1]!.x + 10, len, HARD);
    },
  ],
  ['removeZone', (k) => removeZone(k, 1)],
  ['tidyRails (tolerance 0.3)', (k, len) => tidyRails(k, 0.3, len)],
  ['tidyRails (everything joined into one zone)', (k, len) => tidyRails(k, 50, len)],
  [
    'a blend squeezed to the gap between harsh rails',
    (k, len) => moveZoneEnd(setZoneRail(k, 1, HARD), 1, 'to', 1e9, len),
  ],
];

describe.each(railsBoards)('closed boards: the %s board', (_name, make) => {
  const board = make();
  const length = lengthOf(board);

  it('is closed after each kind of edit, on both sides and on the minus side alone', () => {
    const problems: string[] = [];
    for (const [label, script] of SCRIPTS) {
      for (const side of ['both', 'minus'] as const) {
        const rails = editSides(board.rails, side, (keys) => script(keys, length));
        if (rails === board.rails) {
          if (!MAY_BE_IDLE.has(label))
            problems.push(`${label} (${side}): the edit changed nothing`);
          continue;
        }
        const v = closedVerdict({ ...board, rails });
        if (!v.ok) problems.push(`${label} (${side}): ${v.why}`);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  const sides: ('plus' | 'minus')[] =
    board.rails.minus === undefined ? ['plus'] : ['plus', 'minus'];
  it.each(sides)(
    'is closed at every tenth of 300 random edits of its %s keys',
    (side) => {
      const rng = seeded(1000 + length + side.length);
      let keys: readonly RailKey[] = deepFreeze(
        (side === 'plus' ? board.rails.plus : board.rails.minus!).map((k) => ({
          x: k.x,
          rail: { ...k.rail },
        })),
      );
      const kinds = new Map<string, number>();
      const problems: string[] = [];
      for (let step = 1; step <= 300; step++) {
        const { kind, next } = randomEdit(rng, keys, length);
        if (next !== keys) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        keys = deepFreeze(next as RailKey[]);
        if (step % 10 !== 0) continue;
        const rails: RailsBoard['rails'] =
          side === 'plus'
            ? {
                plus: keys,
                ...(board.rails.minus === undefined ? {} : { minus: board.rails.minus }),
              }
            : { plus: board.rails.plus, minus: keys };
        const v = closedVerdict({ ...board, rails }, true);
        if (!v.ok) problems.push(`after ${step} edits (${kind}): ${v.why}`);
      }
      expect(problems).toEqual([]);
      // the sequence is not idle: most kinds of edit changed the keys at least once
      expect(kinds.size).toBeGreaterThanOrEqual(EDIT_KINDS.length - 1);
    },
    120_000,
  );
});
