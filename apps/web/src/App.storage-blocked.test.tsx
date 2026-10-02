/**
 * Regression (P5): blocked or full storage must not crash the editor or block work.
 *
 * The length-unit preference was read and written straight from localStorage during
 * render, so a browser that throws on storage access (site data blocked, some private
 * modes) replaced the whole editor with the error boundary. Settings saves threw on a
 * full quota, which aborted the export that triggered them.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { readRaw, readStored, writeRaw, writeStored } from './persisted';
import { boardStore } from './store';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

const blockStorage = () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage is disabled', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
};

afterEach(() => vi.restoreAllMocks());

describe('persistence helpers with storage that throws', () => {
  it('read as absent and report a failed write instead of throwing', () => {
    blockStorage();
    expect(readRaw('k')).toBeNull();
    expect(readStored('k', 'fallback', () => 'migrated')).toBe('fallback');
    expect(writeRaw('k', 'v')).toBe(false);
    expect(writeStored('k', { a: 1 })).toBe(false);
  });

  it('still work normally when storage works', () => {
    expect(writeStored('persisted-test', { a: 1 })).toBe(true);
    expect(readStored('persisted-test', null, (p) => p)).toEqual({ a: 1 });
    expect(writeRaw('persisted-raw', 'cm')).toBe(true);
    expect(readRaw('persisted-raw')).toBe('cm');
    localStorage.removeItem('persisted-test');
    localStorage.removeItem('persisted-raw');
  });
});

describe('<App /> with storage blocked', () => {
  it('mounts the editor and loads the board instead of crashing', async () => {
    blockStorage();
    render(<App />);
    expect(screen.getByText('File')).toBeTruthy();
    expect((await screen.findAllByText(/\d+\.\dL/)).length).toBeGreaterThan(0);
    expect(boardStore.getState().board).not.toBeNull();
  });
});
