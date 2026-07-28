/**
 * Non-blocking, site-wide consent bar. Shown to every visitor until they
 * decide; never re-shown once a choice is made. Doesn't gate access to
 * anything — the anonymous analytics baseline (see analytics.ts) keeps
 * running whether or not the visitor ever interacts with this.
 *
 * Slides into view rather than appearing instantly, so it's more likely to
 * actually be noticed. On the first page load of a browsing session it waits
 * before sliding in; on any later page (still undecided) it's shown right
 * away — tracked via a sessionStorage flag as a backstop for hard reloads,
 * on top of this component naturally staying mounted across in-app
 * navigation (it lives in RootLayout, which React Router keeps mounted while
 * only the routed page content underneath it changes).
 *
 * `bottom-28` (matching `Toast`'s clearance) keeps this above the /app
 * editor's mobile bottom sheet, which is always present below `lg` at a
 * minimum height of `PEEK_PX` (`packages/ui/src/components/sheet.tsx`) —
 * same anchor and z-order otherwise, so without this offset the banner sits
 * directly on top of it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button, cn } from '@openshaper/ui';
import { getConsent, setConsent, subscribeConsent } from './consent';
import { upgradeToFullTracking } from './analytics';

const SEEN_KEY = 'bs.consentBannerSeen';
const FIRST_DELAY_MS = 15000;

export function ConsentBanner() {
  const consent = useSyncExternalStore(subscribeConsent, getConsent, () => null);
  const [visible, setVisible] = useState(() => {
    try {
      return sessionStorage.getItem(SEEN_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => {
      setVisible(true);
      try {
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch {
        // sessionStorage unavailable (private browsing, quota) — the delay
        // just resets on the next mount, which is a harmless fallback.
      }
    }, FIRST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  if (consent !== null) return null;

  return (
    <div
      role="region"
      aria-label="Analytics consent"
      className={cn(
        'fixed inset-x-0 bottom-28 z-50 border-t border-border bg-card px-4 py-3 text-card-foreground shadow-lg transition-transform duration-500 ease-out lg:bottom-0',
        visible ? 'translate-y-0 pointer-events-auto' : 'translate-y-full pointer-events-none',
      )}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Hi — I&apos;m building OpenShaper solo, and seeing how it&apos;s really used helps me know
          what to build next. Accepting lets me see richer usage data to guide that; Reject keeps
          things anonymous and aggregate-only, same as today.{' '}
          <Link to="/privacy" className="text-foreground underline underline-offset-2">
            Learn more
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConsent('rejected')}>
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setConsent('accepted');
              upgradeToFullTracking();
            }}
          >
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
