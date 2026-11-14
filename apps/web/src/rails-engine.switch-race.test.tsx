// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails switch turned on while the section engine is still converting the open board: the rails
 * conversion waits for it and is made from the section document, once; and a file loaded meanwhile is the
 * one that lands. The switch turned off and on again around a section edit or a load. No Worker in jsdom:
 * conversions run through the client's synchronous fallback.
 */
import { parseBrd, parseS3dx } from '@openshaper/io';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import pointedS3dx from '../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import { resetRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import { useDocumentEngines } from './use-document-engines';
import { resetSectionEngine } from './use-section-engine';

const sample = parseBrd(sampleBrd).board;
const other = parseS3dx(pointedS3dx).board;

beforeEach(() => {
  resetSectionEngine();
  resetRailsEngine();
  sectionStore.setState({ doc: null, board: null });
  railsStore.setState({ doc: null, board: null, slices: null });
  activeStore.use(boardStore);
  boardStore.getState().load(sample);
});

describe('the switch turned on while the section engine converts', () => {
  it('the rails board is made from the section document of the open board', async () => {
    const { result, rerender } = renderHook(({ rails }) => useDocumentEngines(true, rails), {
      initialProps: { rails: false },
    });
    expect(result.current.sections.converting).toBe(true);
    rerender({ rails: true });
    expect(result.current.rails.converting).toBe(true);
    await waitFor(() => expect(result.current.kind).toBe('rails'), { timeout: 20_000 });
    const sections = sectionStore.getState().doc!;
    expect(sections).not.toBeNull();
    expect(railsStore.getState().doc!.stations.length).toBe(sections.stations.length);
    expect(activeStore.target).toBe(railsStore);
  }, 30_000);

  it('a file loaded before either lands is the one converted', async () => {
    const { result, rerender } = renderHook(({ rails }) => useDocumentEngines(true, rails), {
      initialProps: { rails: false },
    });
    rerender({ rails: true });
    act(() => boardStore.getState().load(other));
    const loadCount = boardStore.getState().loadCount;
    await waitFor(() => expect(result.current.kind).toBe('rails'), { timeout: 20_000 });
    // the rails board is the other board's: its length, not the sample's
    const length = (b: { outline: { knots: readonly { end: { x: number } }[] } }) =>
      b.outline.knots[b.outline.knots.length - 1]!.end.x;
    expect(length(railsStore.getState().board!)).toBeCloseTo(length(other), 0);
    expect(boardStore.getState().loadCount).toBe(loadCount);
  }, 30_000);
});

describe('the switch turned off and on again', () => {
  // Unskip when a section edit made while the switch is off reaches the rails board when it is turned on
  // again (or is reported as dropped). Today the rails board is still the open document's, so it is shown
  // as it was and the section edit is silently left behind; which edits win is a design decision.
  it.skip('a section edit made while it was off is in the rails board', async () => {
    const { result, rerender } = renderHook(({ rails }) => useDocumentEngines(true, rails), {
      initialProps: { rails: true },
    });
    await waitFor(() => expect(result.current.kind).toBe('rails'), { timeout: 20_000 });
    const stations = railsStore.getState().doc!.stations.length;
    rerender({ rails: false });
    await waitFor(() => expect(result.current.kind).toBe('sections'), { timeout: 20_000 });
    act(() => sectionStore.getState().addCrossSection(70));
    rerender({ rails: true });
    await waitFor(() => expect(result.current.kind).toBe('rails'));
    expect(railsStore.getState().doc!.stations.length).toBe(stations + 1);
  }, 30_000);

  it('another file loaded while it was off is converted, and replaces the rails board', async () => {
    const { result, rerender } = renderHook(({ rails }) => useDocumentEngines(true, rails), {
      initialProps: { rails: true },
    });
    await waitFor(() => expect(result.current.kind).toBe('rails'), { timeout: 20_000 });
    const first = railsStore.getState().doc!;
    act(() => railsStore.getState().addCrossSection(70));
    rerender({ rails: false });
    await waitFor(() => expect(result.current.kind).toBe('sections'), { timeout: 20_000 });
    act(() => boardStore.getState().load(other));
    rerender({ rails: true });
    await waitFor(() => expect(result.current.kind).toBe('rails'), { timeout: 20_000 });
    expect(railsStore.getState().doc).not.toBe(first);
    expect(railsStore.getState().past.length).toBe(0);
    const length = (b: { outline: { knots: readonly { end: { x: number } }[] } }) =>
      b.outline.knots[b.outline.knots.length - 1]!.end.x;
    expect(length(railsStore.getState().board!)).toBeCloseTo(length(other), 0);
  }, 30_000);
});
