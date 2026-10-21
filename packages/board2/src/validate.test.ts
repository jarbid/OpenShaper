// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `validateBoard`, structural and range part (step S1). Every code it can emit
 * has a negative control and, where a bound is involved, a boundary control on
 * the accepted side; the checks are exact comparisons, so no tolerance applies.
 */
import { checksum } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { reviveBoardDoc } from './doc';
import { RAIL_LANES } from './params';
import { constantLaw, sampleDoc } from './testing/sample-doc';
import { validateBoard } from './validate';
import type { BoardDoc, BottomFeature, LawCurve, RailLane } from './types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const edit = (
  f: (d: Mutable<BoardDoc> & { laws: Record<RailLane, LawCurve> }) => void,
): BoardDoc => {
  const d = sampleDoc() as Mutable<BoardDoc> & { laws: Record<RailLane, LawCurve> };
  f(d);
  return d;
};
const codes = (d: BoardDoc): string[] => validateBoard(d).map((i) => i.code);

describe('validateBoard: a valid document', () => {
  it('has no issues, before and after a JSON revive (also frozen)', () => {
    expect(validateBoard(sampleDoc())).toEqual([]);
    const r = reviveBoardDoc(JSON.parse(JSON.stringify(sampleDoc())));
    expect(r.ok && validateBoard(r.value)).toEqual([]);
  });

  it('never throws on invalid build tolerances; reports them instead', () => {
    const d = edit((x) => {
      x.build = { ...x.build, tolerances: { paramRel: -1 } };
    });
    let issues: ReturnType<typeof validateBoard> = [];
    expect(() => {
      issues = validateBoard(d);
    }).not.toThrow();
    expect(issues.map((i) => i.code)).toContain('doc-malformed');
  });

  it('does not mutate the document', () => {
    const d = sampleDoc();
    const before = checksum(d);
    validateBoard(d);
    expect(checksum(d)).toBe(before);
  });
});

describe('validateBoard: document, symmetry and tail rules', () => {
  it('format and version', () => {
    expect(codes(edit((d) => void ((d as { format: string }).format = 'x')))).toEqual([
      'doc-malformed',
    ]);
    expect(codes(edit((d) => void ((d as { version: number }).version = 2)))).toEqual([
      'doc-version',
    ]);
  });

  it('symmetry "none" is asymmetric-unsupported (Phase 6), with no cascade of other issues', () => {
    expect(codes(edit((d) => void (d.symmetry = 'none')))).toEqual(['asymmetric-unsupported']);
  });

  it('a tail other than standard is tail-not-standard', () => {
    expect(codes(edit((d) => void ((d as { tail: unknown }).tail = { kind: 'notched' })))).toEqual([
      'tail-not-standard',
    ]);
  });

  it('a full-domain law on a symmetric board is symmetry-broken, located at its lane', () => {
    const d = edit((x) => {
      x.laws.edgeHardness = {
        domain: 'full',
        keys: [
          { s: 0, value: 0.5 },
          { s: 0.5, value: 0.5 },
        ],
      };
    });
    const issues = validateBoard(d);
    expect(issues.map((i) => i.code)).toEqual(['symmetry-broken']);
    expect(issues[0]!.at).toEqual({ lane: 'edgeHardness' });
  });
});

describe('validateBoard: rail laws', () => {
  it('key faults carry their lane and key', () => {
    const d = edit((x) => {
      x.laws.apexHeight = {
        domain: 'half',
        keys: [
          { s: 0, value: 0.4 },
          { s: 0.3, value: 0.4 },
          { s: 0.2, value: 0.4 },
          { s: 0.5, value: 0.4 },
        ],
      };
    });
    const issues = validateBoard(d);
    expect(issues.map((i) => i.code)).toEqual(['law-keys-unsorted']);
    expect(issues[0]!.at).toMatchObject({ lane: 'apexHeight', key: 2 });
  });

  it('a sloped tail tip is law-tip-slope', () => {
    const d = edit((x) => {
      x.laws.upperFullness = {
        domain: 'half',
        keys: [
          { s: 0, value: 0.6, out: { ds: 0.1, dv: 0.1 } },
          { s: 0.5, value: 0.6 },
        ],
      };
    });
    expect(codes(d)).toEqual(['law-tip-slope']);
  });

  const bounds: [RailLane, number, number][] = [
    // lane, lowest accepted value, highest accepted value
    ['deckInset', 0.1, 1000],
    ['tuckInset', 0.1, 1000],
    ['apexHeight', 0.05, 0.95],
    ['upperFullness', 0.05, 1],
    ['lowerFullness', 0.05, 1],
    ['edgeHardness', 0, 1],
  ];
  for (const [lane, lo, hi] of bounds) {
    it(`${lane}: the range ends are accepted, a step outside is law-out-of-range`, () => {
      const at = (v: number): BoardDoc => edit((d) => void (d.laws[lane] = constantLaw(v)));
      expect(codes(at(lo)), `${lane} at ${lo}`).toEqual([]);
      expect(codes(at(hi)), `${lane} at ${hi}`).toEqual([]);
      const below = validateBoard(at(lo - 0.01));
      expect(below.map((i) => i.code)).toEqual(['law-out-of-range']);
      expect(below[0]!.at).toMatchObject({ lane, key: 0 });
      expect(below[0]!.value).toBeCloseTo(lo - 0.01, 12);
      if (Number.isFinite(hi) && hi < 100) {
        expect(codes(at(hi + 0.01))).toEqual(['law-out-of-range']);
      }
    });
  }

  it("the ranges come from the document's own build parameters", () => {
    const d = edit((x) => {
      x.laws.deckInset = constantLaw(0.5);
      (x.build as Mutable<typeof x.build>).minInset = 1;
    });
    expect(codes(d)).toEqual(['law-out-of-range']);
    const widened = edit((x) => {
      x.laws.apexHeight = constantLaw(0.97);
      (x.build as Mutable<typeof x.build>).apexHeightRange = [0.05, 0.99];
    });
    expect(codes(widened)).toEqual([]);
  });

  it('an overshooting ease handle is flagged although every key is in range', () => {
    const d = edit((x) => {
      x.laws.apexHeight = {
        domain: 'half',
        keys: [
          { s: 0, value: 0.4 },
          { s: 0.25, value: 0.4, out: { ds: 0.05, dv: 0.7 } },
          { s: 0.5, value: 0.4 },
        ],
      };
    });
    const issues = validateBoard(d);
    expect(issues.map((i) => i.code)).toEqual(['law-out-of-range']);
    expect(issues[0]!.at).toMatchObject({ lane: 'apexHeight', key: 1 });
    expect(issues[0]!.value).toBeCloseTo(1.1, 14);
  });

  it('a smooth in-range law with several keys passes (auto ease cannot overshoot)', () => {
    const d = edit((x) => {
      x.laws.apexHeight = {
        domain: 'half',
        keys: [
          { s: 0, value: 0.95 },
          { s: 0.1, value: 0.05 },
          { s: 0.3, value: 0.95 },
          { s: 0.5, value: 0.05 },
        ],
      };
    });
    expect(codes(d)).toEqual([]);
  });

  it('reports every lane at once', () => {
    const d = edit((x) => {
      for (const lane of RAIL_LANES) x.laws[lane] = constantLaw(-5);
    });
    expect(validateBoard(d).filter((i) => i.code === 'law-out-of-range')).toHaveLength(
      RAIL_LANES.length,
    );
  });
});

describe('validateBoard: build parameters', () => {
  it('a bad parameter is doc-malformed from validateBoard as well as the standalone check', () => {
    const d = edit((x) => void ((x.build as Mutable<typeof x.build>).minRailHeight = 0));
    expect(codes(d)).toEqual(['doc-malformed']);
  });
});

describe('validateBoard: bottom features', () => {
  const concave = (
    over: Partial<Extract<BottomFeature, { kind: 'concave' }>> = {},
  ): BottomFeature => ({
    kind: 'concave',
    id: 'c',
    enabled: true,
    layout: 'single',
    centre: 0,
    width: 0.8,
    depth: {
      keys: [
        { s: 40, value: 0 },
        { s: 100, value: 0.3 },
        { s: 160, value: 0 },
      ],
    },
    ...over,
  });
  const withFeatures = (...f: BottomFeature[]): BoardDoc => edit((d) => void (d.features = f));
  const featureCodes = (d: BoardDoc): string[] => validateBoard(d).map((i) => i.code);

  it('valid vee, single and double concave, channels', () => {
    const depth = concave().depth;
    expect(
      featureCodes(
        withFeatures(
          { kind: 'vee', id: 'v', enabled: true, depth, stringerRadius: 0.1 },
          concave(),
          concave({ id: 'd', layout: 'double', centre: 0.5, width: 0.4 }),
          {
            kind: 'channels',
            id: 'ch',
            enabled: false,
            depth,
            count: 4,
            width: 0.3,
            pitch: 1,
            railInset: 2,
          },
        ),
      ),
    ).toEqual([]);
  });

  it('negative controls: each parameter bound is feature-invalid, located at its feature', () => {
    const depth = concave().depth;
    const bad: [string, BottomFeature][] = [
      ['vee radius 0', { kind: 'vee', id: 'x', enabled: true, depth, stringerRadius: 0 }],
      ['vee radius above 1', { kind: 'vee', id: 'x', enabled: true, depth, stringerRadius: 1.2 }],
      ['concave width 0', concave({ id: 'x', width: 0 })],
      ['concave width above 1', concave({ id: 'x', width: 1.1 })],
      ['single concave off-centre', concave({ id: 'x', centre: 0.2 })],
      [
        'double concave bumps overlap',
        concave({ id: 'x', layout: 'double', centre: 0.2, width: 0.4 }),
      ],
      [
        'double concave reaches the tuck',
        concave({ id: 'x', layout: 'double', centre: 0.7, width: 0.4 }),
      ],
      ['double concave centre 0', concave({ id: 'x', layout: 'double', centre: 0, width: 0.4 })],
      [
        'channels count 0',
        {
          kind: 'channels',
          id: 'x',
          enabled: true,
          depth,
          count: 0,
          width: 0.3,
          pitch: 1,
          railInset: 2,
        },
      ],
      [
        'channels width 0',
        {
          kind: 'channels',
          id: 'x',
          enabled: true,
          depth,
          count: 2,
          width: 0,
          pitch: 1,
          railInset: 2,
        },
      ],
      [
        'channels pitch below width',
        {
          kind: 'channels',
          id: 'x',
          enabled: true,
          depth,
          count: 2,
          width: 2,
          pitch: 1,
          railInset: 2,
        },
      ],
      [
        'channels railInset negative',
        {
          kind: 'channels',
          id: 'x',
          enabled: true,
          depth,
          count: 2,
          width: 0.3,
          pitch: 1,
          railInset: -1,
        },
      ],
      [
        'depth keys unsorted',
        concave({
          id: 'x',
          depth: {
            keys: [
              { s: 100, value: 0 },
              { s: 40, value: 1 },
            ],
          },
        }),
      ],
      ['depth with one key', concave({ id: 'x', depth: { keys: [{ s: 100, value: 0 }] } })],
    ];
    for (const [name, f] of bad) {
      const issues = validateBoard(withFeatures(f));
      expect(issues.length, name).toBeGreaterThan(0);
      expect(
        issues.every((i) => i.code === 'feature-invalid' && i.at?.feature === 'x'),
        name,
      ).toBe(true);
    }
  });

  it('boundary controls: double concave bumps that touch each other and the tuck are accepted', () => {
    expect(
      featureCodes(withFeatures(concave({ layout: 'double', centre: 0.5, width: 0.5 }))),
    ).toEqual([]);
    expect(featureCodes(withFeatures(concave({ width: 1 })))).toEqual([]);
  });

  it('duplicate ids are reported on the second feature', () => {
    const issues = validateBoard(withFeatures(concave(), concave()));
    expect(issues.map((i) => i.code)).toEqual(['feature-invalid']);
    expect(issues[0]!.message).toContain('more than one feature');
  });

  it('a document with NaN everywhere does not throw and is refused', () => {
    const d = edit((x) => {
      x.laws.apexHeight = constantLaw(Number.NaN);
      x.features = [concave({ width: Number.NaN })];
    });
    const issues = validateBoard(d);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });
});
