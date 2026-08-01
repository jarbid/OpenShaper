// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Route-level error screen.
 *
 * Wired as `errorElement` on the root and `/app` records in routes.tsx. It
 * catches two distinct failures that both used to surface as react-router's
 * bare "Unexpected Application Error":
 *
 *  - a route loader throwing — vite-react-ssg wraps every route in a synthetic
 *    loader that fetches its static-loader-data manifest on client-side
 *    navigation, which fails with no network;
 *  - a rejected `React.lazy` import — `EditorPage` → `App` → `@openshaper/render3d`
 *    are all code-split, and a failed dynamic import is never retried.
 *
 * Deliberately dependency-free: no lazy imports, no store, no icons package, so
 * this component cannot itself fail for the same reason it is being shown.
 */
import { useRouteError } from 'react-router-dom';

export function RouteErrorBoundary() {
  const error = useRouteError();
  const detail =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null;

  return (
    <div
      role="alert"
      className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground"
    >
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">Something didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You may be offline, or the app was updated while this page was open. Reloading usually
          fixes it — your saved board is kept on this device.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Reload
          </button>
          <a
            href="/app"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Open the design app
          </a>
        </div>
        {detail ? (
          <p className="mt-6 break-words font-mono text-xs text-muted-foreground/70">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
