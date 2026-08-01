# Offline support (`/app` only)

OpenShaper is a static, client-side SPA, and the editor already needs no network:
board state lives in IndexedDB (`session-store.ts`, `trace-store.ts`), settings in
localStorage, the starter templates are inlined into JS via `?raw`, and every
exporter builds its blob in-process. There is not one `fetch` in editor code.

What was missing was asset delivery. With no service worker, opening
`openshaper.com/app` with no connection failed at the document request — so a
workshop with patchy wi-fi lost the whole app. This is the packaging that closes
that gap.

## Scope: the editor, deliberately not the site

Only `/app` works offline. The marketing and guide pages stay network-served and
are **never** precached, for two reasons: cached marketing HTML goes stale in a way
nothing invalidates, and `public/images/guides/` alone is ~2.7 MB that an editor
user has no reason to carry.

Registration follows the same rule. `UpdatePrompt` is mounted from `EditorPage`,
not `RootLayout`, so a visitor who only reads the guides never registers a worker
and never precaches three.js. The trade-off: someone who has never opened the
editor sees the browser's native error page offline, not our branded one. That is
intended — the fallback is a courtesy for editor users who navigate out.

## Navigation model

`src/sw.ts` is a hand-written `injectManifest` worker rather than a generated one,
because the required behaviour cannot be expressed by `generateSW`'s
`navigateFallback`: that uses `createHandlerBoundToURL`, which is **cache-only**, so
pointing it at the offline page would serve that page to marketing routes *even
when online*.

Three routes, in order:

1. **Precache route** — `/app` is a precache entry, so the editor shell is served
   straight from the cache.
2. **`/app` variants** (`/app/`, `/app?x=1`) → the same precached shell via
   `createHandlerBoundToURL`. The regex is `/^\/app(?:\/|$)/`, which deliberately
   does not match `/apple`.
3. **Every other navigation** → `NetworkOnly`. Online this is indistinguishable
   from having no service worker: real HTML, and real 404s for unknown paths (the
   site has no SPA catch-all by design). Only a network *failure* reaches
   `setCatchHandler`, which serves the precached `offline.html`.

Because nothing marketing-related is ever cached, stale marketing HTML is
structurally impossible.

A consequence of the `assets/**` glob: every page chunk, marketing ones included, is
precached, so offline an in-app link followed from the loaded editor can render the
real page client-side without any HTML request. Only a cold document navigation
reaches the worker's catch handler and the branded page. Both outcomes are fine; the
e2e specs assert the cold case, which is the one the worker controls.

## Why the precache is an allowlist, and guarded

`injectManifest.globPatterns` names what to cache; everything else is excluded by
omission. `assets/**/*.{js,css,woff2}` is deliberately a superset — there are no
`manualChunks`, so the editor's graph (`EditorPage` → `App` → `@openshaper/render3d`,
plus the `specs` and `tessellate` module workers and their transitive imports) has
no nameable pattern. A glob that misses one chunk produces a build that looks fine
and breaks offline, since a failed dynamic `import()` is never retried. The cost is
a few small marketing chunks; the benefit is a rule that cannot silently miss.

`tools/precache-guard.ts` then asserts the result and **throws**, failing `pnpm build`
and therefore CI. It checks the shell is present and rewritten, both worker chunks
and enough JS/CSS are there, exactly one `static-loader-data-manifest-*.json` is
included, and that no marketing HTML, guide image, or stray raster snuck in — plus a
12 MB budget. `tools/precache-guard.test.ts` covers each failure mode.

Note the transform runs twice: vite-plugin-pwa runs once at `closeBundle`, before
prerendering, when `dist/app/index.html` does not exist yet; `vite-react-ssg` then
calls `generateSW()` again afterwards. Only the second, complete pass is asserted.
The first pass logs a harmless workbox warning that the
`static-loader-data-manifest-*.json` glob matched nothing — it does not exist yet.

## The `/app` URL rewrite

On disk the prerenderer emits `dist/app/index.html`, but the canonical URL is `/app`
with no trailing slash — `wrangler.toml` sets `html_handling = "drop-trailing-slash"`,
and commit `b796761` fixed analytics splitting across the two forms. `rewriteAppShellUrl`
rewrites the entry to `app` so the precache key is the URL browsers actually request.

This couples us to that wrangler setting: if `drop-trailing-slash` is ever removed,
`/app` will 308 to `/app/` and the precache install may fail. The e2e suite catches it.

## Updates

`registerType: 'prompt'`, so a new worker installs in the background and **waits**.
`UpdatePrompt` surfaces "A new version is available" with an explicit Reload, and
only then does `updateServiceWorker(true)` post `SKIP_WAITING`. Nothing reloads on
its own — an in-progress edit is never interrupted.

The prompt is additionally held behind `createIdleGate` (`pwa.ts`): board edits commit
to the store on pointer-up, so a run of commits means the user is actively shaping.
The toast waits for 20 s of quiet. The reload itself is safe regardless — `App.tsx`
flushes the session to IndexedDB on `pagehide` and `loadSession()` restores it — but
the gate keeps the interruption out of the user's way.

Consequence worth knowing: the SSG build hash is `Math.random()`-derived, so it changes
on **every** build. Every deploy therefore offers an update, even a no-op rebuild.

## Fonts

Instrument Sans — the only face the editor uses — is self-hosted via
`@fontsource-variable/instrument-sans`, imported from `src/index.css`. Vite emits the
woff2 into `assets/`, where the precache glob picks it up.

The Google Fonts stylesheet previously sat in the shared `index.html`, so `/app` paid
for two display faces it never uses, on a render-blocking cross-origin request that
stalls first paint on exactly the flaky connections this feature targets. It now loads
from `MarketingLayout` via `<Head>`, so it lands only on prerendered marketing pages.
`/app` makes no third-party request at all.

## Tauri

`VitePWA({ disable })` is keyed off `TAURI_ENV_PLATFORM`, which also swaps
`virtual:pwa-register/react` for an inert stub, so no runtime branch is needed.
`canUseServiceWorker()` independently returns false when `BASE_URL !== '/'` (the
desktop build uses a relative base over a custom protocol).

## Testing

- **Build** — the precache guard fails the build on a wrong precache. Cheapest gate.
- **Unit** — `tools/precache-guard.test.ts`, `src/pwa.test.ts`, `src/UpdatePrompt.test.tsx`
  (the last via a stub for the virtual module, aliased in `vitest.config.ts`).
- **E2E** — `pnpm --filter @openshaper/web e2e:offline`. A separate Playwright config,
  because the worker only exists in a production build; it builds and serves `dist`.
  Specs navigate `/app/` with a trailing slash: `vite preview` does not replicate
  Cloudflare's `drop-trailing-slash` and would return the landing page for `/app`.

## Rolling back

A service worker cannot be withdrawn by deleting `sw.js` — installed clients keep
theirs. Ship one deploy with `VitePWA({ selfDestroying: true })`, which emits a worker
that unregisters itself, clears its caches and reloads its clients. Only after that has
had time to propagate should the plugin be removed.
