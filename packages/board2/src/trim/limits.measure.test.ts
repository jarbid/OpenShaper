// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Legitimate rails boards at each of the limits a board is held to (`RAILS_*` in `params.ts`): the
 * most stations, rail keys, knots of a chain and bottom features the reader takes, and the longest
 * and widest plan the build takes. Each is written to text, revived, built and meshed at view
 * quality and as an STL at `TRIM.stlFace`, and the times and sizes are printed; each must finish inside a stated time.
 * Several take seconds, more on a loaded CI runner, so this is a study, kept out of the default run:
 *
 *   TRIM_LIMITS=1 NODE_OPTIONS=--expose-gc \
 *     pnpm --filter @openshaper/board2 exec vitest run src/trim/limits.measure.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  TRIM,
  RAILS_FEATURES_MAX,
  RAILS_HALF_WIDTH_MAX,
  RAILS_KEYS_MAX,
  RAILS_KNOTS_MAX,
  RAILS_LENGTH_MAX,
  RAILS_STATIONS_MAX,
} from '../params';
import { boardSet } from '../test-support/board-set';
import { asymmetricBoard, swallowBoard } from '../testing';
import type { BottomFeature, Chain, ChainKnot, Pair } from '../types';
import type { RailsBoard } from './board';
import { convertSections } from './convert';
import { railsToJson, reviveRails } from './doc';
import { buildRails, meshRails } from './native';

const study = describe.skipIf(process.env.TRIM_LIMITS !== '1');

function railsOf(doc: Parameters<typeof convertSections>[0]): RailsBoard {
  const r = convertSections(doc);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value.board;
}

const lerp = (a: Pair, b: Pair, t: number): Pair => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * `chain` with each Bézier segment split into `m` by de Casteljau: the same curve, with
 * `m - 1` smooth knots more a segment.
 */
function subdivided(chain: Chain, m: number): Chain {
  const k = chain.knots;
  const out: ChainKnot[] = [{ ...k[0]! }];
  for (let s = 0; s + 1 < k.length; s++) {
    let p0 = k[s]!.p;
    let p1 = k[s]!.out;
    let p2 = k[s + 1]!.in;
    const p3 = k[s + 1]!.p;
    for (let j = 1; j < m; j++) {
      // split the remaining piece at the share that is 1 / (m - j + 1) of it
      const t = 1 / (m - j + 1);
      const a = lerp(p0, p1, t);
      const b = lerp(p1, p2, t);
      const c = lerp(p2, p3, t);
      const d = lerp(a, b, t);
      const e = lerp(b, c, t);
      const f = lerp(d, e, t);
      const prev = out[out.length - 1]!;
      out[out.length - 1] = { ...prev, out: a };
      out.push({ p: f, in: d, out: e, smooth: true });
      p0 = f;
      p1 = e;
      p2 = c;
    }
    const prev = out[out.length - 1]!;
    out[out.length - 1] = { ...prev, out: p1 };
    out.push({ ...k[s + 1]!, in: p2 });
  }
  return { knots: out };
}

/** `chain` split to at most `n` knots. */
const withKnots = (chain: Chain, n: number): Chain =>
  subdivided(chain, Math.floor((n - 1) / (chain.knots.length - 1)));

/** A board scaled by `sx` along x and `sy` across: the plan, the places of stations and keys. */
function scaled(b: RailsBoard, sx: number, sy: number): RailsBoard {
  const plan = (q: Pair): Pair => [q[0] * sx, q[1] * sy];
  const line = (q: Pair): Pair => [q[0] * sx, q[1]];
  const map = (c: Chain, f: (q: Pair) => Pair): Chain => ({
    knots: c.knots.map((k) => ({ ...k, p: f(k.p), in: f(k.in), out: f(k.out) })),
  });
  return {
    ...b,
    outline: {
      plus: map(b.outline.plus, plan),
      ...(b.outline.minus === undefined ? {} : { minus: map(b.outline.minus, plan) }),
    },
    rocker: map(b.rocker, line),
    deck: map(b.deck, line),
    stations: b.stations.map((s) => ({ ...s, x: s.x * sx })),
    rails: {
      plus: b.rails.plus.map((k) => ({ ...k, x: k.x * sx })),
      ...(b.rails.minus === undefined
        ? {}
        : { minus: b.rails.minus.map((k) => ({ ...k, x: k.x * sx })) }),
    },
  };
}

/** A scale a hair under 1, so a board scaled to a limit is not over it by a rounding. */
const SHY = 1 - 1e-12;

const lengthOf = (b: RailsBoard): number => b.outline.plus.knots.at(-1)!.p[0];
const widthOf = (b: RailsBoard): number =>
  Math.max(
    ...[b.outline.plus, b.outline.minus ?? b.outline.plus].flatMap((c) =>
      c.knots.flatMap((k) => [k.p[1], k.in[1], k.out[1]]),
    ),
  );

/** `n` stations spread evenly inside the board, each with the curves of the nearest station. */
function manyStations(b: RailsBoard, n: number): RailsBoard {
  const L = lengthOf(b);
  const stations = Array.from({ length: n }, (_, i) => {
    const x = (L * (i + 0.5)) / n;
    let near = b.stations[0]!;
    for (const s of b.stations) if (Math.abs(s.x - x) < Math.abs(near.x - x)) near = s;
    return { ...near, id: `s${i}`, x };
  });
  return { ...b, stations };
}

/** `n` rail keys a side spread evenly along the board, the board's own rails in turn. */
function manyKeys(b: RailsBoard, n: number): RailsBoard {
  const L = lengthOf(b);
  const plus = Array.from({ length: n }, (_, i) => ({
    x: (L * i) / (n - 1),
    rail: b.rails.plus[i % b.rails.plus.length]!.rail,
  }));
  return { ...b, rails: { plus } };
}

/** The board with the chains `which` picks (the outline, the rocker and deck, the station curves) at `n` knots. */
function manyKnots(
  b: RailsBoard,
  n: number,
  which: { readonly outline?: boolean; readonly lines?: boolean; readonly curves?: boolean },
): RailsBoard {
  return {
    ...b,
    ...(which.outline === true
      ? {
          outline: {
            plus: withKnots(b.outline.plus, n),
            ...(b.outline.minus === undefined ? {} : { minus: withKnots(b.outline.minus, n) }),
          },
        }
      : {}),
    ...(which.lines === true ? { rocker: withKnots(b.rocker, n), deck: withKnots(b.deck, n) } : {}),
    ...(which.curves === true
      ? {
          stations: b.stations.map((s) => ({
            ...s,
            plus: { bottom: withKnots(s.plus.bottom, n), deck: withKnots(s.plus.deck, n) },
          })),
        }
      : {}),
  };
}

/** `n` bottom features: the board's own, in turn, each with its own id. */
function manyFeatures(b: RailsBoard, own: readonly BottomFeature[], n: number): RailsBoard {
  const features = Array.from({ length: n }, (_, i) => ({ ...own[i % own.length]!, id: `f${i}` }));
  return { ...b, features };
}

/** The heap and array buffers in use (bytes) after a full collection, when the run exposes one (`NODE_OPTIONS=--expose-gc`), else NaN. */
function heapAfterGc(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) return Number.NaN;
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

interface Cost {
  readonly textKB: number;
  readonly reviveMs: number;
  readonly buildMs: number;
  readonly viewMs: number;
  readonly viewVertices: number;
  readonly stlMs: number;
  readonly stlMB: number;
  /** The panel grid of the view and the STL mesh where the budget coarsened them, else 0. */
  readonly viewGrid: number;
  readonly stlGrid: number;
  /** Seam segments of the view and of the STL mesh. */
  readonly seams: number;
  readonly stlSeams: number;
  /** MB of heap and array buffers the built board and its two meshes hold, after a full collection (NaN without `--expose-gc`). */
  readonly builtMB: number;
}

/** Writes, revives, builds and meshes `board` (view, then an STL at `face`). */
function cost(board: RailsBoard, face: number = TRIM.stlFace): Cost {
  const text = railsToJson(board);
  let t = performance.now();
  const revived = reviveRails(JSON.parse(text));
  const reviveMs = performance.now() - t;
  if (!revived.ok) throw new Error(revived.issues.map((i) => i.message).join('; '));
  const heap0 = heapAfterGc();
  t = performance.now();
  const built = buildRails(revived.value);
  const buildMs = performance.now() - t;
  if (!built.ok) throw new Error(built.issues.map((i) => i.message).join('; '));
  t = performance.now();
  const view = meshRails(built.value);
  const viewMs = performance.now() - t;
  t = performance.now();
  const stl = meshRails(built.value, { maxEdge: face });
  const stlMs = performance.now() - t;
  const builtMB = Math.round((heapAfterGc() - heap0) / 1e6);
  expect(Number.isFinite(view.volume) && view.volume > 0).toBe(true);
  return {
    textKB: Math.round(text.length / 1024),
    reviveMs: Math.round(reviveMs),
    buildMs: Math.round(buildMs),
    viewMs: Math.round(viewMs),
    viewVertices: view.vertexCount,
    stlMs: Math.round(stlMs),
    // binary STL: an 84-byte header and count, 50 bytes a triangle
    stlMB: Math.round((84 + 50 * (stl.indices.length / 3)) / 1e5) / 10,
    viewGrid: view.grid ?? 0,
    stlGrid: stl.grid ?? 0,
    seams: view.seams.positions.length / 6,
    stlSeams: stl.seams.positions.length / 6,
    builtMB,
  };
}

study('a board at each limit', () => {
  const swallow = (): RailsBoard => railsOf({ ...swallowBoard(), features: [] });
  const shortboard = (): RailsBoard => {
    const b = boardSet().find((x) => x.name === 'shortboard');
    if (b === undefined) throw new Error('no shortboard');
    return railsOf(b.doc);
  };
  const report = (name: string, c: Cost): void => {
    process.stderr.write(`[limits] ${name}: ${JSON.stringify(c)}\n`);
  };
  // a generous bound for this machine: the build and the view mesh of each board
  const BUDGET_MS = 10_000;
  const cases: [string, () => RailsBoard][] = [
    [`${RAILS_STATIONS_MAX} stations`, () => manyStations(swallow(), RAILS_STATIONS_MAX)],
    [`${RAILS_KEYS_MAX} rail keys`, () => manyKeys(swallow(), RAILS_KEYS_MAX)],
    [
      `${RAILS_KNOTS_MAX} knots: the outline`,
      () => manyKnots(shortboard(), RAILS_KNOTS_MAX, { outline: true }),
    ],
    [
      `${RAILS_KNOTS_MAX} knots: both sides of an asymmetric outline`,
      () =>
        manyKnots(railsOf({ ...asymmetricBoard(), features: [] }), RAILS_KNOTS_MAX, {
          outline: true,
        }),
    ],
    [
      `${RAILS_KNOTS_MAX} knots: the rocker and the deck`,
      () => manyKnots(shortboard(), RAILS_KNOTS_MAX, { lines: true }),
    ],
    [
      `${RAILS_KNOTS_MAX} knots: every station curve`,
      () => manyKnots(shortboard(), RAILS_KNOTS_MAX, { curves: true }),
    ],
    [
      `${RAILS_FEATURES_MAX} features`,
      () => manyFeatures(swallow(), swallowBoard().features, RAILS_FEATURES_MAX),
    ],
    [
      `${RAILS_LENGTH_MAX} by ${RAILS_HALF_WIDTH_MAX} cm`,
      () => {
        const b = shortboard();
        return scaled(
          b,
          (RAILS_LENGTH_MAX / lengthOf(b)) * SHY,
          (RAILS_HALF_WIDTH_MAX / widthOf(b)) * SHY,
        );
      },
    ],
    [
      `${RAILS_LENGTH_MAX} by 1 cm`,
      () => {
        const b = shortboard();
        return scaled(b, (RAILS_LENGTH_MAX / lengthOf(b)) * SHY, 1 / widthOf(b));
      },
    ],
    [
      `${RAILS_STATIONS_MAX} stations on ${RAILS_LENGTH_MAX} by ${RAILS_HALF_WIDTH_MAX} cm`,
      () => {
        const b = manyStations(shortboard(), RAILS_STATIONS_MAX);
        return scaled(
          b,
          (RAILS_LENGTH_MAX / lengthOf(b)) * SHY,
          (RAILS_HALF_WIDTH_MAX / widthOf(b)) * SHY,
        );
      },
    ],
    [
      `${RAILS_STATIONS_MAX} stations on an asymmetric ${RAILS_LENGTH_MAX} by ${RAILS_HALF_WIDTH_MAX} cm`,
      () => {
        const b = manyStations(railsOf({ ...asymmetricBoard(), features: [] }), RAILS_STATIONS_MAX);
        return scaled(
          b,
          (RAILS_LENGTH_MAX / lengthOf(b)) * SHY,
          (RAILS_HALF_WIDTH_MAX / widthOf(b)) * SHY,
        );
      },
    ],
  ];
  it.each(cases)('%s', (name, make) => {
    const c = cost(make());
    report(name, c);
    expect(c.buildMs + c.viewMs).toBeLessThan(BUDGET_MS);
  });

  it(`${RAILS_LENGTH_MAX} by ${RAILS_HALF_WIDTH_MAX} cm as an STL asked at a face of 0.1 cm`, () => {
    const b = shortboard();
    const c = cost(
      scaled(b, (RAILS_LENGTH_MAX / lengthOf(b)) * SHY, (RAILS_HALF_WIDTH_MAX / widthOf(b)) * SHY),
      0.1,
    );
    report('1000 by 150 cm, STL at 0.1 cm', c);
    expect(c.stlGrid).toBeGreaterThan(0);
    expect(c.stlMs).toBeLessThan(BUDGET_MS);
  });
});
