// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The reporting half of the route error screen.
 *
 * Worth pinning because the failure it guards against is invisible by
 * construction: a React error boundary *consumes* the error, so nothing here
 * reaches `window.onerror` and posthog-js's unhandled-error capture never fires.
 * If this reporting call were dropped in a refactor, no test and no dashboard
 * would notice — a chunk that stops loading after a deploy would simply show a
 * nice screen to everyone and produce no signal at all.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from './analytics';
import { RouteErrorBoundary } from './RouteErrorBoundary';

vi.mock('./analytics', () => ({ captureError: vi.fn() }));

let routeError: unknown = null;
vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useRouteError: () => routeError,
}));

describe('RouteErrorBoundary', () => {
  beforeEach(() => {
    vi.mocked(captureError).mockClear();
  });

  it('reports the error the boundary swallowed', () => {
    const error = new Error('Failed to fetch dynamically imported module');
    routeError = error;
    render(<RouteErrorBoundary />);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith('route_error', error);
  });

  it('reports once, not once per render', () => {
    routeError = new Error('boom');
    const { rerender } = render(<RouteErrorBoundary />);
    rerender(<RouteErrorBoundary />);
    rerender(<RouteErrorBoundary />);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it('reports a non-Error throw, which react-router will happily hand over', () => {
    routeError = 'a bare string';
    render(<RouteErrorBoundary />);
    expect(captureError).toHaveBeenCalledWith('route_error', 'a bare string');
  });

  it('sends nothing when there is no error to report', () => {
    routeError = null;
    render(<RouteErrorBoundary />);
    expect(captureError).not.toHaveBeenCalled();
  });

  it('still shows the recovery screen', () => {
    routeError = new Error('boom');
    render(<RouteErrorBoundary />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});
