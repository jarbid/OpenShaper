// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The lofted panels: through their station curves, held beyond the end stations, C1 across the
 * stringer, straight past the wall, with gradients that are the heights' derivatives, and fast
 * enough for a mesh.
 */
import { describe, expect, it } from 'vitest';
import { chainEval, chainParamAtX, compileChain, funcEval } from '../chain';
import type { Chain, ChainKnot } from '../types';
import { buildLoft, loftAt, loftPanels } from './loft';
import type { CurveAt, LoftParts, PanelLoft } from './loft';

/** A chain through `n + 1` even points of f on [a, b], each span the cubic Hermite with slopes f′. */
const fnChain = (
  f: (x: number) => number,
  df: (x: number) => number,
  a: number,
  b: number,
  n: number,
): Chain => {
  const h = (b - a) / n;
  const knots: ChainKnot[] = [];
  for (let i = 0; i <= n; i++) {
    const x = a + i * h;
    const y = f(x);
    const s = df(x);
    knots.push({
      p: [x, y],
      in: [x - h / 3, y - (s * h) / 3],
      out: [x + h / 3, y + (s * h) / 3],
      smooth: true,
    });
  }
  return { knots };
};

/** A dome v = top − a·u² (a deck curve), flat at the stringer. */
const dome = (top: number, a: number): Chain =>
  fnChain(
    (u) => top - a * u * u,
    (u) => -2 * a * u,
    0,
    1,
    6,
  );
/** A bottom v = c·u² + e·u⁴ (c < 0 a vee-less belly, c > 0 a rising bottom). */
const belly = (c: number, e: number): Chain =>
  fnChain(
    (u) => c * u * u + e * u ** 4,
    (u) => 2 * c * u + 4 * e * u ** 3,
    0,
    1,
    6,
  );
const flat = (v: number): Chain =>
  fnChain(
    () => v,
    () => 0,
    0,
    1,
    2,
  );

const L = 180;
const rocker = fnChain(
  (x) => 0.0006 * (x - 100) ** 2,
  (x) => 0.0012 * (x - 100),
  0,
  L,
  12,
);
const deck = fnChain(
  (x) => 0.0006 * (x - 100) ** 2 + 2 + 5 * Math.sin((Math.PI * x) / L),
  (x) => 0.0012 * (x - 100) + ((5 * Math.PI) / L) * Math.cos((Math.PI * x) / L),
  0,
  L,
  12,
);
const plusWidth = (x: number): number => 26 * (1 - ((x - 95) / 95) ** 2);
const minusWidth = (x: number): number => 0.92 * plusWidth(x);

const XS = [20, 60, 105, 150];
const SAMPLES = 600;
const topCurves: CurveAt[] = XS.map((x, i) => ({ x, curve: dome(1, 0.3 + 0.12 * i) }));
const botCurves: CurveAt[] = XS.map((x, i) => ({ x, curve: belly(0.08 - 0.03 * i, 0.04 * i) }));
const minusTop: CurveAt[] = XS.map((x, i) => ({ x, curve: dome(1, 0.5 - 0.05 * i) }));
const minusBot: CurveAt[] = XS.map((x) => ({ x, curve: flat(0) }));

const top = buildLoft(topCurves, SAMPLES);
const bot = buildLoft(botCurves, SAMPLES);
const parts = (asym: boolean): LoftParts => {
  const mt = asym ? buildLoft(minusTop, SAMPLES) : top;
  const mb = asym ? buildLoft(minusBot, SAMPLES) : bot;
  return {
    rocker,
    deck,
    halfWidth: [plusWidth, asym ? minusWidth : plusWidth],
    bottom: [bot, mb],
    top: [top, mt],
    from: 0,
    to: L,
  };
};
const symmetric = loftPanels(parts(false));
const asymmetric = loftPanels(parts(true));

/** v of a station curve at u, from the chain itself. */
const curveAt = (c: Chain, u: number): number => {
  const ch = compileChain(c);
  const s = chainParamAtX(ch, u, 0, ch.segments);
  const p = new Float64Array(2);
  chainEval(ch, s, 0, p, 0);
  return p[1]!;
};
const stringer = (x: number): { R: number; T: number } => {
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  funcEval(compileChain(rocker), x, r, 0);
  funcEval(compileChain(deck), x, d, 0);
  return { R: r[0]!, T: d[0]! - r[0]! };
};

describe('buildLoft and loftPanels', () => {
  it("is each station's curve at the station's x", () => {
    const cases: [string, typeof symmetric, number, readonly CurveAt[], (x: number) => number][] = [
      ['plus deck', asymmetric, 1, topCurves, plusWidth],
      ['plus bottom', asymmetric, 1, botCurves, plusWidth],
      ['minus deck', asymmetric, -1, minusTop, minusWidth],
      ['minus bottom', asymmetric, -1, minusBot, minusWidth],
    ];
    let worst = 0;
    for (const [name, panels, sign, curves, w] of cases) {
      const isDeck = name.endsWith('deck');
      for (const { x, curve } of curves) {
        const { R, T } = stringer(x);
        for (let i = 0; i <= 200; i++) {
          const u = i / 200;
          const y = sign * u * w(x);
          const z = isDeck ? panels.deck(x, y) : panels.bottom(x, y);
          worst = Math.max(worst, Math.abs(z - (R + T * curveAt(curve, u))));
        }
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('holds the end curves beyond the first and last station', () => {
    const out = new Float64Array(3);
    const at = new Float64Array(3);
    for (const loft of [top, bot]) {
      for (let i = 0; i <= 50; i++) {
        const u = (1.2 * i) / 50;
        loftAt(loft, XS[0]!, u, at);
        for (const x of [-20, 0, 10, XS[0]! - 0.01]) {
          loftAt(loft, x, u, out);
          expect(out[0]).toBe(at[0]);
          expect(out[1]).toBe(0);
        }
        loftAt(loft, XS[3]!, u, at);
        for (const x of [XS[3]! + 0.01, 170, L, L + 20]) {
          loftAt(loft, x, u, out);
          expect(out[0]).toBe(at[0]);
          expect(out[1]).toBe(0);
        }
      }
    }
  });

  it('is C1 across the stringer', () => {
    const out = new Float64Array(6);
    const neg = new Float64Array(6);
    for (const x of [5, 33, 60, 88, 140]) {
      for (const d of [1e-2, 1e-3, 1e-4]) {
        symmetric.both(x, d, out);
        symmetric.both(x, -d, neg);
        for (const k of [0, 3]) {
          // the slope across goes to zero with the distance from the stringer
          expect(Math.abs(out[k + 2]!)).toBeLessThan(d);
          expect(Math.abs(neg[k + 2]!)).toBeLessThan(d);
          // height and slope along are the same either side
          expect(Math.abs(out[k]! - neg[k]!)).toBeLessThan(1e-12);
          expect(Math.abs(out[k + 1]! - neg[k + 1]!)).toBeLessThan(1e-12);
        }
      }
      symmetric.both(x, 0, out);
      expect(out[2]).toBe(0);
      expect(out[5]).toBe(0);
    }
  });

  it("gives gradients that are the heights' derivatives", () => {
    const out = new Float64Array(6);
    const e = 1e-4;
    let worst = 0;
    for (const panels of [symmetric, asymmetric]) {
      for (let i = 0; i < 400; i++) {
        const x = 3 + ((i * 0.618034) % 1) * (L - 6);
        const side = i % 2 === 0 ? 1 : -1;
        const w = side > 0 ? plusWidth(x) : minusWidth(x);
        const u = 0.05 + ((i * 0.414214) % 1) * 0.9;
        const y = side * u * w;
        panels.both(x, y, out);
        const fs = [panels.deck, panels.bottom];
        for (let p = 0; p < 2; p++) {
          const f = fs[p]!;
          const dx = (f(x + e, y) - f(x - e, y)) / (2 * e);
          const dy = (f(x, y + e) - f(x, y - e)) / (2 * e);
          worst = Math.max(worst, Math.abs(dx - out[3 * p + 1]!), Math.abs(dy - out[3 * p + 2]!));
          expect(out[3 * p]).toBe(f(x, y));
        }
      }
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('carries on straight past the wall', () => {
    for (const x of [10, 50, 100, 160]) {
      const w = plusWidth(x);
      for (const f of [asymmetric.deck, asymmetric.bottom]) {
        for (const side of [1, -1]) {
          const ws = side > 0 ? w : minusWidth(x);
          const h = 0.05 * ws;
          for (let y = 1.0 * ws; y < 1.6 * ws; y += h) {
            const s = side * y;
            const d2 = f(x, s + side * h) - 2 * f(x, s) + f(x, s - side * h);
            const ok = y - h >= ws;
            if (ok) expect(Math.abs(d2)).toBeLessThan(1e-11);
          }
        }
      }
    }
  });

  it('blends two domes into a dome', () => {
    const out = new Float64Array(3);
    const second = (loft: PanelLoft, x: number): number => {
      let most = -Infinity;
      const h = 1 / SAMPLES;
      for (let j = 1; j < SAMPLES; j++) {
        const v = (u: number): number => {
          loftAt(loft, x, u, out);
          return out[0]!;
        };
        most = Math.max(most, v((j - 1) * h) - 2 * v(j * h) + v((j + 1) * h));
      }
      return most;
    };
    for (let x = XS[0]!; x <= XS[3]!; x += 2.5) expect(second(top, x)).toBeLessThanOrEqual(0);
  });

  it('is fast', () => {
    const out = new Float64Array(6);
    const run = (count: number): number => {
      const t0 = performance.now();
      let acc = 0;
      for (let i = 0; i < count; i++) {
        // a mesh's order: along rows, a little at a time
        const x = (i % 2000) * 0.09;
        const y = ((i / 2000) | 0) * 0.5 - 25;
        asymmetric.both(x, y, out);
        acc += out[0]!;
      }
      expect(Number.isFinite(acc)).toBe(true);
      return performance.now() - t0;
    };
    run(50_000);
    const ms = run(200_000);
    // 8× an aim of 100 ns a call
    expect(ms).toBeLessThan(200_000 * 800e-6);
  });
});
