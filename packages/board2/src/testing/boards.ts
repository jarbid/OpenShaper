// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test boards of the section-based model (docs/design/m1-model.md §6, step 1):
 * a swallow, a fish and an asymmetric board with realistic proportions, and an
 * analytic board with a closed form. Test-only (the package's source never
 * imports this directory).
 *
 * Frame: cm, tail at x = 0. Each function returns a fresh plain document.
 */
import { DEFAULT_BUILD } from '../params';
import type {
  BoardDoc,
  BottomFeature,
  Chain,
  ChainKnot,
  Outline,
  Pair,
  Section,
  Station,
} from '../types';

/** A knot with absolute handles; a missing handle is the point itself (an unused end handle). */
export const knot = (p: Pair, inn?: Pair, out?: Pair, smooth = true): ChainKnot => ({
  p,
  in: inn ?? p,
  out: out ?? p,
  smooth,
});

/** Bézier segments of a chain given as knots `[p, in, out]`. */
export const chain = (...knots: ChainKnot[]): Chain => ({ knots });

/**
 * A realistic section from five numbers: the tuck (`uT`, `vT`), the apex height
 * `vA` (at u = 1, vertical tangent) and the deck rail edge (`uD`, `vD`); bottom and
 * deck centres are fixed (0, 0) and (0, 1) with horizontal handles. Interior
 * handles are a sixth of the neighbour difference, with u kept in [0, 1].
 */
export function section(uT: number, vT: number, vA: number, uD: number, vD: number): Section {
  const pts: Pair[] = [
    [0, 0],
    [uT, vT],
    [1, vA],
    [uD, vD],
    [0, 1],
  ];
  const knots: ChainKnot[] = pts.map((p, i) => {
    if (i === 0) return knot(p, p, [uT / 3, 0]);
    if (i === 4) return knot(p, [uD / 3, 1], p);
    const prev = pts[i - 1]!;
    const next = pts[i + 1]!;
    // the apex leaves vertically; the others follow the neighbours, shortened so both handles keep u in [0, 1]
    let du = i === 2 ? 0 : (next[0] - prev[0]) / 6;
    let dv = (next[1] - prev[1]) / 6;
    if (du !== 0) {
      const room = Math.min(p[0], 1 - p[0]) / Math.abs(du);
      if (room < 1) {
        du *= room;
        dv *= room;
      }
    }
    return knot(p, [p[0] - du, p[1] - dv], [p[0] + du, p[1] + dv]);
  });
  return { chain: { knots }, apex: 2 };
}

const station = (id: string, x: number, plus: Section, minus?: Section): Station => ({
  id,
  x,
  plus,
  ...(minus === undefined ? {} : { minus }),
});

const meta = (name: string) => ({ name, source: 'board2-testing' });

// ---------------------------------------------------------------------------
// Analytic board
// ---------------------------------------------------------------------------

/** The closed forms of {@link analyticBoard}: half-width, rocker and thickness as functions of x. */
export interface AnalyticFacts {
  readonly length: number;
  readonly halfWidth: (x: number) => number;
  readonly rocker: (x: number) => number;
  readonly thickness: (x: number) => number;
  /** The one section, as a Bézier chain in (u, v). */
  readonly section: Section;
}

const ANALYTIC_L = 100;
const ANALYTIC_W = 20;
const ANALYTIC_ROCKER = 2;

export const analyticFacts: AnalyticFacts = {
  length: ANALYTIC_L,
  halfWidth: (x) => 4 * ANALYTIC_W * (x / ANALYTIC_L) * (1 - x / ANALYTIC_L),
  rocker: (x) => ANALYTIC_ROCKER * (1 - (2 * x) / ANALYTIC_L) ** 2,
  thickness: (x) => 1 + 20 * (x / ANALYTIC_L) * (1 - x / ANALYTIC_L),
  section: {
    chain: chain(
      knot([0, 0], [0, 0], [0.5, 0]),
      knot([1, 0.4], [1, 0.12], [1, 0.68]),
      knot([0, 1], [0.5, 1], [0, 1]),
    ),
    apex: 1,
  },
};

/**
 * A standard-tail board whose plan, rocker and thickness are parabolas (exact in
 * cubic Bézier form) with one constant section at one station:
 * half-width `80 t (1 − t)`, rocker `2 (1 − 2t)²`, thickness `1 + 20 t (1 − t)`, t = x / 100.
 */
export function analyticBoard(): BoardDoc {
  const L = ANALYTIC_L;
  const W = ANALYTIC_W;
  const xs = [0, L / 3, (2 * L) / 3, L];
  const poly = (ys: number[]): Chain =>
    chain(
      knot([xs[0]!, ys[0]!], undefined, [xs[1]!, ys[1]!]),
      knot([xs[3]!, ys[3]!], [xs[2]!, ys[2]!], undefined),
    );
  // quadratic Bernstein ordinates q elevate to (q0, (q0 + 2 q1)/3, (2 q1 + q2)/3, q2)
  const elevate = (q: [number, number, number]): number[] => [
    q[0],
    (q[0] + 2 * q[1]) / 3,
    (2 * q[1] + q[2]) / 3,
    q[2],
  ];
  return {
    format: 'openshaper',
    version: 3,
    model: 'sections',
    meta: meta('analytic'),
    symmetry: 'mirror',
    tail: { kind: 'standard' },
    outline: { plus: poly(elevate([0, 2 * W, 0])) },
    rocker: poly(elevate([ANALYTIC_ROCKER, -ANALYTIC_ROCKER, ANALYTIC_ROCKER])),
    // deck = rocker + thickness: ordinates (2 + 1, -2 + 11, 2 + 1)
    deck: poly(elevate([ANALYTIC_ROCKER + 1, -ANALYTIC_ROCKER + 11, ANALYTIC_ROCKER + 1])),
    stations: [station('mid', L / 2, analyticFacts.section)],
    features: [],
    build: { ...DEFAULT_BUILD },
  };
}

// ---------------------------------------------------------------------------
// Swallow, fish, asymmetric
// ---------------------------------------------------------------------------

/** Section parameters per station: [uT, vT, vA, uD, vD]. */
type SectionRow = readonly [number, number, number, number, number];

const sectionsAlong = (xs: readonly number[], rows: readonly SectionRow[], tag = ''): Station[] =>
  xs.map((x, i) => station(`s${tag}${x}`, x, section(...rows[i]!)));

const FULL_SECTIONS: readonly SectionRow[] = [
  [0.7, 0.05, 0.3, 0.7, 0.7],
  [0.75, 0.05, 0.28, 0.74, 0.68],
  [0.82, 0.05, 0.3, 0.8, 0.72],
  [0.88, 0.06, 0.38, 0.86, 0.78],
  [0.9, 0.07, 0.4, 0.88, 0.8],
  [0.88, 0.06, 0.38, 0.86, 0.78],
  [0.8, 0.05, 0.32, 0.78, 0.7],
  [0.7, 0.04, 0.3, 0.7, 0.65],
];

const vee = (id: string, keys: [number, number][], r: number): BottomFeature => ({
  kind: 'vee',
  id,
  enabled: true,
  depth: { keys: keys.map(([s, value]) => ({ s, value })) },
  stringerRadius: r,
});

/** A 6'1" swallowtail: notch bottom at x = 11, tips at x = 0, a vee and a double concave. */
export function swallowBoard(): BoardDoc {
  const plus: Chain = chain(
    knot([11, 0], undefined, [6.5, 2.5], false),
    knot([0, 9.5], [1.2, 8.2], [3, 13], false),
    knot([30, 19.2], [16, 15.5], [46, 22.6]),
    knot([95, 23.6], [70, 23.8], [120, 23.4]),
    knot([155, 17.5], [140, 21.5], [165, 13.5]),
    knot([185, 0], [185, 8], undefined),
  );
  return {
    format: 'openshaper',
    version: 3,
    model: 'sections',
    meta: meta('swallow'),
    symmetry: 'mirror',
    tail: { kind: 'notched', zone: 24 },
    outline: { plus },
    rocker: chain(
      knot([0, 3.2], undefined, [30, 1.2]),
      knot([92, 0], [62, 0], [125, 0]),
      knot([185, 10.5], [155, 1.5], undefined),
    ),
    deck: chain(
      knot([0, 3.7], undefined, [30, 5.2]),
      knot([92, 6.2], [62, 6.2], [125, 6.1]),
      knot([185, 11], [155, 7], undefined),
    ),
    stations: sectionsAlong([11, 24, 40, 70, 100, 130, 160, 185], FULL_SECTIONS),
    features: [
      vee(
        'vee',
        [
          [60, 0],
          [120, 0.2],
          [170, 0],
        ],
        0.3,
      ),
      {
        kind: 'concave',
        id: 'double',
        enabled: true,
        depth: {
          keys: [
            { s: 80, value: 0 },
            { s: 110, value: 0.3 },
            { s: 140, value: 0 },
          ],
        },
        layout: 'double',
        centre: 0.4,
        width: 0.3,
      },
    ],
    build: { ...DEFAULT_BUILD },
  };
}

/** A 5'7" fish: a shallow, wide notch (bottom at x = 6) with tips at x = 0 and a single concave. */
export function fishBoard(): BoardDoc {
  const plus: Chain = chain(
    knot([6, 0], undefined, [4.5, 3], false),
    knot([0, 12], [0.8, 9.2], [2.5, 15], false),
    knot([28, 21.5], [14, 18.5], [44, 24.2]),
    knot([88, 25], [66, 25.2], [110, 24.8]),
    knot([140, 18], [128, 22.5], [152, 13.5]),
    knot([170, 0], [170, 8], undefined),
  );
  return {
    format: 'openshaper',
    version: 3,
    model: 'sections',
    meta: meta('fish'),
    symmetry: 'mirror',
    tail: { kind: 'notched', zone: 18 },
    outline: { plus },
    rocker: chain(
      knot([0, 2.6], undefined, [28, 1]),
      knot([85, 0], [58, 0], [115, 0]),
      knot([170, 9.5], [142, 1.2], undefined),
    ),
    deck: chain(
      knot([0, 3.2], undefined, [28, 4.6]),
      knot([85, 6.4], [58, 6.4], [115, 6.3]),
      knot([170, 10.2], [142, 6.6], undefined),
    ),
    stations: sectionsAlong([6, 16, 32, 64, 100, 120, 150, 170], FULL_SECTIONS),
    features: [
      {
        kind: 'concave',
        id: 'single',
        enabled: true,
        depth: {
          keys: [
            { s: 40, value: 0 },
            { s: 90, value: 0.35 },
            { s: 140, value: 0 },
          ],
        },
        layout: 'single',
        centre: 0,
        width: 0.7,
      },
    ],
    build: { ...DEFAULT_BUILD },
  };
}

/** A standard-tail board whose two sides differ in outline and sections, with two channels. */
export function asymmetricBoard(): BoardDoc {
  const plus: Chain = chain(
    knot([0, 0], undefined, [3, 5], false),
    knot([30, 18.5], [12, 16], [48, 21.6]),
    knot([92, 23.5], [68, 23.7], [118, 23.2]),
    knot([150, 17], [136, 21], [160, 13]),
    knot([180, 0], [180, 8], undefined),
  );
  const minus: Chain = chain(
    knot([0, 0], undefined, [3.5, 6], false),
    knot([30, 20], [12, 17.2], [48, 22.8]),
    knot([92, 24.6], [68, 24.8], [118, 24.2]),
    knot([150, 17.6], [136, 21.8], [160, 13.4]),
    knot([180, 0], [180, 8], undefined),
  );
  const outline: Outline = { plus, minus };
  const xs = [0, 20, 45, 80, 115, 165, 180];
  const rows: readonly SectionRow[] = [
    [0.7, 0.04, 0.3, 0.7, 0.7],
    [0.8, 0.05, 0.3, 0.78, 0.7],
    [0.86, 0.06, 0.36, 0.84, 0.76],
    [0.9, 0.07, 0.4, 0.88, 0.8],
    [0.86, 0.06, 0.36, 0.84, 0.76],
    [0.78, 0.05, 0.3, 0.76, 0.68],
    [0.7, 0.04, 0.3, 0.7, 0.65],
  ];
  // the minus side: fuller lower rails and a harder tuck, so the two sides differ
  const minusRows = rows.map(
    ([uT, vT, vA, uD, vD]): SectionRow => [uT - 0.03, vT, vA + 0.06, uD, vD - 0.02],
  );
  return {
    format: 'openshaper',
    version: 3,
    model: 'sections',
    meta: meta('asymmetric'),
    symmetry: 'asymmetric',
    tail: { kind: 'standard' },
    outline,
    rocker: chain(
      knot([0, 2.8], undefined, [30, 1.1]),
      knot([90, 0], [60, 0], [122, 0]),
      knot([180, 10], [150, 1.4], undefined),
    ),
    deck: chain(
      knot([0, 3.3], undefined, [30, 4.8]),
      knot([90, 6.1], [60, 6.1], [122, 6]),
      knot([180, 10.6], [150, 6.7], undefined),
    ),
    stations: xs.map((x, i) =>
      station(`s${x}`, x, section(...rows[i]!), section(...minusRows[i]!)),
    ),
    features: [
      {
        kind: 'channels',
        id: 'channels',
        enabled: true,
        depth: {
          keys: [
            { s: 70, value: 0 },
            { s: 100, value: 0.3 },
            { s: 130, value: 0.3 },
            { s: 150, value: 0 },
          ],
        },
        count: 2,
        width: 0.8,
        pitch: 1.2,
        railInset: 3,
      },
    ],
    build: { ...DEFAULT_BUILD },
  };
}

/** The three realistic test boards by name. */
export const testBoards: { readonly [name: string]: () => BoardDoc } = {
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
};
