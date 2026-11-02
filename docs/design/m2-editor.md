# M2 design note: the NURBS editor

Status: **M2 design**, under `nurbs-plan.md` (which wins on any conflict) and after `m1-model.md`
(the model, evaluator, mesh, converter and viewer as built). Frame as everywhere: cm, **tail at
x = 0**, nose toward +x, y across (plus side y > 0), z up. Target: every edit except export feels
instant (drag update < 50 ms end to end); one tolerance, 0.5 mm.

## 1. Store: a second document behind the same interface

- **A section store that is a `BoardState`.** `createSectionStore()` (new entry
  `@openshaper/store/sections`) holds `doc: BoardDoc` and implements the existing `BoardState`
  interface; its `board` is a memoised **classic projection** of the doc. Reason: `SplineEditor`,
  `context-menu-items`, `ControlPointInspector`, `FinPanel` and `Board3DView` all take a
  `StoreApi<BoardState>`, so the panes, inspector, locks, Tunni controls, R/T nudging, apex line,
  station markers and context menus work unchanged.
- **Engine picks the store.** `App` passes `activeStore = engineOn ? sectionStore : boardStore` to
  the panes, sidebar and shortcuts. `boardStore` stays as the classic document (the import
  reference for "Deviation from classic"); the NURBS engine never edits it.
- **Projection** (`project.ts`, type-only imports of board2, so the flag-off bundle guard holds):
  - outline plus → `outline`, rocker → `bottom`, deck → `deck`: chains map knot for knot to kernel
    splines (`p`/`in`/`out`/`smooth` ↔ `end`/`tangentToPrev`/`tangentToNext`/`continuous`), exact.
  - each station → a physical slice `(u·w(ξ), v·T(ξ))`, w the chord length and T the stringer
    thickness at ξ: the exact inverse of the converter's normalisation. Classic's dummy end slices
    are added so index-based code is unchanged (slice i ↔ station i − 1).
  - `fins` pass through (`doc.fins` is classic's fin config).
  - Caches: `WeakMap<Chain, Spline>`, and per `Section` keyed by (w, T), so an untouched chain keeps
    its spline object and React re-renders only what changed.
- **Edits.** Each action projects its target, applies the **same kernel/store spline edit**
  (`moveKnotEnd`, `rotateKnotTangent`, `moveSegmentTangents`, locks, `fairKnot`, ...), applies the
  same rules (`enforceJunctions` for outline/rocker/deck, `constrainSectionToBlank` for slices),
  writes back **only the touched chain** (slice: divide by w and T, then clamp every control to
  0 ≤ u ≤ 1) and calls `commit(nextDoc, label)`. Reason: one set of edit maths for both engines.
- **History.** The past/future/`beginEdit`/`endEdit`/`jumpTo` logic of `board-store.ts` moves into a
  generic `history.ts` used by both stores. Guarded by `board-store.characterization.test.ts`,
  which must not change.
- **Targets.** `SplineTarget` gains an optional `side: 'minus'` on `outline` and `crossSection`.
  Classic never sets it; `sameTarget` compares it.
- **Classic-only actions** are no-ops in the section store and hidden by the UI:
  `setInterpolationType` and the "Resize cross-sections" toggle. Sections are normalised, so they
  always follow the outline, rocker and deck.
- **Locks.** `ChainKnot` gains an optional `lock?: { prev?: Pair; next?: Pair }`. Revive accepts
  it and the geometry ignores it, like classic.

## 2. Pure edit functions (`packages/store/src/sections/edits.ts`)

All take and return a `BoardDoc`. Every untouched `Chain`, `Section` and `Station` is passed through
by reference, so `buildBoard`'s fit cache stays warm: an outline, rocker, deck or feature edit refits
nothing, and a section edit refits one section (≈ 1.6 ms, `m1-model.md` §13).

| Function                                             | Behaviour                                                                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withChain(doc, target, chain)`                      | Replace one chain: outline plus or minus, rocker, deck, or one station side.                                                                                                                                           |
| `addStation(doc, x)`                                 | Classic `insertCrossSection` on the projection, normalised. The new section differs from the blend at x by at most the blend divergence (≈ 1 mm). Gets a fresh id.                                                     |
| `removeStation`, `moveStation`                       | Keep at least two stations, the order, and x ≥ d on a notched board.                                                                                                                                                   |
| `pasteSection`, `applyRailPreset`                    | The classic functions on the projection, normalised.                                                                                                                                                                   |
| `scaleDoc(fL, fW, fT)`                               | Scales the lines, station x and the feature keys and widths. Sections are untouched (they are normalised).                                                                                                             |
| Length change                                        | When the nose tip moves, station x and feature keys scale by L′/L, so the end stations stay at the ends.                                                                                                               |
| `setSymmetry(doc, 'asymmetric')`                     | `minus` copies plus **by reference** (no refit).                                                                                                                                                                       |
| `setSymmetry(doc, 'mirror', keep)`                   | Keeps the chosen side's outline and sections. The UI asks which side, labelled as the outline pane shows them.                                                                                                         |
| `setTail(doc, 'standard' \| 'swallow' \| 'fish', d)` | Rebuilds the outline's tail knots: swallow a straight inner wall to a corner tip, fish a rounded wall. Notched tails get `auto: true`, so the zone re-picks itself. Stations at ξ < d are dropped; undo restores them. |
| `setNotchDepth(doc, d)`                              | Moves the notch bottom and scales the inner wall in x.                                                                                                                                                                 |
| `add/remove/updateFeature`, `setFeatureKeys`         | Vee, single and double concave, channels; keyed depth over x.                                                                                                                                                          |

On an asymmetric board, `side: 'minus'` edits only the minus outline or section. The rocker, deck,
features, d and the nose point are shared: moving a shared end point moves it on both halves.

**Validity.** The Phase 0 section rules hold by construction (the clamps above). Plan rules
(x-monotone lines, notch chord angle) are the worker's `validateBoard`. A refused doc stays in the
store and stays editable; the 3D view keeps the last good surface marked stale, as in M1 §12.7.
Save is allowed (revive accepts shape-valid docs, which can then be repaired).

## 3. Section editor and bottom features UX

- **Stations.** The existing station markers in the outline and rocker panes do the work:
  `sectionMarkers`, `onPickSection`, `onMoveSection`, `onAddSectionAt` and `onDeleteSection` map to
  the station functions above. The section pane shows the selected station.
  - Asymmetric boards show plus at +x and minus at −x as two targets, instead of `mirrorX`.
  - A station inside the notch zone is drawn in its chord frame (across the rail), with a "rail
    section" label.
- **Rules as drag bounds.**
  - Centre points are held by `blankLocks` (as in Phase 0.5).
  - The apex moves vertically only.
  - The apex line guide (Phase 0.6) marks u = 1. Handles slide onto it rather than past it.
  - A refused move sticks at the last legal position, as in classic.
- **As-built ghost.** The section pane draws the evaluated section with features and blend as a
  dashed ghost. So does the scrub preview between stations. Both come from the worker (§4).
- **Notch depth.** The outline's first knot (d, 0) is the handle: its drag is locked to x and calls
  `setNotchDepth`.
- **Sidebar** (`sidebar-sections.ts`, Shape tab, listed only when the engine is on):
  - **Board shape**: symmetry toggle, tail type (Standard, Swallow, Fish) and notch depth.
  - **Bottom features**: add Vee, Single concave, Double concave or Channels. Each feature has an
    enable switch and its parameters. A depth-key table (x, depth) has add and remove rows.
  - Relevant to the rocker, cross-section, 3D and quad views.
  - Lengths use `units` and `format.ts` (`apps/web/CLAUDE.md`). Fractions of the chord are
    unitless %.
  - The rocker pane draws the depth over x as a read-only strip. Dragging depth keys comes later.

## 4. Live 3D during edits

- **The doc is the source.** A new protocol request `{ kind: 'doc', doc, probes }` skips the
  converter: build (no check) → validate → mesh, with ladders reused while `editing` and refreshed
  on release, as in M1 §10.
- **Identity across the clone.** Structured clone makes fresh `Section` objects. The core maps each
  section to the earlier one with the same content (coordinates rounded to 1e-9, the converter's
  key), so fits stay warm.
- **Probes.** `probes` are ξ values (the selected station and the scrub position). The answer
  carries their evaluated section polylines (both sides) for the ghosts.
- **Worker, not main thread.** The worker's share of a drag is ≈ 5 ms. The main thread is the
  bottleneck (software WebGL, M1 §11), and the 2D panes draw the projection synchronously, so they
  never wait for a mesh.
- **Specs.** Volume and plan area come from the answer's `meshProperties` (decision 6). Length,
  width and thickness come from the projection, which is exact. In NURBS mode the classic specs
  worker is skipped.
- **Classic hull.** `Board3DView` does not tessellate it while a live external surface applies.

## 5. Files

- **Save.** `.board.json` v3 is `boardDocToJson(doc)`.
  - App metadata maps onto `meta`. Fields without a slot go in a new optional `meta.extra`
    (`JsonValue`).
  - `meta.extra` and the knot `lock` are additive, so the version stays 3. The format is
    branch-only; no v3 files exist outside it.
- **Open.** `io` sniffs the version: `readBoardText` returns `{ kind: 'classic', board }` or
  `{ kind: 'sections', json }`. The app revives the second in the lazily loaded NURBS chunk. Reason:
  `io` and the main chunk stay free of board2.
- **Classic import with the engine on** (`.brd`, `.s3dx`, `.srf`, v2 json):
  - The file is parsed classically and loaded into `boardStore` as the reference.
  - Then `convertClassic` runs and the doc is loaded into the section store.
  - A refusal opens `ImportWarningsDialog` with the converter's reasons; the previous doc stays.
- **v3 with the engine off.** A dialog offers "This board uses the NURBS engine. Turn it on and
  open?". There is no NURBS → classic conversion in M2.
- **Engine switch.**
  - Off → on: the current classic board is converted when the section store is empty or
    `boardStore.loadCount` changed since the last conversion. Otherwise the existing doc is kept.
  - On → off: the classic store is shown as it was.
- **Templates.** A script (`apps/web/tools/make-nurbs-templates.ts`) runs once and commits v3
  files: the three classic templates converted, plus Swallow and Fish shortboards made with
  `setTail`. They are loaded `?raw` in the lazy chunk. The New Board chooser lists them when the
  engine is on. Each gets a `docs/registry.ts` entry (coverage test).
- **Share link.** The envelope stays `v1`; the payload is the v3 JSON, and the decoder dispatches
  as file open does.
- **Session restore.** `SessionSnapshot` gains an optional `sectionsJson` (additive, so no
  `SESSION_VERSION` bump). Both documents restore, and the engine setting picks the one shown.
- **Export (M3 territory).** In NURBS mode exports use the projection, with a notice that bottom
  features and the smooth blend are not in the file yet.

## 6. Implementation steps (one session each; the app works after every step)

1. **Section store, projection and the line editors.**
   - _Build:_ `history.ts` extraction, the projection, the section store and `side` in
     `SplineTarget`. The engine switch converts into the store, the panes edit the outline, rocker
     and deck, and the worker takes `doc` jobs. Sections are read-only in this step.
   - _Check:_ the characterization snapshots are unchanged.
   - _Check:_ chain → spline → chain is bit-identical; a slice → section round trip is within
     1e-12.
   - _Check:_ an outline, rocker or deck edit keeps every `Section` object.
   - _Check:_ undo, redo and `jumpTo` work on docs.
   - _Check:_ the flag-off bundle guard passes.
   - _Preview:_ with the engine on, drag outline, rocker and deck knots, handles and Tunni points;
     lock a knot; R/T-nudge; undo. 3D follows live, with `nurbs-timing.mjs` drag round trip
     median ≤ 35 ms and p95 ≤ 50 ms.
2. **Section editor.**
   - _Build:_ slice edits with the bounds; add, remove and move a station; paste and rail preset;
     worker probes; as-built ghost and scrub preview.
   - _Check:_ a fuzz test (random drags of every handle of every station on the three goldens)
     never produces a `section-*` validator error.
   - _Check:_ an added station is within 1 mm of the surface before the insert.
   - _Check:_ a section drag refits one section; worker p95 ≤ 15 ms, round trip p95 ≤ 50 ms.
   - _Preview:_ select a station in the outline or rocker view, reshape the rail and watch 3D
     follow; centre and apex obey the rules; add a station, delete it, undo.
3. **Symmetry and tail type.**
   - _Build:_ `setSymmetry`, `setTail`, `setNotchDepth`; two-sided targets in the panes; the
     keep-side dialog; the Board shape sidebar section; the notch handle.
   - _Check:_ asymmetric shares `Section` objects (no refit).
   - _Check:_ back to mirror keeps the chosen side bit-for-bit.
   - _Check:_ a swallow and a fish made from each golden validate.
   - _Check:_ notch-depth drags over 0.5 to 2 × d validate or report the stale surface.
   - _Preview:_ make the shortboard asymmetric and edit one rail only; switch to swallow and fish
     and drag the notch depth live; switch back to mirror and pick a side.
4. **Bottom features.**
   - _Build:_ the feature functions; the Bottom features sidebar section in display units; the
     rocker depth strip; features in the section ghost.
   - _Check:_ a feature edit refits nothing (warm build < 1 ms).
   - _Check:_ field values round-trip in mm, cm and in.
   - _Check:_ the docs registry entry (coverage test).
   - _Preview:_ add a double concave running into a vee, adjust depth and width, toggle it, and
     see 3D and the section ghost update < 50 ms per change.
5. **Files, templates, share and session.**
   - _Build:_ v3 save and open; the `io` sniff; classic import through the converter; the
     engine-off prompt; NURBS templates; share link; session restore; specs from the mesh.
   - _Check:_ save → open gives byte-identical text.
   - _Check:_ share encode → decode of a v3 doc.
   - _Check:_ a session with both docs restores.
   - _Check:_ docs coverage for the templates.
   - _Check:_ the full CI gate (lint, typecheck, test, build, `e2e`, `e2e:offline`), with e2e for
     template → edit → reload → same doc, `.brd` open with the engine on, and v3 open with it off.
   - _Preview:_ start from the Fish template, shape it, save, reload, open the file and a share
     link in another browser.

## 7. Open risks

- **Facade fidelity.** `BoardState` assumes classic semantics (dummy slices, indices,
  interpolation type). A classic-only path missed by the projection shows up as a wrong menu item
  or a no-op.
- **Notch-zone sections.** They are edited in the chord frame, not a planar cut, which may confuse.
  Outline edits near a notch can still fail `notch-chord-angle` despite `auto`.
- **Station insertion.** It uses the classic loft, so a new station can move the surface by about
  1 mm where it is added.
- **Main thread.** With software WebGL it already sets the p95 near 50 ms (M1 §11). Two-sided
  section panes and ghosts add drawing.
- **Exports in NURBS mode until M3** miss the features and the blend. The notice must be clear,
  or users will cut boards from it.
- **Share-link size** of a v3 doc is unmeasured: absolute handles and two sides on an asymmetric
  board.

## 8. As built (step 1)

Landed: the section store, the shared history and edit code, the line editors, the engine switch and the
worker's `doc` job. With the engine on, the outline, rocker and deck are edited in the NURBS document and
the 3D view follows. Sections are read-only. With the engine off nothing changes: the classic store, its
characterization snapshots and the flag-off page are untouched.

**Where it is.**

- `packages/store`: `history.ts` (undo, redo, `jumpTo`, drag grouping, shared by both stores),
  `board-actions.ts` (the spline, fin and resize actions, which both stores take from here, so there is one
  body of edit rules), `sections/` (`project.ts`, `edits.ts`, `section-store.ts`; the `./sections` entry).
  `SplineTarget` has `side?: 'minus'` (classic never sets it, `sameTarget` compares it). The package depends on
  board2 for **types only**: a separate ESLint layer for `store/sections` allows `import type` and nothing
  else.
- `packages/board2`: `ChainKnot.lock` (types, revive, writer; the geometry ignores it).
- `apps/web`: `store.ts` (`boardStore`, `sectionStore`, `activeStore`), `store-switch.ts`,
  `use-section-engine.ts`, the worker's `doc` and `convert` jobs (`nurbs-protocol.ts`, `-client.ts`,
  `-core.ts`, `-worker.ts`), the viewer's document input, and `tools/nurbs-bundle-guard.ts`.
- `packages/render3d`: a live surface is placed by its own centre (see Performance).

**Deviations from the design above.**

1. **The editors hold a switch, not a store they are passed.** `activeStore` (`StoreSwitch`) stands for
   whichever store the engine picks; `App` points it in a layout effect (`activeStore.use(...)`) and
   everything that read `boardStore` (panes, inspector, sidebar, shortcuts, 3D view, update prompt) reads
   `activeStore` instead, so no editor needed a new prop. App still uses `boardStore` where it means the
   classic document (loading files, the classic reference for the deviation view).
2. **The conversion runs in the NURBS worker** (`kind: 'convert'`), not in a main-thread chunk: the main
   chunk never imports board2, and the worker is already there. The doc comes back by structured clone;
   the next `doc` job matches its sections by content, so fits stay warm.
3. **A refused board leaves the classic store in charge**, not "the previous doc stays" plus the import
   dialog: the section store keeps its old document, but `activeStore` is the classic store until a board
   converts, so the user edits the board they actually opened. The reasons are in the 3D popover (the
   viewer's classic path reports them). `ImportWarningsDialog` for this is step 5.
4. **No probes in the `doc` request.** They carry the ghosts, which are step 2.
5. **Stations inside a notch zone are projected with the plan half-width at x = ξ**, not the chord. The
   projection is the only place that matters (the section pane), and sections are read-only; step 2 moves
   it to the chord frame (it needs board2's `makeFrame`, which the store may not import).
6. **Two plan rules are added to the classic junction pass** in the section store's `commit`
   (`pinPlan`): every control point of the outline has y ≥ 0 (classic lets a handle cross the stringer) and
   a standard tail's first knot is the tail tip (0, 0) (classic lets the tip move to another knot). Without
   them a drag could make the document refuse itself at `outline-endpoints` or `tail-start`.
7. **The deck's end walls.** The document drops classic's vertical walls (the converter does); the
   projection puts a collapsed corner knot back at the rocker's end heights, and the write-back takes it off
   and moves the chain's end knot to the wall's x. So the junction pass keeps working unchanged, dragging the
   deck's wall knot moves the rocker's tip as in classic, and a nose drag carries the deck's last knot.
8. **Length change** (the nose moves) scales the stations and the feature keys by L′/L, as designed; it is
   in `applyBoardEdit` and tested.
9. **Saving, exporting, sharing and the autosave write the projection** (`activeStore`'s board), not the
   classic board the engine was switched on with. So no NURBS edit is lost to a reload, at the cost of the
   engine-off view then being the projection. The docs page and the Settings text say so. Step 5 replaces the
   autosave with the document.
10. **The classic specs worker runs on the projection**: volume and the rest are the classic loft's of the
    NURBS board's stations. The mesh's volume is in the 3D popover. Step 5 moves the specs to the mesh.

**Classic hull no longer meshed per edit (`render3d`).** The M2 note's §4 had this under "Live 3D"; it turned
out to be what the step 1 timing needs (below). While a `live` external surface applies, `BoardMesh` does not
tessellate the classic hull (the ghost deviation still asks for it), the surface is placed by the centre of
its own mesh, and `Fins3D` and `Guides3D` take that centre through `useBoardOffset` (built for the board
on a deferred value, so a burst of edits does not build them for each one). The classic hull's centre and the
surface's differ by the two surfaces' difference at the extremes (expected about a millimetre; not
measured), so the fins sit that much differently on the surface. Applies to the M1 classic path too (also `live`).

**Acceptance (tests).**

| Check                                                                                                 | Result                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Characterization snapshots (`board-store`, kernel, io)                                                | Unchanged; the 249 existing store tests pass unmodified after the history and actions extraction                                                                    |
| chain → spline → chain, outline, rocker and deck, 3 goldens + swallow, fish, asymmetric               | Bit-identical (deep equality, `-0` checked)                                                                                                                         |
| slice ↔ section on the 3 goldens                                                                      | 1.1e-16 worst (limit 1e-12)                                                                                                                                         |
| An outline, rocker or deck edit keeps every `Section` object                                          | Holds on the 3 goldens; an edit also keeps the untouched chains, the stations and the fins                                                                          |
| The edit is the classic edit: same curves and same history labels as the classic store                | Holds for move, lock, rotate, step length, corner, fair, align (outline, rocker, deck)                                                                              |
| undo, redo, `jumpTo` on documents; a drag is one step; a refused drag leaves none                     | Pass                                                                                                                                                                |
| Random drags (150 per golden, seeded) never break a rule the editor owns                              | Pass (`thickness`, a knot dragged past its neighbour and the notch angle are the user's to fix, as in classic, and the 3D view keeps its last good surface)         |
| Flag-off bundle guard                                                                                 | `tools/nurbs-bundle-guard.ts`: after the build, only `nurbs-core-*` and `nurbs-worker-*` contain board2's code; a deliberate leak fails the build (checked by hand) |
| Flag-off page requests no NURBS module (e2e), and the editor with the engine on edits the NURBS board | Pass; the e2e also drags, undoes, redoes and switches the engine off and on (the document survives)                                                                 |

**Timings** (Chromium, software WebGL, production build, 4-core container,
`node apps/web/tools/perf/nurbs-timing.mjs`; the quad view, the shortboard, 60 pointer moves per drag, three
runs). Request to answer on the main thread per update, median (p95):

| Drag                        | Round trip, ms            | Worker, ms               | Build, ms          | Mesh, ms          |
| --------------------------- | ------------------------- | ------------------------ | ------------------ | ----------------- |
| Outline wide point (3 runs) | 12 (23), 12 (17), 11 (17) | 5.6, 5.7, 5.3 (p95 ≤ 13) | 0.7 to 0.8 (≤ 1.7) | 4.6 to 4.9 (≤ 12) |
| Deck point (3 runs)         | 12 (16), 10 (17), 12 (22) | 6.2 to 6.8 (p95 ≤ 21)    | 0.6 to 0.7         | 5.6 to 6.1        |
| Rocker point (3 runs)       | 11 (26), 10 (16), 12 (17) | 6.5 to 7.1 (p95 ≤ 23)    | 0.6 to 0.7         | 5.8 to 6.3        |

The targets (median ≤ 35 ms, p95 ≤ 50 ms) are met with a wide margin; the largest single update in the nine
runs was 75 ms (one stall in the first rocker run; the others top at 17 to 29). The warm build is
0.7 ms: no converter, and no refit (the sections are matched by content in the worker). After release one
more job re-derives the ladders and the curvature: 31 to 78 ms in the worker.

Before the render3d change the same drags measured median 16 to 17 ms (one run 53) with **p95 65 to 83 ms**
(worker median 7 ms): the classic hull was meshed, built into a geometry and drawn on every edit as well, so every
other answer waited behind a software-WebGL frame. With a throttled CPU (4×, a phone) the median is 52 to
57 ms and p95 129 to 146 ms, nearly all of it the main thread's frames (worker median 5 to 7 ms): the same
limit as in M1 §10.

Opening the shortboard with the engine on (one run): NURBS surface on screen in 108 ms, the board editable (converted
into the section store, in the worker) 289 ms after the file input. Turning the engine on in Settings with the
3D view open, hull on screen and board editable in 0.5 to 0.6 s (includes fetching the lazy layer chunk and
starting two workers).

**What step 2 must know.**

- Sections go through `withChain(doc, { kind: 'crossSection', index, side? }, chain)` (index is the classic
  slice index, station `index - 1`) and `sliceToSection(slice, w, T, apex)` (divides by the half-width and
  thickness, clamps u to [0, 1]). The section store's `lines()` guard turns every spline action on a
  cross-section into a no-op, and the classic-only station actions are stubs: step 2 replaces both. The
  shared actions already run `constrainSectionToBlank` for a `crossSection` target; they only need the
  write-back (`applyBoardEdit` compares only the three lines).
- A section edit changes the section's content, so the worker refits that one section (`canonicalDoc` finds no
  match); every other section keeps its fit. `sameDocHull` in the viewer compares `stations` by identity, so a
  station edit must produce a new `stations` array.
- `w(ξ)` and `T(ξ)` of the projection (`crossSectionsOf`) are the half-width at x = ξ and the stringer
  thickness at ξ, so a section's physical slice changes with any line edit even though the `Section` does
  not. In a notch zone `w` is wrong (deviation 5); use board2's frame there, in the worker or an injected function.
- The deck's wall knots exist only in the projection (deviation 7): indices in the rocker pane are the
  projection's, and a station marker's `index` is `station + 1`.
- The viewer asks for the classic reference only for "Deviation from classic" (`reference` on the `doc`
  request), and `activeStore` is what the layer subscribes to: it re-reads when the engine switches.
- The classic board is still loaded by file open; `use-section-engine.ts` converts it when `loadCount`
  changes. Anything that loads the classic store with the engine on has a window (about 0.1 to 0.3 s) in which
  the classic board is edited, and an edit made in it is dropped by the conversion that follows.
