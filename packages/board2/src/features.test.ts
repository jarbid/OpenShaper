// SPDX-License-Identifier: GPL-3.0-or-later
/** The feature closed forms and keyed depth curves: exact derivatives and checks. */
import { describe, expect, it } from 'vitest';
import {
  bump,
  bump1,
  bump2,
  featureDisplacement,
  featureIssues,
  featureTerm,
  keyedEvaluator,
  veeProfile,
  veeProfile1,
  veeProfile2,
} from './features';
import type { BottomFeature, KeyedCurve } from './types';

const depth: KeyedCurve = {
  keys: [
    { s: 10, value: 0 },
    { s: 30, value: 0.4 },
    { s: 50, value: 0.1 },
    { s: 70, value: 0 },
  ],
};

const fd1 = (f: (x: number) => number, x: number, h = 1e-5): number =>
  (f(x + h) - f(x - h)) / (2 * h);

describe('closed forms', () => {
  it('bump is zero with zero slope at its edges; derivatives match', () => {
    expect(bump(1)).toBe(0);
    expect(bump(-1)).toBe(0);
    expect(bump(0)).toBe(1);
    for (const t of [-0.8, -0.3, 0.2, 0.7]) {
      expect(bump1(t)).toBeCloseTo(fd1(bump, t), 6);
      expect(bump2(t)).toBeCloseTo(fd1(bump1, t), 6);
    }
  });

  it('the vee profile is C1 at r, flat at the stringer, 1 at the outline; derivatives match', () => {
    const r = 0.3;
    expect(veeProfile(0, r)).toBe(0);
    expect(veeProfile(1, r)).toBeCloseTo(1, 12);
    expect(veeProfile(r - 1e-9, r)).toBeCloseTo(veeProfile(r + 1e-9, r), 8);
    expect(veeProfile1(0, r)).toBe(0);
    for (const t of [0.1, 0.25, 0.5, 0.9]) {
      expect(veeProfile1(t, r)).toBeCloseTo(
        fd1((x) => veeProfile(x, r), t),
        6,
      );
      expect(veeProfile2(t, r)).toBeCloseTo(
        fd1((x) => veeProfile1(x, r), t),
        5,
      );
    }
  });
});

describe('keyedEvaluator', () => {
  const ev = keyedEvaluator(depth);
  const out = new Float64Array(3);

  it('is zero outside its keys, hits the keys, and has exact derivatives', () => {
    for (const x of [0, 10, 70, 100]) {
      ev(x, out, 0);
      expect(Array.from(out)).toEqual([0, 0, 0]);
    }
    ev(30, out, 0);
    expect(out[0]).toBeCloseTo(0.4, 12);
    for (const x of [14, 22, 40, 55, 63]) {
      ev(x, out, 0);
      const v = (y: number): number => {
        const o = new Float64Array(3);
        ev(y, o, 0);
        return o[0]!;
      };
      const d1 = (y: number): number => {
        const o = new Float64Array(3);
        ev(y, o, 0);
        return o[1]!;
      };
      expect(out[1]).toBeCloseTo(fd1(v, x), 6);
      expect(out[2]).toBeCloseTo(fd1(d1, x), 5);
    }
  });

  it('never leaves the range of its key values (monotone auto ease)', () => {
    for (let x = 10; x <= 70; x += 0.5) {
      ev(x, out, 0);
      expect(out[0]).toBeGreaterThanOrEqual(0);
      expect(out[0]).toBeLessThanOrEqual(0.4 + 1e-12);
    }
  });
});

describe('featureTerm', () => {
  const kinds: BottomFeature[] = [
    { kind: 'vee', id: 'v', enabled: true, depth, stringerRadius: 0.3 },
    { kind: 'concave', id: 'c', enabled: true, depth, layout: 'double', centre: 0.4, width: 0.3 },
    { kind: 'concave', id: 's', enabled: true, depth, layout: 'single', centre: 0, width: 0.6 },
    {
      kind: 'channels',
      id: 'h',
      enabled: true,
      depth,
      count: 2,
      width: 0.8,
      pitch: 1.2,
      railInset: 3,
    },
  ];
  // an arbitrary smooth chord length ℓ(ξ) = 20 + 0.1 ξ − 0.001 ξ²
  const ell = (x: number): number => 20 + 0.1 * x - 0.001 * x * x;
  const ell1 = (x: number): number => 0.1 - 0.002 * x;
  const ell2 = -0.002;

  it.each(kinds.map((f) => [f.id, f] as const))(
    '%s: value and partials match finite differences',
    (_id, f) => {
      const A = (x: number): number => 0.3 * Math.sin(x / 20);
      const A1 = (x: number): number => (0.3 / 20) * Math.cos(x / 20);
      const A2 = (x: number): number => (-0.3 / 400) * Math.sin(x / 20);
      const t = new Float64Array(6);
      const val = (x: number, u: number): number => {
        featureTerm(f, A(x), A1(x), A2(x), u, ell(x), ell1(x), ell2, t);
        return t[0]!;
      };
      const partial = (x: number, u: number, k: number): number => {
        featureTerm(f, A(x), A1(x), A2(x), u, ell(x), ell1(x), ell2, t);
        return t[k]!;
      };
      const h = 1e-6;
      for (const [x, u] of [
        [33, 0.45],
        [47, 0.8],
        [61, 0.2],
        [28, 0.93],
      ] as const) {
        expect(val(x, u)).toBeCloseTo(featureDisplacement(f, A(x), u, ell(x)), 12);
        const near = (a: number, b: number): void => {
          expect(Math.abs(a - b)).toBeLessThan(1e-6 * Math.max(1, Math.abs(a), Math.abs(b)));
        };
        near(
          partial(x, u, 1),
          fd1((y) => val(y, u), x, h),
        );
        near(
          partial(x, u, 2),
          fd1((v) => val(x, v), u, h),
        );
        near(
          partial(x, u, 3),
          fd1((y) => partial(y, u, 1), x, h),
        );
        near(
          partial(x, u, 4),
          fd1((v) => partial(x, v, 1), u, h),
        );
        near(
          partial(x, u, 5),
          fd1((v) => partial(x, v, 2), u, h),
        );
      }
    },
  );
});

describe('featureIssues', () => {
  const ctx = { xiMin: 0, xiMax: 100, minChord: () => 20 };
  const vee = (d: KeyedCurve): BottomFeature => ({
    kind: 'vee',
    id: 'v',
    enabled: true,
    depth: d,
    stringerRadius: 0.3,
  });

  it('accepts a sound feature and ignores a disabled one', () => {
    expect(featureIssues([vee(depth)], ctx)).toEqual([]);
    expect(featureIssues([{ ...vee({ keys: [] }), enabled: false }], ctx)).toEqual([]);
  });

  it('refuses malformed depths', () => {
    const msgs = (d: KeyedCurve): string =>
      featureIssues([vee(d)], ctx)
        .map((i) => i.message)
        .join('|');
    expect(msgs({ keys: [{ s: 1, value: 0 }] })).toContain('at least two keys');
    expect(
      msgs({
        keys: [
          { s: 5, value: 0 },
          { s: 5, value: 0 },
        ],
      }),
    ).toContain('strictly greater');
    expect(
      msgs({
        keys: [
          { s: 5, value: 0.2 },
          { s: 9, value: 0 },
        ],
      }),
    ).toContain('start and end at 0');
    expect(
      msgs({
        keys: [
          { s: -5, value: 0 },
          { s: 9, value: 0 },
        ],
      }),
    ).toContain('strictly inside');
    expect(
      msgs({
        keys: [
          { s: 5, value: 0, out: { ds: 4, dv: 0 } },
          { s: 9, value: 0, in: { ds: 4, dv: 0 } },
        ],
      }),
    ).toContain('exceeds the segment length');
  });
});
