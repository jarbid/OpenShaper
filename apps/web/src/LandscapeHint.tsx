/**
 * A one-time nudge to turn a phone sideways.
 *
 * The editor's 2D views are length-wise: a 1879 x 544mm board is about 3.5:1, so
 * in a portrait pane the fit is width-constrained and most of the height goes
 * unused. Turning the phone trades that height for width.
 *
 * Measured in Chromium, maximized outline view, sample board:
 *
 *     portrait  360x780   canvas 334x451   2.14 px/cm  (turned nose-up)
 *     landscape 844x390   canvas 818x263   4.10 px/cm  (height-limited)
 *
 * 1.9x, for no work at all. It was 2.7x before the board turn shipped: portrait
 * is now drawn nose-up, which took it from 1.52 to 2.14 and shrank the prize for
 * rotating the device. Still the biggest single win available here, and still
 * free, but the gap is closing and this hint should be retired rather than
 * reworded if it ever stops being worth the row it occupies.
 *
 * Note the landscape number only holds because the header collapses to one row
 * and the sheet starts closed there — measured before those, landscape was
 * 1.32 px/cm, i.e. *worse* than portrait, and this hint was giving bad advice.
 * This comment has now been wrong twice by going stale. Re-measure before
 * trusting it.
 *
 * Deliberately inline rather than a `Toast`: `Toast` and `ConsentBanner` both sit
 * at `bottom-28 z-50`, and on a 360x780 first load the consent banner's own
 * buttons are already below the fold. A fourth thing anchored there would make a
 * known problem worse, and sitting in the chrome means this never has to wait for
 * the banner to be dismissed.
 */
import { Button } from '@openshaper/ui';
import { useEffect, useRef, useState } from 'react';
import { track } from './analytics';
import { useIsCoarsePointer, useIsPhone, useMediaQuery } from './useMediaQuery';

const DISMISSED_KEY = 'bs.landscapeHintSeen';

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Private browsing or a blocked store — the hint reappears next visit, which
    // is a milder failure than never showing it.
    return false;
  }
}

export function LandscapeHint() {
  const isPhone = useIsPhone();
  const isPortrait = useMediaQuery('(orientation: portrait)');
  // A narrow desktop window is phone-sized and portrait too, but it cannot be
  // turned: the hint is only for a device held in the hand.
  const isTouch = useIsCoarsePointer();
  const [dismissed, setDismissed] = useState(wasDismissed);

  // Only a portrait phone has something to gain. Turning the device satisfies the
  // hint on its own, so the condition doubles as the dismissal.
  const show = isPhone && isPortrait && isTouch && !dismissed;

  // StrictMode double-invokes effects; without this the impression is sent twice.
  const reportedShown = useRef(false);
  useEffect(() => {
    if (!show || reportedShown.current) return;
    reportedShown.current = true;
    track('landscape_hint', { action: 'shown' });
  }, [show]);

  if (!show) return null;

  const dismiss = () => {
    setDismissed(true);
    track('landscape_hint', { action: 'dismissed' });
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Same as above: worst case it asks again next time.
    }
  };

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">Turn your phone sideways for a bigger board.</span>
      <Button size="sm" variant="ghost" aria-label="Dismiss" className="shrink-0" onClick={dismiss}>
        ×
      </Button>
    </div>
  );
}
