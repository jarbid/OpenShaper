/**
 * Non-blocking, site-wide consent bar. Shown to every visitor until they
 * decide; never re-shown once a choice is made. Doesn't gate access to
 * anything — the anonymous analytics baseline (see analytics.ts) keeps
 * running whether or not the visitor ever interacts with this.
 */
import { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@openshaper/ui';
import { getConsent, setConsent, subscribeConsent } from './consent';
import { upgradeToFullTracking } from './analytics';

export function ConsentBanner() {
  const consent = useSyncExternalStore(subscribeConsent, getConsent, () => null);
  if (consent !== null) return null;

  return (
    <div
      role="region"
      aria-label="Analytics consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card px-4 py-3 text-card-foreground shadow-lg"
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
