// SPDX-License-Identifier: GPL-3.0-or-later
/** Chains and the chord frame: evaluation, inverse solves, the notch map's joins. */
import { describe, expect, it } from 'vitest';
import {
  arcFractionParams,
  chainEval,
  chainMinX,
  chainParamAtX,
  compileChain,
  funcEval,
} from './chain';
import { frameAt, makeFrame, outlineParam } from './frame';
import { chain, chainPoint, chainZ, knot, swallowBoard } from './testing';

const c = chain(
  knot([0, 1], undefined, [3, 5]),
  knot([10, 2], [6, -3], [14, 6]),
  knot([20, 0], [17, 3], undefined),
);
const cc = compileChain(c);

describe('chain evaluation', () => {
  it('matches the Bézier oracle, with derivatives that match finite differences', () => {
    const o = new Float64Array(6);
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    const hi = new Float64Array(4);
    const lo = new Float64Array(4);
    for (const s of [0, 0.3, 0.6, 1.4, 1.75, 2]) {
      chainEval(cc, s, 2, o, 0);
      const k = Math.min(Math.floor(s), 1);
      const [x, y] = chainPoint(c, k, s - k);
      expect(o[0]).toBeCloseTo(x, 12);
      expect(o[1]).toBeCloseTo(y, 12);
      if (s === 0 || s === 2) continue;
      const h = 1e-5;
      chainEval(cc, s + h, 1, hi, 0);
      chainEval(cc, s - h, 1, lo, 0);
      chainEval(cc, s + h, 0, a, 0);
      chainEval(cc, s - h, 0, b, 0);
      for (let d = 0; d < 2; d++) {
        expect(o[2 + d]).toBeCloseTo((a[d]! - b[d]!) / (2 * h), 5);
        expect(o[4 + d]).toBeCloseTo((hi[2 + d]! - lo[2 + d]!) / (2 * h), 4);
      }
    }
  });

  it('inverts x(s) and gives z(x) with exact slopes', () => {
    const o = new Float64Array(3);
    for (const x of [0, 0.5, 4.2, 9.99, 10, 10.01, 15, 19.5, 20]) {
      const s = chainParamAtX(cc, x, 0, cc.segments);
      const p = new Float64Array(2);
      chainEval(cc, s, 0, p, 0);
      expect(p[0]).toBeCloseTo(x, 12);
      funcEval(cc, x, o, 0);
      expect(o[0]).toBeCloseTo(chainZ(c, x), 9);
      const h = 1e-4;
      const hi = new Float64Array(3);
      const lo = new Float64Array(3);
      funcEval(cc, Math.min(x + h, 20), hi, 0);
      funcEval(cc, Math.max(x - h, 0), lo, 0);
      if (x > 0.5 && x < 19.5 && Math.abs(x - 10) > 0.1) {
        expect(o[1]).toBeCloseTo((hi[0]! - lo[0]!) / (2 * h), 5);
        expect(o[2]).toBeCloseTo((hi[1]! - lo[1]!) / (2 * h), 4);
      }
    }
  });

  it('holds the end value beyond the chain', () => {
    const o = new Float64Array(3);
    funcEval(cc, -5, o, 0);
    expect(o[0]).toBe(1);
    funcEval(cc, 25, o, 0);
    expect(o[0]).toBe(0);
  });

  it('places equal arc-length fractions on a straight chain at equal spacing', () => {
    const line = compileChain(
      chain(knot([0, 0], undefined, [1, 0]), knot([3, 0], [2, 0], undefined)),
    );
    const s = arcFractionParams(line, 0, 1, [0, 0.25, 0.5, 1]);
    expect(Array.from(s)).toEqual([0, expect.closeTo(0.25, 4), expect.closeTo(0.5, 4), 1]);
  });

  it('finds the rearmost point of a notched outline', () => {
    const n = compileChain(swallowBoard().outline.plus);
    const tip = chainMinX(n);
    expect(tip.x).toBe(0);
    expect(tip.s).toBe(1);
  });
});

describe('the notch-zone chord map', () => {
  const doc = swallowBoard();
  const frame = makeFrame(compileChain(doc.outline.plus), doc.tail);
  const n = frame.notch!;

  it('starts at the notch bottom and ends on the x = ξ branch', () => {
    const s = new Float64Array(3);
    outlineParam(frame, n.d, s);
    expect(s[0]).toBe(0);
    const p = new Float64Array(6);
    frameAt(frame, n.d, p);
    expect([p[0], p[1]]).toEqual([11, 0]);
    outlineParam(frame, n.xiEnd, s);
    expect(s[0]).toBeCloseTo(n.sEnd, 12);
  });

  it('is increasing across the zone, and C2 where it joins the x = ξ branch', () => {
    const s = new Float64Array(3);
    for (let i = 0; i <= 50; i++) {
      outlineParam(frame, n.d + (n.zone * i) / 50, s);
      expect(s[1]).toBeGreaterThan(0);
    }
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    const e = 1e-9;
    outlineParam(frame, n.xiEnd - e, a);
    outlineParam(frame, n.xiEnd + e, b);
    for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k]!, 5);
  });

  it('gives chord ends and derivatives that agree with finite differences', () => {
    const p = new Float64Array(6);
    const hi = new Float64Array(6);
    const lo = new Float64Array(6);
    const h = 1e-5;
    for (const xi of [13, 20, 30, 34, 40, 90]) {
      frameAt(frame, xi, p);
      frameAt(frame, xi + h, hi);
      frameAt(frame, xi - h, lo);
      for (let d = 0; d < 2; d++) {
        expect(p[2 + d]).toBeCloseTo((hi[d]! - lo[d]!) / (2 * h), 5);
        expect(p[4 + d]).toBeCloseTo((hi[2 + d]! - lo[2 + d]!) / (2 * h), 4);
      }
    }
  });

  it('is plain x-planes on a standard tail: the chord end has x = ξ exactly', () => {
    const std = makeFrame(
      compileChain(chain(knot([0, 0], undefined, [3, 5]), knot([20, 0], [17, 3], undefined))),
      {
        kind: 'standard',
      },
    );
    const p = new Float64Array(6);
    for (const xi of [0.5, 7.7, 19]) {
      frameAt(std, xi, p);
      expect(p[0]).toBe(xi);
      expect(p[2]).toBe(1);
      expect(p[4]).toBe(0);
    }
  });
});
