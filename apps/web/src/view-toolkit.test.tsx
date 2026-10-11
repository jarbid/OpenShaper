// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Component tests for ThreeDControls' guide toggles.
 *
 * Covers:
 *  - All three toggles render, in the compact (quad mini-pane) variant too.
 *  - Clicking each one patches only its own field.
 *  - An enabled toggle looks different from a disabled one.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseBrd } from '@openshaper/io';
import { splineLengthToX } from '@openshaper/kernel';
import { fmtLen, lengthUnitByKey } from './format';
import { longitudinalFor } from './longitudinal';
import sampleBrd from './sample-board.brd?raw';
import { boardStore } from './store';
import { makeReadout, MeasurementAxisSelect, ThreeDControls } from './view-toolkit';
import {
  ANALYSIS_3D,
  DEFAULT_VIEW_3D,
  EXACT_ANALYSIS_CONCAVE_TAIL,
  exactAnalysisUnavailable,
} from './view3d-settings';
import { swallowBoard } from './test/swallow-board';

describe('ThreeDControls guide toggles', () => {
  it('renders all three toggles', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apex' })).toBeTruthy();
  });

  it('renders all three toggles in the compact quad-view variant', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} compact />);
    expect(screen.getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apex' })).toBeTruthy();
  });

  it('patches only showStringer when Stringer is clicked', () => {
    const onChange = vi.fn();
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stringer' }));
    expect(onChange).toHaveBeenCalledWith({ showStringer: true });
  });

  it('patches only showSections when Sections is clicked', () => {
    const onChange = vi.fn();
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sections' }));
    expect(onChange).toHaveBeenCalledWith({ showSections: true });
  });

  it('patches only showApex when Apex is clicked, and turns it back off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apex' }));
    expect(onChange).toHaveBeenLastCalledWith({ showApex: true });

    rerender(
      <ThreeDControls settings={{ ...DEFAULT_VIEW_3D, showApex: true }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apex' }));
    expect(onChange).toHaveBeenLastCalledWith({ showApex: false });
  });

  it('turns a toggle back off', () => {
    const onChange = vi.fn();
    render(
      <ThreeDControls settings={{ ...DEFAULT_VIEW_3D, showSections: true }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sections' }));
    expect(onChange).toHaveBeenCalledWith({ showSections: false });
  });

  it('shows an enabled toggle as visually distinct from a disabled one', () => {
    const { rerender } = render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} />);
    const off = screen.getByRole('button', { name: 'Stringer' }).className;
    rerender(
      <ThreeDControls settings={{ ...DEFAULT_VIEW_3D, showStringer: true }} onChange={vi.fn()} />,
    );
    const on = screen.getByRole('button', { name: 'Stringer' }).className;
    expect(on).not.toBe(off);
  });
});

describe('ThreeDControls surface analysis', () => {
  const analysisSelect = () => screen.getByTitle(/^Surface analysis/) as HTMLSelectElement;
  const options = () => Array.from(analysisSelect().options);

  it('lists the exact modes and labels the screen-space one honestly', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} compact />);
    expect(options().map((o) => [o.value, o.textContent])).toEqual([
      ['none', 'No analysis'],
      ['zebra', 'Zebra'],
      ['mean-curvature', 'Mean curvature'],
      ['gaussian-curvature', 'Gaussian curvature'],
      ['rail-radius', 'Rail radius'],
      // The old screen-space mode keeps its stored id, so saved settings load.
      ['curvature', 'Normal change (approx.)'],
      ['slope', 'Slope'],
    ]);
    expect(options().every((o) => !o.disabled)).toBe(true);
  });

  it('patches the analysis when a mode is picked', () => {
    const onChange = vi.fn();
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={onChange} />);
    fireEvent.change(analysisSelect(), { target: { value: 'rail-radius' } });
    expect(onChange).toHaveBeenCalledWith({ analysis: 'rail-radius' });
  });

  it('disables the exact modes on a concave tail, saying why, and keeps the rest', () => {
    const block = exactAnalysisUnavailable(swallowBoard());
    expect(block?.reason).toBe(EXACT_ANALYSIS_CONCAVE_TAIL);
    render(
      <ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} exactUnavailable={block} />,
    );
    const exact = new Set(ANALYSIS_3D.filter((o) => o.exact).map((o) => o.value));
    expect(exact.size).toBe(3);
    for (const o of options()) {
      if (exact.has(o.value as never)) {
        expect(o.disabled).toBe(true);
        expect(o.title).toBe(EXACT_ANALYSIS_CONCAVE_TAIL);
        // Visible in the entry itself, for a phone with no hover.
        expect(o.textContent).toMatch(/\(not for concave tails\)$/);
      } else {
        expect(o.disabled).toBe(false);
      }
    }
    expect(analysisSelect().title).toContain(EXACT_ANALYSIS_CONCAVE_TAIL);
  });

  it('has nothing to disable on an ordinary board', () => {
    const { board } = parseBrd(sampleBrd);
    expect(exactAnalysisUnavailable(board)).toBeNull();
    expect(exactAnalysisUnavailable(null)).toBeNull();
  });
});

describe('MeasurementAxisSelect', () => {
  it('offers x-axis and o/curve measurements', () => {
    const onChange = vi.fn();
    render(<MeasurementAxisSelect value="x-axis" onChange={onChange} />);

    const select = screen.getByLabelText('Longitudinal measurement axis');
    expect(screen.getByRole('option', { name: 'x-axis' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'o/curve' })).toBeTruthy();

    fireEvent.change(select, { target: { value: 'o-curve' } });
    expect(onChange).toHaveBeenCalledWith('o-curve');
  });
});

describe('makeReadout over the curve', () => {
  const { board } = parseBrd(sampleBrd);
  const cm = lengthUnitByKey('cm');

  it('reports Pos along the bottom rocker, marked o/c', () => {
    boardStore.setState({ board });
    const [pos] = makeReadout(
      'rocker',
      cm,
      longitudinalFor(board.bottom, 'o-curve'),
    )({ x: 150, y: 0 });

    expect(pos!.label).toBe('Pos o/c');
    expect(pos!.value).toBe(fmtLen(splineLengthToX(board.bottom, 150), cm));
    // A board with rocker reads longer over the curve than straight.
    expect(splineLengthToX(board.bottom, 150)).toBeGreaterThan(150);
  });

  it('leaves Pos straight and unmarked on the x axis', () => {
    boardStore.setState({ board });
    const [pos] = makeReadout(
      'outline',
      cm,
      longitudinalFor(board.bottom, 'x-axis'),
    )({ x: 150, y: 0 });

    expect(pos!.label).toBe('Pos');
    expect(pos!.value).toBe(fmtLen(150, cm));
  });
});
