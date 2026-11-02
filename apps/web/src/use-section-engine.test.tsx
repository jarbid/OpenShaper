// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The engine switch converts the open classic board into the section store, keeps the document
 * across an off/on toggle, converts again when another board is opened, and leaves the classic store
 * in charge when the board is refused. (No Worker in jsdom: the conversion runs through the
 * client's synchronous fallback.)
 */
import { parseBrd, parseS3dx } from '@openshaper/io';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sampleBrd from './sample-board.brd?raw';
import pointedS3dx from '../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import { boardStore, sectionStore } from './store';
import { resetSectionEngine, useSectionEngine } from './use-section-engine';

const sample = parseBrd(sampleBrd).board;
const other = parseS3dx(pointedS3dx).board;
const refused = parseS3dx(pointedS3dx.split('<z>6.985</z>').join('<z>-3</z>')).board;

// The synchronous fallback loads the compute module on first use (board2 and geom): do that once, up front.
beforeAll(async () => {
  await import('./workers/nurbs-core');
}, 60_000);

beforeEach(() => {
  resetSectionEngine();
  sectionStore.setState({ doc: null, board: null });
  boardStore.getState().load(sample);
});

describe('useSectionEngine', () => {
  it('does nothing while the engine is off', () => {
    const { result } = renderHook(() => useSectionEngine(false));
    expect(result.current).toEqual({ ready: false, refusal: null, converting: false });
    expect(sectionStore.getState().doc).toBeNull();
  });

  it('converts the open board when the engine turns on, and is ready with the document loaded', async () => {
    const { result, rerender } = renderHook(({ on }) => useSectionEngine(on), {
      initialProps: { on: false },
    });
    rerender({ on: true });
    expect(result.current.converting).toBe(true);
    await waitFor(() => expect(result.current.ready).toBe(true));
    const doc = sectionStore.getState().doc!;
    expect(doc.format).toBe('openshaper');
    expect(sectionStore.getState().board).not.toBeNull();
    expect(result.current.refusal).toBeNull();
  });

  it('keeps the document across an off and on again, and converts anew for another board', async () => {
    const { result, rerender } = renderHook(({ on }) => useSectionEngine(on), {
      initialProps: { on: true },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const doc = sectionStore.getState().doc!;
    rerender({ on: false });
    expect(result.current.ready).toBe(false);
    rerender({ on: true });
    // the NURBS document is exactly the one that was there, not converted again
    expect(result.current.ready).toBe(true);
    expect(sectionStore.getState().doc).toBe(doc);

    act(() => boardStore.getState().load(other));
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(sectionStore.getState().doc).not.toBe(doc);
  });

  it('leaves the classic store in charge for a board the model cannot hold, with the reasons', async () => {
    boardStore.getState().load(refused);
    const { result } = renderHook(() => useSectionEngine(true));
    await waitFor(() => expect(result.current.refusal).not.toBeNull());
    expect(result.current.ready).toBe(false);
    expect(result.current.converting).toBe(false);
    expect(result.current.refusal!.issues.some((i) => i.severity === 'error')).toBe(true);
    // a convertible board recovers
    act(() => boardStore.getState().load(other));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.refusal).toBeNull();
  });
});
