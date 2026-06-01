import type { RouteRecord } from 'vite-react-ssg';
import { MarketingLayout } from './layouts/MarketingLayout';

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
 * - `/`, `/about`, and the two guide pillars share the marketing layout and are
 *   fully prerendered to static HTML for SEO.
 * - `/app` is the editor: a client-only island (see EditorPage) prerendered as a
 *   lightweight, `noindex` hydration shell.
 */
export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <MarketingLayout />,
    entry: 'src/layouts/MarketingLayout.tsx',
    children: [
      { index: true, lazy: page(() => import('./pages/Landing')) },
      { path: 'about', lazy: page(() => import('./pages/About')) },
      { path: 'surfboard-design-guide', lazy: page(() => import('./pages/SurfboardDesignGuide')) },
      {
        path: 'surfboard-construction-methods',
        lazy: page(() => import('./pages/SurfboardConstructionMethods')),
      },
    ],
  },
  {
    path: 'app',
    lazy: page(() => import('./pages/EditorPage')),
  },
];
