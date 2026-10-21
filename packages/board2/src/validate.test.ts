// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `validateBoard`: the structural and range part (step S1) and the plan-loop,
 * height-field symmetry and domain checks (step S2). Every code it can emit has
 * a negative control and, where a bound is involved, a boundary control on the
 * accepted side. The S1 checks are exact comparisons; the S2 bounds are the
 * documented ones (`Tolerances.point` for the tail, the plan radius measured to
 * 1e-10 relative, so its boundary controls sit 1e-9 either side). The S3 band
 * checks (insets, rail height, profiles, inset loops) each get a board that
 * breaks exactly one of them, located at a σ where the code has one.
 */
import { curvePoint } from '@openshaper/geom';
import { checksum, mulberry32 } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { reviveBoardDoc } from './doc';
import { RAIL_LANES } from './params';
import { planCurve } from './plan';
import {
  constantLaw,
  notchedLoopFixture,
  offKnotLoop,
  sampleDoc,
  stadiumBoard,
} from './testing/index';
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

/**
 * The codes of the band's geometric checks (step S3, `bandChecks`): whether the
 * columns of a board can be built. The law tests below judge the law rules
 * (keys, tips, the range certificate) on their own, so they drop these: a law
 * at the end of its range is accepted by the certificate even where the sample
 * board's shape cannot carry it (an inset of 1000 cm, an apex at 95 % on its
 * sloped deck), which the band checks then report.
 */
const BAND_CODES: ReadonlySet<string> = new Set([
  'inset-invalid',
  'inset-loop-invalid',
  'rail-height',
  'rail-profile-invalid',
]);
const lawCodes = (d: BoardDoc): string[] => codes(d).filter((c) => !BAND_CODES.has(c));

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
      expect(lawCodes(at(lo)), `${lane} at ${lo}`).toEqual([]);
      expect(lawCodes(at(hi)), `${lane} at ${hi}`).toEqual([]);
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
    expect(lawCodes(d)).toEqual([]);
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

describe('validateBoard: the plan loop (§3.3 invariants 1–4, step S2)', () => {
  const stadium = (): Mutable<BoardDoc> => stadiumBoard() as Mutable<BoardDoc>;
  const withPlan = (d: Mutable<BoardDoc>, points: number[], knots?: number[]): BoardDoc => {
    d.plan = { ...d.plan, points, ...(knots === undefined ? {} : { knots }) };
    return d;
  };

  it('the stadium, the sample and the notched-loop board: only the notch is refused', () => {
    expect(validateBoard(stadiumBoard())).toEqual([]);
    expect(validateBoard(sampleDoc())).toEqual([]);
    const d = stadium();
    d.plan = notchedLoopFixture();
    const wide = { ...d.deck, x: [-12, 190] as const };
    d.deck = wide;
    d.bottom = { ...d.bottom, x: [-12, 190] as const };
    const issues = validateBoard(d);
    expect(issues.map((i) => i.code)).toEqual(['tail-not-standard']);
    expect(issues[0]!.at!.u!).toBeLessThan(1e-12);
  });

  it('invariant 1: tail at the origin within Tolerances.point (boundary and negative control)', () => {
    const shift = (dx: number): BoardDoc => {
      const d = stadium();
      return withPlan(
        d,
        d.plan.points.map((v, i) => (i % 2 === 0 ? v + dx : v)),
      );
    };
    expect(codes(shift(0.5e-6))).toEqual([]);
    const off = validateBoard(shift(0.01));
    expect(off.map((i) => i.code)).toEqual(['tail-not-at-origin']);
    expect(off[0]!.value!).toBeCloseTo(0.01, 12);
  });

  it('invariant 2: a straight transom is tail-not-standard', () => {
    const d = stadium();
    // Collinear vertical control points at the tail: Q_{-1}, Q_0, Q_1 on x = x(Q_0)
    // with Q_±2 too, so the tail span is a vertical segment.
    const n = d.plan.knots.length;
    const pts = [...d.plan.points];
    const q = (k: number): number => (((k + n) % n) - 2 + n) % n; // Greville index k → stored index
    for (const k of [-2, -1, 1, 2]) pts[2 * q(k)] = pts[2 * q(0)]!;
    const issues = validateBoard(withPlan(d, pts));
    expect(issues.map((i) => i.code)).toContain('tail-not-standard');
  });

  it('invariant 3: the plan radius against minInset / insetCurvatureFraction', () => {
    // The stadium's tightest radius is ρ(1 + cos 22.5°)/2 at the arc knots.
    const rMin = (25 * (1 + Math.cos(Math.PI / 8))) / 2;
    const at = (limit: number): BoardDoc => {
      const d = stadium();
      d.build = { ...d.build, minInset: limit * d.build.insetCurvatureFraction };
      // Keep the laws inside the (raised) inset range so only the radius speaks.
      for (const lane of ['deckInset', 'tuckInset'] as const) {
        (d.laws as Record<RailLane, LawCurve>)[lane] = constantLaw(limit);
      }
      return d;
    };
    expect(codes(at(rMin * (1 - 1e-9)))).toEqual([]);
    const issues = validateBoard(at(rMin * (1 + 1e-9)));
    expect(issues.map((i) => i.code)).toEqual(['plan-radius']);
    expect(Math.abs(issues[0]!.value! - rMin) / rMin).toBeLessThanOrEqual(1e-10);
  });

  it('invariant 4: one ulp off a partner, or an asymmetric knot set, is symmetry-broken', () => {
    const d = stadium();
    const pts = [...d.plan.points];
    pts[0] = pts[0]! * (1 + 2 * Number.EPSILON);
    expect(codes(withPlan(d, pts))).toEqual(['symmetry-broken']);
    const e = stadium();
    const knots = [...e.plan.knots];
    knots[3] = knots[3]! + 1e-4;
    expect(codes(withPlan(e, [...e.plan.points], knots))).toContain('symmetry-broken');
  });

  it('corners and repeated knots are plan-corner (decision 4: C² in Phase 2)', () => {
    const d = sampleDoc() as Mutable<BoardDoc>;
    const twice = validateBoard(
      withPlan(d, [...d.plan.points], [0, 0.25, 0.25, 0.375, 0.5, 0.625, 0.75, 0.75]),
    );
    const c = twice.filter((i) => i.code === 'plan-corner');
    expect(c.map((i) => [i.at?.u, i.value])).toEqual([
      [0.25, 2],
      [0.75, 2],
    ]);
    const e = sampleDoc() as Mutable<BoardDoc>;
    const corner = validateBoard(
      withPlan(e, [...e.plan.points], [0, 0.25, 0.25, 0.25, 0.5, 0.75, 0.75, 0.75]),
    ).filter((i) => i.code === 'plan-corner');
    expect(corner.map((i) => i.value)).toEqual([3, 3]);
    expect(corner[0]!.message).toMatch(/corner/);
  });

  it('a clockwise loop is doc-malformed (decision 3), although its tail is standard', () => {
    const d = stadium();
    const flipped = withPlan(
      d,
      d.plan.points.map((v, i) => (i % 2 === 1 ? -v : v)),
    );
    expect(codes(flipped)).toEqual(['doc-malformed']);
  });

  it('a figure-8 loop (a half crossing the stringer) is doc-malformed; every other check passes', () => {
    // Bend the −y straight side (Greville Q_5 … Q_18) across y = 0 and keep the +y
    // half its exact mirror: x′ keeps its sign, the pairing stays bitwise and the
    // signed area stays positive, but the −y half reaches y > 0 on (0, ½).
    const d = stadium();
    const n = d.plan.knots.length;
    const pts = [...d.plan.points];
    const q = (k: number): number => (((k + n) % n) - 2 + n) % n; // Greville index → stored
    for (let k = 5; k <= 18; k++) {
      const y = -25 + 33 * Math.sin((Math.PI * (k - 4)) / 15) ** 2;
      pts[2 * q(k) + 1] = y;
      pts[2 * q(n - k) + 1] = -y;
    }
    const issues = validateBoard(withPlan(d, pts));
    expect(issues.map((i) => i.code)).toEqual(['doc-malformed']);
    const u = issues[0]!.at!.u!;
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(0.5);
    // The reported u is on the wrong side (independent evaluation by geom).
    expect(curvePoint(planCurve(d.plan), u).y).toBeGreaterThan(0);
  });

  it('valid loops on non-uniform knot sets without knots at u = 0 or ½ pass', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const d = stadium();
      d.plan = offKnotLoop(mulberry32(seed));
      // Insets the loops' narrow tips can carry (S3's band checks): with the default
      // 5.25 cm deck inset some noses are narrower than twice the inset, and the
      // two sides' deck edges cross (seed 13, `inset-loop-invalid`).
      d.laws = { ...d.laws, deckInset: constantLaw(2), tuckInset: constantLaw(1) };
      expect(d.plan.knots.some((t) => t === 0 || t === 0.5)).toBe(false);
      expect(validateBoard(d), `seed ${seed}`).toEqual([]);
    }
  });

  it('the plan loop must lie inside both height fields (domain-too-small, located at the face)', () => {
    const d = stadium();
    d.deck = { ...d.deck, x: [0.5, d.deck.x[1]] };
    const issues = validateBoard(d);
    expect(issues.map((i) => [i.code, i.at?.face])).toEqual([['domain-too-small', 'deck']]);
    const e = stadium();
    e.bottom = { ...e.bottom, y: [-24, 24] };
    expect(validateBoard(e).map((i) => [i.code, i.at?.face])).toEqual([
      ['domain-too-small', 'bottom'],
    ]);
  });

  it('height fields in symmetric mode: a broken pair is symmetry-broken at its face', () => {
    const d = stadium();
    const z = [...d.bottom.z];
    z[0] = 0.25;
    d.bottom = { ...d.bottom, z };
    expect(validateBoard(d).map((i) => [i.code, i.at?.face])).toEqual([
      ['symmetry-broken', 'bottom'],
    ]);
  });

  it('a hand-typed plan geom refuses is doc-malformed, never a throw; nothing else cascades', () => {
    const d = stadium();
    d.plan = { degree: 3, knots: [0, 0.5], points: [0, 0, 1, 1] };
    let issues: ReturnType<typeof validateBoard> = [];
    expect(() => {
      issues = validateBoard(d);
    }).not.toThrow();
    expect(issues.map((i) => i.code)).toEqual(['doc-malformed']);
    expect(issues[0]!.cause?.code).toBeDefined();
  });

  it('symmetry "none" and a non-standard tail skip the checks they own (no cascade)', () => {
    const d = stadium();
    d.plan = notchedLoopFixture();
    d.deck = { ...d.deck, x: [-12, 190] };
    d.bottom = { ...d.bottom, x: [-12, 190] };
    (d as { tail: unknown }).tail = { kind: 'notched' };
    expect(codes(d)).toEqual(['tail-not-standard']);
    const e = stadium();
    e.symmetry = 'none';
    const pts = [...e.plan.points];
    pts[0] = pts[0]! + 1e-3; // asymmetric now, but symmetry is not checked
    expect(codes(withPlan(e, pts))).toEqual(['asymmetric-unsupported']);
  });
});

describe('validateBoard: the band checks (step S3)', () => {
  it('an edge offset that takes the deck inset below minInset is inset-invalid, located', () => {
    const d = stadiumBoard() as Mutable<BoardDoc>;
    d.offsets = {
      basis: { degree: 3, knots: [0, 0.25, 0.5, 0.75] },
      rows: [{ row: 'deckEdge', values: [-5.2, -5.2, -5.2, -5.2] }],
    };
    const issues = validateBoard(d);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(['inset-invalid']));
    expect(issues[0]!.at?.lane).toBe('deckInset');
    expect(issues[0]!.value).toBeCloseTo(0.05, 9);
  });

  it('a deck 0.05 cm above the bottom is rail-height', () => {
    const issues = validateBoard(stadiumBoard({ thickness: 0.05 }));
    expect(issues.map((i) => i.code)).toContain('rail-height');
    expect(issues.find((i) => i.code === 'rail-height')!.at?.sigma).toBeTypeOf('number');
  });

  it('a crowned deck that falls below a high apex is rail-profile-invalid', () => {
    // Crown 3 cm: at the deck edge the deck falls ~0.19 per cm outwards, more than the
    // 5 % of the rail left above an apex at 95 %.
    const d = stadiumBoard({ crown: 3 }) as Mutable<BoardDoc>;
    expect(validateBoard(d)).toEqual([]);
    d.laws = { ...d.laws, apexHeight: constantLaw(0.95) };
    const issues = validateBoard(d);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(['rail-profile-invalid']));
  });

  it('a deck inset wider than the half-width crosses the stringer: inset-loop-invalid', () => {
    const d = stadiumBoard() as Mutable<BoardDoc>;
    d.laws = { ...d.laws, deckInset: constantLaw(26) };
    const issues = validateBoard(d);
    expect(issues.map((i) => i.code)).toContain('inset-loop-invalid');
    const i = issues.find((x) => x.code === 'inset-loop-invalid')!;
    expect(i.at).toMatchObject({ face: 'deck', row: 'deckEdge' });
    expect(i.cause?.code).toBeDefined();
    // The tuck loop at the default 2 cm is fine: only the deck edge is reported.
    expect(issues.filter((x) => x.code === 'inset-loop-invalid')).toHaveLength(1);
  });

  it('a malformed offset layer on an unrevived document is doc-malformed, never a throw', () => {
    const basis = { degree: 3, knots: [0, 0.25, 0.5, 0.75] };
    const cases: readonly (readonly [BoardDoc['offsets'], string])[] = [
      [{ basis, rows: [{ row: 'apexUpper', values: [0, 0] }] }, 'needs 4 × 1 = 4 values'],
      [{ basis, rows: [{ row: 'apexUpper', values: [0, NaN, 0, 0] }] }, 'not finite'],
      [
        {
          basis,
          rows: [
            { row: 'tuck', values: [0, 0, 0, 0] },
            { row: 'tuck', values: [0, 0, 0, 0] },
          ],
        },
        'appears twice',
      ],
      [{ basis: { degree: 3, knots: [0.5, 0.25] }, rows: [] }, 'basis'],
      [{ basis: null, rows: [{ row: 'tuck', values: [] }] }, 'must be empty'],
    ];
    for (const [offsets, what] of cases) {
      const d = { ...sampleDoc(), offsets };
      let issues: ReturnType<typeof validateBoard> = [];
      expect(() => {
        issues = validateBoard(d);
      }, what).not.toThrow();
      expect(
        issues.map((i) => i.code),
        what,
      ).toEqual(['doc-malformed']);
      expect(issues[0]!.message, what).toContain(what);
    }
  });

  it('band checks run only on a document without errors (no cascade)', () => {
    const d = stadiumBoard({ thickness: 0.05 }) as Mutable<BoardDoc>;
    d.laws = { ...d.laws, apexHeight: constantLaw(2) };
    expect(codes(d)).toEqual(['law-out-of-range']);
  });
});
