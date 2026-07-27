import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { ClientOnly } from 'vite-react-ssg';
import { initAnalytics } from '../analytics';
import { ConsentBanner } from '../ConsentBanner';

/**
 * Pathless layout wrapping every route (marketing pages and /app alike), so
 * analytics init and the consent banner each have exactly one, site-wide
 * mount point. Before this, initAnalytics() only ran inside the /app editor —
 * the marketing/content pages had no analytics coverage at all.
 */
export function RootLayout() {
  useEffect(() => {
    initAnalytics();
  }, []);

  return (
    <>
      <Outlet />
      {/* Prerendered marketing pages aren't wrapped in ClientOnly today — scope
          the client-only guard to just the banner so it doesn't affect their
          static HTML, and so consent (localStorage) is only read post-mount. */}
      <ClientOnly>{() => <ConsentBanner />}</ClientOnly>
    </>
  );
}
