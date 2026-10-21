// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only sample document (docs/design/board2.md §11.1 `testing/`; not exported
 * from the package). A small symmetric board whose parts are shaped right but not
 * meant to be a good board: an eight-point plan loop, bicubic height fields with
 * four control points a side, constant default laws, and one concave. Step S2
 * replaces it by the analytic stadium board.
 */
import { DEFAULT_BUILD_PARAMS, DEFAULT_RAIL_LAWS, RAIL_LANES } from '../params';
import type { BoardDoc, LawCurve, RailLaws } from '../types';

/** A half-domain law with the same value at the tail and nose centres (auto ease: flat). */
export function constantLaw(value: number): LawCurve {
  return {
    domain: 'half',
    keys: [
      { s: 0, value },
      { s: 0.5, value },
    ],
  };
}

/** Constant default laws on every lane. */
export function defaultLaws(): RailLaws {
  const laws: Partial<Record<(typeof RAIL_LANES)[number], LawCurve>> = {};
  for (const lane of RAIL_LANES) laws[lane] = constantLaw(DEFAULT_RAIL_LAWS[lane]);
  return laws as RailLaws;
}

/** A fresh (unfrozen, unshared) copy of the sample document on each call. */
export function sampleDoc(): BoardDoc {
  return {
    format: 'openshaper.board2',
    version: 1,
    meta: { name: 'Sample', author: 'tests', source: 'board2' },
    symmetry: 'mirror-y',
    tail: { kind: 'standard' },
    plan: {
      degree: 3,
      knots: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
      points: [0, 0, 20, -20, 100, -27, 180, -20, 200, 0, 180, 20, 100, 27, 20, 20],
    },
    deck: {
      degreeU: 3,
      degreeV: 3,
      knotsU: [0, 0, 0, 0, 1, 1, 1, 1],
      knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
      x: [-2, 202],
      y: [-29, 29],
      z: [9, 9.5, 9.5, 9, 8, 8.6, 8.6, 8, 8, 8.6, 8.6, 8, 12, 12.4, 12.4, 12],
    },
    bottom: {
      degreeU: 3,
      degreeV: 3,
      knotsU: [0, 0, 0, 0, 1, 1, 1, 1],
      knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
      x: [-2, 202],
      y: [-29, 29],
      z: [6, 6, 6, 6, 0, 0, 0, 0, 0, 0, 0, 0, 10, 10, 10, 10],
    },
    laws: defaultLaws(),
    offsets: {
      basis: { degree: 3, knots: [0, 0.25, 0.5, 0.75] },
      rows: [
        { row: 'deckEdge', values: [0, 0.1, 0, -0.1] },
        { row: 'tuckHandle', values: [0, 0, 0.1, 0.2, 0, 0, -0.1, -0.2] },
      ],
    },
    features: [
      {
        kind: 'concave',
        id: 'single-concave',
        enabled: true,
        layout: 'single',
        centre: 0,
        width: 0.8,
        depth: {
          keys: [
            { s: 40, value: 0 },
            { s: 100, value: 0.3, in: { ds: 20, dv: 0 }, out: { ds: 20, dv: 0 } },
            { s: 160, value: 0 },
          ],
        },
      },
    ],
    build: JSON.parse(JSON.stringify(DEFAULT_BUILD_PARAMS)) as BoardDoc['build'],
    passthrough: { fins: { setup: 'none', system: 'fcs-ii', symmetrical: true, fins: [] } },
  };
}
