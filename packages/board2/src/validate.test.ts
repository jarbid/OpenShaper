// SPDX-License-Identifier: GPL-3.0-or-later
/* eslint-disable @typescript-eslint/no-explicit-any -- the tests edit plain JSON documents */
/**
 * The validator refuses each Phase 0 or notch-zone violation under its own code
 * (docs/design/m1-model.md §6, step 1), and accepts the test boards.
 */
import { describe, expect, it } from 'vitest';
import { boardDocToJson, reviveBoardDoc } from './doc';
import { buildBoard } from './surface';
import { resolveTail, validateBoard } from './validate';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from './testing';
import type { Board2IssueCode, BoardDoc } from './types';

/** A deep, mutable copy of a document, edited by `edit`. */
const mutate = (doc: BoardDoc, edit: (d: any) => void): BoardDoc => {
  const d = JSON.parse(JSON.stringify(doc));
  edit(d);
  return d as BoardDoc;
};

const codes = (doc: BoardDoc): Board2IssueCode[] => [
  ...new Set(validateBoard(doc).map((i) => i.code)),
];

describe('validateBoard', () => {
  it.each([
    ['analytic', analyticBoard],
    ['swallow', swallowBoard],
    ['fish', fishBoard],
    ['asymmetric', asymmetricBoard],
  ])('accepts the %s board', (_name, make) => {
    expect(validateBoard(make())).toEqual([]);
  });

  // [code, a board, the edit that breaks exactly that rule]
  const cases: [Board2IssueCode, () => BoardDoc, (d: any) => void][] = [
    // document structure
    ['symmetry-fields', swallowBoard, (d) => (d.outline.minus = d.outline.plus)],
    ['symmetry-fields', asymmetricBoard, (d) => delete d.stations[2].minus],
    ['too-few-sections', swallowBoard, (d) => (d.stations = [])],
    ['chain-too-short', swallowBoard, (d) => (d.rocker.knots = d.rocker.knots.slice(0, 1))],
    ['chain-too-short', swallowBoard, (d) => (d.stations[1].plus.chain.knots.length = 2)],
    ['station-order', swallowBoard, (d) => (d.stations[3].x = d.stations[2].x - 1)],
    ['station-order', swallowBoard, (d) => (d.stations[0].x = 5)], // before the notch bottom
    ['station-id', swallowBoard, (d) => (d.stations[3].id = d.stations[2].id)],
    // plan
    ['outline-endpoints', swallowBoard, (d) => (d.outline.plus.knots[5].p[1] = 1)],
    ['outline-endpoints', asymmetricBoard, (d) => (d.outline.minus.knots[1].out[1] = -3)],
    [
      'tail-start',
      asymmetricBoard,
      (d) => {
        d.outline.plus.knots[0].p[0] = 1;
        d.outline.minus.knots[0].p[0] = 1;
        d.stations[0].x = 1;
      },
    ],
    ['tail-start', swallowBoard, (d) => (d.outline.plus.knots[0].p[0] = 0)],
    [
      'outline-not-function',
      asymmetricBoard,
      (d) => {
        d.outline.plus.knots[2].in[0] = 120;
        d.outline.plus.knots[2].out[0] = 60;
      },
    ],
    ['notch-zone', swallowBoard, (d) => (d.tail.zone = 0)],
    ['notch-zone', swallowBoard, (d) => (d.tail.zone = 400)],
    ['notch-tip', swallowBoard, (d) => (d.outline.plus.knots[1].p[0] = 1)],
    ['notch-chords-cross', swallowBoard, (d) => (d.tail.zone = 170)],
    ['notch-chord-angle', swallowBoard, (d) => (d.outline.plus.knots[0].out = [4, 0.5])],
    // rocker, deck
    ['line-domain', swallowBoard, (d) => (d.rocker.knots[0].p[0] = 1)],
    ['line-not-function', swallowBoard, (d) => (d.deck.knots[1].in[0] = 130)],
    ['thickness', swallowBoard, (d) => (d.deck.knots[1].p[1] = -1)],
    // Phase 0
    ['section-centre-moved', swallowBoard, (d) => (d.stations[2].plus.chain.knots[0].p = [0.1, 0])],
    [
      'section-centre-moved',
      swallowBoard,
      (d) => {
        const k = d.stations[2].plus.chain.knots[4];
        k.p[1] = 0.9;
        k.in[1] = 0.9;
      },
    ],
    [
      'section-centre-tangent',
      swallowBoard,
      (d) => (d.stations[2].plus.chain.knots[0].out[1] = Number.NaN),
    ],
    [
      'section-centre-tangent',
      swallowBoard,
      (d) => (d.stations[2].plus.chain.knots[4].in[1] = Number.NaN),
    ],
    ['section-apex-index', swallowBoard, (d) => (d.stations[2].plus.apex = 0)],
    ['section-apex-index', swallowBoard, (d) => (d.stations[2].plus.apex = 4)],
    ['section-apex-moved', swallowBoard, (d) => (d.stations[2].plus.chain.knots[2].p[0] = 0.95)],
    [
      'section-out-of-bounds',
      swallowBoard,
      (d) => (d.stations[2].plus.chain.knots[1].out[0] = 1.2),
    ],
    [
      'section-out-of-bounds',
      swallowBoard,
      (d) => (d.stations[2].plus.chain.knots[3].in[0] = -0.1),
    ],
    // features, build
    ['feature-invalid', swallowBoard, (d) => (d.features[0].depth.keys[0].value = 0.1)],
    ['feature-invalid', swallowBoard, (d) => (d.features[1].width = 2)],
    ['feature-invalid', asymmetricBoard, (d) => (d.features[0].railInset = 30)],
    ['build-invalid', swallowBoard, (d) => (d.build.tolerance = 0)],
    ['build-invalid', swallowBoard, (d) => (d.build.railFade = 1.5)],
  ];

  it.each(cases)('refuses a %s violation under that code alone (#%#)', (code, make, edit) => {
    expect(codes(mutate(make(), edit))).toEqual([code]);
  });

  it('accepts a V bottom and a pitched deck (centre handles that leave the stringer at an angle)', () => {
    const doc = mutate(swallowBoard(), (d) => {
      const k = d.stations[2].plus.chain.knots;
      k[0].out[1] = 0.1;
      k[k.length - 1].in[1] = 0.9;
    });
    expect(validateBoard(doc)).toEqual([]);
  });

  it('tests the curve of the rocker and deck, not their control polygons', () => {
    // handles that overlap in x (the first beyond the second) while x(t) still increases: a function of x
    const doc = mutate(swallowBoard(), (d) => {
      d.rocker.knots[0].out[0] = 80; // next knot: x = 92, in handle 62
      d.deck.knots[0].out[0] = 70;
    });
    expect(validateBoard(doc)).toEqual([]);
    // and a curve that does go backwards is still refused
    expect(codes(mutate(swallowBoard(), (d) => (d.rocker.knots[0].out[0] = 400)))).toEqual([
      'line-not-function',
    ]);
  });

  it('re-picks the notch zone of a tail marked auto when the outline changes (an outline edit near the tail)', () => {
    // a steeper first segment of the notch wall: the stored 24 cm zone now gives a chord that crosses the wall too flatly, a 44 cm one does not
    const edit = (d: any): void => {
      d.outline.plus.knots[0].out = [7, 4];
    };
    expect(codes(mutate(swallowBoard(), edit))).toEqual(['notch-chord-angle']);
    const auto = mutate(swallowBoard(), (d) => {
      edit(d);
      d.tail.auto = true;
    });
    expect(validateBoard(auto)).toEqual([]);
    const picked = resolveTail(auto);
    expect(picked.tail.kind === 'notched' && picked.tail.zone).toBeCloseTo(44, 9); // 4 d
    expect(resolveTail(picked)).toEqual(picked); // stable
    // buildBoard picks it too, and the stored document is untouched
    const built = buildBoard(auto);
    expect(built.ok && built.value.doc.tail).toEqual(picked.tail);
    expect(auto.tail).toMatchObject({ kind: 'notched', zone: 24, auto: true });
    // a board that validates keeps the shortest zone of the ladder, which may be shorter than the stored one
    const ok = mutate(swallowBoard(), (d) => (d.tail.auto = true));
    expect(validateBoard(ok)).toEqual([]);
    // and it round-trips through JSON
    const back = reviveBoardDoc(JSON.parse(boardDocToJson(auto)) as unknown);
    expect(back.ok && back.value.tail).toEqual(auto.tail);
  });

  it('lets the deck meet the rocker at the ends, but not cross it', () => {
    // zero thickness at the tail and at the nose: the board closes to a point or an edge there
    const closeEnds = (gap: number) =>
      mutate(swallowBoard(), (d) => {
        for (const [r, k] of [
          [d.rocker.knots[0], d.deck.knots[0]],
          [d.rocker.knots.at(-1), d.deck.knots.at(-1)],
        ]) {
          for (const key of ['p', 'in', 'out'] as const) k[key][1] = r[key][1] + gap;
        }
      });
    expect(validateBoard(closeEnds(0))).toEqual([]);
    expect(codes(closeEnds(-0.1))).toEqual(['thickness']);
  });

  it('reports the issue with its location and marks it an error', () => {
    const [issue] = validateBoard(
      mutate(swallowBoard(), (d) => (d.stations[2].plus.chain.knots[2].p[0] = 0.95)),
    );
    expect(issue).toMatchObject({
      code: 'section-apex-moved',
      severity: 'error',
      at: { station: 's40', side: 'plus' },
      value: 0.95,
    });
  });

  it('reports every violation, not just the first', () => {
    const doc = mutate(swallowBoard(), (d) => {
      d.stations[1].plus.chain.knots[0].p = [0.1, 0];
      d.stations[2].plus.apex = 0;
      d.build.tolerance = -1;
    });
    expect(codes(doc).sort()).toEqual([
      'build-invalid',
      'section-apex-index',
      'section-centre-moved',
    ]);
  });
});
