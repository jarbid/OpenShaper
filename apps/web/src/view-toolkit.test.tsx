// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Component tests for ThreeDControls' guide toggles.
 *
 * Covers:
 *  - Both toggles render, in the compact (quad mini-pane) variant too.
 *  - Clicking each one patches only its own field.
 *  - An enabled toggle looks different from a disabled one.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreeDControls } from './view-toolkit';
import { DEFAULT_VIEW_3D } from './view3d-settings';

describe('ThreeDControls guide toggles', () => {
  it('renders both toggles', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeTruthy();
  });

  it('renders both toggles in the compact quad-view variant', () => {
    render(<ThreeDControls settings={DEFAULT_VIEW_3D} onChange={vi.fn()} compact />);
    expect(screen.getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeTruthy();
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
