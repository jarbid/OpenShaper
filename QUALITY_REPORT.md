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

| Metric                                          | Desktop       | Mobile       |
| ----------------------------------------------- | ------------- | ------------ |
| First contentful paint `/app`                   | 224 ms        | 4,860 ms     |
| `load` event                                    | 136 ms        | 4,219 ms     |
| Editor ready (canvas sized)                     | 673 ms        | 7,930 ms     |
| JS fetched for `/app` (uncompressed)            | 1,960 KB      | 1,092 KB     |
| Drag: input → next frame, median / p95          | 30 / 32 ms¹   | 83 / 98 ms   |
| Drag: main-thread task time per pointer move    | 13.0 ms       | 78.6 ms      |
| Drag: script time per pointer move              | 3.6 ms        | 19.0 ms      |
| React commits per pointer move                  | 2             | 2            |
| **React components rendered per pointer move**  | **185**       | **186**      |
| JS heap after load → after 150 undo/redo edits² | 9.8 → 10.9 MB | 6.3 → 6.6 MB |
| DOM nodes                                       | 590           | 419          |

¹ The probe waits two animation frames, so ~30 ms is the floor at 60 Hz; the task time
is the informative number on desktop.
² Edits with the 3D view mounted (quad on desktop, split on phone); forced GC before
each reading. JS heap only — WebGL buffers are not counted.

**Bundle** (`pnpm build`): 2.14 MB of JS in `dist/assets` (655 KB gzip). Largest
chunks: `index` 877 KB (238 KB gz — three.js / R3F), `app` 598 KB (195 KB gz),
`file-io` 232 KB (78 KB gz), `App` 196 KB (63 KB gz). Vite warns on chunks > 500 KB.
