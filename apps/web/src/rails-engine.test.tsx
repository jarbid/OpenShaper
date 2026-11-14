// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails switch: which store the editors edit, and how a rails board arrives (one test per rule of
 * `rails-engine.ts`). No Worker in jsdom: conversions run through the client's synchronous fallback.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd, parseS3dx } from '@openshaper/io';
import { vec2 } from '@openshaper/kernel';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pointedS3dx from '../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import {
  attachRailsBoard,
  currentRails,
  openRailsBoard,
  resetRailsEngine,
  useRailsEngine,
} from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import { useDocumentEngines } from './use-document-engines';
import { openSectionDoc, prepareSectionDoc, resetSectionEngine } from './use-section-engine';

const sample = parseBrd(sampleBrd).board;
const other = parseS3dx(pointedS3dx).board;
const refused = parseS3dx(pointedS3dx.split('<z>6.985</z>').join('<z>-3</z>')).board;

type Core = typeof import('./workers/nurbs-core');
let core: Core;
beforeAll(async () => {
  core = await import('./workers/nurbs-core');
}, 60_000);

beforeEach(() => {
  resetSectionEngine();
  resetRailsEngine();
  sectionStore.setState({ doc: null, board: null });
  railsStore.setState({ doc: null, board: null, slices: null });
  activeStore.use(boardStore);
  boardStore.getState().load(sample);
});

const engines = (initial = { nurbs: true, rails: true }) =>
  renderHook(({ nurbs, rails }) => useDocumentEngines(nurbs, rails), { initialProps: initial });

/** A rails board made from a sections document, for the documents that arrive whole. */
async function aRailsBoard(): Promise<RailsBoard> {
  const r = await prepareSectionDoc(JSON.parse(swallowDoc));
  if (!r.ok) throw new Error(r.error);
  const out = core.toRails({ doc: r.doc });
  if (!out.ok) throw new Error(out.error);
  return out.board;
}

describe('which store the editors edit', () => {
  it('is the classic store with the NURBS engine off, and the section store with the rails switch off', async () => {
    const { result, rerender } = engines({ nurbs: false, rails: true });
    expect(result.current.kind).toBe('classic');
    expect(activeStore.target).toBe(boardStore);
    rerender({ nurbs: true, rails: false });
    await waitFor(() => expect(result.current.kind).toBe('sections'));
    expect(activeStore.target).toBe(sectionStore);
    expect(railsStore.getState().doc).toBeNull();
  });

  it('is the rails store with both on and a rails board ready', async () => {
    const { result } = engines();
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(activeStore.target).toBe(railsStore);
    expect(railsStore.getState().doc!.model).toBe('rails');
    expect(currentRails()).toBe(railsStore.getState().doc);
  });
});

describe('turning the switch on', () => {
  it('converts the section store’s document, so NURBS edits are kept', async () => {
    const { result, rerender } = engines({ nurbs: true, rails: false });
    await waitFor(() => expect(result.current.kind).toBe('sections'));
    const stations = sectionStore.getState().doc!.stations.length;
    act(() => {
      sectionStore.getState().addCrossSection(70);
    });
    expect(sectionStore.getState().doc!.stations.length).toBe(stations + 1);
    rerender({ nurbs: true, rails: true });
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(railsStore.getState().doc!.stations.length).toBe(stations + 1);
  });

  it('converts the classic board when there is no section document (the section engine refused it)', async () => {
    boardStore.getState().load(sample);
    const { result } = renderHook(() => useRailsEngine(true, { ready: false, converting: false }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(railsStore.getState().doc!.model).toBe('rails');
  });

  it('is kept: off and on again converts nothing and loses no rails edit, until another document is loaded', async () => {
    const { result, rerender } = engines();
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    const doc = railsStore.getState().doc!;
    act(() => {
      railsStore.getState().addCrossSection(70);
    });
    const edited = railsStore.getState().doc!;
    expect(edited).not.toBe(doc);

    rerender({ nurbs: true, rails: false });
    expect(activeStore.target).not.toBe(railsStore);
    rerender({ nurbs: true, rails: true });
    expect(result.current.kind).toBe('rails');
    expect(railsStore.getState().doc).toBe(edited);

    act(() => boardStore.getState().load(other));
    await waitFor(() => expect(railsStore.getState().doc).not.toBe(edited));
    await waitFor(() => expect(result.current.kind).toBe('rails'));
  });
});

describe('while the switch is on', () => {
  it('a load of the classic store is converted into the rails store', async () => {
    const { result } = engines();
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    const first = railsStore.getState().doc!;
    act(() => boardStore.getState().load(other));
    expect(result.current.kind).not.toBe('rails');
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(railsStore.getState().doc).not.toBe(first);
    expect(railsStore.getState().loadCount).toBeGreaterThan(1);
  });

  it('a sections document opened is converted (from the section store’s document)', async () => {
    const { result } = engines();
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    const first = railsStore.getState().doc!;
    const r = await prepareSectionDoc(JSON.parse(swallowDoc));
    if (!r.ok) throw new Error(r.error);
    act(() => openSectionDoc(r.doc));
    await waitFor(() => expect(railsStore.getState().doc).not.toBe(first));
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(railsStore.getState().doc!.stations.length).toBe(r.doc.stations.length);
    expect(railsStore.getState().doc!.meta.name).toBe('Swallow shortboard');
  });
});

describe('documents that arrive whole', () => {
  it('a rails board is loaded into the rails store directly: no conversion, projection in the classic store', async () => {
    const board = await aRailsBoard();
    const { result } = engines();
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    act(() => openRailsBoard(board));
    // ready at once with that very board; nothing converts over it
    expect(result.current.kind).toBe('rails');
    expect(result.current.rails.converting).toBe(false);
    expect(result.current.sections.converting).toBe(false);
    expect(railsStore.getState().doc).toBe(board);
    expect(boardStore.getState().board).not.toBeNull();
    expect(currentRails()).toBe(board);
    await new Promise((r) => setTimeout(r, 50));
    expect(railsStore.getState().doc).toBe(board);
  });

  it('a restored session’s board attaches to the classic board loaded just before it', async () => {
    const board = await aRailsBoard();
    const { result } = engines({ nurbs: false, rails: false });
    act(() => {
      boardStore.getState().load(other);
      attachRailsBoard(board);
    });
    // the switches are turned on by the app after this: the board is there at once
    act(() => {});
    const on = renderHook(() => useDocumentEngines(true, true));
    expect(on.result.current.kind).toBe('rails');
    expect(railsStore.getState().doc).toBe(board);
    expect(result.current.kind).toBeDefined();
  });
});

describe('turning the switch off', () => {
  it('shows the section store as it was; the rails board keeps its edits', async () => {
    const { result, rerender } = engines({ nurbs: true, rails: false });
    await waitFor(() => expect(result.current.kind).toBe('sections'));
    const sections = sectionStore.getState().doc!;
    rerender({ nurbs: true, rails: true });
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    act(() => {
      railsStore.getState().addCrossSection(70);
    });
    const rails = railsStore.getState().doc!;
    rerender({ nurbs: true, rails: false });
    await waitFor(() => expect(result.current.kind).toBe('sections'));
    expect(sectionStore.getState().doc).toBe(sections);
    expect(railsStore.getState().doc).toBe(rails);
    expect(activeStore.target).toBe(sectionStore);
  });
});

describe('a board the converter refuses', () => {
  it('leaves the previous state as it was, with the reasons; a convertible board recovers', async () => {
    const { result } = engines();
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    const rails = railsStore.getState().doc!;
    act(() => boardStore.getState().load(refused));
    await waitFor(() => expect(result.current.refusal).not.toBeNull());
    expect(result.current.kind).toBe('classic');
    expect(result.current.refusal!.issues.some((i) => i.severity === 'error')).toBe(true);
    // the previous rails board is still in its store
    expect(railsStore.getState().doc).toBe(rails);
    act(() => boardStore.getState().load(other));
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(result.current.refusal).toBeNull();
  });

  it('is the converter’s own refusal when the rails conversion made it', async () => {
    boardStore.getState().load(refused);
    const { result } = renderHook(() => useRailsEngine(true, { ready: false, converting: false }));
    await waitFor(() => expect(result.current.refusal).not.toBeNull());
    expect(result.current.ready).toBe(false);
    expect(result.current.converting).toBe(false);
  });
});

describe('edits made while the board converts', () => {
  it('a drag in progress is waited out', async () => {
    act(() => boardStore.getState().beginEdit());
    const { result } = renderHook(() => useRailsEngine(true, { ready: false, converting: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.ready).toBe(false);
    act(() => boardStore.getState().endEdit());
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it('are in the board that lands: a conversion of an edited board is made again', async () => {
    const before = boardStore.getState().board!;
    const { result } = renderHook(() => useRailsEngine(true, { ready: false, converting: false }));
    expect(result.current.converting).toBe(true);
    const nose = before.outline.knots.length - 1;
    const end = before.outline.knots[nose]!.end;
    act(() => {
      boardStore.getState().moveControlPoint({ kind: 'outline' }, nose, vec2(end.x + 3, end.y));
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const knots = railsStore.getState().doc!.outline.plus.knots;
    expect(knots[knots.length - 1]!.p[0]).toBeCloseTo(end.x + 3, 1);
  });
});
