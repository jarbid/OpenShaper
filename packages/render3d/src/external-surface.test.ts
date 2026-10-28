// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  isDeviationAnalysis,
  sameStatus,
  surfaceCurvatureStatus,
  surfaceDeviationStatus,
} from './analysis';
import { DIVERGING_RAMP, SEQUENTIAL_RAMP } from './analysis-palette';
import type { CurvatureMesh } from './curvature-mesh';
import type { DeviationMesh } from './deviation-mesh';
import { sameHull, type ExternalSurface } from './external-surface';
import { stationBoard } from './test-support/boards';

const curvature = {
  scale: { mean: 0.02, gaussian: 4e-4, radius: [0.5, 50] },
} as unknown as CurvatureMesh;

const surfaceFor = (
  board = stationBoard(),
  deviation: DeviationMesh | null = null,
): ExternalSurface => ({ board, curvature, deviation });

describe('sameHull', () => {
  it('is true for the same board and for one that differs only in non-hull parts', () => {
    const b = stationBoard();
    expect(sameHull(b, b)).toBe(true);
    expect(sameHull(b, { ...b, fins: { ...b.fins, setup: 'none' } })).toBe(true);
  });

  it('is false once the outline, a rocker curve or the cross-sections are replaced', () => {
    const b = stationBoard();
    const other = stationBoard();
    expect(sameHull(b, other)).toBe(false);
    expect(sameHull(b, { ...b, outline: other.outline })).toBe(false);
    expect(sameHull(b, { ...b, deck: other.deck })).toBe(false);
    expect(sameHull(b, { ...b, bottom: other.bottom })).toBe(false);
    expect(sameHull(b, { ...b, crossSections: [...b.crossSections] })).toBe(false);
  });
});

describe('external surface statuses', () => {
  it('has the exact modes ready at once, with the surface’s own scale and the mode’s ramp', () => {
    const s = surfaceFor();
    expect(surfaceCurvatureStatus('mean-curvature', s)).toEqual({
      state: 'ready',
      mode: 'mean-curvature',
      scale: curvature.scale,
      ramp: DIVERGING_RAMP,
    });
    expect(surfaceCurvatureStatus('rail-radius', s)).toMatchObject({ ramp: SEQUENTIAL_RAMP });
  });

  it('reports the deviation unavailable without a surface or without its deviation', () => {
    const none = { state: 'unavailable', mode: 'nurbs-deviation', reason: 'no-surface' };
    expect(surfaceDeviationStatus(null, 0.5)).toEqual(none);
    expect(surfaceDeviationStatus(surfaceFor(), 0.5)).toEqual(none);
  });

  it('reports the deviation ready with its range and band, never stale', () => {
    const deviation = { range: [-0.1, 0.2] } as unknown as DeviationMesh;
    const status = surfaceDeviationStatus(surfaceFor(undefined, deviation), 0.3);
    expect(status).toMatchObject({
      state: 'ready',
      mode: 'nurbs-deviation',
      band: 0.3,
      range: [-0.1, 0.2],
      stale: false,
    });
    expect(sameStatus(status, surfaceDeviationStatus(surfaceFor(undefined, deviation), 0.3))).toBe(
      true,
    );
    expect(sameStatus(status, surfaceDeviationStatus(surfaceFor(undefined, deviation), 0.4))).toBe(
      false,
    );
  });

  it('counts both deviation modes as deviations', () => {
    expect(isDeviationAnalysis('ghost-deviation')).toBe(true);
    expect(isDeviationAnalysis('nurbs-deviation')).toBe(true);
    expect(isDeviationAnalysis('zebra')).toBe(false);
  });
});
