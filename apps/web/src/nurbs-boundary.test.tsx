// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS layer is a lazy chunk behind a persisted setting. A chunk that will not
 * load must stay a local failure (a note, the classic view), never reach the route's
 * error screen: with the setting saved, that would stop the whole editor loading
 * offline.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from './analytics';
import { NURBS_UNAVAILABLE_TEXT, NurbsBoundary } from './nurbs-boundary';

vi.mock('./analytics', () => ({ captureError: vi.fn() }));

describe('NurbsBoundary', () => {
  beforeEach(() => {
    vi.mocked(captureError).mockClear();
    // React logs a caught render error; the test expects one.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows a note and keeps the rest of the page when the lazy import rejects', async () => {
    const Layer = lazy(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module')),
    );
    const onFail = vi.fn();
    render(
      <div>
        <p>classic 3D view</p>
        <NurbsBoundary onFail={onFail}>
          <Suspense fallback={null}>
            <Layer />
          </Suspense>
        </NurbsBoundary>
      </div>,
    );
    await waitFor(() => expect(screen.getByTestId('nurbs-unavailable')).toBeTruthy());
    expect(screen.getByTestId('nurbs-unavailable').textContent).toBe(NURBS_UNAVAILABLE_TEXT);
    expect(screen.getByText('classic 3D view')).toBeTruthy();
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith('nurbs_layer', expect.any(Error));
  });

  it('also catches a layer that throws while rendering', async () => {
    const Broken = () => {
      throw new Error('boom');
    };
    render(
      <NurbsBoundary>
        <Broken />
      </NurbsBoundary>,
    );
    await waitFor(() => expect(screen.getByTestId('nurbs-unavailable')).toBeTruthy());
  });

  it('renders its children untouched when nothing fails', () => {
    render(
      <NurbsBoundary>
        <p>layer</p>
      </NurbsBoundary>,
    );
    expect(screen.getByText('layer')).toBeTruthy();
    expect(screen.queryByTestId('nurbs-unavailable')).toBeNull();
  });
});
