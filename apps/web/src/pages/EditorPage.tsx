import { lazy, Suspense } from 'react';
import { ClientOnly } from 'vite-react-ssg';
import { Seo } from '../seo/Seo';
import { UpdatePrompt } from '../UpdatePrompt';

// The editor pulls in the canvas editors, three.js and the board store — all of
// which assume a browser. Load it only on the client, inside ClientOnly, so the
// /app route still prerenders to a clean (noindex) shell.
const App = lazy(() => import('../App').then((m) => ({ default: m.App })));

export default function EditorPage() {
  return (
    <>
      <Seo
        title="Design app"
        description="OpenShaper's surfboard design app — draw outlines, rocker and cross-sections, see live volume and weight, and export STEP, STL, DXF and PDF."
        path="/app"
        noindex
      />
      <ClientOnly>
        {() => (
          <>
            {/* Outside <Suspense> so service-worker registration starts immediately
                rather than waiting on the editor chunk — and so the update toast
                still shows if that chunk fails to load. */}
            <UpdatePrompt />
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading the design app…
                </div>
              }
            >
              <App />
            </Suspense>
          </>
        )}
      </ClientOnly>
    </>
  );
}
