// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The offset layer's evaluation (docs/design/board2.md §6.1). Its effect on the
 * band (identity, survival under law changes, restricted components) is tested
 * in `band/band.test.ts`.
 *
 * Oracles: the empty layer is `null` (nothing applied); a degree-1 periodic
 * field interpolates its control values at the knots (hat functions: closed
 * form) and is linear between them; a constant field is that constant
 * everywhere (partition of unity) to 4ε; σ wraps with period 1; the
 * two components of `tuckHandle` come out in the order `n, z`; rows without a
 * field read 0.
 */
import { describe, expect, it } from 'vitest';
import { offsetEvaluator, ZERO_OFFSETS } from './offsets';
import type { OffsetLayer } from './types';

describe('offsetEvaluator', () => {
  it('the empty layer evaluates to nothing', () => {
    expect(offsetEvaluator({ basis: null, rows: [] })).toBeNull();
    expect(
      offsetEvaluator({ basis: { degree: 3, knots: [0, 0.25, 0.5, 0.75] }, rows: [] }),
    ).toBeNull();
  });

  it('degree 1: control values at the knots, linear between (hat functions)', () => {
    // Periodic degree 1 on knots k_i: control point i peaks at k_{i+1}.
    const layer: OffsetLayer = {
      basis: { degree: 1, knots: [0, 0.25, 0.5, 0.75] },
      rows: [
        { row: 'deckEdge', values: [1, 2, 3, 4] },
        { row: 'tuckHandle', values: [10, -10, 20, -20, 30, -30, 40, -40] },
      ],
    };
    const ev = offsetEvaluator(layer)!;
    const at = [0.25, 0.5, 0.75, 0];
    for (let i = 0; i < 4; i++) {
      const o = ev(at[i]!);
      expect(o.deckEdgeN).toBe(i + 1);
      expect(o.tuckHandleN).toBe(10 * (i + 1));
      expect(o.tuckHandleZ).toBe(-10 * (i + 1));
      // Rows without a field read 0.
      expect(o.apexUpperZ).toBe(0);
      expect(o.tuckN).toBe(0);
    }
    // Midway between the peaks of 1 and 2.
    expect(ev(0.375).deckEdgeN).toBeCloseTo(1.5, 14);
    // Wrapping: σ + 1 and σ − 1 read the same.
    expect(ev(1.375).deckEdgeN).toBe(ev(0.375).deckEdgeN);
    expect(ev(-0.625).deckEdgeN).toBe(ev(0.375).deckEdgeN);
  });

  it('a constant cubic field is that constant everywhere', () => {
    const ev = offsetEvaluator({
      basis: { degree: 3, knots: [0, 0.1, 0.3, 0.5, 0.6, 0.9] },
      rows: [{ row: 'apexUpper', values: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3] }],
    })!;
    for (let k = 0; k < 100; k++) {
      expect(Math.abs(ev(k / 100).apexUpperZ - 0.3)).toBeLessThanOrEqual(4 * Number.EPSILON);
      expect(ev(k / 100).deckHandleL).toBe(0);
    }
  });

  it('a field of the wrong size throws (revive prevents it for documents)', () => {
    expect(() =>
      offsetEvaluator({
        basis: { degree: 1, knots: [0, 0.5] },
        rows: [{ row: 'tuckHandle', values: [1, 2] }],
      }),
    ).toThrow(RangeError);
    expect(Object.isFrozen(ZERO_OFFSETS)).toBe(true);
  });
});
