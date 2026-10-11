// SPDX-License-Identifier: GPL-3.0-or-later
import type { BezierBoard } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { DIVERGING_RAMP, SEQUENTIAL_RAMP } from './analysis-palette';
import {
  ANALYSIS_OFF,
  analysisStatus,
  isExactAnalysis,
  rampFor,
  sameStatus,
  type AnalysisMode,
  type CurvatureResult,
} from './analysis';
import type { CurvatureMesh } from './curvature-mesh';
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
    ];
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
