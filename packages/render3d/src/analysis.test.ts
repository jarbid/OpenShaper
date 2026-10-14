// SPDX-License-Identifier: GPL-3.0-or-later
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { DIVERGING_RAMP, NO_DATA_STRIPES, SEQUENTIAL_RAMP } from './analysis-palette';
import {
  ANALYSIS_OFF,
  analysisStatus,
  deviationStatus,
  isExactAnalysis,
  rampFor,
  sameStatus,
  type AnalysisMode,
  type CurvatureResult,
  type DeviationResult,
} from './analysis';
import type { CurvatureMesh } from './curvature-mesh';
import type { DeviationMesh } from './deviation-mesh';
import { stationBoard, swallowBoard } from './test-support/boards';

const fakeMesh = (): CurvatureMesh =>
  ({ scale: { mean: 0.01, gaussian: 1e-5, radius: [1, 100] } }) as unknown as CurvatureMesh;

describe('analysis modes', () => {
  it('knows which modes are exact', () => {
    const all: AnalysisMode[] = [
      'none',
      'zebra',
      'curvature',
      'slope',
      'mean-curvature',
      'gaussian-curvature',
      'rail-radius',
      'ghost-deviation',
    ];
    // The deviation is computed too, but not from the fitted surface.
    expect(all.filter(isExactAnalysis)).toEqual([
      'mean-curvature',
      'gaussian-curvature',
      'rail-radius',
    ]);
  });

  it('paints curvature diverging and rail radius sequential', () => {
    expect(rampFor('mean-curvature')).toBe(DIVERGING_RAMP);
    expect(rampFor('gaussian-curvature')).toBe(DIVERGING_RAMP);
    expect(rampFor('rail-radius')).toBe(SEQUENTIAL_RAMP);
    // Diverging: an odd number of stops, so zero has a stop of its own.
    expect(DIVERGING_RAMP.length % 2).toBe(1);
  });
});

describe('analysisStatus', () => {
  const board = stationBoard();

  it('is off for the screen-space modes and with no board', () => {
    for (const m of ['none', 'zebra', 'curvature', 'slope'] as const) {
      expect(analysisStatus(m, board, null)).toBe(ANALYSIS_OFF);
    }
    expect(analysisStatus('mean-curvature', null, null)).toBe(ANALYSIS_OFF);
  });

  it('computes until a result for this very board lands', () => {
    expect(analysisStatus('mean-curvature', board, null)).toEqual({
      state: 'computing',
      mode: 'mean-curvature',
    });
    // After an edit the live board is a new object: the old result is stale.
    const old: CurvatureResult = { board: stationBoard(), mesh: fakeMesh() };
    expect(analysisStatus('rail-radius', board, old).state).toBe('computing');
  });

  it('is ready, with the scale and the ramp, once it has', () => {
    const mesh = fakeMesh();
    const status = analysisStatus('gaussian-curvature', board, { board, mesh });
    expect(status).toEqual({
      state: 'ready',
      mode: 'gaussian-curvature',
      scale: mesh.scale,
      ramp: DIVERGING_RAMP,
    });
  });

  it('passes a worker failure on', () => {
    expect(analysisStatus('mean-curvature', board, { board, error: 'boom' })).toEqual({
      state: 'failed',
      mode: 'mean-curvature',
      message: 'boom',
    });
  });

  it('is unavailable for a concave tail, whatever the worker said', () => {
    const swallow: BezierBoard = swallowBoard();
    for (const result of [null, { board: swallow, mesh: fakeMesh() }]) {
      expect(analysisStatus('rail-radius', swallow, result)).toEqual({
        state: 'unavailable',
        mode: 'rail-radius',
        reason: 'concave-tail',
      });
    }
  });
});

describe('sameStatus', () => {
  const board = stationBoard();
  const mesh = fakeMesh();
  const ready = analysisStatus('mean-curvature', board, { board, mesh });

  it('treats equal states as the same, so a re-render reports nothing new', () => {
    expect(sameStatus(ready, analysisStatus('mean-curvature', board, { board, mesh }))).toBe(true);
    expect(
      sameStatus(
        analysisStatus('mean-curvature', board, null),
        analysisStatus('mean-curvature', stationBoard(), null),
      ),
    ).toBe(true);
  });

  it('tells apart a new mode, a new state and a new scale', () => {
    expect(sameStatus(ready, analysisStatus('rail-radius', board, { board, mesh }))).toBe(false);
    expect(sameStatus(ready, analysisStatus('mean-curvature', board, null))).toBe(false);
    expect(
      sameStatus(ready, analysisStatus('mean-curvature', board, { board, mesh: fakeMesh() })),
    ).toBe(false);
  });
});

describe('deviationStatus', () => {
  const board = stationBoard();
  const ghost = stationBoard();
  const mesh = (range: [number, number] | null = [-0.2, 0.3]): DeviationMesh =>
    ({ range }) as unknown as DeviationMesh;

  it('is off with no board, and unavailable, saying why, with no ghost', () => {
    expect(deviationStatus(null, ghost, null, 0.5)).toBe(ANALYSIS_OFF);
    expect(deviationStatus(board, null, null, 0.5)).toEqual({
      state: 'unavailable',
      mode: 'ghost-deviation',
      reason: 'no-ghost',
    });
    // A result is no use once its ghost has been cleared.
    expect(deviationStatus(board, null, { board, ghost, mesh: mesh() }, 0.5).state).toBe(
      'unavailable',
    );
  });

  it('computes until there is a result against this very ghost', () => {
    expect(deviationStatus(board, ghost, null, 0.5)).toEqual({
      state: 'computing',
      mode: 'ghost-deviation',
    });
    // Measured against another ghost (the old one, before a new ghost was opened).
    const other: DeviationResult = { board, ghost: stationBoard(), mesh: mesh() };
    expect(deviationStatus(board, ghost, other, 0.5).state).toBe('computing');
  });

  it('is ready with the band, the range, and the colours for the legend', () => {
    const m = mesh([-0.2, 0.3]);
    expect(deviationStatus(board, ghost, { board, ghost, mesh: m }, 0.4)).toEqual({
      state: 'ready',
      mode: 'ghost-deviation',
      band: 0.4,
      range: m.range,
      ramp: DIVERGING_RAMP,
      stripes: NO_DATA_STRIPES,
    });
    const none = deviationStatus(board, ghost, { board, ghost, mesh: mesh(null) }, 0.4);
    expect(none).toMatchObject({ state: 'ready', range: null });
  });

  it('keeps showing the last result against this ghost while an edit is measured', () => {
    // After an edit the live board is a new object; the map stays up a step behind.
    const before: DeviationResult = { board: stationBoard(), ghost, mesh: mesh() };
    expect(deviationStatus(board, ghost, before, 0.5).state).toBe('ready');
  });

  it('passes on a failure for this board, and waits out one for an earlier board', () => {
    expect(deviationStatus(board, ghost, { board, ghost, error: 'boom' }, 0.5)).toEqual({
      state: 'failed',
      mode: 'ghost-deviation',
      message: 'boom',
    });
    const earlier: DeviationResult = { board: stationBoard(), ghost, error: 'boom' };
    expect(deviationStatus(board, ghost, earlier, 0.5).state).toBe('computing');
  });

  it('reports a new band, a new range and a new mode as changes, and nothing else', () => {
    const m = mesh();
    const ready = deviationStatus(board, ghost, { board, ghost, mesh: m }, 0.5);
    expect(sameStatus(ready, deviationStatus(board, ghost, { board, ghost, mesh: m }, 0.5))).toBe(
      true,
    );
    expect(sameStatus(ready, deviationStatus(board, ghost, { board, ghost, mesh: m }, 0.6))).toBe(
      false,
    );
    expect(
      sameStatus(ready, deviationStatus(board, ghost, { board, ghost, mesh: mesh() }, 0.5)),
    ).toBe(false);
    const curvature = analysisStatus('mean-curvature', board, { board, mesh: fakeMesh() });
    expect(sameStatus(ready, curvature)).toBe(false);
    expect(sameStatus(curvature, ready)).toBe(false);
  });
});
