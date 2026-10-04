# OpenShaper architecture

A short map of the app for people (and agents) changing it. The project rules — pure
kernel, golden data, workers for heavy compute — live in `.claude/CLAUDE.md`; this file
only describes what is where and how data moves.

## Modules

pnpm + Turborepo monorepo. Dependencies point inward; `kernel`, `io` and `units` never
import React, the DOM or three.js.

| Package             | Role                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel`   | Immutable board model (`BezierBoard`: outline, bottom, deck splines + cross-sections + fins) and all geometry: splines, interpolation, loft, tessellation, volume, rails, fins. |
| `packages/io`       | `.brd` (plain + legacy-encrypted) read/write, `.s3d`/`.s3dx`/`.srf` readers, `.board.json` (session/native), share-link codec (gzip + base64url in the URL fragment).           |
| `packages/units`    | Metric/imperial parsing and formatting (fractions, ft·in).                                                                                                                      |
| `packages/store`    | `createBoardStore()` — a vanilla **Zustand** store: board, undo/redo history, selection, drag grouping. Edits are pure functions in `edits.ts`; `selectors.ts` derives specs.   |
| `packages/render2d` | `SplineEditor` — the canvas 2D editor (outline / rocker / cross-section) with viewport, hit-testing, drawing, context menu.                                                     |
| `packages/render3d` | `Board3DView` (react-three-fiber) — hull mesh, fins, guides, viewcube; tessellation in a Web Worker (`tessellate.worker.ts`).                                                   |
| `packages/export`   | PDF / DXF / STL / STEP exporters, spec sheet, construction templates (hollow-wood, rail bands).                                                                                 |
| `packages/ui`       | Design-system React components (Tailwind).                                                                                                                                      |
| `apps/web`          | The product: marketing pages + docs (prerendered) and the editor at `/app` (client-only).                                                                                       |
| `apps/desktop`      | Tauri shell that loads the `apps/web` build.                                                                                                                                    |
| `worker/`           | Cloudflare Worker: serves `apps/web/dist` and proxies `/edge` to PostHog.                                                                                                       |

## Data flow (editor)

```
file / template / share link / IndexedDB session
        │  io: parseBrd · parseS3dx · readBoardJson · decodeShareFragment
        ▼
boardStore (apps/web/src/store.ts = createBoardStore())      ← undo/redo, selection
        │  actions: moveControlPoint, addCrossSection, scaleBoard, setFinSetup, …
        │  each commit = pure edit (store/edits.ts) → enforceJunctions
        │                → adjustCrossSectionsToThicknessAndWidth → new BezierBoard
        ▼
React (useSyncExternalStore on the board)
 ├─ SplineEditor ×N (render2d)  draws splines + interpolated sections on <canvas>
 ├─ Board3DView (render3d)      tessellateAsync(board, faceSize, signal) → mesh-queue
 │        → Web Worker: kernel tessellateBoard → loft rings → BoardMesh (typed arrays,
 │          transferred) → meshToGeometry → three.js BufferGeometry → R3F mesh
 ├─ useSpecsWorker              settled board → specs worker → volume, area, CoM…
 └─ exports (export pkg)        on demand, from the current board
        │
        ▼
session-store (IndexedDB autosave of writeBoardJson) · file-io (save .brd/.board.json)
```

- The kernel is immutable, so a new board reference is the change signal. Specs
  (`selectSpecs`) and per-spline widths are cached in `WeakMap`s keyed by object; the
  mesh cache is an 8-entry LRU because the undo history would otherwise keep every
  mesh alive. The mesh queue keeps one worker job in flight and drops superseded ones;
  the 3D canvas renders on demand (`frameloop="demand"`).
- During a drag (`beginEdit` … `endEdit`), each pointer move commits a new board but
  history coalesces into one undo step; `useSettledBoard` holds the heavy derived
  readouts at the pre-drag board until release.

## Entry points

- `apps/web/src/main.tsx` — `ViteReactSSG` over `routes.tsx`. Strips a shared-board
  fragment from the URL before anything (analytics) can read it.
- `routes.tsx` — `RootLayout` (analytics + consent) → marketing pages, `/docs/*`, and
  `/app` → `pages/EditorPage.tsx`, which lazy-loads `App.tsx` inside `ClientOnly`.
- `App.tsx` — the editor shell: loads the start board (session restore, share link or
  `sample-board.brd`), owns view state, panes, dialogs, menus and keyboard shortcuts.
- Workers: `apps/web/src/workers/specs-worker.ts`, `packages/render3d/src/tessellate.worker.ts`.
- `apps/web/src/sw.ts` — hand-written service worker (injectManifest), editor + docs offline.

## Desktop vs mobile UI

One component tree, three layout tiers chosen in `App.tsx`:

- **Desktop (`lg`+)**: sidebar beside the viewport; views quad / outline / rocker /
  cross-section / 3D / split.
- **Compact (below `lg`)**: the sidebar moves into a draggable bottom sheet; quad stacks vertically.
- **Phone** (`useIsPhone`, `useMediaQuery.ts`): no quad view; unit selector moves into the
  sheet; portrait panes draw the board nose-up (CSS-rotated canvas); a landscape phone
  starts with the sheet closed. Touch: long-press context menu, coarse-pointer hit sizes
  (`spline-editor-*.test.tsx`, `touch-floor.test.tsx`).

The sidebar's tabs and sections are data (`sidebar-sections.ts`, `SIZING` in
`Sidebar.tsx`); see `docs/design/sidebar.md`.

## Build, test, deploy

- `pnpm typecheck` · `pnpm test` (Vitest in every package; jsdom in `apps/web`) ·
  `pnpm build` (`tsc -b && vite-react-ssg build` → `apps/web/dist`, prerendered HTML per
  route, PWA precache guard in `tools/precache-guard.ts`). `pnpm lint` runs ESLint
  (`eslint.config.mjs`, which also enforces the package layering) and `prettier --check`.
  `pnpm coverage` prints per-package line coverage.
- E2E: `pnpm --filter @openshaper/web e2e` (dev server) and `e2e:offline` (built `dist`
  via `tools/serve-dist.mjs`).
- Characterization snapshots (behaviour lock for refactors):
  `packages/kernel/src/characterization.test.ts`,
  `packages/io/src/roundtrip.characterization.test.ts`,
  `packages/store/src/board-store.characterization.test.ts`.
- Performance: `pnpm --filter @openshaper/store bench` (compute) and
  `node apps/web/tools/perf/browser-perf.mjs` (browser, after `pnpm build`).
- CI (`.github/workflows/ci.yml`): install → lint → typecheck → test → build, and an `e2e`
  job running both Playwright suites.
- Deploy: Cloudflare Workers static assets (`wrangler.toml`, `worker/index.ts`).
  Desktop: `pnpm build:desktop` (Tauri).
