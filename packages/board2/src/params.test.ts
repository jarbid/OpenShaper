// SPDX-License-Identifier: GPL-3.0-or-later
/** Named parameters (§12.1) and their validation. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILD_PARAMS,
  DEFAULT_RAIL_LAWS,
  GEOM_TOLERANCE_KEYS,
  EDGE_FIT_KEYS,
  LAW_ROUNDING_REL,
  OFFSET_ROW_COMPONENTS,
  RAIL_LANES,
  laneRange,
  validateBuildParams,
} from './params';
import { DEFAULT_EDGE_FIT, DEFAULT_TOLERANCES } from '@openshaper/geom';
import type { BuildParams, RailLane } from './types';

const DEG = Math.PI / 180;
const clone = (): { -readonly [K in keyof BuildParams]: BuildParams[K] } =>
  JSON.parse(JSON.stringify(DEFAULT_BUILD_PARAMS));

describe('DEFAULT_BUILD_PARAMS', () => {
  it('is the §12.1 table, value for value', () => {
    expect(DEFAULT_BUILD_PARAMS).toEqual({
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
    });
  });

  it('is deeply frozen and valid', () => {
    expect(Object.isFrozen(DEFAULT_BUILD_PARAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BUILD_PARAMS.apexHeightRange)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BUILD_PARAMS.lawTolerance)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BUILD_PARAMS.tolerances)).toBe(true);
    expect(validateBuildParams(DEFAULT_BUILD_PARAMS)).toEqual([]);
  });

  it('the stated reasons hold: minInset is 1000 × geom fit; 0.1° is 1/1800 rad', () => {
    expect(DEFAULT_BUILD_PARAMS.minInset).toBeCloseTo(1000 * DEFAULT_TOLERANCES.fit, 12);
    expect(DEFAULT_BUILD_PARAMS.deckJoinAngleTol).toBeCloseTo(Math.PI / 1800, 15);
  });
});

describe('DEFAULT_RAIL_LAWS and lane ranges', () => {
  it('RAIL_LANES lists every lane of the type exactly once (the Record forces the compiler to agree)', () => {
    const every: Record<RailLane, true> = {
      deckInset: true,
      tuckInset: true,
      apexHeight: true,
      upperFullness: true,
      lowerFullness: true,
      edgeHardness: true,
    };
    expect([...RAIL_LANES].sort()).toEqual(Object.keys(every).sort());
    expect(Object.keys(DEFAULT_RAIL_LAWS).sort()).toEqual(Object.keys(every).sort());
  });

  it('every default lane value lies inside its lane range under the default parameters', () => {
    for (const lane of RAIL_LANES) {
      const [lo, hi] = laneRange(lane, DEFAULT_BUILD_PARAMS);
      expect(DEFAULT_RAIL_LAWS[lane], lane).toBeGreaterThanOrEqual(lo);
      expect(DEFAULT_RAIL_LAWS[lane], lane).toBeLessThanOrEqual(hi);
    }
  });

  it('lane ranges follow §5.1', () => {
    const b = DEFAULT_BUILD_PARAMS;
    expect(laneRange('deckInset', b)).toEqual([0.1, Infinity]);
    expect(laneRange('tuckInset', b)).toEqual([0.1, Infinity]);
    expect(laneRange('apexHeight', b)).toEqual([0.05, 0.95]);
    expect(laneRange('upperFullness', b)).toEqual([0.05, 1]);
    expect(laneRange('lowerFullness', b)).toEqual([0.05, 1]);
    expect(laneRange('edgeHardness', b)).toEqual([0, 1]);
  });

  it('fullness 2/3 is the parabola (§5.3)', () => {
    expect(DEFAULT_RAIL_LAWS.upperFullness).toBe(2 / 3);
  });

  it('offset components follow the structural rules of §3.5 and exclude the apex', () => {
    expect(OFFSET_ROW_COMPONENTS).toEqual({
      deckEdge: ['n'],
      deckHandle: ['l'],
      apexUpper: ['z'],
      apexLower: ['z'],
      tuckHandle: ['n', 'z'],
      tuck: ['n'],
    });
    expect('apex' in OFFSET_ROW_COMPONENTS).toBe(false);
  });

  it('the key lists track geom (no stale or missing names) and the rounding allowance is a few ε', () => {
    expect([...GEOM_TOLERANCE_KEYS]).toEqual(Object.keys(DEFAULT_TOLERANCES));
    expect([...EDGE_FIT_KEYS]).toEqual(Object.keys(DEFAULT_EDGE_FIT));
    expect(LAW_ROUNDING_REL).toBe(4 * Number.EPSILON);
  });
});

describe('validateBuildParams: every bound has a negative control', () => {
  const cases: [string, (p: ReturnType<typeof clone>) => void][] = [
    ['minInset 0', (p) => void (p.minInset = 0)],
    ['minInset NaN', (p) => void (p.minInset = Number.NaN)],
    ['insetCurvatureFraction 0', (p) => void (p.insetCurvatureFraction = 0)],
    ['insetCurvatureFraction 1', (p) => void (p.insetCurvatureFraction = 1)],
    ['minRailHeight negative', (p) => void (p.minRailHeight = -1)],
    ['apexHeightRange lo 0', (p) => void (p.apexHeightRange = [0, 0.9])],
    ['apexHeightRange hi 1', (p) => void (p.apexHeightRange = [0.1, 1])],
    ['apexHeightRange reversed', (p) => void (p.apexHeightRange = [0.9, 0.1])],
    ['fullnessRange lo 0', (p) => void (p.fullnessRange = [0, 1])],
    ['fullnessRange hi above 1', (p) => void (p.fullnessRange = [0.1, 1.1])],
    ['maxFrameTurn 0', (p) => void (p.maxFrameTurn = 0)],
    ['maxFrameTurn above π/2', (p) => void (p.maxFrameTurn = 2)],
    ['maxStationSpacing 0', (p) => void (p.maxStationSpacing = 0)],
    ['lawTolerance 0', (p) => void ((p.lawTolerance as Record<string, number>).apexHeight = 0)],
    ['deckJoinAngleTol π/2', (p) => void (p.deckJoinAngleTol = Math.PI / 2)],
    ['apexJoinAngleTol 0', (p) => void (p.apexJoinAngleTol = 0)],
    ['maxBandRefinePasses -1', (p) => void (p.maxBandRefinePasses = -1)],
    ['maxBandRefinePasses 1.5', (p) => void (p.maxBandRefinePasses = 1.5)],
    ['planMargin negative', (p) => void (p.planMargin = -0.1)],
    ['featureTol 0', (p) => void (p.featureTol = 0)],
    ['geom tolerance 0', (p) => void (p.tolerances = { fit: 0 })],
    ['geom tolerance count not an integer', (p) => void (p.tolerances = { newtonMaxIter: 2.5 })],
  ];
  for (const [name, mutate] of cases) {
    it(`rejects ${name} as doc-malformed`, () => {
      const p = clone();
      mutate(p);
      const issues = validateBuildParams(p);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.code === 'doc-malformed' && i.severity === 'error')).toBe(true);
    });
  }

  it('a geom tolerance failure carries the geom issue as its cause', () => {
    const p = clone();
    p.tolerances = { fit: -1 };
    expect(validateBuildParams(p)[0]!.cause).toMatchObject({ code: 'unsupported' });
  });

  it('accepts the boundary values (fullness hi = 1, a zero planMargin, zero refine passes)', () => {
    const p = clone();
    p.fullnessRange = [0.2, 1];
    p.planMargin = 0;
    p.maxBandRefinePasses = 0;
    p.maxFrameTurn = Math.PI / 2;
    expect(validateBuildParams(p)).toEqual([]);
  });
});
