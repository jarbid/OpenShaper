// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact predicates (design §12, §16 "predicates"). Oracle: the exact sign of the
 * determinant in BigInt arithmetic. Every finite double is a dyadic rational
 * `m · 2^e`; scaling all inputs by a common power of two makes them integers,
 * and the determinants are then evaluated exactly. Tolerance: none (the sign
 * must agree exactly).
 *
 * Inputs: random, nearly collinear / cocircular with 1-ulp perturbations,
 * exactly cocircular lattice points, and large offsets (1e6 + small), the
 * cases where the naive formula gets the sign wrong (checked below, so the
 * suite would fail if the wrappers fell back to it).
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../testing';
import { incircle, makePredicates, orient2d } from './predicates';

/** `x = m · 2^e` exactly. */
function exact(x: number): { m: bigint; e: number } {
  if (x === 0) return { m: 0n, e: 0 };
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (bexp === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = bexp - 1075;
  }
  return { m: sign * mant, e };
}

/** The values as integers at a common scale `2^E` (E the smallest exponent). */
function scaled(xs: readonly number[]): bigint[] {
  const es = xs.map(exact);
  const E = Math.min(...es.map((v) => (v.m === 0n ? Infinity : v.e)));
  return es.map((v) => (v.m === 0n ? 0n : v.m << BigInt(v.e - E)));
}

const sgn = (x: bigint): number => (x > 0n ? 1 : x < 0n ? -1 : 0);
/** Sign as −1, 0 or 1 (`Math.sign` keeps −0). */
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

function orientExact(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const [AX, AY, BX, BY, CX, CY] = scaled([ax, ay, bx, by, cx, cy]) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  return sgn((AX - CX) * (BY - CY) - (AY - CY) * (BX - CX));
}

function incircleExact(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const [AX, AY, BX, BY, CX, CY, DX, DY] = scaled([ax, ay, bx, by, cx, cy, dx, dy]) as bigint[] as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const adx = AX - DX;
  const ady = AY - DY;
  const bdx = BX - DX;
  const bdy = BY - DY;
  const cdx = CX - DX;
  const cdy = CY - DY;
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;
  return sgn(
    alift * (bdx * cdy - cdx * bdy) +
      blift * (cdx * ady - adx * cdy) +
      clift * (adx * bdy - bdx * ady),
  );
}

/** `x` moved by |k| ulps towards +∞ (k > 0) or −∞ (k < 0); `x ≠ 0`. */
function ulps(x: number, k: number): number {
  const dv = new DataView(new ArrayBuffer(8));
  let y = x;
  for (let i = 0; i < Math.abs(k); i++) {
    dv.setFloat64(0, y);
    const bits = dv.getBigUint64(0);
    const up = k > 0 === y > 0;
    dv.setBigUint64(0, up ? bits + 1n : bits - 1n);
    y = dv.getFloat64(0);
  }
  return y;
}

const naiveOrient = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number => sign((ax - cx) * (by - cy) - (ay - cy) * (bx - cx));

describe('orient2d', () => {
  it('is positive for counter-clockwise triples (y up), negative clockwise, zero collinear', () => {
    expect(orient2d(0, 0, 1, 0, 0, 1)).toBeGreaterThan(0);
    expect(orient2d(0, 0, 0, 1, 1, 0)).toBeLessThan(0);
    expect(orient2d(0, 0, 1, 1, 2, 2)).toBe(0);
    expect(makePredicates().orient2d(0, 0, 1, 0, 0, 1)).toBeGreaterThan(0);
  });

  it('matches the exact BigInt sign on random, 1-ulp-perturbed and large-offset inputs', () => {
    const rng = mulberry32(11);
    const pred = makePredicates();
    let naiveWrong = 0;
    for (let i = 0; i < 20000; i++) {
      const kind = i % 4;
      let ax: number, ay: number, bx: number, by: number, cx: number, cy: number;
      if (kind === 0) {
        [ax, ay, bx, by, cx, cy] = Array.from({ length: 6 }, () => rng() * 2 - 1) as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
      } else {
        // On the line y = s·x (+ offset), c perturbed by a few ulps.
        const off = kind === 3 ? 1e6 : 0;
        const s = rng() * 4 - 2;
        const t = [rng(), rng(), rng()].map((v) => v * 10 - 5) as [number, number, number];
        ax = off + t[0];
        ay = off + s * t[0];
        bx = off + t[1];
        by = off + s * t[1];
        cx = off + t[2];
        cy = ulps(off + s * t[2], Math.floor(rng() * 7) - 3);
        if (kind === 2) [bx, by] = [ulps(bx, 1), ulps(by, -1)];
      }
      const want = orientExact(ax, ay, bx, by, cx, cy);
      const seed = `case ${i}`;
      expect(sign(orient2d(ax, ay, bx, by, cx, cy)), seed).toBe(want);
      expect(sign(pred.orient2d(ax, ay, bx, by, cx, cy)), seed).toBe(want);
      if (naiveOrient(ax, ay, bx, by, cx, cy) !== want) naiveWrong++;
    }
    // The perturbed cases are hard: the naive formula must fail on some of them,
    // or this test would not exercise the adaptive stages.
    expect(naiveWrong).toBeGreaterThan(100);
  });
});

describe('incircle', () => {
  it('is positive inside the circle of a counter-clockwise triangle', () => {
    expect(incircle(0, 0, 1, 0, 0, 1, 0.25, 0.25)).toBeGreaterThan(0);
    expect(incircle(0, 0, 1, 0, 0, 1, 2, 2)).toBeLessThan(0);
    expect(incircle(0, 0, 1, 0, 0, 1, 1, 1)).toBe(0);
    // Clockwise triangle: the sign flips.
    expect(incircle(0, 0, 0, 1, 1, 0, 0.25, 0.25)).toBeLessThan(0);
  });

  it('matches the exact BigInt sign on random, cocircular-lattice, perturbed and offset inputs', () => {
    const rng = mulberry32(12);
    const pred = makePredicates();
    // Lattice points on x² + y² = 25 (exactly cocircular).
    const ring = [
      [5, 0],
      [4, 3],
      [3, 4],
      [0, 5],
      [-3, 4],
      [-4, 3],
      [-5, 0],
      [-4, -3],
      [-3, -4],
      [0, -5],
      [3, -4],
      [4, -3],
    ] as const;
    let zeros = 0;
    for (let i = 0; i < 20000; i++) {
      const kind = i % 4;
      let q: number[];
      if (kind === 0) q = Array.from({ length: 8 }, () => rng() * 2 - 1);
      else {
        const pick = (): readonly [number, number] => ring[Math.floor(rng() * ring.length)]!;
        const off = kind === 3 ? 1e6 : 0;
        const sc = kind === 1 ? 1 : 0.1;
        q = [pick(), pick(), pick(), pick()].flatMap(([x, y]) => [off + sc * x, off + sc * y]);
        // Perturb a non-zero coordinate: from 0, one ulp is a subnormal, and
        // Shewchuk's arithmetic is exact only without underflow (out of scope:
        // parameter coordinates are never subnormal).
        const k = q[7] !== 0 ? 7 : 6;
        if (kind !== 1) q[k] = ulps(q[k]!, Math.floor(rng() * 5) - 2);
      }
      const [ax, ay, bx, by, cx, cy, dx, dy] = q as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const want = incircleExact(ax, ay, bx, by, cx, cy, dx, dy);
      if (want === 0) zeros++;
      expect(sign(incircle(ax, ay, bx, by, cx, cy, dx, dy)), `case ${i}`).toBe(want);
      expect(sign(pred.incircle(ax, ay, bx, by, cx, cy, dx, dy)), `case ${i}`).toBe(want);
    }
    expect(zeros).toBeGreaterThan(1000);
  });
});
