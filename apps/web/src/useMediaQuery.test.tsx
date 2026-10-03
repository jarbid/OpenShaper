import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setTier, setViewport } from './test/viewport';
import { useIsDesktop, useIsPhone } from './useMediaQuery';

/** Record what the hook returned on every render, first render included. */
function trackTier(hook: () => boolean) {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(hook());
    return null;
  }
  const view = render(<Probe />);
  return { seen, rerender: () => view.rerender(<Probe />) };
}

describe('layout tiers', () => {
  it('is right on the first render, not a frame later', () => {
    // The whole point of reading matchMedia synchronously: a tier that settles
    // in an effect reports `false` first, so a desktop paints the compact layout
    // for a frame and a phone paints a view it should not have.
    setTier('phone');
    const { seen } = trackTier(useIsPhone);
    expect(seen[0], 'phone tier should be known on the very first render').toBe(true);
    expect(seen.every(Boolean), 'the value should never flip after mount').toBe(true);
  });

  it('treats a narrow portrait phone as a phone', () => {
    setTier('phone');
    expect(trackTier(useIsPhone).seen.at(-1)).toBe(true);
    expect(trackTier(useIsDesktop).seen.at(-1)).toBe(false);
  });

  it('treats a landscape phone as a phone — it is short, not narrow', () => {
    // 844x390: wide enough to pass a width-only test, far too short for a
    // column of stacked panes.
    setTier('phoneLandscape');
    expect(trackTier(useIsPhone).seen.at(-1)).toBe(true);
  });

  it('hands over to Tailwind sm exactly at 640px, with no overlap (P18)', () => {
    // `sm:` styles start at min-width 640px, so 640 itself must not be a phone.
    setViewport(640, 900);
    expect(trackTier(useIsPhone).seen.at(-1)).toBe(false);
    setViewport(639, 900);
    expect(trackTier(useIsPhone).seen.at(-1)).toBe(true);
  });

  it('does not treat a tablet as a phone', () => {
    setTier('tablet');
    expect(trackTier(useIsPhone).seen.at(-1)).toBe(false);
    expect(trackTier(useIsDesktop).seen.at(-1)).toBe(false);
  });

  it('treats a desktop as desktop and not a phone', () => {
    setTier('desktop');
    expect(trackTier(useIsPhone).seen.at(-1)).toBe(false);
    expect(trackTier(useIsDesktop).seen.at(-1)).toBe(true);
  });

  it('follows the viewport when it changes', () => {
    setTier('desktop');
    const { seen } = trackTier(useIsPhone);
    expect(seen.at(-1)).toBe(false);
    act(() => setViewport(360, 780));
    expect(seen.at(-1), 'rotating or resizing should re-tier without a remount').toBe(true);
  });
});
