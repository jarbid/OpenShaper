// SPDX-License-Identifier: GPL-3.0-or-later
import { lazy, Suspense } from 'react';
import { ClientOnly } from 'vite-react-ssg';
import { Seo } from '../seo/Seo';
import { finStore } from '../fin/fin-store';
import { UpdatePrompt } from '../UpdatePrompt';

// Canvas, store and kernel assume a browser, so
// the designer loads client-side only and /fin prerenders to a light shell. It is the
// site's home page (/ redirects here), so unlike the board editor's shell it is indexed.
const FinApp = lazy(() => import('../fin/FinApp').then((m) => ({ default: m.FinApp })));

export default function FinPage() {
  return (
    <>
      <Seo
        title="OpenFinShaper"
        description="OpenFinShaper — free surf fin design software in your browser. Draw a fin's outline, foil, thickness and cant, and export it for CNC or 3D printing."
        path="/fin"
      />
      <ClientOnly>
        {() => (
          <>
            <UpdatePrompt subscribe={finStore.subscribe} />
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading OpenFinShaper…
                </div>
              }
            >
              <FinApp />
            </Suspense>
          </>
        )}
      </ClientOnly>
    </>
  );
}
