// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Bottom slice against the real rails store: the section and the relief strip it draws, with its
 * magnification written on it, and the one handle, the chosen contour's depth: dragged or stepped by a key it sets
 * the depth as the panel's dial does (one undo step), off with the reason where the station has too little of the
 * contour, and held at the most the board allows.
 */
import type { RailsBoard } from '@openshaper/board2';
import { contourDials, contoursOf } from '@openshaper/store/rails';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { publishProbes, resetProbes } from '../nurbs-probes';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { getBottomStatus, resetBottomChoice, setChosenContour } from './bottom-choice';
import { BottomSlice } from './BottomSlice';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];
/** The station in the middle of the board, inside a concave through the middle third; its classic slice index. */
const SLICE = 3;
const pointer = { pointerId: 6, isPrimary: true, button: 0 };

const doc = () => railsStore.getState().doc as RailsBoard;
const labels = () => railsStore.getState().past.map((p) => p.label);
const handle = () => screen.getByRole('slider', { name: 'Depth' });
const depth = () => contoursOf(doc())[0]!.depth;
/** The handle's centre, px from the top of the drawing. */
const centre = () => Number.parseFloat(handle().style.top) + 8;
const addConcave = () => {
  act(() => {
    railsStore.getState().addContour('single-concave');
  });
};

beforeEach(async () => {
  localStorage.clear();
  resetBottomChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetBottomChoice();
  resetProbes();
  publishProbes([]);
  activeStore.use(boardStore);
});

describe('a board with no contour', () => {
  it('draws the section alone and says the bottom is flat, with no handle', () => {
    render(<BottomSlice units={CM} slice={SLICE} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Section of the board');
    expect(screen.queryByTestId('relief-strip')).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Depth' })).toBeNull();
    expect(screen.getByText(/No contour: the bottom is flat across/)).toBeTruthy();
  });

  it('says there is nothing to draw at the end slices', () => {
    render(<BottomSlice units={CM} slice={0} />);
    expect(screen.getByText(/Nothing to draw here/)).toBeTruthy();
  });
});

describe('with a contour', () => {
  it('draws the relief strip under the section with its magnification written on it', () => {
    addConcave();
    const { container } = render(<BottomSlice units={CM} slice={SLICE} />);
    const strip = screen.getByTestId('relief-strip');
    expect(strip.textContent).toMatch(
      /Contour relief, height ×\d+ \(the section above is true scale\)/,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(
      /relief of the contour magnified \d+ times/,
    );
    expect(strip.textContent).toContain('Depth 3 mm'.replace('3 mm', '0.3 cm'));
    // the bottom curve of the station is drawn on both sides of the stringer
    expect(container.querySelectorAll('svg g.stroke-primary path')).toHaveLength(2);
    expect(strip.querySelectorAll('path').length).toBeGreaterThanOrEqual(4);
  });

  it('has a handle that is a vertical slider reading the depth in the display unit', () => {
    addConcave();
    render(<BottomSlice units={CM} slice={SLICE} />);
    const h = handle();
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(Number(h.getAttribute('aria-valuenow'))).toBeCloseTo(depth(), 9);
    const d = contourDials(doc(), 'single-concave')!.depth;
    expect(Number(h.getAttribute('aria-valuemax'))).toBeCloseTo(d.max, 9);
    expect(h.getAttribute('aria-disabled')).toBe('false');
  });

  it('sets the depth when it is dragged, the whole drag one undo step, and the handle follows', () => {
    addConcave();
    render(<BottomSlice units={CM} slice={SLICE} />);
    const from = centre();
    fireEvent.pointerDown(handle(), { ...pointer, clientX: 100, clientY: from });
    fireEvent.pointerMove(handle(), { ...pointer, clientX: 100, clientY: from - 10 });
    const up = depth();
    expect(up).toBeGreaterThan(0.3);
    fireEvent.pointerMove(handle(), { ...pointer, clientX: 100, clientY: from - 25 });
    expect(depth()).toBeGreaterThan(up);
    fireEvent.pointerUp(handle(), { ...pointer, clientX: 100, clientY: from - 25 });
    expect(labels()).toEqual(['Add Single concave', 'Set depth of single concave']);
    expect(centre()).toBeLessThan(from);
    act(() => railsStore.getState().undo());
    expect(depth()).toBeCloseTo(0.3, 9);
  });

  it('is held at the most the board allows, and says so', () => {
    addConcave();
    render(<BottomSlice units={CM} slice={SLICE} />);
    fireEvent.pointerDown(handle(), { ...pointer, clientY: centre() });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: centre() - 5000 });
    fireEvent.pointerUp(handle(), { ...pointer, clientY: centre() });
    const d = contourDials(doc(), 'single-concave')!.depth;
    expect(depth()).toBeCloseTo(d.max, 9);
    expect(getBottomStatus()).toMatch(/Held at the most this board allows here/);
  });

  it('is stepped by the arrow keys, up deeper, a held key one undo step', () => {
    addConcave();
    render(<BottomSlice units={CM} slice={SLICE} />);
    const h = handle();
    fireEvent.keyDown(h, { key: 'ArrowUp' });
    fireEvent.keyDown(h, { key: 'ArrowUp' });
    fireEvent.keyDown(h, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(h, { key: 'ArrowUp' });
    expect(depth()).toBeCloseTo(0.3 + 0.02 + 0.02 + 0.1, 9);
    expect(labels()).toEqual(['Add Single concave', 'Set depth of single concave']);
    fireEvent.keyDown(h, { key: 'ArrowDown' });
    fireEvent.keyUp(h, { key: 'ArrowDown' });
    expect(depth()).toBeCloseTo(0.3 + 0.14 - 0.02, 9);
    fireEvent.keyDown(h, { key: 'Home' });
    fireEvent.keyUp(h, { key: 'Home' });
    expect(depth()).toBe(0);
    fireEvent.keyDown(h, { key: 'End' });
    fireEvent.keyUp(h, { key: 'End' });
    expect(depth()).toBeCloseTo(contourDials(doc(), 'single-concave')!.depth.max, 9);
  });

  it('is off, with the reason, at a station where the contour has too little depth, and for a contour switched off', () => {
    addConcave();
    const { rerender } = render(<BottomSlice units={CM} slice={1} />);
    // the first station is outside a concave through the middle third
    expect(handle().getAttribute('aria-disabled')).toBe('true');
    expect(handle().getAttribute('title')).toMatch(/too little depth here/);
    expect(screen.getByTestId('outside-run').textContent).toMatch(
      /^Single concave runs .* to .*: choose a station along it\.$/,
    );
    expect(screen.getByTestId('relief-strip').textContent).not.toContain('Depth 0.3');
    const before = doc();
    fireEvent.pointerDown(handle(), { ...pointer, clientY: centre() });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: centre() - 20 });
    expect(doc()).toBe(before);
    rerender(<BottomSlice units={CM} slice={SLICE} />);
    expect(screen.queryByTestId('outside-run')).toBeNull();
    expect(handle().getAttribute('aria-disabled')).toBe('false');
    act(() => railsStore.getState().setFeatureEnabled('single-concave', false));
    expect(handle().getAttribute('aria-disabled')).toBe('true');
    expect(handle().getAttribute('title')).toMatch(/switched off/);
  });

  it('follows the chosen contour', () => {
    act(() => {
      railsStore.getState().addContour('single-concave');
      railsStore.getState().addContour('vee');
    });
    render(<BottomSlice units={CM} slice={SLICE} />);
    // the first contour is the one chosen when none is named
    const first = centre();
    expect(screen.getByTestId('relief-strip').textContent).toMatch(/Depth 0\.3 cm/);
    act(() => setChosenContour('vee'));
    // the vee’s run ends at this station: it has too little depth here, and the strip says where it runs
    expect(screen.getByTestId('outside-run').textContent).toMatch(/^Vee runs/);
    expect(centre()).not.toBe(first);
  });
});
