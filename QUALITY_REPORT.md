# Quality pass report

Branch `refactor/quality-pass`. Goal: make the app code robust and maintainable with
**no user-visible change**. Anything user-visible goes to `PROPOSALS.md` instead.

## Phase 0 — safety net

### Gates at baseline (commit `99c3030`, before any edit)

| Gate             | Result                                               | Time |
| ---------------- | ---------------------------------------------------- | ---- |
| `pnpm typecheck` | pass                                                 | 26 s |
| `pnpm test`      | pass — **1,604 tests** in 144 files (18 tasks)       | 90 s |
| `pnpm lint`      | pass, but **a placeholder** (`echo "(eslint todo)"`) | 2 s  |
| `pnpm build`     | pass (one Vite chunk-size warning, see bundle)       | 45 s |

Per package: kernel 428 · io 122 · units 42 · store 116 · render2d 104 · render3d 45 ·
export 195 · web 538 · worker 14.

After Phase 0 (with the characterization tests): all four gates pass, **1,683 tests**
(kernel 453 · io 164 · store 128; others unchanged).

E2E (Playwright) was not part of the baseline gate — CI does not run it either.

### Characterization tests added

Behaviour locks for the refactor. If one of these snapshots would need to change, the
change is a behaviour change and goes to `PROPOSALS.md`.

| File                                                           | Locks                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/src/characterization.test.ts` (25)            | For 3 golden boards, the shortboard as sLinear, and edge cases (2-knot box board = minimal control points, 60 % rocker slope, 3 mm knife-edge rails, curvy): volume, area, CoM, max width/thickness, interpolated sections + lofted rings at 5 stations; mesh step counts, vertex/triangle counts, bounds, position/normal sums and an index checksum at 1.5 and 0.5 cm faces. 8 significant digits. |
| `packages/io/src/roundtrip.characterization.test.ts` (42)      | Every sample file in the repo (7 `.brd`, 7 `.s3dx`): `.brd` export is lossless (`parse(write(b))` deep-equals `b`), stable on re-export, and pinned to a file snapshot per sample; `.board.json` and share-link round-trips give an identical board.                                                                                                                                                 |
| `packages/store/src/board-store.characterization.test.ts` (12) | Store actions on the reference shortboard: move point, grouped tangent drag, add/delete point, all knot tools, add/move/delete section, paste + rail preset, scale, sLinear, fin edits, adjust-thickness off, undo/redo/jump. History labels, selection, fins, knot counts, specs and a hash of the rounded board.                                                                                   |

Two facts surfaced while writing them (recorded in the audit):

- `.board.json` / share links turn `-0` coordinates into `0` (JSON has no negative
  zero). The funboard has three. Geometrically identical; the `.brd` writer preserves
  `-0` deliberately. The test normalizes `-0` and says so.
- `getMaxWidth` returns `-Infinity` for a board whose outline is a straight line
  (constant half-width, e.g. the box test board).

### Existing test review

- **Coverage gaps (no colocated test):** all of `packages/ui`; `render3d`
  `Board3DView`/`Fins3D`/`Guides3D`/`BoardViewcube`/`tessellate.worker` (mocked out in 12
  web tests); `render2d` `handle-side.ts` (SplineEditor only via the web harness);
  `export` `pdf-core`, `pdf-draw`, `construction/clipper`, `construction/units`;
  web `ConstructionPanel`, `ExportPdf1to1Dialog`, `ExportStepDialog`, `FinPanel`,
  `SectionPositionEditor`, `SharedBoardPrompt`, `use-keyboard-shortcuts`, `use-trace`,
  `trace-store`, `weights`, `workers/specs-worker`; `units` `parse.ts` only via the barrel.
  No e2e covers file import, undo/redo, session restore, or rocker/section editing.
- **Weak tests (assert little):** `kernel/board.slinear.test.ts:64`,
  `io/s3d-reader.test.ts:293`, `io/srf-reader.test.ts:245`, `io/s3dx-reader.test.ts:91`
  (never checks the flag was ignored), `render2d/draw.test.ts:189-195` (truthy
  constants) and `:292`, `render3d/geometry.test.ts:146` (attributes truthy, no counts),
  `e2e/app.spec.ts:95-112` (drag asserts only "no console errors", not that the board
  changed). Several web storage-robustness tests are `not.toThrow` only — acceptable for
  what they test.
- **Brittle:** fixed sleeps in `e2e/board-turn.spec.ts` and `e2e/tap-targets.spec.ts`;
  Tailwind class-name assertions in ~10 web tests (`touch-floor`, `App.test`,
  `MenuSubmenu`, `Sidebar`, `ShareDialog`, …); `SettingsDialog.test.tsx:74` depends on
  `container.firstChild` being the backdrop.
- **Duplication:** the same 3-knot `makeBoard` is hand-copied in 6 files (store,
  render3d ×2, render2d, web ×2); `makeSpline` in 4; `goldenDir` + `loadBrd` preamble in
  16 files; the `vi.mock('@openshaper/render3d')` stub in 12 web tests; the three sample
  `.brd` files in `apps/web/src` are byte-identical copies of `docs/specs/golden/*.brd`.
- No `.only` / `.skip` / `.todo`; no test without an assertion.

### Performance baseline

Tools: `pnpm --filter @openshaper/store bench` (Node 22, compute) and
`node apps/web/tools/perf/browser-perf.mjs --runs 3` (production build, headless
Chromium; `PW_CHROMIUM` to pick the binary). Browser numbers are the median of 3 runs.

**Compute (Node, desktop-class CPU, mean per call)**

| Operation                                            | shortboard | longboard |
| ---------------------------------------------------- | ---------- | --------- |
| `tessellateBoard` draft (1.5 cm)                     | 17.4 ms    | 32.6 ms   |
| `tessellateBoard` standard (0.9 cm, the default)     | 36.6 ms    | 67.3 ms   |
| `tessellateBoard` fine (0.5 cm)                      | 95.2 ms    | 150.9 ms  |
| `selectSpecs` uncached (volume, area, CoM, stations) | 8.6 ms     | 7.0 ms    |
| store `moveControlPoint` in a drag (adjust on)       | 0.14 ms    | —         |

**Browser** — desktop: 1440×900, no throttling. Mobile: 390×844, touch, 4× CPU,
Slow 4G (150 ms RTT, 1.6 Mbps).

| Metric                                          | Desktop                         | Mobile        |
| ----------------------------------------------- | ------------------------------- | ------------- |
| First contentful paint `/app`                   | 224 ms                          | 4,860 ms      |
| `load` event                                    | 136 ms                          | 4,219 ms      |
| Editor ready (canvas sized)                     | 673 ms                          | 7,930 ms      |
| JS fetched for `/app` (uncompressed)            | 1,960 KB                        | 1,092 KB      |
| Drag: input → next frame, median / p95          | 30 / 32 ms¹                     | 83 / 98 ms    |
| Drag: main-thread task time per pointer move    | 13.0 ms                         | 78.6 ms       |
| Drag: script time per pointer move              | 3.6 ms                          | 19.0 ms       |
| React commits per pointer move                  | 2                               | 2             |
| **React components rendered per pointer move**³ | **~99** (185 as first recorded) | **~99** (186) |
| JS heap after load → after 150 undo/redo edits² | 9.8 → 10.9 MB                   | 6.3 → 6.6 MB  |
| DOM nodes                                       | 590                             | 419           |

¹ The probe waits two animation frames, so ~30 ms is the floor at 60 Hz; the task time
is the informative number on desktop.
³ Corrected in Phase 2: the first probe also counted skipped subtrees (their fibers keep a
stale "performed work" flag), inflating the figure. Re-measured on the same base build
with the fixed probe: 99.1 per move on both profiles.

² Edits with the 3D view mounted (quad on desktop, split on phone); forced GC before
each reading. JS heap only — WebGL buffers are not counted.

**Bundle** (`pnpm build`): 2.14 MB of JS in `dist/assets` (655 KB gzip). Largest
chunks: `index` 877 KB (238 KB gz — three.js / R3F), `app` 598 KB (195 KB gz),
`file-io` 232 KB (78 KB gz), `App` 196 KB (63 KB gz). Vite warns on chunks > 500 KB.

## Phase 1 — audit (ranked)

Eight read-only audits (geometry, state, rendering, desktop UI, mobile UI, file I/O,
tests, build/deps). Evidence (probes, profiles, repro tests) is in the session scratchpad;
file:line references below are against `99c3030`.

Items that change anything a user sees or does — including bug fixes they would notice,
analytics payloads, file bytes or geometry — are **not** here; they are in
`PROPOSALS.md` (P-numbers).

### Ranking: impact vs risk (Phase 2 works top-down)

| #   | Item                                                                                                                                                                                                                                                                                                                                                                           | Impact | Risk | Evidence                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **3D worker: coalesce + dedupe.** `tessellateAsync` posts one job per board change and never drops superseded ones; Fins3D/Guides3D post duplicate jobs for the same board (cache fills only on resolve). Keep one in flight + a "latest" slot; share in-flight promises.                                                                                                      | High   | Low  | 60 worker posts for 60 pointer moves (specs worker: 1); 37 ms/job vs 16 ms frames → queue grows during a drag. `render3d/geometry.ts:54-71`, `Fins3D.tsx:66`, `Guides3D.tsx:145`                      |
| 2   | **Bound the mesh cache.** `WeakMap<board, mesh>` is kept alive by the 200-step undo history. Small LRU.                                                                                                                                                                                                                                                                        | High   | Low  | 1.05 MB/mesh at standard, 3.4 MB at fine → up to ~210–690 MB of ArrayBuffers (invisible to the JS-heap baseline)                                                                                      |
| 3   | **Stop re-rendering the whole app per pointer move.** Stable `useSettledBoard` snapshot during drags; narrow `App` subscriptions; memoize `overlaysFor`/`ghostSplinesFor`/section markers/format callbacks; `React.memo` on panes, Sidebar, 3D pane; keep `past` identity when the drag label is unchanged; move `scrubX` down.                                                | High   | Med  | ~99 components (first recorded as 185, see ³) + 2 commits per move; 13 ms (desktop) / 79 ms (4× CPU) main-thread per move; hover alone 9.6 ms/move in quad. `App.tsx:147`, `SplineEditor.tsx:720-749` |
| 4   | **Specs 2× faster, bit-identical.** Memoize `csWidth` per spline; reuse the volume integral as the CoM weight; single max-thickness scan.                                                                                                                                                                                                                                      | Med    | Low  | uncached specs 5.7→2.9 ms (short), identical JSON                                                                                                                                                     |
| 5   | **Lazy-load posthog** (≈300 KB raw / ~95 KB gz of the entry chunk on every route) behind `import()` in `initAnalytics`, buffering calls so event names/properties and ordering are unchanged.                                                                                                                                                                                  | High   | Med  | `analytics.ts:25` static import                                                                                                                                                                       |
| 6   | **Lazy-load exporters + clipper** (`file-io` 232 KB chunk + ~82 KB export code in `App`) at click time.                                                                                                                                                                                                                                                                        | Med    | Low  | `App.tsx:1,51`, `file-io.ts:18`                                                                                                                                                                       |
| 7   | **Worker error handling.** Tessellate worker has no error path (promise never settles, `pending` leaks and pins boards); specs worker has no `onerror`.                                                                                                                                                                                                                        | Med    | Low  | `geometry.ts:226`, `tessellate.worker.ts:17`, `use-specs-worker.ts`                                                                                                                                   |
| 8   | **2D canvas: resize backing store only when size/dpr changes** (reassigned on every draw).                                                                                                                                                                                                                                                                                     | Med    | Low  | +5.7 ms per draw at 2800×1600; 20 buffer resets for 20 touch moves. `SplineEditor.tsx:614`                                                                                                            |
| 9   | **3D idle rendering: `frameloop="demand"`** + explicit `invalidate()` for flip/viewcube.                                                                                                                                                                                                                                                                                       | High   | Med  | 301 draw calls in 3 s idle, main thread ~100 % (software GL). Only if every interaction can be verified; otherwise → proposal                                                                         |
| 10  | **Guides: memo `guideLines` on `[board, faceSize]`**, derive the active ring separately; stable ring keys.                                                                                                                                                                                                                                                                     | Med    | Low  | 24 ms main-thread per recompute, also on station change. `Guides3D.tsx:163`                                                                                                                           |
| 11  | **S-blend (sLinear) specs**: hoist per-station prep out of `sLinearPoint`; cache segment lengths.                                                                                                                                                                                                                                                                              | Med    | Med  | 213 ms vs 6 ms for control-point boards; 1-entry memo alone 220→132 ms, identical                                                                                                                     |
| 12  | **STL/STEP export off the main thread** (worker, same output).                                                                                                                                                                                                                                                                                                                 | Med    | Med  | STL 1.9–2.7 s + 45 MB string, STEP 1.2 s, synchronous on click                                                                                                                                        |
| 13  | **Build/CI speed**: drop unused package `dist/` builds and `^build` deps of test/typecheck; drop the duplicate `tsc -b` in the web build.                                                                                                                                                                                                                                      | Med    | Low  | 8 unused `dist/` emits per run; ~13 s duplicate typecheck                                                                                                                                             |
| 14  | **Typecheck test files** (+ fix the 9 errors, incl. a likely typing bug in `hws.test.ts:960`); enable the two zero-error flags (`noImplicitReturns`, `noFallthroughCasesInSwitch`).                                                                                                                                                                                            | Med    | Low  | tests excluded from every package tsconfig                                                                                                                                                            |
| 15  | **Duplicate logic → shared helpers** (outputs byte-identical): settings persistence `persisted<T>()` (same keys/format); IndexedDB helpers (session/trace); `sameTarget` ×3; `clamp` ×4, `isFinite3` ×2; station bracketing ×3; latin1 decode ×4; `esc` ×3; DXF emitters ×2; PDF meta ×3; Fins3D/Guides3D offset hook; "end active edit" ×4; `getChildText`/`getChildElement`. | Med    | Low  | see per-area notes                                                                                                                                                                                    |
| 16  | **Dead code**: ~12 kernel exports used nowhere, unreachable branches (`board.ts:212`, `loft.ts:147`, `bezier-spline.ts:383`), dead `exportBoard` cases, unused `Toolbar`, `wireframe` prop, `canUndo/canRedo`, clipper/geom helpers, `savedAt`; stale comments (`kernel/index.ts`, `tessellate.ts:23` "nose..tail", orphaned doc blocks).                                      | Low    | Low  | grep-verified by the audits                                                                                                                                                                           |
| 17  | **App.tsx decomposition** into hooks (`useSessionPersistence`, `useViewStatePersistence`, `useCrossSectionEditing`, `useToast`, `useBoardDocument`, pure `buildMenus`) and one `<Pane kind>` for the duplicated quad/single pane props.                                                                                                                                        | Med    | Med  | 1,785 lines; pane props duplicated verbatim `App.tsx:1267/1578`, `1288/1598`                                                                                                                          |
| 18  | **Minor perf**: `meshToGeometry` single-pass centring (bit-identical); memo `boardSpan`; stable `ContextMenu` `onClose`; swallow outline pre-sort; one store `set` per action instead of commit + select.                                                                                                                                                                      | Low    | Low  | 2.4 ms + 1.7 ms per result/render; 17 µs per swallow sample                                                                                                                                           |
| 19  | **Weak typing**: remove redundant casts (`board as BezierBoard` ×5, `as unknown as BlobPart` ×4, `sameTarget` cast, select `onChange` casts via a generic `SelectRow`), `Selection.kind` default in one place.                                                                                                                                                                 | Low    | Low  | no `any` anywhere; ~30 casts                                                                                                                                                                          |
| 20  | **Tests**: shared board builders (same `makeBoard` ×6, `makeSpline` ×4, golden-loader preamble ×16); render3d mock into `test/setup.ts` (×12); strengthen weak assertions (`s3dx-reader.test.ts:91`, `geometry.test.ts:146`, `draw.test.ts:189`, e2e drag). No coverage removed.                                                                                               | Med    | Low  | see Phase 0 test review                                                                                                                                                                               |

### Not in Phase 2

- **User-visible bugs and behaviour changes** → `PROPOSALS.md`. The most serious:
  undo after adding sections can **crash the editor** (stale selection, P1); a drag
  interrupted by a view switch leaves the store stuck in "editing" (P2); blocked storage
  crashes the editor during render (P5); crafted share links can crash save and re-fire
  on every reload (P7).
- **Dependency majors** (vitest 5, vite 8, React 19 + fiber 9 + drei 10, three 0.186, …)
  → proposal. Minor/patch bumps are possible but not needed for this pass.
- **E2E + lint in CI, ESLint with hooks and layering rules** → proposal (process change).

## Phase 2 — log

Each row is one commit. "Gates" = typecheck, test, lint, build all pass, characterization
snapshots unchanged. Perf is measured with `browser-perf.mjs` against a build of the
previous state (`base`) and the change (`new`), same machine, back to back.

The harness gained a second drag with the 3D view mounted (quad on desktop), counting
tessellation jobs per move and worker settle time, and a memory phase of 40 separate
drags (40 undo steps) reading ArrayBuffer backing stores as well as the JS heap. Base
numbers for those, desktop: 3D drag 416 ms main-thread per move (software WebGL in this
sandbox dominates), 1 tessellation job per move, ArrayBuffers **5.3 → 61.6 MB** after the
40 edits. On the phone tier the split view has no 3D pane, so that phase measures 2D only.

| #   | Change                                                                                                                           | Tests | Measured                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 3D worker queue: one job in flight, shared + droppable jobs                                                                      | 1,689 | No change measurable here: with software WebGL each 3D frame takes ~170 ms, so input never outpaces the worker (1 job/move before and after). The dropping/sharing is proven by `mesh-queue.test.ts` (5 superseded boards → 2 jobs; identical asks → 1 job). On real GPUs a 60 Hz drag posts ~1.6× the jobs the worker can finish; those backlog jobs are now dropped.                                         |
| 2   | Mesh cache: 8-entry LRU instead of a WeakMap pinned by undo history                                                              | 1,691 | ArrayBuffers after the 3D drag + 40 separate drags: **61.6 → 15.4 MB** (desktop, 2 runs each, identical). JS heap 15.3 → 15.7 MB. Bounded now; before it grew ~1.4 MB per undo step up to the 200-step cap. Only a deep undo (> 8 meshes back) re-tessellates: one worker round trip.                                                                                                                          |
| 3a  | Store keeps `past` identity across one drag's moves                                                                              | 1,692 | Prerequisite for 3c (history subscribers stop changing per move); no measurable change alone.                                                                                                                                                                                                                                                                                                                  |
| 3b  | Coordinate fields re-sync during render (`useSyncedText`), not in an effect                                                      | 1,694 | React commits per drag move **2 → 1** (both profiles).                                                                                                                                                                                                                                                                                                                                                         |
| 3c  | `memo(Sidebar)` + stable `applyResize`/`openTracePicker`; `memo(ThreeDPane)`                                                     | 1,694 | Prod build, fixed probe, 3a–3c vs base: components per 2D drag move **99 → 43**; main-thread per move desktop **9.7 → 7.75 ms**, phone (4× CPU) **54.5 → 41.8 ms** (2 runs each).                                                                                                                                                                                                                              |
| 3d  | `memo(BoardGizmo)` (view cube)                                                                                                   | 1,694 | Quad-view drag (dev probe): components per move **237 → 137** with 3c; the view cube's 20 hit areas no longer re-render per edit.                                                                                                                                                                                                                                                                              |
| 4   | Specs: memoize `csWidth` per spline; volume doubles as CoM weight; one max-thickness scan                                        | 1,700 | Full-precision specs **bit-identical** on all 16 sample boards (dump diff) and pinned by new exact-equality tests. Uncached `selectSpecs`: shortboard **8.6 → 2.6 ms**, longboard **7.0 → 2.5 ms**. Side effect of the `csWidth` memo on the loft: tessellation shortboard 17.4/36.6/95.2 → 12.5/27.9/72.2 ms, longboard 32.6/67.3/150.9 → 22.0/63.7/130.5 ms (draft/standard/fine); mesh snapshots unchanged. |
| 5   | ~~Lazy-load posthog~~ → **moved to PROPOSALS (P38)**                                                                             | —     | Keeps event names/properties, but events, pageviews and uncaught errors in the window before the chunk loads would be lost or re-timestamped: an analytics behaviour change.                                                                                                                                                                                                                                   |
| 6   | ~~Lazy-load exporters~~ → **moved to PROPOSALS (P39)**                                                                           | —     | The Build tab's live preview needs export + clipper at render time, so only the exporters could move, and a download after an `await` may lose user activation in some browsers.                                                                                                                                                                                                                               |
| 7   | Tessellation worker error path: worker reports failures; queue rejects and moves on; `onerror` fails all and restarts the worker | 1,702 | Fixes a regression risk introduced by #1: a throwing job would have held the queue forever (3D frozen for the session); before #1 it leaked one promise per failure. Built-app smoke: 3D drag still 1 job/move; R3F components per 3D drag move 73 → 21 (from 3d).                                                                                                                                             |
| 8   | 2D canvas: reassign width/height only on a size change, else `ctx.reset()`                                                       | 1,702 | **Pixel-identical** to base at 7 scripted steps (`canvas-hashes.mjs`, SHA-256 per canvas, DPR 2). 2D drag main-thread per move desktop **8.35 → 7.75 ms**, phone (4× CPU) **46.1 → 42.8 ms** (2 runs each).                                                                                                                                                                                                    |
