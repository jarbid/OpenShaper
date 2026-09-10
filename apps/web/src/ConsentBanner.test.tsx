import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentBanner } from './ConsentBanner';
import { setConsent } from './consent';

vi.mock('./analytics', () => ({
  track: vi.fn(),
  upgradeToFullTracking: vi.fn(),
}));

const renderBanner = () =>
  render(
    <MemoryRouter>
      <ConsentBanner />
    </MemoryRouter>,
  );

const bar = () => screen.queryByRole('region', { name: 'Analytics consent' });
/** The bar is always mounted while undecided; it slides in via transform. */
const isOnScreen = () => bar()?.className.includes('translate-y-0') ?? false;

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('ConsentBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = 'bs.consent=; path=/; max-age=0';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('slides in shortly after the first page load, not instantly', () => {
    renderBanner();
    expect(isOnScreen()).toBe(false);
    advance(2000);
    expect(isOnScreen()).toBe(true);
  });

  // The whole point of the bar: ignoring it is not a way to dismiss it.
  it('stays up indefinitely while the visitor ignores it', () => {
    renderBanner();
    advance(2000);
    advance(60 * 60 * 1000);
    expect(isOnScreen()).toBe(true);
  });

  /**
   * A hard reload remounts the component, which would otherwise restart the
   * delay and briefly hide a bar the visitor has already been shown. In-app
   * navigation never unmounts it at all (it lives in RootLayout).
   */
  it('is already up on the next page load, with no second delay', () => {
    const first = renderBanner();
    advance(2000);
    first.unmount();

    renderBanner();
    expect(isOnScreen()).toBe(true);
  });

  it.each(['accepted', 'rejected'] as const)('disappears once %s', (choice) => {
    renderBanner();
    advance(2000);
    act(() => {
      setConsent(choice);
    });
    expect(bar()).toBeNull();
  });

  it('never appears for a visitor who already decided', () => {
    setConsent('accepted');
    renderBanner();
    advance(2000);
    expect(bar()).toBeNull();
  });
});
