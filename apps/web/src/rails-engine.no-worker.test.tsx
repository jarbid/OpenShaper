// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A browser where the NURBS worker cannot be made (`new Worker` throws: blocked by a policy, or offline): a
 * conversion is refused with the reason, nothing is left half-made, and the classic board stays the one
 * edited. A rails board that arrives whole needs no worker and is edited as usual.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openRailsBoard, resetRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import { useDocumentEngines } from './use-document-engines';
import { resetSectionEngine } from './use-section-engine';

type Core = typeof import('./workers/nurbs-core');
let core: Core;
let arrived: RailsBoard;
beforeAll(async () => {
  core = await import('./workers/nurbs-core');
  const d = core.docFromJson(JSON.parse(swallowDoc));
  if (!d.ok) throw new Error(d.error);
  const made = core.toRails({ doc: d.doc });
  if (!made.ok) throw new Error(made.error);
  arrived = made.board;
}, 60_000);

const globals = globalThis as { Worker?: unknown };
const hadWorker = 'Worker' in globals;
const saved = globals.Worker;

beforeEach(() => {
  globals.Worker = class {
    constructor() {
      throw new Error('Workers are blocked here.');
    }
  };
  resetSectionEngine();
  resetRailsEngine();
  sectionStore.setState({ doc: null, board: null });
  railsStore.setState({ doc: null, board: null, slices: null });
  activeStore.use(boardStore);
  boardStore.getState().load(parseBrd(sampleBrd).board);
});

afterEach(() => {
  if (hadWorker) globals.Worker = saved;
  else delete globals.Worker;
});

describe('no worker', () => {
  it('a conversion is refused with the reason, and the classic board stays edited', async () => {
    const { result } = renderHook(() => useDocumentEngines(true, true));
    await waitFor(() => expect(result.current.refusal).not.toBeNull());
    expect(result.current.refusal!.error).toMatch(/Workers are blocked/);
    expect(result.current.kind).toBe('classic');
    expect(activeStore.target).toBe(boardStore);
    expect(result.current.rails.converting).toBe(false);
  });

  it('a rails board that arrives whole is edited without one', async () => {
    const { result } = renderHook(() => useDocumentEngines(true, true));
    act(() => openRailsBoard(arrived));
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(activeStore.target).toBe(railsStore);
    act(() => railsStore.getState().addCrossSection(80));
    expect(railsStore.getState().doc!.stations.length).toBe(arrived.stations.length + 1);
  });
});
