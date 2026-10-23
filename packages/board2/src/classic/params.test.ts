// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The converter's defaults (docs/design/board2.md §12.2): pinned to the design
 * table, frozen, and the relations the table's reasons state.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUILD_PARAMS } from '../params';
import { DEFAULT_CONVERT_OPTIONS as O, LINE_CORRECTION_PASSES, LINE_REFINE_PASSES } from './params';

describe('DEFAULT_CONVERT_OPTIONS', () => {
  it('is the §12.2 table (plus S6’s lineSampleSpacing), deeply frozen', () => {
    expect(O).toEqual({
      lineTol: 0.001,
      surfaceTol: 0.005,
      deckInsetFraction: 0.21,
      tuckInsetFraction: 0.08,
      cornerAngleMin: (2 * Math.PI) / 180,
      cornerFilletRadius: 0.5,
      sampleSpacingX: 0.5,
      ringSamples: 128,
      lineSampleSpacing: 0.05,
      creaseProbe: 0.01,
      endGap: 0.001,
      surfaceKnotSpacing: { x: 10, y: 5 },
      minKnotSpacing: 1.5,
      creaseWindow: 3,
      tipWindow: 2,
      trimDataMargin: 1,
      maxRefinePasses: 6,
      maxBandCorrectionPasses: 4,
      bandCorrectionStall: 0.02,
      fairnessRatioBracket: [1e-10, 1],
      fairnessSearchSteps: 12,
    });
    expect(Object.isFrozen(O)).toBe(true);
    expect(Object.isFrozen(O.surfaceKnotSpacing)).toBe(true);
    expect(Object.isFrozen(O.fairnessRatioBracket)).toBe(true);
    expect(LINE_CORRECTION_PASSES).toBe(1);
    expect(LINE_REFINE_PASSES).toBe(16);
  });

  it('keeps the relations its reasons state', () => {
    const b = DEFAULT_BUILD_PARAMS;
    // A fillet hosts the minimum band (§12.2 cornerFilletRadius).
    expect(O.cornerFilletRadius).toBeGreaterThanOrEqual(b.minInset / b.insetCurvatureFraction);
    // Twice the halvings that leave a start span of line samples with fewer than two.
    expect(LINE_REFINE_PASSES).toBe(
      2 * Math.ceil(Math.log2(O.surfaceKnotSpacing.x / O.lineSampleSpacing)),
    );
    // creaseWindow is 2 × minKnotSpacing; three samples per minKnotSpacing span.
    expect(O.creaseWindow).toBe(2 * O.minKnotSpacing);
    expect(O.minKnotSpacing / O.sampleSpacingX).toBe(3);
    // 12 halvings of 10 decades: a factor of about 1.0057.
    const [lo, hi] = O.fairnessRatioBracket;
    expect(Math.exp(Math.log(hi / lo) / 2 ** O.fairnessSearchSteps)).toBeCloseTo(1.0056, 4);
    // The line samples are a tenth of the loft row spacing.
    expect(O.lineSampleSpacing * 10).toBe(O.sampleSpacingX);
  });
});
