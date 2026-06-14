import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { SettingsDialog } from './SettingsDialog';

beforeEach(() => {
  localStorage.clear();
});

describe('<SettingsDialog />', () => {
  it('renders without crashing and shows the title', () => {
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/settings/i)).toBeTruthy();
  });

  it('shows color inputs for all curve / overlay fields', () => {
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />);
    // There should be 6 color inputs (outline, deck, bottom, cross-section, ghost, grid).
    const colorInputs = document.querySelectorAll('input[type="color"]');
    expect(colorInputs.length).toBeGreaterThanOrEqual(6);
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={onClose} />);
    const closeBtn = screen.getByTitle(/close/i);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onSave with updated settings when Apply is clicked', () => {
    const onSave = vi.fn();
    render(<SettingsDialog settings={DEFAULT_SETTINGS} onSave={onSave} onClose={vi.fn()} />);
    // Change the outline color.
    const outlineInput = screen.getByLabelText(/outline/i) as HTMLInputElement;
    fireEvent.change(outlineInput, { target: { value: '#ff0000' } });
    // Apply.
    fireEvent.click(screen.getByText(/apply/i));
    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0]![0];
    expect(saved.outlineColor).toBe('#ff0000');
  });

  it('resets to defaults when "Reset to defaults" is clicked', () => {
    const onSave = vi.fn();
    const modified = { ...DEFAULT_SETTINGS, outlineColor: '#ff0000' };
    render(<SettingsDialog settings={modified} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/reset to defaults/i));
    fireEvent.click(screen.getByText(/apply/i));
    const saved = onSave.mock.calls[0]![0];
    expect(saved.outlineColor).toBe(DEFAULT_SETTINGS.outlineColor);
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SettingsDialog settings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={onClose} />,
    );
    // The outermost div is the backdrop.
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
