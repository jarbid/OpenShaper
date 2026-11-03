// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The engine switch converts the open classic board into the section store, keeps the document
 * across an off/on toggle, converts again when another board is opened, and leaves the classic store
 * in charge when the board is refused. (No Worker in jsdom: the conversion runs through the
 * client's synchronous fallback.)
 */
import { parseBrd, parseS3dx } from '@openshaper/io';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sampleBrd from './sample-board.brd?raw';
import pointedS3dx from '../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import { boardStore, sectionStore } from './store';
import { vec2 } from '@openshaper/kernel';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import {
  currentSections,
  holdSectionsText,
  openSectionDoc,
  prepareSectionDoc,
  resetSectionEngine,
  useSectionEngine,
} from './use-section-engine';

// `unavailable` stands for the compute chunk failing to load (offline, a stale app shell).
const chunk = vi.hoisted(() => ({ unavailable: false }));
vi.mock('./section-files', async (importOriginal) => {
  const m = await importOriginal<typeof import('./section-files')>();
  return {
    ...m,
    readSections: (json: unknown) =>
      chunk.unavailable
        ? Promise.resolve({ ok: false as const, error: 'offline', reason: 'unavailable' as const })
        : m.readSections(json),
  };
});

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

describe('edits made while the board converts', () => {
  it('are in the document that lands: a conversion of an edited board is made again', async () => {
    const before = boardStore.getState().board!;
    const { result } = renderHook(() => useSectionEngine(true));
    expect(result.current.converting).toBe(true);
    // the person drags the nose out 3 cm before the first conversion has landed
    const nose = before.outline.knots.length - 1;
    const end = before.outline.knots[nose]!.end;
    act(() => {
      boardStore.getState().moveControlPoint({ kind: 'outline' }, nose, vec2(end.x + 3, end.y));
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const doc = sectionStore.getState().doc!;
    const noseX = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];
    expect(noseX).toBeCloseTo(end.x + 3, 6);
  });

  it('waits for a drag in progress to end', async () => {
    act(() => boardStore.getState().beginEdit());
    const { result } = renderHook(() => useSectionEngine(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.ready).toBe(false);
    act(() => boardStore.getState().endEdit());
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});

describe('documents that arrive whole', () => {
  it('a prepared document opens without a conversion: the classic store gets its projection', async () => {
    const r = await prepareSectionDoc(JSON.parse(swallowDoc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { result } = renderHook(() => useSectionEngine(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => openSectionDoc(r.doc));
    // ready at once, with that document, and nothing is converting over it
    expect(result.current.ready).toBe(true);
    expect(result.current.converting).toBe(false);
    expect(sectionStore.getState().doc).toBe(r.doc);
    expect(boardStore.getState().board).not.toBeNull();
    expect(currentSections()).toEqual({ doc: r.doc });
  });

  it('a held document is revived when the engine turns on, not converted', async () => {
    const { result, rerender } = renderHook(({ on }) => useSectionEngine(on), {
      initialProps: { on: false },
    });
    holdSectionsText(swallowDoc);
    expect(currentSections()).toEqual({ text: swallowDoc });
    rerender({ on: true });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(sectionStore.getState().doc!.meta.name).toBe('Swallow shortboard');
    expect(sectionStore.getState().doc!.tail.kind).toBe('notched');
  });

  it('refuses what is not a document, with the reason', async () => {
    const r = await prepareSectionDoc({ format: 'openshaper', version: 3, model: 'sections' });
    expect(r.ok).toBe(false);
  });
});

describe('a saved document that cannot be revived (M2 review R1)', () => {
  it('is kept, not converted over, when the code would not load', async () => {
    chunk.unavailable = true;
    try {
      const r = await prepareSectionDoc(JSON.parse(swallowDoc));
      expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
      holdSectionsText(swallowDoc);
      const { result } = renderHook(() => useSectionEngine(true));
      await waitFor(() => expect(result.current.refusal).not.toBeNull());
      expect(result.current.refusal!.error).toMatch(/kept/);
      expect(result.current.ready).toBe(false);
      expect(sectionStore.getState().doc).toBeNull();
      // what the next autosave writes is the saved text
      expect(currentSections()).toEqual({ text: swallowDoc });
    } finally {
      chunk.unavailable = false;
    }
  });

  it('an invalid document is told apart, and the classic board is converted instead', async () => {
    holdSectionsText('{"format":"openshaper","version":3,"model":"sections"}');
    const { result } = renderHook(() => useSectionEngine(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(sectionStore.getState().doc).not.toBeNull();
  });
});
