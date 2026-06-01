import { lazy, Suspense } from 'react';
import { ClientOnly } from 'vite-react-ssg';
import { Seo } from '../seo/Seo';

// The editor pulls in the canvas editors, three.js and the board store — all of
// which assume a browser. Load it only on the client, inside ClientOnly, so the
// /app route still prerenders to a clean (noindex) shell.
const App = lazy(() => import('../App').then((m) => ({ default: m.App })));

export default function EditorPage() {
  return (
    <>
      <Seo
        title="Design app"
        description="OpenShaper's surfboard design app — draw outlines, rocker and cross-sections, see live volume and weight, and export STL, DXF and PDF."
        path="/app"
        noindex
      />
      <ClientOnly>
        {() => (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading the design app…
              </div>
            }
          >
            <App />
          </Suspense>
        )}
      </ClientOnly>
    </>
  );
}
