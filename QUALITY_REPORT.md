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

| #   | Change                                                                                                                                                            | Tests | Measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 3D worker queue: one job in flight, shared + droppable jobs                                                                                                       | 1,689 | No change measurable here: with software WebGL each 3D frame takes ~170 ms, so input never outpaces the worker (1 job/move before and after). The dropping/sharing is proven by `mesh-queue.test.ts` (5 superseded boards → 2 jobs; identical asks → 1 job). On real GPUs a 60 Hz drag posts ~1.6× the jobs the worker can finish; those backlog jobs are now dropped.                                                                                                               |
| 2   | Mesh cache: 8-entry LRU instead of a WeakMap pinned by undo history                                                                                               | 1,691 | ArrayBuffers after the 3D drag + 40 separate drags: **61.6 → 15.4 MB** (desktop, 2 runs each, identical). JS heap 15.3 → 15.7 MB. Bounded now; before it grew ~1.4 MB per undo step up to the 200-step cap. Only a deep undo (> 8 meshes back) re-tessellates: one worker round trip.                                                                                                                                                                                                |
| 3a  | Store keeps `past` identity across one drag's moves                                                                                                               | 1,692 | Prerequisite for 3c (history subscribers stop changing per move); no measurable change alone.                                                                                                                                                                                                                                                                                                                                                                                        |
| 3b  | Coordinate fields re-sync during render (`useSyncedText`), not in an effect                                                                                       | 1,694 | React commits per drag move **2 → 1** (both profiles).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3c  | `memo(Sidebar)` + stable `applyResize`/`openTracePicker`; `memo(ThreeDPane)`                                                                                      | 1,694 | Prod build, fixed probe, 3a–3c vs base: components per 2D drag move **99 → 43**; main-thread per move desktop **9.7 → 7.75 ms**, phone (4× CPU) **54.5 → 41.8 ms** (2 runs each).                                                                                                                                                                                                                                                                                                    |
| 3d  | `memo(BoardGizmo)` (view cube)                                                                                                                                    | 1,694 | Quad-view drag (dev probe): components per move **237 → 137** with 3c; the view cube's 20 hit areas no longer re-render per edit.                                                                                                                                                                                                                                                                                                                                                    |
| 4   | Specs: memoize `csWidth` per spline; volume doubles as CoM weight; one max-thickness scan                                                                         | 1,700 | Full-precision specs **bit-identical** on all 16 sample boards (dump diff) and pinned by new exact-equality tests. Uncached `selectSpecs`: shortboard **8.6 → 2.6 ms**, longboard **7.0 → 2.5 ms**. (An earlier note here credited ~20 % faster tessellation to the `csWidth` memo; the final back-to-back bench shows tessellation unchanged — that comparison had mixed machine load. Corrected in Phase 3.)                                                                       |
| 5   | ~~Lazy-load posthog~~ → **moved to PROPOSALS (P38)**                                                                                                              | —     | Keeps event names/properties, but events, pageviews and uncaught errors in the window before the chunk loads would be lost or re-timestamped: an analytics behaviour change.                                                                                                                                                                                                                                                                                                         |
| 6   | ~~Lazy-load exporters~~ → **moved to PROPOSALS (P39)**                                                                                                            | —     | The Build tab's live preview needs export + clipper at render time, so only the exporters could move, and a download after an `await` may lose user activation in some browsers.                                                                                                                                                                                                                                                                                                     |
| 7   | Tessellation worker error path: worker reports failures; queue rejects and moves on; `onerror` fails all and restarts the worker                                  | 1,702 | Fixes a regression risk introduced by #1: a throwing job would have held the queue forever (3D frozen for the session); before #1 it leaked one promise per failure. Built-app smoke: 3D drag still 1 job/move; R3F components per 3D drag move 73 → 21 (from 3d).                                                                                                                                                                                                                   |
| 8   | 2D canvas: reassign width/height only on a size change, else `ctx.reset()`                                                                                        | 1,702 | **Pixel-identical** to base at 7 scripted steps (`canvas-hashes.mjs`, SHA-256 per canvas, DPR 2). 2D drag main-thread per move desktop **8.35 → 7.75 ms**, phone (4× CPU) **46.1 → 42.8 ms** (2 runs each).                                                                                                                                                                                                                                                                          |
| 9   | 3D canvas `frameloop="demand"` + explicit `invalidate()` after imperative camera moves (flip, orbit, view-cube snap, ortho fit)                                   | 1,702 | **Pixel-identical** to the continuous-loop build at all 14 steps of `webgl-shots.mjs` (orbit, zoom, flip, view cube, modes, lighting, analysis, guides, mesh quality, fins, resize, board edit). Idle 3D view, desktop: main thread **100 % → 0 %** busy; 3D drag main-thread per move **364 → 86 ms** (software WebGL; the idle loop no longer competes). Phone profile: ~14 % idle busy before and after in this sandbox (cause not isolated; not the render loop).                |
| 10  | Guides: lines memoized on `[board, faceSize]`; active ring picked separately (`activeGuideKey`)                                                                   | 1,703 | Changing the active station with guides on: **17.4 ms → 1 µs** (shortboard, standard) — no re-loft of every ring. Same lines and same highlighted ring (equivalence test).                                                                                                                                                                                                                                                                                                           |
| 11  | S-blend specs: per-station work hoisted out of the per-sample loop                                                                                                | 1,703 | Full-precision specs **bit-identical** (3 S-blend boards in the dump diff). Uncached S-blend `selectSpecs` **120 → 72 ms** vs a base that already had #4 (Phase 0 figure: 213 ms).                                                                                                                                                                                                                                                                                                   |
| 12  | ~~STL/STEP export in a worker~~ → **moved to PROPOSALS (P41)**                                                                                                    | —     | Same open question as #6: the download would start after an `await`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 13  | Package `build` = `tsc --noEmit` (nothing reads `dist/`; exports point at `src`); `test`/`typecheck` no longer depend on `^build`                                 | 1,703 | Uncached (`turbo --force`): typecheck **26 → 18 s**, test **70 → 64 s**, build 37 → 36 s; no more unused `dist/` in 8 packages. The web build keeps its `tsc -b` — the Cloudflare build runs `pnpm build` alone.                                                                                                                                                                                                                                                                     |
| 14  | Test files type-checked in every package (exclusion dropped now that builds don't emit); `noImplicitReturns` + `noFallthroughCasesInSwitch` on                    | 1,703 | 9 latent errors fixed, none changing a test's behaviour: a test helper typed `setup` as `'thruster'` only while tests passed `'2+1'`/`'twin'`; 4 unused imports/locals; an unused 34-line fixture helper; a stale `@ts-expect-error`; `vi.mocked` for a mock typed as a plain function; and `near()` in `trace-transform.test.ts`, which ignored its `eps` argument — the argument is removed and the stricter 9-place check kept (honouring it would have loosened six assertions). |
| 15  | Shared helpers: `useBoardOffset`, `sameTarget`, `isFinite3`, `escapeXml` + `POINTS_PER_CM`, `latin1Decode` + s3d `tagRe`, `idb.ts`, `readStored`/`writeStored`    | 1,703 | 8 commits, each output-identical (export/io tests, round-trip characterization, 3D screenshots for the render3d one). Not merged on purpose: the `clamp` copies (ternary vs `Math.max/min` differ when lo > hi and on −0), the srf/share-link byte loops (different shapes).                                                                                                                                                                                                         |
| 16  | Dead code: unused construction helpers (`rowLayout`, `offsetOpen`, `norm`, `differenceAll`, `intersectAll`), deprecated `wireframe` prop; stale/orphaned comments | 1,703 | Kept deliberately: unused-but-symmetric legacy kernel API ports (`curveMinY`/`MaxY`, `nrOfControlPoints`, …), `canUndo`/`canRedo` (tested store API), `savedAt` (part of the stored session format), `exportBoard`'s exhaustive switch, `Toolbar` (design-system primitive). Two "unreachable" kernel branches turned out reachable (P42).                                                                                                                                           |
| 17  | App: one `threeDPane` element and one `editorPaneProps(kind)` for the quad/split and single layouts                                                               | 1,703 | −52 lines; 2D canvas hashes and 3D screenshots identical. The larger hook extractions (session/view persistence, menus) were left: higher risk for modest gain.                                                                                                                                                                                                                                                                                                                      |
| 19  | Redundant `board as BezierBoard` casts in App removed                                                                                                             | 1,703 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 20  | Two weak tests strengthened (s3dx zero-Protection now compares the parse; boardGeometry checks counts against the kernel mesh)                                    | 1,703 | No test removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Not done from the list: #18's `meshToGeometry` rewrite (three's `applyMatrix4` renormalises normals, so a hand loop would not be bit-identical — not worth ~2 ms), and the cross-package test-builder consolidation (packages cannot share test helpers without a new test-support package; noted for later).

## Phase 3 — summary

### Before / after

Back to back on the same machine: Phase 0 commit `f5e44d3` vs the final head. Browser:
3 runs per profile, medians. Compute: `vitest bench`, means. Desktop: 1440×900.
Phone: 390×844 touch, 4× CPU, Slow 4G.

| Metric                                       | Desktop before → after           | Phone before → after          |
| -------------------------------------------- | -------------------------------- | ----------------------------- |
| 2D drag: main-thread time per pointer move   | 9.3 → **7.0 ms** (−25 %)         | 45.4 → **37.7 ms** (−17 %)    |
| 2D drag: React commits per move              | 2 → **1**                        | 2.1 → **1.1**                 |
| 2D drag: components rendered per move        | 99 → **43**                      | 99 → **43**                   |
| 3D drag (quad): main-thread per move¹        | 311 → **73 ms** (−77 %)          | — (no 3D pane in split)       |
| 3D drag: R3F components rendered per move    | 73 → **21**                      | —                             |
| Idle 3D view: main thread busy               | 101 % → **0 %**                  | ~15 % → ~14 % (P43)           |
| ArrayBuffers after 40 separate edits         | 61.6 → **15.3 MB** (bounded)     | 5 → 5 MB                      |
| JS heap after those edits                    | 15.4 → 15.4 MB                   | 10.5 → 10.2 MB                |
| Editor ready / FCP                           | unchanged (noise)                | 7.54 → 7.50 s / 4.62 → 4.63 s |
| JS fetched for `/app`                        | 1,948 → 1,949 KB                 | 1,092 → 1,091 KB              |
| Uncached specs (shortboard / longboard)      | 5.07 / 4.29 → **2.15 / 2.02 ms** | ×4 CPU                        |
| Uncached specs, S-blend (shortboard)         | 167 → **55 ms** (−67 %)          |                               |
| Tessellation (all qualities)                 | unchanged (±5 %, noise)          |                               |
| CI-equivalent `typecheck` / `test`, uncached | 26 / 70 → **18 / 64 s**          |                               |

¹ Software WebGL in this sandbox makes 3D frames expensive, so most of that gain is the
idle render loop no longer competing. Expect a smaller absolute gain on a real GPU, but
the same direction.

Load time and bundle size did not move. The two changes that would cut them (lazy
PostHog, lazy exporters) are proposals P38/P39, because each changes behaviour at the
margins.

### Bugs fixed (none user-visible)

- **Tessellation worker had no error path.** A throwing job never replied. With the new
  queue that would have frozen the 3D view for the session; before the queue it leaked
  one promise (pinning a board) per failure.
- **The mesh cache leaked through undo history**: up to ~690 MB of ArrayBuffers at fine
  quality.
- **Unbounded 3D job backlog during drags** (one job per move, never dropped).
- **9 latent type errors in test files** that were never type-checked, including a
  helper whose type contradicted how the tests call it, and a `near()` helper that
  silently ignored its tolerance argument.
- **The perf probe counted skipped React subtrees.** The Phase 0 figure of "185
  components per move" was really 99, and is corrected above.

User-visible bugs found (crashes, data loss, field and touch problems) are in
`PROPOSALS.md` (P1–P43), with a suggested order.

### Tests: before → after

- **1,604 → 1,703** tests, all passing; none removed or weakened.
- **New coverage**
  - Characterization of loft, mesh and specs (25)
  - Every sample file through `.brd`, `.board.json` and share links (42)
  - 12 store editing scenarios
  - The mesh queue (8), the guide-ring equivalence, `useSyncedText`, combined-getter
    exactness and the history-identity test
- **Test files are now type-checked** in every package.
- **Strengthened:** two near-empty assertions.
- **No line-coverage tool is installed.** Adding `@vitest/coverage-v8` is the way to get
  percentages; I left it out to avoid new dependencies.
- **Still uncovered** (from the Phase 0 review): `packages/ui`, the R3F components
  (mocked in web tests), several dialogs/panels, the specs worker, and e2e for file
  import, undo/redo and session restore.

### End-to-end check (not part of CI)

Playwright on the final head, with the sandbox's preinstalled Chromium (older than the
build this Playwright version pins), through a temporary config that is not committed:

- **`e2e` (dev server): 33/33 pass.**
- **`e2e:offline` (production build): 6/7 pass.** "A shared link opens with no network at
  all" fails, and fails the same way on the Phase 0 baseline build (verified with
  `CI=1`, so the baseline built and served its own dist). It is pre-existing, and either
  environmental or a real offline share-link problem (see P45).

## Line coverage (P44)

First measured numbers, from `pnpm coverage` (Vitest v8, `src/` of each package) on
the commit that added it. Coverage counts only a package's _own_ tests, which
understates the UI packages: `SplineEditor` (render2d) and the `ui` components are
mostly exercised by `apps/web`'s tests, which these per-package figures do not credit.

| Package  | Lines                                                    |
| -------- | -------------------------------------------------------- |
| store    | 97.4% (788/809)                                          |
| worker   | 96.4% (54/56)                                            |
| kernel   | 95.9% (5191/5413)                                        |
| export   | 94.4% (3862/4091)                                        |
| units    | 89.6% (455/508)                                          |
| io       | 83.4% (1306/1566)                                        |
| web      | 74.9% (5793/7737)                                        |
| render2d | 45.3% (929/2052)                                         |
| render3d | 25.7% (232/902)                                          |
| ui       | 0% (0/732), no tests of its own; covered from `apps/web` |
