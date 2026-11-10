import type { RouteRecord } from 'vite-react-ssg';
import { FinHelpLayout } from './layouts/FinHelpLayout';
import { RootLayout } from './layouts/RootLayout';
import { RouteErrorBoundary } from './RouteErrorBoundary';

/**
 * Adapt a default-exporting page module to react-router's data-router `lazy`
 * format ({ Component }). Using `lazy` (rather than `React.lazy`) lets
 * vite-react-ssg preload the matched route before hydration, so the prerendered
 * HTML and the client render match — no hydration mismatch.
 */
const page = (importer: () => Promise<{ default: React.ComponentType }>) => async () => ({
  Component: (await importer()).default,
});

/**
 * Route table consumed by vite-react-ssg: the OpenFinShaper site, and nothing else.
 *
 * - `RootLayout` is a pathless wrapper around every route below — it's the one
 *   site-wide mount point for analytics init and the consent banner.
 * - `/fin` is the fin designer: a client-only island (see FinPage) prerendered as a
 *   lightweight hydration shell. `/` redirects to it (public/_redirects, with
 *   pages/Home as the fallback).
 * - `/docs/fin-designer` (help) and `/privacy` share the bare FinHelpLayout, which
 *   leads only back to the designer.
 * - `errorElement` sits on both the root and `/fin`: an error in the root's own
 *   (vite-react-ssg synthetic) loader bubbles to its own boundary, not a child's,
 *   so the designer needs its own to keep failures scoped.
 *
 * The board editor's pages (EditorPage, the board docs) are still in the source tree
 * but unrouted, so the build neither prerenders nor bundles them.
 */
export const routes: RouteRecord[] = [
  {
    element: <RootLayout />,
    entry: 'src/layouts/RootLayout.tsx',
    errorElement: <RouteErrorBoundary />,
    children: [
      // `/` → `/fin` (public/_redirects); this page is the fallback where that file isn't honoured.
      { index: true, lazy: page(() => import('./pages/Home')) },
      {
        path: 'fin',
        lazy: page(() => import('./pages/FinPage')),
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: 'docs/fin-designer',
        element: <FinHelpLayout />,
        entry: 'src/layouts/FinHelpLayout.tsx',
        children: [{ index: true, lazy: page(() => import('./pages/docs/FinDesigner')) }],
      },
      {
        path: 'privacy',
        element: <FinHelpLayout />,
        entry: 'src/layouts/FinHelpLayout.tsx',
        children: [{ index: true, lazy: page(() => import('./pages/Privacy')) }],
      },
    ],
  },
];
