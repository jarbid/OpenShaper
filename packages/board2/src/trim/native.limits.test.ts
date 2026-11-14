// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rails boards that `reviveRails` accepts (they are shaped right) and `buildRails` should refuse, because
 * they build a wrong board with no issue, a mesh of non-finite numbers, or a mesh whose size has no bound.
 * Each case is skipped: `buildRails`'s `checkBoard` does not make these checks yet. Each says what makes it
 * pass. Do not unskip the size cases before the check exists: they then run for minutes.
 */
import { describe, expect, it } from 'vitest';
import { swallowBoard } from '../testing';
import type { Chain, ChainKnot } from '../types';
import type { RailsBoard } from './board';
import { convertSections } from './convert';
import { buildRails } from './native';

function swallow(): RailsBoard {
  const r = convertSections({ ...swallowBoard(), features: [] });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
}

/** `chain` with knot `k` moved to `p` (its handles with it). */
function moved(chain: Chain, k: number, p: readonly [number, number]): Chain {
  const knots = chain.knots.map((q, i): ChainKnot => (i === k ? { ...q, p, in: p, out: p } : q));
  return { ...chain, knots };
}

/** The codes of the error issues `buildRails` gives `board`, empty when it builds. */
function refusedWith(board: RailsBoard): string[] {
  const r = buildRails(board);
  return r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.code);
}

describe('buildRails refuses what it cannot build right', () => {
  // Unskip when `checkBoard` refuses a repeated station id with `station-id`, as the sections model's
  // `validate` does. The app keeps each station's engine section by id (`RailsSlices`), so two stations
  // with one id are drawn with the same section.
  it.skip('two stations with one id', () => {
    const b = swallow();
    const stations = b.stations.map((s) => ({ ...s, id: 's1' }));
    expect(refusedWith({ ...b, stations })).toContain('station-id');
  });

  // Unskip when `checkBoard` refuses a line knot whose magnitude is beyond the board's reach (proposed:
  // any outline, rocker or deck coordinate beyond 1000 cm). Today a rocker knot at 1e308 builds, and the
  // mesh, its volume and the probes are NaN, with no issue.
  it.skip('a rocker knot at 1e308', () => {
    const b = swallow();
    expect(
      refusedWith({ ...b, rocker: moved(b.rocker, 1, [b.rocker.knots[1]!.p[0], 1e308]) }),
    ).not.toEqual([]);
  });

  // Unskip when `checkBoard` refuses an outline larger than a board (proposed: length at most 1000 cm and
  // half width at most 150 cm). Today the loft and the mesh grid grow with the outline's extent: a half
  // width of 1000 cm builds a mesh of 1.1 million vertices in about 3 s and a 128 MB STL; 10,000 cm runs for
  // minutes. A share link of 6 KB carries such a board.
  it.skip('a half width of 10,000 cm', () => {
    const b = swallow();
    const k = 2;
    const p = b.outline.plus.knots[k]!.p;
    const outline = { ...b.outline, plus: moved(b.outline.plus, k, [p[0], 1e4]) };
    expect(refusedWith({ ...b, outline })).not.toEqual([]);
  });

  // Unskip when `checkBoard` refuses an outline that crosses the stringer or itself, as `validate` does for
  // a sections document (`outline-not-function`). Today the widest knot moved to the far side builds, with a
  // volume a quarter of the board's and no issue.
  it.skip('an outline that crosses the stringer', () => {
    const b = swallow();
    const k = 2;
    const p = b.outline.plus.knots[k]!.p;
    const outline = { ...b.outline, plus: moved(b.outline.plus, k, [p[0], -p[1]]) };
    expect(refusedWith({ ...b, outline })).not.toEqual([]);
  });

  // Unskip when `checkBoard` refuses a station curve that does not run from the stringer (u = 0) to the
  // wall (u = 1) as a function of u. Today a station whose curves are all at (0, 0) builds, with the
  // volume halved and no issue.
  it.skip('a station whose curves have no width', () => {
    const b = swallow();
    const flat = (c: Chain): Chain => ({
      ...c,
      knots: c.knots.map((q) => ({ ...q, p: [0, 0], in: [0, 0], out: [0, 0] })),
    });
    const stations = b.stations.map((s, i) =>
      i === 1 ? { ...s, plus: { bottom: flat(s.plus.bottom), deck: flat(s.plus.deck) } } : s,
    );
    expect(refusedWith({ ...b, stations })).not.toEqual([]);
  });
});
