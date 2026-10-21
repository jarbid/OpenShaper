// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Smoke test and public-API pin for the scaffold (docs/design/board2.md §11,
 * decision 31).
 *
 * - The runtime export lists of both entry points are pinned exactly: the
 *   scaffold exports types only, so both are empty. Each build step adds its
 *   values here in the same diff.
 * - A sample document round-trips through JSON unchanged: `BoardDoc` is plain
 *   data (decision 1). The sample is type-checked against `BoardDoc` with
 *   `satisfies`, so a type change that breaks it fails `pnpm typecheck`.
 * - Type-level checks pin the conventions the types encode (lanes, rows that may
 *   carry offsets, Phase 2's symmetry and tail options).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as board2 from './index';
import * as classic from './classic/index';
import type {
  BandRow,
  BoardDoc,
  BuildParams,
  OffsetRow,
  RailLane,
  RailLaws,
  Symmetry,
  TailSpec,
} from './index';
import type { ClassicBoard, DeviationCause } from './classic/index';
import type { BezierBoard } from '@openshaper/kernel';

/** Every runtime (value) export of `@openshaper/board2`, sorted. Empty: types only. */
const PUBLIC_VALUES: readonly string[] = [];
/** Every runtime export of `@openshaper/board2/classic`, sorted. */
const CLASSIC_VALUES: readonly string[] = [];

const DEG = Math.PI / 180;

/** A constant half-domain law (keys at the tail and nose centres, auto ease). */
const constant = (value: number) => ({
  domain: 'half' as const,
  keys: [
    { s: 0, value },
    { s: 0.5, value },
  ],
});

const LAWS: RailLaws = {
  deckInset: constant(5),
  tuckInset: constant(2),
  apexHeight: constant(0.4),
  upperFullness: constant(0.6),
  lowerFullness: constant(0.6),
  edgeHardness: constant(0.5),
};

/** The §12.1 defaults, written out (the real record arrives with step S1). */
const BUILD: BuildParams = {
  minInset: 0.1,
  insetCurvatureFraction: 0.5,
  minRailHeight: 0.1,
  apexHeightRange: [0.05, 0.95],
  fullnessRange: [0.05, 1],
  maxFrameTurn: 5 * DEG,
  maxStationSpacing: 5,
  lawTolerance: {
    deckInset: 0.005,
    tuckInset: 0.005,
    apexHeight: 0.002,
    upperFullness: 0.005,
    lowerFullness: 0.005,
    edgeHardness: 0.005,
  },
  deckJoinAngleTol: 0.1 * DEG,
  apexJoinAngleTol: 0.1 * DEG,
  maxBandRefinePasses: 6,
  planMargin: 2,
  featureTol: 0.001,
  tolerances: {},
  edgeFit: {},
};

/** A small symmetric doc: an eight-point plan loop, flat-ish deck and bottom, one concave. */
const SAMPLE = {
  format: 'openshaper.board2',
  version: 1,
  meta: { name: 'Scaffold sample', source: 'board2' },
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
  laws: LAWS,
  offsets: { basis: null, rows: [] },
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
  build: BUILD,
  passthrough: { fins: { setup: 'none', system: 'fcs-ii', symmetrical: true, fins: [] } },
} satisfies BoardDoc;

describe('@openshaper/board2 scaffold', () => {
  it('exports types only (the runtime export lists are pinned)', () => {
    expect(Object.keys(board2).sort()).toEqual(PUBLIC_VALUES);
    expect(Object.keys(classic).sort()).toEqual(CLASSIC_VALUES);
  });

  it('a BoardDoc is plain data: a JSON round trip is lossless', () => {
    const text = JSON.stringify(SAMPLE);
    expect(JSON.parse(text)).toEqual(SAMPLE);
    // Stable: serialising the parsed copy gives the same bytes.
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
  });

  it('pins the conventions the types encode', () => {
    expectTypeOf<RailLane>().toEqualTypeOf<
      'deckInset' | 'tuckInset' | 'apexHeight' | 'upperFullness' | 'lowerFullness' | 'edgeHardness'
    >();
    // Every band row but the apex may carry an offset (§6.1): the apex moves only
    // with the outline and the apex-height law.
    expectTypeOf<OffsetRow>().toEqualTypeOf<Exclude<BandRow, 'apex'>>();
    expectTypeOf<'apex'>().not.toExtend<OffsetRow>();
    expectTypeOf<Symmetry>().toEqualTypeOf<'mirror-y' | 'none'>();
    expectTypeOf<TailSpec['kind']>().toEqualTypeOf<'standard'>();
    // Build parameters are part of the document, so a board rebuilds identically.
    expectTypeOf<BoardDoc['build']>().toEqualTypeOf<BuildParams>();
    // The classic entry starts from the kernel's board, whatever reader made it.
    expectTypeOf<ClassicBoard>().toEqualTypeOf<BezierBoard>();
    expectTypeOf<'station-crease'>().toExtend<DeviationCause>();
  });
});
