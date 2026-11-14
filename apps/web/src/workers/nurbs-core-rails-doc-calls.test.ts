// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the worker's compute calls for a rails board: only the rails engine, built from the last rails
 * build; never the converter and never a sections build. `resetCore` forgets the last build.
 */
import * as board2 from '@openshaper/board2';
import { swallowBoard } from '@openshaper/board2/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportDocument,
  measureDocument,
  meshDocument,
  probeDocument,
  resetCore,
} from './nurbs-core';
import type { JobOptions } from './nurbs-protocol';

vi.mock('@openshaper/board2', async (original) => {
  const real = await original<typeof import('@openshaper/board2')>();
  return {
    ...real,
    buildRails: vi.fn(real.buildRails),
    buildBoard: vi.fn(real.buildBoard),
    convertSections: vi.fn(real.convertSections),
  };
});

const OPTIONS: JobOptions = { curvature: false, deviation: false, reuseLadders: true };

const rails = (): board2.RailsBoard => {
  const c = board2.convertSections(swallowBoard());
  if (!c.ok) throw new Error('not convertible');
  return c.value.board;
};

const run = (board: board2.RailsBoard, options = OPTIONS) => {
  const out = meshDocument(board, null, options);
  if (!out.ok) throw new Error(out.error);
  return out;
};

const builds = () => vi.mocked(board2.buildRails).mock.results.map((r) => r.value);
const previousOf = (call: number) => vi.mocked(board2.buildRails).mock.calls[call]![1]?.previous;

beforeEach(() => {
  resetCore();
  vi.mocked(board2.buildRails).mockClear();
  vi.mocked(board2.buildBoard).mockClear();
  vi.mocked(board2.convertSections).mockClear();
});

describe('a rails board is built directly', () => {
  const board = rails();
  const calls = () => {
    vi.mocked(board2.convertSections).mockClear();
  };

  it.each([
    ['mesh', () => run(board, { ...OPTIONS, engine: 'sections' })],
    ['settled mesh', () => run(board, { ...OPTIONS, reuseLadders: false, curvature: true })],
    ['probe', () => probeDocument(board, [10])],
    ['measure', () => measureDocument(board)],
    ['STL', () => exportDocument(board, { format: 'stl', faceSize: 1, slug: 'b' })],
    ['DXF', () => exportDocument(board, { format: 'dxf', curveMode: 'polyline', crossSectionCount: 3, ghost: null, fins: [], slug: 'b' })], // prettier-ignore
    ['PDF 1:1', () => exportDocument(board, { format: 'pdf-1to1', options: {}, fins: [], slug: 'b' })], // prettier-ignore
    ['STEP', () => exportDocument(board, { format: 'step', unit: 'mm', slug: 'b' })],
  ])('by the %s request: no conversion, no sections build', (_name, request) => {
    calls();
    const out = request();
    expect(out.ok).toBe(true);
    expect(board2.convertSections).not.toHaveBeenCalled();
    expect(board2.buildBoard).not.toHaveBeenCalled();
    expect(board2.buildRails).toHaveBeenCalledTimes(1);
  });
});

describe('the rails build is given the last one', () => {
  it('reuses the loop and the laws of an equal board, though the second is a fresh clone', () => {
    const board = rails();
    run(board);
    run(structuredClone(board));
    const [first, second] = builds();
    expect(previousOf(0)).toBeUndefined();
    expect(previousOf(1)).toBe(first.value);
    expect(second.value.loop).toBe(first.value.loop);
    expect(second.value.laws).toBe(first.value.laws);
  });

  it('builds a new loop for a moved outline knot', () => {
    const board = rails();
    run(board);
    const knots = board.outline.plus.knots.map((k, i) =>
      i === 2 ? { ...k, p: [k.p[0], k.p[1] + 0.5] as [number, number] } : k,
    );
    run({ ...board, outline: { ...board.outline, plus: { knots } } });
    const [first, second] = builds();
    expect(second.value.loop).not.toBe(first.value.loop);
    expect(second.value.laws).not.toBe(first.value.laws);
  });

  it('is given nothing after resetCore', () => {
    const board = rails();
    run(board);
    resetCore();
    run(board);
    expect(previousOf(1)).toBeUndefined();
    const [first, second] = builds();
    expect(second.value.loop).not.toBe(first.value.loop);
  });
});
