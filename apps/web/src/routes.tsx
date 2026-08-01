import type { RouteRecord } from 'vite-react-ssg';
import { MarketingLayout } from './layouts/MarketingLayout';
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
 * Route table consumed by vite-react-ssg.
 *
 * - `RootLayout` is a pathless wrapper around every route below — it's the one
 *   site-wide mount point for analytics init and the consent banner.
 * - `/`, `/about`, `/privacy`, and the two guide pillars share the marketing
 *   layout and are fully prerendered to static HTML for SEO.
 * - `/app` is the editor: a client-only island (see EditorPage) prerendered as a
 *   lightweight, `noindex` hydration shell.
 * - `errorElement` sits on both the root and `/app`: an error in the root's own
 *   (vite-react-ssg synthetic) loader bubbles to its own boundary, not a child's,
 *   so the editor needs its own to keep failures scoped.
 */
export const routes: RouteRecord[] = [
  {
    element: <RootLayout />,
    entry: 'src/layouts/RootLayout.tsx',
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        path: '/',
        element: <MarketingLayout />,
        entry: 'src/layouts/MarketingLayout.tsx',
        children: [
          { index: true, lazy: page(() => import('./pages/Landing')) },
          { path: 'about', lazy: page(() => import('./pages/About')) },
          { path: 'privacy', lazy: page(() => import('./pages/Privacy')) },
          {
            path: 'surfboard-design-guide',
            lazy: page(() => import('./pages/SurfboardDesignGuide')),
          },
          {
            path: 'surfboard-construction-methods',
            lazy: page(() => import('./pages/SurfboardConstructionMethods')),
          },
          {
            path: 'surfboard-volume-calculator',
            lazy: page(() => import('./pages/SurfboardVolumeCalculator')),
          },
          {
            path: 'build-a-hollow-wooden-surfboard',
            lazy: page(() => import('./pages/HollowWoodenSurfboard')),
          },
        ],
      },
      {
        path: 'app',
        lazy: page(() => import('./pages/EditorPage')),
        errorElement: <RouteErrorBoundary />,
      },
    ],
  },
];
