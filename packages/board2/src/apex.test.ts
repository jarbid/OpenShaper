// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The apex line (t = 1/2, the widest point of every section) is G1: the surface normal just below and
 * just above it is the same. The section fit has a triple knot there, so the fit must be told that the
 * tangent is vertical; a handle a few micrometres off vertical (the longboard's station 30.5 stores
 * 1.4e-5 of sideways run in a 0.27 cm handle) once lost that constraint and left a crease of up to
 * 1.7 degrees along the apex line (review of M1, finding 1).
 */
import { describe, expect, it } from 'vitest';
import type { BoardDoc, Chain } from './types';
import { SECTION_APEX_TOL } from './params';
import { apexCrease, boardSet, buildOrThrow } from './test-support/board-set';

/** Largest allowed normal angle across the apex line, degrees. */
const G1_DEG = 0.05;

/**
 * The document with the handles of every station's apex moved off vertical, inward: by `du` (normalised
 * u) or, with `angle`, by that angle in rad of the handle's own length.
 */
function perturbApex(
  doc: BoardDoc,
  how: { du: number } | { angle: number },
  which: 'in' | 'out' | 'both',
): BoardDoc {
  const copy = structuredClone(doc) as { -readonly [K in keyof BoardDoc]: BoardDoc[K] };
  const move = (c: Chain, apex: number): void => {
    const k = c.knots[apex] as { p: [number, number]; in: [number, number]; out: [number, number] };
    for (const h of which === 'both' ? (['in', 'out'] as const) : [which]) {
      const du = 'du' in how ? how.du : how.angle * Math.abs(k[h][1] - k.p[1]);
      k[h][0] -= du;
    }
  };
  for (const s of copy.stations) {
    move(s.plus.chain, s.plus.apex);
    if (s.minus !== undefined) move(s.minus.chain, s.minus.apex);
  }
  return copy as BoardDoc;
}

describe('the apex line is G1', () => {
  const set = boardSet();

  it.each(set.map((b) => [b.name, b] as const))(
    '%s: the normal angle below vs above t = 1/2 stays under 0.05 degrees along the board',
    (_n, b) => {
      const c = apexCrease(buildOrThrow(b.doc));
      expect(c.max, `at x = ${c.at}`).toBeLessThan(G1_DEG);
    },
  );

  it.each(set.map((b) => [b.name, b] as const))(
    '%s: and under small perturbations of the apex handles (1e-8 in u, and half the practical angle)',
    (_n, b) => {
      for (const how of [{ du: 1e-8 }, { angle: SECTION_APEX_TOL / 2 }]) {
        for (const which of ['in', 'out', 'both'] as const) {
          const c = apexCrease(buildOrThrow(perturbApex(b.doc, how, which)), 1);
          expect(c.max, `${which} handle ${JSON.stringify(how)} at x = ${c.at}`).toBeLessThan(
            G1_DEG,
          );
        }
      }
    },
  );

  it('a handle beyond the practical angle is a corner, not snapped', () => {
    expect(SECTION_APEX_TOL).toBeLessThan(0.01);
    const short = set[0]!.doc;
    // 0.05 in u on a handle about 0.1 long: far more than 1e-3 rad off vertical
    const c = apexCrease(buildOrThrow(perturbApex(short, { du: 0.05 }, 'in')), 2);
    expect(c.max).toBeGreaterThan(0.5);
  });
});
