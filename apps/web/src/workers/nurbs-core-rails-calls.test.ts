// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the worker's compute hands the rails engine: each build is given the last one, so the outline loop is
 * reused for a rebuild of an unchanged outline, and a build or mesh that throws falls back to the
 * sections engine.
 */
import * as board2 from '@openshaper/board2';
import { swallowBoard } from '@openshaper/board2/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meshDocument, resetCore } from './nurbs-core';
import type { JobOptions } from './nurbs-protocol';

const spies = vi.hoisted(() => ({ meshThrows: false }));

vi.mock('@openshaper/board2', async (original) => {
  const real = await original<typeof import('@openshaper/board2')>();
  return {
    ...real,
    buildRails: vi.fn(real.buildRails),
    meshRails: vi.fn((...args: Parameters<typeof real.meshRails>) => {
      if (spies.meshThrows) throw new Error('mesh failed');
      return real.meshRails(...args);
    }),
  };
});

const OPTIONS: JobOptions = {
  curvature: false,
  deviation: false,
  reuseLadders: true,
  engine: 'rails',
};
const run = (doc = swallowBoard()) => {
  const out = meshDocument(doc, null, OPTIONS);
  if (!out.ok) throw new Error(out.error);
  return out;
};

beforeEach(() => {
  resetCore();
  spies.meshThrows = false;
  vi.mocked(board2.buildRails).mockClear();
});

describe('the rails build is given the last one', () => {
  it('reuses the outline loop of an unchanged outline, though the document is a fresh clone', () => {
    run();
    run(structuredClone(swallowBoard()));
    const [first, second] = vi.mocked(board2.buildRails).mock.results.map((r) => r.value);
    expect(vi.mocked(board2.buildRails).mock.calls[0]![1]?.previous).toBeUndefined();
    const previous = vi.mocked(board2.buildRails).mock.calls[1]![1]?.previous;
    expect(previous).toBe(first.value);
    expect(second.value.loop).toBe(first.value.loop);
  });

  it('builds a new loop for a changed outline', () => {
    run();
    const doc = swallowBoard();
    const knots = doc.outline.plus.knots.map((k, i) =>
      i === 2 ? { ...k, p: [k.p[0], k.p[1] + 0.5] as [number, number] } : k,
    );
    run({ ...doc, outline: { ...doc.outline, plus: { knots } } });
    const [first, second] = vi.mocked(board2.buildRails).mock.results.map((r) => r.value);
    expect(second.value.loop).not.toBe(first.value.loop);
  });
});

describe('a rails mesh that throws', () => {
  it('falls back to the sections engine and says so', () => {
    spies.meshThrows = true;
    const out = run();
    expect(out.summary.engine).toBe('sections');
    expect(out.issues.find((i) => i.code === 'rails-fallback')?.message).toContain('mesh failed');
    expect(out.mesh.positions.length).toBeGreaterThan(0);
  });
});
