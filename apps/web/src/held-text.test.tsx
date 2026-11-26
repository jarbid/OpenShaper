// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rails board's text that a restored session could not read is held for the classic board loaded with
 * it: no engine converts that board over the text, the autosave writes the text back, a notice says so,
 * and any other board loaded ends the hold. (No Worker in jsdom: conversions run through the client's
 * synchronous fallback.)
 */
import { parseBrd, parseS3dx } from '@openshaper/io';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pointedS3dx from '../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import { HeldRailsNotice, heldRailsNotice } from './HeldRailsNotice';
import { heldFor, holdText, keptRailsFor, releaseHeld } from './held-text';
import { resetRailsEngine, useRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { boardStore, railsStore, sectionStore } from './store';
import {
  currentSections,
  holdSectionsText,
  resetSectionEngine,
  useSectionEngine,
} from './use-section-engine';

const sample = parseBrd(sampleBrd).board;
const other = parseS3dx(pointedS3dx).board;

/** A rails board of a version this app does not read. */
const NEWER = JSON.stringify({ format: 'openshaper', version: 99, model: 'rails' });
/** What a sections document's text looks like to the hold: not a rails board. */
const SECTIONS = JSON.stringify({ format: 'openshaper', version: 3, model: 'sections' });

// The synchronous fallback loads the compute module on first use (board2 and geom): do that once, up front.
beforeAll(async () => {
  await import('./workers/nurbs-core');
}, 60_000);

beforeEach(() => {
  resetSectionEngine();
  resetRailsEngine();
  sectionStore.setState({ doc: null, board: null });
  railsStore.setState({ doc: null, board: null, slices: null });
  boardStore.getState().load(sample);
});

/** Both engines, as `useDocumentEngines` runs them with both switches on. */
const bothEngines = () =>
  renderHook(() => {
    const sections = useSectionEngine(true);
    const rails = useRailsEngine(true, sections);
    return { sections, rails };
  });

/** Long enough for a conversion that was going to happen to have happened. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 400)));

describe('the held text', () => {
  it('belongs to the classic board that was open when it was held', () => {
    holdText(NEWER, 'invalid');
    const loadCount = boardStore.getState().loadCount;
    expect(heldFor(loadCount)).toBe(NEWER);
    expect(keptRailsFor(loadCount)).toMatchObject({ rails: true, reason: 'invalid' });
    boardStore.getState().load(other);
    expect(heldFor(boardStore.getState().loadCount)).toBeNull();
    expect(keptRailsFor(boardStore.getState().loadCount)).toBeNull();
  });

  it('is kept only when it is a rails board: a sections text is still revived or converted over', () => {
    holdText(SECTIONS);
    expect(heldFor(boardStore.getState().loadCount)).toBe(SECTIONS);
    expect(keptRailsFor(boardStore.getState().loadCount)).toBeNull();
    holdText('not json at all');
    expect(keptRailsFor(boardStore.getState().loadCount)).toBeNull();
  });

  it('can be let go', () => {
    holdText(NEWER);
    releaseHeld();
    expect(heldFor(boardStore.getState().loadCount)).toBeNull();
  });
});

describe('a rails text that would not read', () => {
  it('is not converted over by the section engine, which is not converting either', async () => {
    holdSectionsText(NEWER, 'invalid');
    const { result } = renderHook(() => useSectionEngine(true));
    await settle();
    expect(result.current).toEqual({ ready: false, refusal: null, converting: false });
    expect(sectionStore.getState().doc).toBeNull();
    // what the next autosave writes is the saved text
    expect(currentSections()).toEqual({ text: NEWER });
  });

  it('is not converted over by the rails engine either', async () => {
    holdSectionsText(NEWER, 'invalid');
    const { result } = bothEngines();
    await settle();
    expect(result.current.sections).toEqual({ ready: false, refusal: null, converting: false });
    expect(result.current.rails).toEqual({ ready: false, refusal: null, converting: false });
    expect(sectionStore.getState().doc).toBeNull();
    expect(railsStore.getState().doc).toBeNull();
    expect(currentSections()).toEqual({ text: NEWER });
  });

  it('is kept whichever way it did not read: the code would not load, too', async () => {
    holdSectionsText(NEWER, 'unavailable');
    const { result } = bothEngines();
    await settle();
    expect(result.current.sections.converting).toBe(false);
    expect(result.current.rails.converting).toBe(false);
    expect(railsStore.getState().doc).toBeNull();
    expect(currentSections()).toEqual({ text: NEWER });
  });

  it('is let go when another board is loaded: both engines convert that one', async () => {
    holdSectionsText(NEWER, 'invalid');
    const { result } = bothEngines();
    await settle();
    expect(railsStore.getState().doc).toBeNull();

    act(() => boardStore.getState().load(other));
    await waitFor(() => expect(result.current.rails.ready).toBe(true), { timeout: 30_000 });
    expect(railsStore.getState().doc).not.toBeNull();
    // the autosave now has the new board's document, not the held text
    expect(currentSections()).not.toEqual({ text: NEWER });
  }, 60_000);

  it('does not hold up a sections text that is not a document: the classic board is converted instead', async () => {
    holdSectionsText(SECTIONS);
    const { result } = renderHook(() => useSectionEngine(true));
    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: 30_000 });
    expect(sectionStore.getState().doc).not.toBeNull();
  }, 60_000);
});

describe('the notice', () => {
  it('says why the text was not read, and that it is kept', () => {
    const read = heldRailsNotice('invalid');
    expect(read).toMatch(/could not be read — it may be from a newer OpenShaper/);
    expect(read).toMatch(/kept unchanged/);
    expect(read).toMatch(/saving writes a classic file/);
    expect(read).toMatch(/open or start another board to replace the saved one/);
    const loaded = heldRailsNotice('unavailable');
    expect(loaded).toMatch(/could not be loaded/);
    expect(loaded).toMatch(/Reload to try again/);
    // the reader's reason is not known: the words for a text that would not read
    expect(heldRailsNotice(null)).toBe(read);
  });

  it('is shown for the held text, put away by a click, and gone with the hold', async () => {
    render(<HeldRailsNotice />);
    expect(screen.queryByTestId('rails-held')).toBeNull();

    act(() => holdSectionsText(NEWER, 'invalid'));
    const notice = await screen.findByTestId('rails-held');
    expect(notice.textContent).toBe(heldRailsNotice('invalid'));
    expect(notice.getAttribute('role')).toBe('alert');

    act(() => notice.click());
    expect(screen.queryByTestId('rails-held')).toBeNull();

    // a text held again is told again
    act(() => holdSectionsText(NEWER, 'unavailable'));
    expect((await screen.findByTestId('rails-held')).textContent).toBe(
      heldRailsNotice('unavailable'),
    );

    // another board loaded ends the hold, and the notice with it
    act(() => boardStore.getState().load(other));
    expect(screen.queryByTestId('rails-held')).toBeNull();
  });

  it('is not shown for a text that is held to be revived', () => {
    render(<HeldRailsNotice />);
    act(() => holdSectionsText(SECTIONS));
    expect(screen.queryByTestId('rails-held')).toBeNull();
  });
});
