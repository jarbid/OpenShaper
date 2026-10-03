/**
 * P34: every editor dialog is a real modal dialog for keyboard and screen-reader
 * users: named `role="dialog"` with `aria-modal`, Escape to dismiss, Tab kept
 * inside, and focus returned to what opened it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../SettingsDialog';
import { DEFAULT_SETTINGS } from '../settings';
import { Modal } from './modal';

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <Modal
          name="test"
          label="Test dialog"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          className="grid place-items-center"
        >
          <div onClick={(e) => e.stopPropagation()}>
            <button>first</button>
            <button>last</button>
          </div>
        </Modal>
      )}
    </>
  );
}

describe('<Modal /> (P34)', () => {
  it('is a named modal dialog and takes focus', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and gives focus back to the opener', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('open'));
    const first = screen.getByText('first');
    const last = screen.getByText('last');

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes on a backdrop click but not a click inside', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('first'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('dialogs that had no Escape (P34)', () => {
  it('Settings closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <SettingsDialog settings={DEFAULT_SETTINGS} onSave={() => {}} onClose={onClose} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
