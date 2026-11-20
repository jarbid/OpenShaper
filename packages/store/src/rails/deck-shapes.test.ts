// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deck shapes (`deck-shapes.ts`): the arcs it writes, how a curve is read, and applying a shape to
 * every board the project ships and makes (the made boards and the starter templates), at one
 * station and at all of them, at a typical crown and at the greatest the board holds: the engine builds
 * the result with no issue and it is closed, every deck keeps the half-curve rules, the shape and
 * the crown read back, applying a shape twice changes nothing (the same object), and a seeded
 * sequence of random calls keeps all of that.
 */
import type { Chain, RailsBoard } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import {
  BAND_SHARE_MAX,
  CROWN_MIN,
  DEFAULT_WALL_FALL_SHARE,
  DOME_READ_TOLERANCE,
  FLAT_TOLERANCE,
  WALL_MIN,
  WALL_SLOPE_MAX,
  applyDeckShape,
  bandAt,
  bandEdge,
  deckCrownRange,
  deckCrownRangeAt,
  deckShapeAt,
  deckShapeOf,
  domeFall,
  domedSpline,
  flatSpline,
  heightAt,
  wallFallFor,
  type DeckScope,
  type DeckShapeRequest,
} from './deck-shapes';
import { moveStation } from './edits';
import { halfCurveFrame, obeysHalfCurveRules } from './half-curve';
import { curveToSpline, splineToCurve, stationSplines } from './project';
import { insertStation } from './station-insert';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';
import { between, deepFreeze, pick, seeded } from './test-support/zone-kit';
import type { StationSplines } from '../edits';
import { splineFromKnots, knot, vec2 } from '@openshaper/kernel';

/** A station entry for a curve on its own: a deck over a flat bottom at 0. */
const entryOf = (
  deck: StationSplines['deck'],
  w: number,
  T: number,
  bottomEnd = 0,
): StationSplines => ({
  deck,
  bottom: splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(w / 3, 0), true),
    knot(vec2(w, bottomEnd), vec2((2 * w) / 3, 0), vec2(w, bottomEnd), true),
  ]),
  w,
  T,
});

/** How many of the deck curves of `doc` break a half-curve rule (the board's own rules, both sides). */
function brokenDecks(doc: RailsBoard): string[] {
  const out: string[] = [];
  for (const side of ['plus', 'minus'] as const) {
    if (side === 'minus' && doc.outline.minus === undefined) continue;
    stationSplines(doc, side).forEach((e, i) => {
      if (e.w > 0 && e.T > 0 && !obeysHalfCurveRules(e.deck, halfCurveFrame(e, 'deck'))) {
        out.push(`${doc.stations[i]!.id} ${side}`);
      }
    });
  }
  return out;
}

const middle = (doc: RailsBoard): number => Math.floor(doc.stations.length / 2);

describe('domes', () => {
  it('domeFall and wallFallFor are each other’s inverse, and a dome has fallen the wall fall at the wall', () => {
    const rng = seeded(11);
    for (let i = 0; i < 200; i++) {
      const w = between(rng, 1, 40);
      const edge = between(rng, (1 - BAND_SHARE_MAX) * w, w);
      const fall = between(rng, 0.01, 6);
      const crown = domeFall(fall, w, edge);
      expect(wallFallFor(crown, w, edge) / fall).toBeCloseTo(1, 9);
      expect(domeFall(fall, w, w)).toBeCloseTo(fall, 12);
    }
    expect(domeFall(2, 0, 1)).toBe(0);
    expect(wallFallFor(1, 20, 0)).toBe(0);
  });

  it('a Domed curve is exactly the parabola, in two knots, level at the stringer and on the wall', () => {
    const rng = seeded(5);
    for (let i = 0; i < 300; i++) {
      const w = between(rng, 0.5, 40);
      const T = between(rng, 0.2, 9);
      const fall = between(rng, 0.01, (w * WALL_SLOPE_MAX) / 2);
      const s = domedSpline(w, T, fall);
      const k = s.knots;
      expect(k).toHaveLength(2);
      expect(k[0]!.end).toEqual({ x: 0, y: T });
      expect(k[0]!.tangentToNext.y).toBe(T);
      expect(k[1]!.end.x).toBe(w);
      for (let j = 0; j <= 100; j++) {
        const x = (w * j) / 100;
        expect(heightAt(s, x), `w ${w} fall ${fall}`).toBeCloseTo(T - domeFall(fall, w, x), 9);
      }
      expect(obeysHalfCurveRules(s, { curve: 'deck', w, T, otherEnd: T - fall - 1 })).toBe(true);
    }
  });

  it('is within 0.15 mm of the circle with the same fall, at the crowns the boards have', () => {
    // the parabola's distance from the circle is w^4 / (32 R^3) at the most: measured on every station of every board at its own crown
    let worst = 0;
    for (const [, make] of everyBoard) {
      const doc = make();
      const entries = stationSplines(doc, 'plus');
      doc.stations.forEach((_, i) => {
        const e = entries[i]!;
        const dome = applyDeckShape(doc, { shape: 'domed' }, { station: i, all: false });
        const now = deckShapeAt(dome, i);
        if (now?.shape !== 'domed') return;
        const fall = now.wallFall!;
        const radius = (e.w * e.w + fall * fall) / (2 * fall);
        for (let j = 1; j < 100; j++) {
          const x = (e.w * j) / 100;
          const circle = radius - Math.sqrt(radius * radius - x * x);
          worst = Math.max(worst, Math.abs(circle - domeFall(fall, e.w, x)));
        }
      });
    }
    expect(worst).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(0.015);
  });

  it('is the same share of the thickness through any stretch of the curve along either axis', () => {
    const rng = seeded(17);
    for (let i = 0; i < 200; i++) {
      const w = between(rng, 2, 30);
      const T = between(rng, 1, 8);
      const fall = between(rng, 0.05, Math.min(T * 0.9, (w * WALL_SLOPE_MAX) / 2));
      const entry = entryOf(domedSpline(w, T, fall), w, T);
      const a = between(rng, 0.5, 2);
      const b = between(rng, 0.5, 2);
      // the stored curve, divided by the width and thickness it was drawn at, is drawn again at another width and thickness
      const stretched = curveToSpline(splineToCurve(entry.deck, w, T), a * w, b * T);
      const read = deckShapeOf(entryOf(stretched, a * w, b * T), 1)!;
      expect(read.shape).toBe('domed');
      expect(read.wallFall! / (b * fall)).toBeCloseTo(1, 9);
    }
  });

  it('a flat curve is level from the stringer to the wall', () => {
    const s = flatSpline(20, 5);
    expect(s.knots).toHaveLength(2);
    for (let x = 0; x <= 20; x += 2) expect(heightAt(s, x)).toBeCloseTo(5, 12);
    expect(obeysHalfCurveRules(s, { curve: 'deck', w: 20, T: 5, otherEnd: 0 })).toBe(true);
  });
});

describe('the band edge', () => {
  it('is the half width less the band, held to the share the engine allows', () => {
    expect(bandEdge(20, 2)).toBe(18);
    expect(bandEdge(20, 0)).toBe(20);
    expect(bandEdge(20, 100)).toBeCloseTo(20 * (1 - BAND_SHARE_MAX), 12);
    expect(bandEdge(20, NaN)).toBe(20);
    expect(bandEdge(20, -3)).toBe(20);
  });
});

describe('reading a deck curve', () => {
  const w = 22;
  const T = 5.5;

  it('reads a flat curve as Flat, with the knots it has', () => {
    expect(deckShapeOf(entryOf(flatSpline(w, T), w, T), 2)).toEqual({
      shape: 'flat',
      crown: 0,
      wallFall: null,
    });
    const three = splineFromKnots([
      knot(vec2(0, T), vec2(0, T), vec2(3, T), true),
      knot(vec2(9, T), vec2(6, T), vec2(12, T), true),
      knot(vec2(w, T), vec2(18, T), vec2(w, T), true),
    ]);
    expect(deckShapeOf(entryOf(three, w, T), 2)?.shape).toBe('flat');
  });

  it('reads a domed curve as Domed, with its fall at the wall and its crown, whatever the band', () => {
    for (const fall of [0.4, 1.5, 3, 5]) {
      const e = entryOf(domedSpline(w, T, fall), w, T);
      for (const band of [0, 1, 2, 3.5, 1000]) {
        const r = deckShapeOf(e, band)!;
        expect(r.shape).toBe('domed');
        expect(r.wallFall! / fall).toBeCloseTo(1, 9);
        expect(r.crown).toBeCloseTo(domeFall(fall, w, bandEdge(w, band)), 9);
      }
      // a wider band puts the edge nearer the stringer, so the crown is less
      expect(deckShapeOf(e, 3)!.crown).toBeLessThan(deckShapeOf(e, 1)!.crown);
    }
  });

  it('reads anything else as Custom, with the curve’s own crown at the band edge', () => {
    // the end knot of a domed curve moved a millimetre
    const base = domedSpline(w, T, 2);
    const k = base.knots;
    const moved = splineFromKnots([
      k[0]!,
      knot(
        vec2(w, k[1]!.end.y - 0.1),
        vec2(k[1]!.tangentToPrev.x, k[1]!.tangentToPrev.y - 0.1),
        vec2(w, k[1]!.end.y - 0.1),
        true,
      ),
    ]);
    const r = deckShapeOf(entryOf(moved, w, T), 2)!;
    expect(r.shape).toBe('custom');
    expect(r.wallFall).toBeNull();
    expect(r.crown).toBeCloseTo(T - heightAt(moved, bandEdge(w, 2)), 12);
    // a curve that stops short of the wall, and one that rises
    const short = splineFromKnots([
      knot(vec2(0, T), vec2(0, T), vec2(3, T), true),
      knot(vec2(w - 1, T - 1), vec2(w - 4, T - 0.5), vec2(w - 1, T - 1), true),
    ]);
    expect(deckShapeOf(entryOf(short, w, T), 2)?.shape).toBe('custom');
    const up = splineFromKnots([
      knot(vec2(0, T), vec2(0, T), vec2(3, T), true),
      knot(vec2(w, T + 1), vec2(w - 4, T + 0.5), vec2(w, T + 1), true),
    ]);
    expect(deckShapeOf(entryOf(up, w, T), 2)?.shape).toBe('custom');
  });

  it('a curve within the tolerances of a shape still reads it, and one beyond them does not', () => {
    const lift = (dy: number) =>
      splineFromKnots([
        knot(vec2(0, T), vec2(0, T), vec2(w / 3, T), true),
        knot(vec2(w, T - dy), vec2((2 * w) / 3, T - dy), vec2(w, T - dy), true),
      ]);
    // the end knot and its handle both lowered, so the curve's greatest distance from level is dy
    expect(deckShapeOf(entryOf(lift(FLAT_TOLERANCE * 0.9), w, T), 2)?.shape).toBe('flat');
    expect(deckShapeOf(entryOf(lift(FLAT_TOLERANCE * 1.5), w, T), 2)?.shape).not.toBe('flat');
  });

  it('reads no shape at a station with no width or no thickness', () => {
    expect(deckShapeOf(entryOf(flatSpline(0, T), 0, T), 1)).toBeNull();
    expect(deckShapeOf(entryOf(flatSpline(w, 0), w, 0), 1)).toBeNull();
  });

  it('reads every deck the project ships as Custom: each rolls faster than an arc near its rail', () => {
    for (const [name, make] of everyBoard) {
      const doc = make();
      doc.stations.forEach((_, i) => {
        const r = deckShapeAt(doc, i);
        if (r !== null) expect(r.shape, `${name} station ${i}`).toBe('custom');
      });
    }
  });
});

describe('what a station can hold', () => {
  it('keeps the deck a millimetre above the bottom at the wall at the greatest crown', () => {
    for (const [name, make] of everyBoard) {
      const doc = make();
      const entries = stationSplines(doc, 'plus');
      doc.stations.forEach((st, i) => {
        const e = entries[i]!;
        const band = bandAt(doc, 'plus', st.x);
        const range = deckCrownRange(e, band);
        if (range === null) return;
        expect(range.min).toBe(CROWN_MIN);
        expect(range.max).toBeGreaterThanOrEqual(CROWN_MIN);
        const fall = wallFallFor(range.max, e.w, bandEdge(e.w, band));
        const bottomEnd = e.bottom.knots.at(-1)!.end.y;
        const wallHeight = e.T - fall - bottomEnd;
        expect(wallHeight, `${name} ${st.id}`).toBeGreaterThanOrEqual(WALL_MIN - 1e-9);
        // and never steeper at the wall than the slope allowed
        expect((2 * fall) / e.w).toBeLessThanOrEqual(WALL_SLOPE_MAX + 1e-9);
      });
    }
  });

  it('has none at a station with no width, and none where the board is too thin', () => {
    expect(deckCrownRange(entryOf(flatSpline(0, 1), 0, 1), 0)).toBeNull();
    // thinner than the wall margin: nothing to fall into
    expect(
      deckCrownRange(entryOf(flatSpline(10, WALL_MIN * 0.9), 10, WALL_MIN * 0.9), 0),
    ).toBeNull();
    // a station can hold the least crown, at its smallest
    const thin = entryOf(
      flatSpline(10, WALL_MIN + CROWN_MIN * 1.2),
      10,
      WALL_MIN + CROWN_MIN * 1.2,
    );
    expect(deckCrownRange(thin, 0)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Applying a shape to every board
// ---------------------------------------------------------------------------

/** A crown that is typical of the station: the one a new Domed deck is given there, at its band edge. */
function typical(doc: RailsBoard, station: number): number {
  const e = stationSplines(doc, 'plus')[station]!;
  const edge = bandEdge(e.w, bandAt(doc, 'plus', doc.stations[station]!.x));
  return domeFall(DEFAULT_WALL_FALL_SHARE * e.T, e.w, edge);
}

/** What each scenario applies: a shape, a crown (the typical one, the greatest, or none), and a scope. */
const SCENARIOS: readonly {
  readonly name: string;
  readonly request: (doc: RailsBoard, station: number) => DeckShapeRequest;
  readonly all: boolean;
}[] = [
  { name: 'flat, all stations', request: () => ({ shape: 'flat' }), all: true },
  { name: 'flat, one station', request: () => ({ shape: 'flat' }), all: false },
  {
    name: 'domed with the crown each station has, all stations',
    request: () => ({ shape: 'domed' }),
    all: true,
  },
  {
    name: 'domed at a typical crown, all stations',
    request: (d, s) => ({ shape: 'domed', crown: typical(d, s) }),
    all: true,
  },
  {
    name: 'domed at a typical crown, one station',
    request: (d, s) => ({ shape: 'domed', crown: typical(d, s) }),
    all: false,
  },
  {
    name: 'domed at the least crown, all stations',
    request: () => ({ shape: 'domed', crown: 0 }),
    all: true,
  },
  {
    name: 'domed at the least crown, one station',
    request: () => ({ shape: 'domed', crown: 0 }),
    all: false,
  },
  {
    name: 'domed at the greatest crown, all stations',
    request: () => ({ shape: 'domed', crown: Number.MAX_VALUE }),
    all: true,
  },
  {
    name: 'domed at the greatest crown, one station',
    request: () => ({ shape: 'domed', crown: Number.MAX_VALUE }),
    all: false,
  },
];

describe.each(everyBoard)('applying a shape to the %s board', (_name, make) => {
  const doc = make();
  const station = middle(doc);

  it.each(SCENARIOS.filter((s) => s.all))(
    'builds a closed board, with the shape read back: $name',
    ({ request, all }) => {
      const scope: DeckScope = { station, all };
      const next = applyDeckShape(doc, request(doc, station), scope);
      expect(next).not.toBe(doc);
      const verdict = closedVerdict(next, true);
      expect(verdict.why).toBe('');
      expect(verdict.ok).toBe(true);
      expect(brokenDecks(next)).toEqual([]);
      for (let i = 0; i < next.stations.length; i++) {
        const read = deckShapeAt(next, i);
        // a station with no width or thickness has nothing to read
        if (read !== null) expect(read.shape).toBe(request(doc, station).shape);
      }
      // the same shape again is the same board
      expect(applyDeckShape(next, request(doc, station), scope)).toBe(next);
    },
  );

  it.each(SCENARIOS.filter((s) => !s.all))(
    'changes the station alone, and builds a closed board: $name',
    ({ request, all }) => {
      const scope: DeckScope = { station, all };
      const req = request(doc, station);
      const next = applyDeckShape(doc, req, scope);
      expect(next).not.toBe(doc);
      expect(closedVerdict(next, true).ok).toBe(true);
      expect(brokenDecks(next)).toEqual([]);
      expect(deckShapeAt(next, station)?.shape).toBe(req.shape);
      next.stations.forEach((st, i) => {
        if (i !== station) expect(st).toBe(doc.stations[i]);
      });
      // the parts an edit does not touch are the same objects
      expect(next.outline).toBe(doc.outline);
      expect(next.rocker).toBe(doc.rocker);
      expect(next.deck).toBe(doc.deck);
      expect(next.rails).toBe(doc.rails);
      expect(next.stations[station]!.plus.bottom).toBe(doc.stations[station]!.plus.bottom);
      expect(applyDeckShape(next, req, scope)).toBe(next);
    },
  );

  it('reads the crown that was asked, or the most the station holds', () => {
    const asked = typical(doc, station);
    const next = applyDeckShape(doc, { shape: 'domed', crown: asked }, { station, all: false });
    const range = deckCrownRangeAt(doc, station)!;
    const read = deckShapeAt(next, station)!;
    expect(read.shape).toBe('domed');
    expect(read.crown).toBeCloseTo(Math.min(asked, range.max), 9);
    const most = applyDeckShape(doc, { shape: 'domed', crown: 1e9 }, { station, all: false });
    expect(deckShapeAt(most, station)!.crown).toBeCloseTo(range.max, 9);
    const least = applyDeckShape(doc, { shape: 'domed', crown: 0 }, { station, all: false });
    expect(deckShapeAt(least, station)!.crown).toBeCloseTo(range.min, 9);
  });
});

// ---------------------------------------------------------------------------
// What the other edits do to a Domed deck
// ---------------------------------------------------------------------------

/** The chain with every height scaled by `f`: the deck line and the rocker scaled together scale the thickness. */
const scaleHeights = (c: Chain, f: number): Chain => ({
  knots: c.knots.map((k) => ({
    ...k,
    p: [k.p[0], k.p[1] * f],
    in: [k.in[0], k.in[1] * f],
    out: [k.out[0], k.out[1] * f],
  })),
});

/** The chain with every distance from the stringer scaled by `f`: the outline scaled so the board is wider. */
const scaleWidths = (c: Chain, f: number): Chain => scaleHeights(c, f);

/** Which stations read Domed, as a string of letters for a failure message. */
const reads = (d: RailsBoard): string =>
  d.stations.map((_, i) => deckShapeAt(d, i)?.shape[0] ?? '-').join('');

describe.each(everyBoard)(
  'a Domed deck on the %s board, through the edits that are not its own',
  (_name, make) => {
    const doc = make();
    const mid = middle(doc);
    const stretch = [0.7, 0.9, 1.1, 1.5];
    const domed = [
      applyDeckShape(doc, { shape: 'domed' }, { station: mid, all: true }),
      applyDeckShape(doc, { shape: 'domed', crown: 1.5 }, { station: mid, all: true }),
      applyDeckShape(doc, { shape: 'domed', crown: Number.MAX_VALUE }, { station: mid, all: true }),
    ];

    it('stays Domed where a station is moved along the board, at every place it can be', () => {
      for (const d of domed) {
        const before = reads(d);
        const a = d.stations[mid - 1]!.x;
        const b = d.stations[mid + 1]!.x;
        for (let k = 1; k < 8; k++) {
          const moved = moveStation(d, mid + 1, a + ((b - a) * k) / 8);
          expect(reads(moved)).toBe(before);
        }
      }
    });

    it('stays Domed where the thickness or the width of the board is changed by a tenth, or by half', () => {
      for (const d of domed) {
        const before = reads(d);
        for (const f of stretch) {
          const thicker = {
            ...d,
            deck: scaleHeights(d.deck, f),
            rocker: scaleHeights(d.rocker, f),
          };
          expect(reads(thicker), `thickness x${f}`).toBe(before);
          const wider = {
            ...d,
            outline: {
              ...d.outline,
              plus: scaleWidths(d.outline.plus, f),
              ...(d.outline.minus ? { minus: scaleWidths(d.outline.minus, f) } : {}),
            },
          };
          expect(reads(wider), `width x${f}`).toBe(before);
        }
      }
    });

    it('is Domed in a station added between two Domed ones, and the new station’s dome is between theirs', () => {
      for (const d of domed) {
        for (let i = 0; i + 1 < d.stations.length; i++) {
          const lo = deckShapeAt(d, i);
          const hi = deckShapeAt(d, i + 1);
          if (lo?.shape !== 'domed' || hi?.shape !== 'domed') continue;
          const added = insertStation(d, (d.stations[i]!.x + d.stations[i + 1]!.x) / 2)!;
          const mid2 = deckShapeAt(added.doc, i + 1)!;
          expect(mid2.shape).toBe('domed');
          // its fall at the wall, as a share of the thickness, is between its neighbours'
          const share = (doc2: RailsBoard, j: number) =>
            deckShapeAt(doc2, j)!.wallFall! / stationSplines(doc2, 'plus')[j]!.T;
          const s = [share(added.doc, i), share(added.doc, i + 1), share(added.doc, i + 2)];
          expect(s[1]).toBeGreaterThanOrEqual(Math.min(s[0]!, s[2]!) - 1e-9);
          expect(s[1]).toBeLessThanOrEqual(Math.max(s[0]!, s[2]!) + 1e-9);
        }
      }
    });
  },
);

describe('what a call leaves alone', () => {
  const doc = everyBoard.find(([n]) => n === 'asymmetric')![1]();

  it('leaves a station with no width or no thickness as it is', () => {
    const empty = doc.stations.findIndex((_, i) => deckShapeAt(doc, i) === null);
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(applyDeckShape(doc, { shape: 'flat' }, { station: empty, all: false })).toBe(doc);
    const all = applyDeckShape(doc, { shape: 'flat' }, { station: middle(doc), all: true });
    expect(all.stations[empty]).toBe(doc.stations[empty]);
  });

  it('does nothing for a station the board does not have', () => {
    for (const station of [-1, doc.stations.length, 1.5, NaN]) {
      expect(applyDeckShape(doc, { shape: 'flat' }, { station, all: true })).toBe(doc);
    }
  });

  it('ignores a crown that is not a number: each station keeps its own', () => {
    const keep = applyDeckShape(doc, { shape: 'domed' }, { station: 2, all: true });
    const nan = applyDeckShape(doc, { shape: 'domed', crown: NaN }, { station: 2, all: true });
    expect(deckShapeAt(nan, 2)!.crown).toBeCloseTo(deckShapeAt(keep, 2)!.crown, 9);
  });

  it('changes nothing it was not asked to: a frozen board is not written to', () => {
    const frozen = deepFreeze(structuredClone(doc));
    expect(() =>
      applyDeckShape(frozen, { shape: 'domed', crown: 1.2 }, { station: 2, all: true }),
    ).not.toThrow();
  });
});

describe('all stations', () => {
  const doc = everyBoard.find(([n]) => n === 'mirror')![1]();
  const station = 2;
  /** The fall at the wall over the thickness at a station, plus side. */
  const wallShare = (d: RailsBoard, i: number): number =>
    deckShapeAt(d, i)!.wallFall! / stationSplines(d, 'plus')[i]!.T;

  it('gives the chosen station the crown asked and every other the same share of its thickness at the wall', () => {
    const asked = 1.8;
    const next = applyDeckShape(doc, { shape: 'domed', crown: asked }, { station, all: true });
    const entries = stationSplines(doc, 'plus');
    expect(deckShapeAt(next, station)!.crown).toBeCloseTo(asked, 9);
    const share = wallShare(next, station);
    next.stations.forEach((st, i) => {
      const range = deckCrownRangeAt(doc, i);
      const read = deckShapeAt(next, i);
      if (range === null || read === null) return;
      expect(read.shape).toBe('domed');
      const e = entries[i]!;
      const wanted = domeFall(share * e.T, e.w, bandEdge(e.w, bandAt(doc, 'plus', st.x)));
      expect(read.crown).toBeCloseTo(Math.min(range.max, Math.max(range.min, wanted)), 9);
    });
  });

  it('is one curve in (u, v): the share of the thickness fallen at the wall is the same at every station', () => {
    const next = applyDeckShape(doc, { shape: 'domed', crown: 1.5 }, { station, all: true });
    const share = wallShare(next, station);
    next.stations.forEach((_, i) => {
      if (deckShapeAt(next, i) !== null) expect(wallShare(next, i)).toBeCloseTo(share, 9);
    });
  });

  it('keeps the rail at the last station of a board whose band is wide beside its half width', () => {
    // the golden shortboard's last station is 2.3 cm to the wall with a band of 1.03 cm: its band edge is 1.3 cm out
    const last = doc.stations.length - 1;
    for (const request of [{ shape: 'domed', crown: 1.5 } as const, { shape: 'domed' } as const]) {
      const from =
        request.crown === undefined
          ? applyDeckShape(doc, { shape: 'flat' }, { station, all: true })
          : doc;
      const next = applyDeckShape(from, request, { station, all: true });
      const e = stationSplines(next, 'plus')[last]!;
      const height = e.deck.knots.at(-1)!.end.y - e.bottom.knots.at(-1)!.end.y;
      // as thick at the wall, as a share of its thickness, as the rest of the board: not the millimetre the least allows
      expect(height).toBeGreaterThan(0.25 * e.T);
      expect(height).toBeGreaterThan(WALL_MIN * 2);
    }
  });

  it('holds every station to what it can hold when the crown is too much for the thin ones', () => {
    const next = applyDeckShape(doc, { shape: 'domed', crown: 5 }, { station, all: true });
    expect(closedVerdict(next, true).ok).toBe(true);
    // the chosen station holds 5 cm; the tips take their share, and the rail at the tail is not gone
    const entries = stationSplines(next, 'plus');
    entries.forEach((e) => {
      const bottomEnd = e.bottom.knots.at(-1)!.end.y;
      expect(e.deck.knots.at(-1)!.end.y - bottomEnd).toBeGreaterThanOrEqual(WALL_MIN - 1e-9);
    });
  });

  it('gives a station with no crown the default fall at the wall, and keeps the crown a station has', () => {
    const flat = applyDeckShape(doc, { shape: 'flat' }, { station, all: true });
    const next = applyDeckShape(flat, { shape: 'domed' }, { station, all: true });
    next.stations.forEach((_, i) => {
      const range = deckCrownRangeAt(next, i);
      if (range === null || deckShapeAt(next, i) === null) return;
      // the default share of the thickness at the wall, or the most the station holds
      expect(wallShare(next, i)).toBeLessThanOrEqual(DEFAULT_WALL_FALL_SHARE + 1e-9);
      expect(deckShapeAt(next, i)!.crown).toBeGreaterThanOrEqual(range.min - 1e-9);
    });
    expect(wallShare(next, station)).toBeCloseTo(DEFAULT_WALL_FALL_SHARE, 9);
    // a drawn deck kept through Domed keeps each station's crown
    const keep = applyDeckShape(doc, { shape: 'domed' }, { station, all: true });
    doc.stations.forEach((_, i) => {
      const was = deckShapeAt(doc, i);
      if (was !== null && was.crown >= CROWN_MIN)
        expect(deckShapeAt(keep, i)!.crown).toBeCloseTo(was.crown, 9);
    });
  });
});

describe.each(everyBoard)('all stations of the %s board', (_name, make) => {
  const doc = make();
  const station = middle(doc);

  it('fall the same share of their thickness at the wall, or hold the most they can, with no rail thinner than a millimetre at one that can hold more', () => {
    for (const request of [{ shape: 'domed', crown: 1.5 } as const, { shape: 'domed' } as const]) {
      const from =
        request.crown === undefined
          ? applyDeckShape(doc, { shape: 'flat' }, { station, all: true })
          : doc;
      const next = applyDeckShape(from, request, { station, all: true });
      const entries = stationSplines(next, 'plus');
      const shares: number[] = [];
      next.stations.forEach((st, i) => {
        const e = entries[i]!;
        const read = deckShapeAt(next, i);
        const range = deckCrownRangeAt(next, i);
        if (read === null || read.shape !== 'domed' || range === null) return;
        const heldAtMost = read.crown >= range.max - 1e-9;
        const share = read.wallFall! / e.T;
        shares.push(share);
        // a station that holds its most may fall less than the share; none falls more
        if (!heldAtMost) expect(share, `${st.id}`).toBeGreaterThan(0);
      });
      // every station that was not held at its most fell the one share the call set
      const free = shares.filter((x) => Math.abs(x - shares[0]!) < 1e-9);
      expect(free.length).toBeGreaterThanOrEqual(Math.ceil(shares.length / 2));
    }
  });
});

describe('the two sides of an asymmetric board', () => {
  const doc = everyBoard.find(([n]) => n === 'asymmetric')![1]();
  const station = 2;

  it('give both sides the crown asked, and both read it', () => {
    const next = applyDeckShape(doc, { shape: 'domed', crown: 1.4 }, { station, all: false });
    for (const side of ['plus', 'minus'] as const) {
      const e = stationSplines(next, side)[station]!;
      const r = deckShapeOf(e, bandAt(next, side, next.stations[station]!.x))!;
      expect(r.shape).toBe('domed');
      expect(r.crown).toBeCloseTo(1.4, 9);
    }
    expect(deckShapeAt(next, station)!.sidesDiffer).toBe(false);
  });

  it('with no crown given, keep each side’s own, and say that the sides differ', () => {
    const next = applyDeckShape(doc, { shape: 'domed' }, { station, all: false });
    const read = deckShapeAt(next, station)!;
    expect(read.shape).toBe('domed');
    const plus = deckShapeOf(
      stationSplines(next, 'plus')[station]!,
      bandAt(next, 'plus', next.stations[station]!.x),
    )!;
    const minus = deckShapeOf(
      stationSplines(next, 'minus')[station]!,
      bandAt(next, 'minus', next.stations[station]!.x),
    )!;
    expect(read.sidesDiffer).toBe(Math.abs(plus.crown - minus.crown) > DOME_READ_TOLERANCE);
    expect(read.crown).toBeCloseTo(plus.crown, 12);
  });

  it('change one side alone when it is named, and a side a mirror board lacks is no call', () => {
    const plusOnly = applyDeckShape(
      doc,
      { shape: 'domed', crown: 1.4 },
      { station, all: false },
      'plus',
    );
    expect(plusOnly.stations[station]!.minus).toBe(doc.stations[station]!.minus);
    expect(plusOnly.stations[station]!.plus.deck).not.toBe(doc.stations[station]!.plus.deck);
    expect(deckShapeAt(plusOnly, station)!.shape).toBe('custom');
    const mirror = everyBoard.find(([n]) => n === 'mirror')![1]();
    expect(applyDeckShape(mirror, { shape: 'flat' }, { station: 1, all: true }, 'minus')).toBe(
      mirror,
    );
  });
});

// ---------------------------------------------------------------------------
// A random sequence of calls
// ---------------------------------------------------------------------------

describe.each(everyBoard)('a random sequence of calls on the %s board', (name, make) => {
  it('keeps the rules, reads what it wrote, and is idempotent', { timeout: 20_000 }, () => {
    const rng = seeded(name.length * 7919);
    let doc: RailsBoard = deepFreeze(structuredClone(make()));
    for (let step = 0; step < 40; step++) {
      const shape = pick(rng, ['flat', 'domed', 'domed', 'domed'] as const);
      const crown = pick(rng, [undefined, between(rng, 0, 4), 1e6, 0.001, -2]);
      const request: DeckShapeRequest =
        shape === 'flat' || crown === undefined ? { shape } : { shape, crown };
      const scope: DeckScope = {
        station: Math.floor(rng() * doc.stations.length),
        all: rng() < 0.5,
      };
      const side = pick(rng, [undefined, undefined, 'plus', 'minus'] as const);
      const where = `${name} step ${step}: ${JSON.stringify({ request, scope, side })}`;
      const next = applyDeckShape(doc, request, scope, side);
      expect(brokenDecks(next), where).toEqual([]);
      // the same call on its own result changes nothing
      expect(applyDeckShape(next, request, scope, side), where).toBe(next);
      if (side === undefined && request.shape === 'flat') {
        const read = deckShapeAt(next, scope.station);
        if (read !== null) expect(read.shape, where).toBe('flat');
      }
      doc = deepFreeze(next);
      if (step % 13 === 12) expect(closedVerdict(doc, true).ok, where).toBe(true);
    }
  });
});
