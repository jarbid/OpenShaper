// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The `@openshaper/geom/testing` subpath: pinned export list, a deterministic
 * PRNG with its published first values, and a checksum that sees every bit.
 */
import { describe, expect, it } from 'vitest';
import * as testing from './index';
import { checksum, mulberry32, randomClampedBasis, randomPeriodicBasis } from './index';

describe('@openshaper/geom/testing', () => {
  it('exports exactly the pinned runtime values', () => {
    expect(Object.keys(testing).sort()).toEqual(
      [
        'checksum',
        'mulberry32',
        'randomClampedBasis',
        'randomCurve',
        'randomPeriodicBasis',
        'randomSurface',
      ].sort(),
    );
  });

  it('mulberry32 is deterministic, in [0, 1), and matches the reference values', () => {
    const r = mulberry32(1);
    expect([r(), r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('checksum changes with any bit and ignores key order', () => {
    const base = { a: Float64Array.of(1, 2, 3), b: [1, 'x', { c: true }] };
    const same = { b: [1, 'x', { c: true }], a: Float64Array.of(1, 2, 3) };
    expect(checksum(base)).toBe(checksum(same));
    const flipped = Float64Array.of(1, 2, 3);
    new Uint8Array(flipped.buffer)[0]! ^= 1; // one bit of the first double
    expect(checksum({ ...base, a: flipped })).not.toBe(checksum(base));
    expect(checksum(0)).not.toBe(checksum(-0));
    expect(checksum(Float32Array.of(1))).not.toBe(checksum(Float64Array.of(1)));
    expect(checksum({ a: 1 })).not.toBe(checksum({ b: 1 }));
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => checksum(cyc)).toThrow();
  });

  it('random bases are valid and respect the requested spacing', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const p = 1 + (i % 5);
      const b = randomClampedBasis(rng, p, p + 1 + (i % 9), { maxMult: p, minSpacing: 0.04 });
      const U = b.knots;
      for (let k = 1; k < U.length; k++) {
        if (U[k] !== U[k - 1]) expect(U[k]! - U[k - 1]!).toBeGreaterThanOrEqual(0.04 * (1 - 1e-12));
      }
      const pb = randomPeriodicBasis(rng, p, p + 1 + (i % 9), { maxMult: p });
      expect(pb.count).toBe(p + 1 + (i % 9));
    }
  });
});
