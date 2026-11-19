// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rails boards that `reviveRails` accepts (they are shaped right) and `buildRails` refuses, because
 * they would build a wrong board with no issue, a mesh of non-finite numbers, or a mesh whose size has
 * no bound; and the boards made and the starter templates, which every check lets through.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reviveBoardDoc } from '../doc';
import {
  RADIUS_MAX,
  RAIL_DOMAIN,
  RAILS_COORD_MAX,
  RAILS_FEATURES_MAX,
  RAILS_HALF_WIDTH_MAX,
  RAILS_KEYS_MAX,
  RAILS_KNOTS_MAX,
  RAILS_LENGTH_MAX,
  RAILS_OUTLINE_PATH_MAX,
  RAILS_STATIONS_MAX,
  STATION_GAP,
  TRIM,
} from '../params';
import { boardSet } from '../test-support/board-set';
import { analyticBoard, asymmetricBoard, swallowBoard } from '../testing';
import type { Chain, ChainKnot } from '../types';
import type { RailsBoard } from './board';
import { convertSections } from './convert';
import { buildRails, meshRails } from './native';

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
  // A repeated station id is `station-id`, as the sections model's `validate` has it. The app keeps each station's engine section by id (`RailsSlices`), so two stations
  // with one id are drawn with the same section.
  it('two stations with one id', () => {
    const b = swallow();
    const stations = b.stations.map((s) => ({ ...s, id: 's1' }));
    expect(refusedWith({ ...b, stations })).toContain('station-id');
  });

  // A line knot beyond `RAILS_COORD_MAX` of the origin is refused: a rocker knot at 1e308 would build a
  // mesh, a volume and probes of NaN.
  it('a rocker knot at 1e308', () => {
    const b = swallow();
    expect(
      refusedWith({ ...b, rocker: moved(b.rocker, 1, [b.rocker.knots[1]!.p[0], 1e308]) }),
    ).not.toEqual([]);
  });

  // An outline wider than `RAILS_HALF_WIDTH_MAX` is refused before anything is built: the loft and the
  // mesh grid grow with the outline's extent, and 10,000 cm would run for minutes. A share link of 6 KB
  // carries such a board.
  it('a half width of 10,000 cm', () => {
    const b = swallow();
    const k = 2;
    const p = b.outline.plus.knots[k]!.p;
    const outline = { ...b.outline, plus: moved(b.outline.plus, k, [p[0], 1e4]) };
    expect(refusedWith({ ...b, outline })).not.toEqual([]);
  });

  // An outline that crosses the stringer is `outline-not-function`, as `validate` has it for a sections
  // document: the widest knot moved to the far side would build a quarter of the board with no issue.
  it('an outline that crosses the stringer', () => {
    const b = swallow();
    const k = 2;
    const p = b.outline.plus.knots[k]!.p;
    const outline = { ...b.outline, plus: moved(b.outline.plus, k, [p[0], -p[1]]) };
    expect(refusedWith({ ...b, outline })).not.toEqual([]);
  });

  // A station curve that does not run from the stringer (u = 0) to the wall (u = 1) is refused: a station
  // whose curves are all at (0, 0) would build with the volume halved and no issue.
  it('a station whose curves have no width', () => {
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

function railsOf(doc: Parameters<typeof convertSections>[0]): RailsBoard {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
}

const asymmetric = (): RailsBoard => railsOf({ ...asymmetricBoard(), features: [] });

/** `chain` with every point of knot `k` (the knot and its handles) given `f` of itself. */
function mapKnot(
  chain: Chain,
  k: number,
  f: (q: readonly [number, number]) => readonly [number, number],
): Chain {
  return {
    ...chain,
    knots: chain.knots.map(
      (q, i): ChainKnot => (i === k ? { ...q, p: f(q.p), in: f(q.in), out: f(q.out) } : q),
    ),
  };
}

/** `board` with station `i`'s curves on `side` given `f`. */
function withCurve(
  board: RailsBoard,
  i: number,
  side: 'plus' | 'minus',
  f: (c: Chain) => Chain,
): RailsBoard {
  const stations = board.stations.map((s, j) => {
    if (j !== i) return s;
    const curves = side === 'plus' ? s.plus : s.minus!;
    const next = { bottom: f(curves.bottom), deck: curves.deck };
    return side === 'plus' ? { ...s, plus: next } : { ...s, minus: next };
  });
  return { ...board, stations };
}

describe('buildRails holds a board to its limits', () => {
  it('refuses a deck number that is not finite', () => {
    const b = swallow();
    expect(refusedWith({ ...b, deck: mapKnot(b.deck, 1, (q) => [q[0], Infinity]) })).toEqual([
      'out-of-range',
    ]);
  });

  it(`refuses an outline point beyond ${RAILS_COORD_MAX} cm of the origin`, () => {
    const b = swallow();
    const last = b.outline.plus.knots.length - 1;
    const plus = mapKnot(b.outline.plus, last, (q) => [RAILS_COORD_MAX + 1, q[1]]);
    expect(refusedWith({ ...b, outline: { ...b.outline, plus } })).toContain('out-of-range');
  });

  it(`refuses an outline longer than ${RAILS_LENGTH_MAX} cm`, () => {
    const b = swallow();
    const last = b.outline.plus.knots.length - 1;
    // every point within reach of the origin, the extent 1 cm over the limit
    let plus = mapKnot(b.outline.plus, last, (q) => [RAILS_LENGTH_MAX, q[1]]);
    plus = mapKnot(plus, 0, (q) => [q[0] - 1 - b.outline.plus.knots[0]!.p[0], q[1]]);
    expect(refusedWith({ ...b, outline: { ...b.outline, plus } })).toContain('out-of-range');
  });

  it(`refuses a half width over ${RAILS_HALF_WIDTH_MAX} cm`, () => {
    const b = swallow();
    const outline = {
      ...b.outline,
      plus: mapKnot(b.outline.plus, 2, (q) => [q[0], RAILS_HALF_WIDTH_MAX + 0.5]),
    };
    expect(refusedWith({ ...b, outline })).toEqual(['out-of-range']);
  });

  it(`refuses an outline side whose control polygon is over ${RAILS_OUTLINE_PATH_MAX} cm`, () => {
    const b = swallow();
    // knot 2's handles pulled out to the far end: every point inside the plan's limits
    const far = [RAILS_COORD_MAX - 1, RAILS_HALF_WIDTH_MAX - 1] as const;
    const plus = {
      ...b.outline.plus,
      knots: b.outline.plus.knots.map((k, i) => (i === 2 ? { ...k, in: far, out: far } : k)),
    };
    expect(refusedWith({ ...b, outline: { ...b.outline, plus } })).toEqual(['out-of-range']);
  });

  it('refuses a minus outline that crosses the stringer', () => {
    const b = asymmetric();
    const minus = mapKnot(b.outline.minus!, 2, (q) => [q[0], -q[1]]);
    expect(refusedWith({ ...b, outline: { ...b.outline, minus } })).toEqual([
      'outline-not-function',
    ]);
  });

  it('refuses a station whose x is not finite', () => {
    const b = swallow();
    const stations = b.stations.map((s, i) => (i === 2 ? { ...s, x: Number.NaN } : s));
    expect(refusedWith({ ...b, stations })).toContain('out-of-range');
  });

  it(`refuses two stations closer than ${STATION_GAP} cm`, () => {
    const b = swallow();
    const stations = b.stations.map((s, i) =>
      i === 2 ? { ...s, x: b.stations[1]!.x + STATION_GAP / 2 } : s,
    );
    expect(refusedWith({ ...b, stations })).toEqual(['station-order']);
  });

  it("refuses a station outside the outline's extent", () => {
    const b = swallow();
    const last = b.stations.length - 1;
    const stations = b.stations.map((s, i) => (i === last ? { ...s, x: s.x + 5 } : s));
    expect(refusedWith({ ...b, stations })).toEqual(['station-order']);
  });

  it('refuses a station inside the outline where the board has no width', () => {
    const b = swallow();
    // the outline pinched to the stringer at an interior station's place
    const x = b.stations[3]!.x;
    const plus = mapKnot(b.outline.plus, 3, () => [x, 0]);
    expect(refusedWith({ ...b, outline: { ...b.outline, plus } })).toEqual(['station-order']);
  });

  it('refuses a station where the board has no thickness', () => {
    const b = swallow();
    expect(refusedWith({ ...b, deck: b.rocker })).toContain('thickness');
  });

  it('refuses a station curve that does not start at the stringer', () => {
    const b = withCurve(swallow(), 2, 'plus', (c) => mapKnot(c, 0, (q) => [q[0] + 0.1, q[1]]));
    expect(refusedWith(b)).toEqual(['section-out-of-bounds']);
  });

  it('refuses a station curve whose knots go back in u', () => {
    const b = withCurve(swallow(), 2, 'plus', (c) => {
      const k = c.knots;
      // the second knot moved behind the first's u
      return mapKnot(c, 1, (q) => [q === k[1]!.p ? -0.01 : q[0], q[1]]);
    });
    expect(refusedWith(b)).toEqual(['section-out-of-bounds']);
  });

  it('refuses a minus station curve with a handle beyond the wall', () => {
    const b = withCurve(asymmetric(), 2, 'minus', (c) => {
      const k = c.knots;
      const out = k[k.length - 2]!.out;
      return {
        ...c,
        knots: k.map((q, i) => (i === k.length - 2 ? { ...q, out: [1.2, out[1]] as const } : q)),
      };
    });
    expect(refusedWith(b)).toEqual(['section-out-of-bounds']);
  });

  it('refuses a rail number outside its range, on the plus keys', () => {
    const b = swallow();
    const plus = b.rails.plus.map((k, i) =>
      i === 1 ? { ...k, rail: { ...k.rail, band: -1 } } : k,
    );
    expect(refusedWith({ ...b, rails: { plus } })).toEqual(['out-of-range']);
  });

  it('refuses a rail number outside its range on minus keys of a mirror board', () => {
    const b = swallow();
    const edge = RAIL_DOMAIN.deckEdge[1] + 1;
    const minus = b.rails.plus.map((k, i) =>
      i === 0 ? { ...k, rail: { ...k.rail, deckEdge: edge } } : k,
    );
    expect(refusedWith({ ...b, rails: { plus: b.rails.plus, minus } })).toEqual(['out-of-range']);
  });

  it('refuses rail numbers at ±1e308 and a rail key at x = 1e6', () => {
    const b = swallow();
    const big = b.rails.plus.map((k) => ({ ...k, rail: { ...k.rail, tuck: 1e308 } }));
    expect(refusedWith({ ...b, rails: { plus: big } })).toEqual(['out-of-range']);
    const far = b.rails.plus.map((k, i) => (i === 0 ? { ...k, x: -1e6 } : k));
    expect(refusedWith({ ...b, rails: { plus: far } })).toEqual(['out-of-range']);
  });

  it(`refuses a corner radius outside 0 to ${RADIUS_MAX} cm`, () => {
    const b = swallow();
    expect(refusedWith({ ...b, corners: { ...b.corners, nose: 1e308 } })).toEqual(['out-of-range']);
    expect(refusedWith({ ...b, corners: { ...b.corners, plus: [-5] } })).toEqual(['out-of-range']);
  });

  it('refuses stations at x = ±1e6', () => {
    const b = swallow();
    const last = b.stations.length - 1;
    const stations = b.stations.map((s, i) =>
      i === 0 ? { ...s, x: -1e6 } : i === last ? { ...s, x: 1e6 } : s,
    );
    expect(refusedWith({ ...b, stations })).toEqual(['station-order', 'station-order']);
  });
});

/** `n` copies of `item`, made by `make` from the item and its place. */
const copies = <T>(item: T, n: number, make: (item: T, i: number) => T = (t) => t): T[] =>
  Array.from({ length: n }, (_, i) => make(item, i));

/** The messages of the error issues `buildRails` gives `board`. */
function refusalsOf(board: RailsBoard): string[] {
  const r = buildRails(board);
  return r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => i.message);
}

// The reader refuses a document over these counts (`reviveRails`). A board that builds must be one the
// reader takes back, or the app could hold a board it can save and never open again: so the builder
// refuses the same counts, and says which.
describe('buildRails refuses what the reader would refuse', () => {
  it(`more than ${RAILS_STATIONS_MAX} stations`, () => {
    const b = swallow();
    const stations = copies(b.stations[1]!, RAILS_STATIONS_MAX + 1, (s, i) => ({
      ...s,
      id: `s${i}`,
      x: 1 + i * 0.5,
    }));
    expect(refusalsOf({ ...b, stations })).toEqual([
      `the board has ${RAILS_STATIONS_MAX + 1} stations; the limit is ${RAILS_STATIONS_MAX}`,
    ]);
  });

  it(`more than ${RAILS_KNOTS_MAX} knots in the outline, the rocker, the deck or a station's curve`, () => {
    const b = swallow();
    const over = (c: Chain): Chain => ({
      ...c,
      knots: copies(c.knots[0]!, RAILS_KNOTS_MAX + 1),
    });
    const limit = `has ${RAILS_KNOTS_MAX + 1} knots; the limit is ${RAILS_KNOTS_MAX}`;
    expect(refusalsOf({ ...b, outline: { ...b.outline, plus: over(b.outline.plus) } })).toEqual([
      `outline.plus: ${limit}`,
    ]);
    expect(refusalsOf({ ...b, rocker: over(b.rocker) })).toEqual([`rocker: ${limit}`]);
    expect(refusalsOf({ ...b, deck: over(b.deck) })).toEqual([`deck: ${limit}`]);
    const id = b.stations[1]!.id;
    expect(refusalsOf(withCurve(b, 1, 'plus', over))).toEqual([
      `station '${id}' (plus bottom): the curve ${limit}`,
    ]);
  });

  it(`more than ${RAILS_KNOTS_MAX} corner radii a side`, () => {
    const b = swallow();
    const plus = copies(0.5, RAILS_KNOTS_MAX + 1);
    expect(refusalsOf({ ...b, corners: { ...b.corners, plus } })).toEqual([
      `the corner radii number ${RAILS_KNOTS_MAX + 1} a side; the limit is ${RAILS_KNOTS_MAX}`,
    ]);
  });

  it(`more than ${RAILS_FEATURES_MAX} bottom features`, () => {
    const b = railsOf(swallowBoard());
    const f = b.features[0]!;
    const features = copies(f, RAILS_FEATURES_MAX + 1, (t, i) => ({ ...t, id: `f${i}` }));
    expect(refusalsOf({ ...b, features })).toEqual([
      `the board has ${RAILS_FEATURES_MAX + 1} bottom features; the limit is ${RAILS_FEATURES_MAX}`,
    ]);
  });

  it(`more than ${RAILS_KEYS_MAX} rail keys a side`, () => {
    const b = swallow();
    const key = b.rails.plus[0]!;
    const plus = copies(key, RAILS_KEYS_MAX + 1, (k, i) => ({ ...k, x: i * 0.01 }));
    expect(refusalsOf({ ...b, rails: { ...b.rails, plus } })).toEqual([
      `the plus side has ${RAILS_KEYS_MAX + 1} rail keys; the limit is ${RAILS_KEYS_MAX}`,
    ]);
  });
});

describe('every real board is inside the limits', () => {
  const templates = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/web/src/templates',
  );
  const cases: [string, RailsBoard][] = [
    ['analytic', railsOf(analyticBoard())],
    ...boardSet().map((b): [string, RailsBoard] => [b.name, railsOf(b.doc)]),
    ...readdirSync(templates)
      .filter((f) => f.endsWith('.board'))
      .map((f): [string, RailsBoard] => {
        const r = reviveBoardDoc(JSON.parse(readFileSync(join(templates, f), 'utf8')));
        if (!r.ok) throw new Error(`${f}: ${r.issues.map((i) => i.message).join('; ')}`);
        return [f, railsOf(r.value)];
      }),
  ];

  it('covers the made boards and the starter templates', () => {
    expect(cases.length).toBeGreaterThanOrEqual(14);
  });

  it.each(cases)('%s builds with no issue', (_name, board) => {
    const r = buildRails(board);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('the mesh budget', () => {
  /** The shortboard scaled to `length` by `halfWidth` cm, a hair under each. */
  function sized(length: number, halfWidth: number): RailsBoard {
    const sb = boardSet().find((x) => x.name === 'shortboard');
    if (sb === undefined) throw new Error('no shortboard');
    const b = railsOf(sb.doc);
    const L = b.outline.plus.knots.at(-1)!.p[0];
    const W = Math.max(...b.outline.plus.knots.flatMap((k) => [k.p[1], k.in[1], k.out[1]]));
    const sx = (length / L) * (1 - 1e-12);
    const sy = (halfWidth / W) * (1 - 1e-12);
    const plan = (q: readonly [number, number]): readonly [number, number] => [
      q[0] * sx,
      q[1] * sy,
    ];
    const line = (q: readonly [number, number]): readonly [number, number] => [q[0] * sx, q[1]];
    const map = (c: Chain, f: typeof plan): Chain => ({
      knots: c.knots.map((k) => ({ ...k, p: f(k.p), in: f(k.in), out: f(k.out) })),
    });
    return {
      ...b,
      outline: { plus: map(b.outline.plus, plan) },
      rocker: map(b.rocker, line),
      deck: map(b.deck, line),
      stations: b.stations.map((s) => ({ ...s, x: s.x * sx })),
      rails: { plus: b.rails.plus.map((k) => ({ ...k, x: k.x * sx })) },
    };
  }
  const built = (b: RailsBoard) => {
    const r = buildRails(b);
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
    return r.value;
  };

  it(`holds a ${RAILS_LENGTH_MAX} by ${RAILS_HALF_WIDTH_MAX} cm board to it, and says so`, () => {
    const b = built(sized(RAILS_LENGTH_MAX, RAILS_HALF_WIDTH_MAX));
    const view = meshRails(b);
    // about 480,000 vertices at a 1.1 cm grid, where the view grid would give about a million
    expect(view.coarsened).toBe(true);
    expect(view.grid!).toBeGreaterThan(TRIM.viewGrid);
    expect(view.vertexCount).toBeLessThan(600_000);
    // an STL asked finer than the budget allows is held to it too, with the same panel grid
    const stl = meshRails(b, { maxEdge: 0.1 });
    expect(stl.coarsened).toBe(true);
    expect(stl.grid).toBe(view.grid);
    expect(stl.vertexCount).toBeLessThan(700_000);
    // the volume does not depend on the cut
    expect(Math.abs(stl.volume - view.volume) / view.volume).toBeLessThan(1e-3);
  });

  it(`meshes a ${RAILS_LENGTH_MAX} by 1 cm board, its strips bounded by the outline's length`, () => {
    const m = meshRails(built(sized(RAILS_LENGTH_MAX, 1)));
    expect(m.vertexCount).toBeLessThan(150_000);
    expect(Number.isFinite(m.volume) && m.volume > 0).toBe(true);
  });

  it("leaves every made board alone at view and draft, and the largest at the app's finest STL", () => {
    for (const { name, doc } of boardSet()) {
      const b = built(railsOf(doc));
      const qualities =
        name === 'longboard'
          ? [{}, { draft: true }, { maxEdge: TRIM.stlFace }]
          : [{}, { draft: true }];
      for (const opts of qualities) {
        const m = meshRails(b, opts);
        expect(m.coarsened).toBeUndefined();
        expect(m.grid).toBeUndefined();
      }
    }
  });
});
