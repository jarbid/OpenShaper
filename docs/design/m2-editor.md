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

## 9. As built (step 2)

Landed: the section editor. With the engine on, a station's section is edited in the cross-section pane under
the Phase 0 rules, stations are added, deleted and moved, sections are pasted and given rail presets, and the
pane draws the as-built section (what the NURBS surface really has) as a dashed ghost at the selected station
and under the scrub. With the engine off nothing changes (the classic characterization snapshots are untouched).

**Where it is.**

- `packages/store/src/sections`: `edits.ts` (`addStation`, `removeStation`, `moveStation`, and the slice
  write-back inside `applyBoardEdit`), `project.ts` (the injected chord, `sliceDims`), `section-store.ts` (the
  `lines()` guard and the station stubs are gone; `setNotchChords`). `board-actions.ts` gained
  `createSectionShapeActions` (paste and the rail presets), which both stores now take from there.
- `packages/board2`: `probe.ts` (`createChordFn`, `probeSection`), and `buildBoard`'s `spanHint`
  (see Performance).
- `apps/web`: the worker's `probes` on the `doc` request and a probes-only `probe` request
  (`workers/nurbs-protocol.ts`, `-core.ts`, `-worker.ts`, `nurbs-client.ts`), `nurbs-viewer.ts` (probes in
  the input and the state), `nurbs-probes.ts` (the channel between the editor and the layer, and the polyline
  as a spline), `nurbs-layer.tsx`, `App.tsx` (the ghosts), `use-section-engine.ts` (`injectNotchChords`).

**How a section edit is written back.** The slice actions are the classic ones (`constrainSectionToBlank`
holds the centre points, the apex's width and `u <= apex`). `applyBoardEdit` then looks at every slice of the
projection: one that differs from the projection's is divided by the half-width (chord) and thickness it was
projected with (`sliceDims`, remembered per slice object) and replaces that station's `Section`; the
station list is a new array and every other `Section` is the same object. It only does so when the outline,
rocker and deck were not touched by the edit: a whole-board resize scales the slices with the lines, and the
normalised sections do not change, so they are left alone (a step 1 test pins this). The apex knot is
recomputed (the old one if it still sits at `u = 1` and the knot count is unchanged, else the same point, else
the first widest knot), so inserting or deleting a knot cannot leave `section-apex-index` or
`section-apex-moved` behind. A station whose chord or thickness is zero (a tip, a blunt end) has nothing to
edit and an edit there is taken back.

**The notch-zone chord.** `w(xi)` is board2's `createChordFn(doc)`: the length of the fan chord from `(xi, 0)`
to the outline point `P(xi)`, on the resolved notch zone. The store takes it by injection
(`setNotchChords`, a `NotchChords = (doc) => (xi) => number`), and `projectDoc(doc, chords)` keys its
cache on it. The app loads it from `workers/nurbs-core.ts` (the module the worker also bundles, a lazy chunk,
so the flag-off bundle guard still holds) in `use-section-engine.ts` before a **notched** board is loaded; a
standard board never loads it (its half-width is a function of x, which the store computes). The provider
caches the function on (outline, tail, rocker, deck), so a section edit on a swallow does not re-resolve the
zone. The pane title says "(rail section)" for a station inside the zone (by the stored zone).

**Probes.** `doc` requests carry `probes` (station coordinates) and the answer carries, per coordinate, both
sides' as-built section as a polyline in the pane's frame: `x` the distance along the chord from the stringer,
`y = v * T(xi)` with `v` the surface's own normalised height at the point, so a feature's depth will show as a
dip and the section at a station overlays the stored one to the fit tolerance. When only the probes change (the
pointer moves along the outline) and no job is running, a `probe` request asks for them alone: a warm build and
no mesh, so a hover uploads nothing to the 3D view; a change that arrives during a job waits for its answer. The
App asks for the selected station and the scrub position (`nurbs-probes.ts`); the layer over the 3D view owns
the worker, so the ghosts need the 3D view on screen (quad, split or 3D): in the single cross-section view the
scrub ghost is the classic loft of the projection, as before.

**Deviations from the design above.**

1. **Station insertion is within 1.1 mm, not 1 mm, of the surface it was added to.** It is classic's
   `insertCrossSection` on the projection, normalised by its own width and thickness. Measured on the midpoints
   of every gap of the three goldens (the section at `x` of the new board against the old surface, 96 points,
   both directions): shortboard 0.65 mm, funboard 1.07 mm, longboard 1.03 mm worst. The difference is the
   classic loft against the NURBS blend (M1 §13), not the fit. Closing it needs the blend's section as a chain
   with few knots, which the converter's fitting does not give; not done. The test bound is 1.1 mm.
2. **Chord by injection from the lazy core chunk, on the main thread, for notched boards only.** Computing it
   in the worker would make every projection asynchronous. Cost: the 0.3 MB core is also parsed on the main
   thread when a swallow or fish is opened with the engine on.
3. **`probe` is a second request kind**, besides `probes` on the `doc` request, for the hover (above).
4. **`buildBoard({ spanHint })` while editing** (board2). Not in the design; see Performance.
5. **The minus side is not edited** (step 3): `side: 'minus'` targets are not produced by the UI yet, and the
   pane shows the plus section on an asymmetric board. The probe carries both sides.
6. **Paste and the rail presets** share their bodies with the classic store (`createSectionShapeActions`)
   instead of being separate pure functions; the section store's write-back is what normalises them. A pasted
   control that passes the apex line is clamped to `u = 1` by the write-back.
7. **`sameDocHull` already compared `stations` by identity**; a test pins that a station edit is a new hull
   and a fin edit is not.

**Acceptance (tests).**

| Check                                                                                                                                                                   | Result                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Characterization snapshots (`board-store`, kernel, io)                                                                                                                  | Unchanged (297 store tests, the 249 classic ones among them, pass without edits)                                                            |
| Seeded random drags of every knot, and both handles of each, of every station (4 drags each, drags of up to 6 cm in each direction), 3 goldens, swallow, fish           | No `section-*` validator error, ever; the lines never move                                                                                  |
| An added station lies within 1 mm of the earlier surface                                                                                                                | Not quite: 1.07 mm worst (deviation 1)                                                                                                      |
| A section drag refits one section                                                                                                                                       | Holds on the 3 goldens: one `Section` replaced, every other the same object, outline, rocker, deck and fins the same objects, one undo step |
| Undo and redo of add, remove, move station and of section drags                                                                                                         | Pass (labels and the projection follow; a station cannot pass its neighbour; at least two stations stay)                                    |
| Centre points held, apex vertical only, swallow station on its chord                                                                                                    | Pass                                                                                                                                        |
| Paste and rail preset write one valid section                                                                                                                           | Pass                                                                                                                                        |
| e2e: select a station, drag the apex in the cross-section pane, undo and redo                                                                                           | Pass (volume 27.3 L, 27.5 L edited, 27.3 L after undo)                                                                                      |
| Gate: `pnpm lint`, `pnpm typecheck`, `CI=1 turbo run test --concurrency=2`, `pnpm build` (bundle guard), `pnpm --filter @openshaper/web e2e` (47) and `e2e:offline` (8) | All pass. Nothing flaky seen in these runs.                                                                                                 |

**Performance.** The section drag (the apex of a mid-board station, 60 pointer moves, same setup as step 1:
Chromium, software WebGL, production build, 4-core container, `nurbs-timing.mjs`) built one section per
move at 3.1 to 3.3 ms median (p95 8 to 14 ms) because the fit climbs the span ladder from 12 spans for the new
section at every move, and the rung it stops on jumps between 12 and 48. `buildBoard` now takes a `spanHint`:
while an edit is in progress the worker offers it the span the last build chose, and it is taken when it fits
every station within the tolerance, so the dragged section is fitted once; the settled job after the release
climbs as before. The hinted rung is at least as fine as the one the climb would have stopped at, so the
surface during the drag differs from the settled one by less than the fit tolerance (0.5 mm).

Six runs (the first three are the ones before the hint, for reference), request to answer on the main thread,
median (p95), worker median (p95), and the build and mesh medians:

| Section drag      | Round trip, ms                                       | Worker, ms                                                              | Build, ms (median)          | Mesh, ms (median)             |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| Before the hint   | 13 (72), 14 (61), 13 (21)                            | 11.1 (31.7), 11.7 (25.0), 11.0 (19.7)                                   | 3.1 to 3.3                  | 7.5 to 8.3                    |
| With the hint, 6x | 10 (68), 11 (30), 10 (16), 12 (19), 11 (41), 12 (76) | 9.1 (25.1), 9.4 (28.1), 8.5 (15.1), 9.6 (18.3), 10.0 (19.7), 9.4 (27.6) | 1.4 to 1.6 (p95 4.6 to 9.1) | 6.9 to 8.3 (p95 12.6 to 20.8) |

For comparison the same runs for the line drags (worker p95): outline 10.8 to 12.4 ms, deck 16.3 to 19.7, rocker
11.3 to 12.6; round trip median 10 to 11 for all three.

**The targets are not met reliably.** The medians are far inside them (worker 8.5 to 10 ms, round trip 10 to
12 ms). Worker p95 is 15.1 to 28.1 ms against a target of 15: it met it once in six runs. Round trip p95 is
16 to 76 ms against 50: it met it in four of six. What is left is not the fit any more (build p95 4.6 to 9 ms,
median 1.5) but the mesh (p95 13 to 21 ms, the same as the unedited deck drag's 16 to 20 ms in the same
sessions) and main-thread stalls behind software-WebGL frames, the limit M1 §10 and step 1 already named.
A deck drag, which edits no section, misses the 15 ms worker p95 too in this container, so the target is
tighter than this container's noise; on a quiet machine or with a GPU it should hold, but that is not measured.

**What step 3 must know.**

- A tail change to or from a notched tail must call `injectNotchChords(doc)` (`use-section-engine.ts`) before
  the document is loaded or the projection shows the plan's outer rail for stations in the notch zone. The
  provider is per store (`setNotchChords`), set once, and keyed on (outline, tail, rocker, deck) identity.
- `side: 'minus'` is accepted by `withChain` for a station and by `applyBoardEdit` not at all: the slice
  write-back handles the plus section only (`st.plus`), and `sliceDims` and `projectDoc` project the plus
  side only. Two-sided panes need a second projection (or a side argument) and a write-back per side. The
  probes already carry `minus`.
- The apex index is recomputed on every write-back (`sectionOfSlice`); keep that for the minus section.
- `addStation` and `moveStation` use the plus outline's range `[xi0, L]` (`xi0` is `d` on a notched board);
  `setTail` must drop or move stations at `xi < d` itself (`validateBoard` reports `station-order`).
- `setNotchDepth` changes the chord of every station in the zone: the sections are normalised, so they follow,
  and the projection re-derives `w` through the injected function (new outline chain, new cache entry).
- `buildBoard`'s `spanHint` is the worker's, from `lastSpan`; a document job with `reuseLadders` uses it.
- Rocker-pane indices are projection indices (the deck's wall knots), and a station marker's index is
  `station + 1`; both still hold.
- The ghosts need the 3D view mounted (the layer owns the worker). A two-sided section pane adds a second
  ghost; `probeAt(items, xi)` matches on the exact coordinate asked.

## 10. As built (step 3)

Landed: symmetry, tail type and notch depth. With the engine on, a **Board shape** section in the Shape tab
makes the board asymmetric (each half gets its own outline and its own section at every station) or mirror
symmetric again (asking which half to keep), and sets a standard, swallow or fish tail and its notch depth. The
outline and cross-section panes show both halves of an asymmetric board and edit either. With the engine off
nothing changes (the classic characterization snapshots are untouched).

**Where it is.**

- `packages/store/src/sections`: `shape.ts` (`setSymmetry`, `setTail`, `setNotchDepth`, `tailTypeOf`,
  `defaultNotchDepth`, `notchDepthRange`; all pure), `edits.ts` (`applyMinusEdit`, `alignEnds`, `scalePlan`;
  `addStation` takes a section from each half), `project.ts` (the minus projection), `section-store.ts` (the
  `side: 'minus'` dispatch and the three new actions on `SectionState`). `packages/store/src/edits.ts` has
  `SidedBoard`, `minusHalf` and `findTargetSpline`; `getTargetSpline` reads a minus target from the minus half.
- `packages/render2d`: `sides.ts` and the `splitSides` prop of `SplineEditor` (and `axis` in the context-menu
  request). `packages/board2`: `createChordFn(doc, side?)`.
- `apps/web`: `BoardShapeSection.tsx`, `KeepSideDialog.tsx`, `board-shape.ts` (`TAIL_TYPES`), the `boardShape`
  entry in `sidebar-sections.ts` (with `SIZING.segment` in `Sidebar.tsx`), `paneProps` in `view-toolkit.tsx`,
  the ghosts and copy/paste in `App.tsx`, `loadNotchChords` in `use-section-engine.ts`, the docs section
  `board-shape` on `/docs/editing` with a registry kind `tail-type`.

**The minus half.** An asymmetric document projects to a plus board with a second classic board attached,
`board.minus` (`SidedBoard`): its outline is the minus outline, its stations the minus sections (projected with
the minus half-width or chord), and its rocker, deck and fins the very same objects. Everything that reads
`getTargetSpline(board, target)` (the panes, the inspector, nudging, the context menu) therefore reads a
`side: 'minus'` target without change. The writers take the same route: the section store builds the shared spline
actions twice, once over the plus board and once over `board.minus`, and sends a minus target (named without its
side) to the second. So a minus edit is the classic edit with the classic rules (`enforceJunctions`,
`constrainSectionToBlank`, the Phase 0 section rules), and `applyMinusEdit` writes back the minus outline and the
touched minus sections only. Paste and the rail presets take an optional `side`.

- **Shared end points.** The nose and the notch bottom are on both halves. A plus edit that moves one carries the
  minus end with it (`alignEnds`); the minus outline's ends are held on the plus outline's, so dragging the minus
  nose in x does nothing. The rocker, deck, stations and features are never written by a minus edit.
- A whole-board resize scales the minus outline with the plus one.
- `setTail` and `setNotchDepth` act on both outlines.

**Panes.** In an asymmetric board the outline pane draws the plus half above the centre line and the minus half
below it; the cross-section pane draws the plus section to the right of the centre line and the minus section
to the left. Each is edited where it is drawn: `SplineEditor` (`splitSides`) works on a reflected copy of the
minus spline (one object per spline, `sides.ts`) for drawing and hit testing, and reflects every point it hands
back. Ghosts (the as-built probes, the scrub preview, neighbouring stations, the classic ghost board) are drawn
on both sides. The keep-side dialog names the halves as the outline view draws them: the upper rail and the
lower rail.

**Notch depth.** The outline's first knot of a notched tail is the handle: a drag of it (or a typed X in the
inspector) is `setNotchDepth`, y is ignored, and a drag is one undo step. The section has a field in the display
unit, held between 0.5% and 30% of the length. The wall scales in x with the depth; the tail tips stay at x = 0.

**Tails.** `setTail` replaces the outline's tail knots. A swallow is a straight inner wall from the notch bottom to
a corner tip, a fish a rounded wall; the default depth is 6% (swallow) and 3.5% (fish) of the length, the tip's
half-width 42% and 50% of the greatest half-width, and the tail is marked `auto` (zone 1.5 d to start). Going to
standard rebuilds a round tail from the tip's rise.

**Deviations from the design above.**

1. **The tail type is not stored.** `tailTypeOf` reads it back from the wall: a straight wall (handles on the
   diagonal of the wall's own unit square) is a swallow, a bowed one a fish. A converted classic notch, or the
   fish test board (whose wall is nearly straight), may read as the other kind; no data is wrong, only the label.
   Switching between swallow and fish keeps the depth and the tip and rebuilds the wall.
2. **`setNotchDepth` moves the station on the notch bottom with it and drops the ones it passes** (the design only
   moved the notch bottom). Changing the tail to or from a notch, and a depth drag past a station, drops stations
   behind the new notch bottom as designed; undo restores them. Stations inside the zone are kept (the converter
   drops them; here the user keeps what they drew).
3. **Bottom feature keys are not moved** by a tail change. A feature whose keys then lie behind the notch bottom is
   `feature-invalid` and the surface is refused (stale, below). The feature functions are step 4.
4. **A refusal keeps the last good surface only for a gesture.** A drag of the notch handle, a point or a section
   does (`editing`); a typed depth or a tail change that the model refuses shows the classic mesh and the reason
   (the viewer's existing rule, M1 §12.7, unchanged).
5. **Specs, save, share and the autosave of an asymmetric board** use the plus half mirrored (step 1's deviations 9
   and 10 still hold): the file has one half. The 3D view and the popover's volume are the whole board. Step 5
   (the document is what is saved) removes this; the docs page says so.
6. **The minus nose cannot be dragged in x** (it is held on the plus nose); drag the plus one.
7. **`NotchChords` takes a side**, and `notchChords` in the worker core keeps one memory per side; the key includes
   the other half's outline, since the notch zone is picked on both.
8. **`BoardState.pasteCrossSection` and `applyRailPreset` gained an optional `side`** (classic ignores it).

**Acceptance (tests).**

| Check                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Characterization snapshots (`board-store`, kernel, io)                                                                                 | Unchanged (324 store tests, the 249 classic ones among them, pass without edits)                                                                                                                                                                                                                      |
| Asymmetric shares the `Section` objects, no refit                                                                                      | Holds on the 3 goldens: every `minus` is the `plus` object, the minus outline is the plus chain, and the lines, features and fins are the same objects (the fit cache is keyed by `Section` identity)                                                                                                 |
| Back to mirror keeps the chosen side bit for bit                                                                                       | Holds for both halves of the asymmetric test board: the kept chain and every kept section are the very objects, and the JSON is equal                                                                                                                                                                 |
| A swallow and a fish made from each golden validate                                                                                    | Pass (6 boards), also built, switched to the other kind and back to standard                                                                                                                                                                                                                          |
| Notch-depth drags over 0.5 to 2 x the default depth (31 steps) validate or are refused with reasons, never a throw                     | Fish: 31 of 31 valid on all 3 goldens. Swallow: valid up to 1.75 x (shortboard, 25 of 31), 1.70 x (funboard, 24) and 1.50 x (longboard, 20); deeper is refused with `notch-chord-angle`. In the browser the drag keeps the last good surface ("last good surface shown") and recovers on the way back |
| Fuzz of every handle of every station (step 2) extended to the minus side of an asymmetric board                                       | Pass: the asymmetric test board and the three goldens made asymmetric, minus side; also the plus side of the asymmetric board. No `section-*` error; the lines and the other half never move                                                                                                          |
| A minus edit changes only the minus half; a plus end-point move carries the minus end; one undo step                                   | Pass                                                                                                                                                                                                                                                                                                  |
| `SplineEditor` with `splitSides`: a drag of a minus point below the stringer edits the minus spline in its own frame                   | Pass (jsdom)                                                                                                                                                                                                                                                                                          |
| e2e: make the shortboard asymmetric, drag one rail's outline point, only that side changes, undo                                       | Pass                                                                                                                                                                                                                                                                                                  |
| Gate: `pnpm lint`, `pnpm typecheck`, `CI=1 turbo run test --concurrency=2`, `pnpm build` (bundle guard), `e2e` (48), `e2e:offline` (8) | All pass. Nothing flaky seen in these runs.                                                                                                                                                                                                                                                           |

**Timings** (`nurbs-timing.mjs --skip open,switch`, one run: Chromium, software WebGL, production build, 4-core
container, 60 pointer moves per drag, quad view, the shortboard). Request to answer on the main thread, median (p95),
and the worker's:

| Drag               | Round trip, ms | Worker, ms | Build, ms (median) | Mesh, ms (median) |
| ------------------ | -------------- | ---------- | ------------------ | ----------------- |
| Outline wide point | 11 (19)        | 5.4 (14.6) | 0.5                | 4.8               |
| Deck point         | 10 (17)        | 6.1 (16.0) | 0.4                | 5.6               |
| Rocker point       | 11 (16)        | 6.8 (11.3) | 0.5                | 6.3               |
| Section apex       | 12 (40)        | 9.0 (24.1) | 1.5                | 7.4               |

The line and section drags are where step 2 left them (step 2: lines median 10 to 12 ms and worker p95 11 to 23;
section median 10 to 12 ms, round trip p95 16 to 76, worker p95 15 to 28): this step adds nothing to the worker or to
a symmetric board's drag, and the build is as warm (0.4 to 0.5 ms). The step 2 caveat stands: the section drag's worker
p95 is above its 15 ms target in this container and the line drags' is at or just above it (deck 16.0); the
medians are far inside. An asymmetric board's drag was not timed (one run, no new targets); the worker builds the
minus side's sections with the same cache.

**What step 4 must know.**

- Feature keys must lie strictly inside `(xi0, L)` where `xi0` is the notch bottom `d`, and the first and last values
  are zero. `setTail` and `setNotchDepth` do not touch the features, so the feature functions have to keep their keys
  clear of `d` (or move them) when the tail changes: today a swallow made under a feature that starts behind the notch
  bottom is refused as `feature-invalid`.
- The features and the rocker are shared by both halves of an asymmetric board, but the feature validator's chord limits
  are the narrower of the two halves (`minChord(frames, ...)`): a minus-side outline edit can make a channel too wide for
  the board (`feature-invalid`, refused: the 3D view goes stale).
- A new action that edits a spline should be added to `SPLINE_ACTIONS` in `section-store.ts` only if it takes a target
  first, as all of them do; the minus half is reached by that list. Anything that takes a station index (paste, presets,
  a station edit) must say which half (`side`) or act on both.
- `tailTypeOf` is derived: do not store a tail kind next to `tail` without adding it to `BoardDoc` and its revive.
- `projectDoc(doc).minus` is the minus half's board; `getTargetSpline(board, target)` reads a `side: 'minus'` target
  from it. A new reader that builds its own board from `board.outline` must carry `.minus` or ask for the half it wants.
- The classic specs, save, share and the autosave still write the plus half mirrored (deviation 5); step 5 replaces
  them with the document.
- Typed values that the model refuses (a depth, a tail) show the classic mesh with the reason; only gestures keep the
  stale surface (deviation 4). If step 4's feature fields commit one value at a time, they will show the same.

## 11. As built (step 4)

Landed: bottom features. With the engine on, a **Bottom features** section in the Shape tab adds a vee, a single
or double concave or channels, switches each on and off, and sets its depth, its extent along the board and its
shape, in the display unit. The rocker pane draws the depth of every enabled feature as a read-only strip, the
cross-section pane's dashed as-built section shows the features, and a tail or notch change no longer refuses a
board whose features reach behind the new notch bottom. With the engine off nothing changes (the classic
characterization snapshots are untouched).

**Where it is.**

- `packages/store/src/sections`: `features.ts` (all the feature edits, the field ranges, `refitFeatures`,
  `depthPolyline`), `shape.ts` (`setTail` and `setNotchDepth` call `refitFeatures`), `section-store.ts` (the
  eight feature actions and `featureLimits` on `SectionState`).
- `packages/render2d`: `drawFeatureDepth` and the `featureDepth` overlay (`EditorOverlays`).
- `apps/web`: `bottom-features.ts` (the kinds, the fields of each, text and parse, the strip's series),
  `BottomFeaturesSection.tsx`, the `bottomFeatures` entry in `sidebar-sections.ts` (with `SIZING.addButton` and
  `SIZING.slider` in `Sidebar.tsx`), `help-text.ts`, the docs section `bottom-features` on `/docs/editing` with a
  registry kind `bottom-feature` (and its coverage test), `App.tsx` (the strip), `e2e/nurbs-viewer.spec.ts`, and a
  feature measurement in `tools/perf/nurbs-timing.mjs`.

**The edits** (`features.ts`; pure, take and return a `BoardDoc`, and replace `features` only, so every `Chain`,
`Section` and `Station` is the same object):

| Function                                             | Behaviour                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addFeature(doc, kind)`                              | Appends an enabled feature (`vee`, `single-concave`, `double-concave`, `channels`) with a four-key plateau depth over a share of the station range, fitted to the board. Ids are `kind`, `kind-2`, ...                                         |
| `removeFeature`, `setFeatureEnabled`                 | A disabled feature keeps its settings and is not validated or built.                                                                                                                                                                           |
| `setFeatureParams(doc, id, patch)`                   | Stringer blend, width, centre, channel count, width, spacing, rail inset; each clamped to its range given the others.                                                                                                                          |
| `setFeatureDepth(doc, id, d)`                        | Scales the inner keys so the greatest depth is `d`.                                                                                                                                                                                            |
| `setFeatureKey`, `addFeatureKey`, `removeFeatureKey` | The first and last key move along x only (they are the feature's From and To); an inner key moves between its neighbours and has a depth; a curve keeps its ends and one key between.                                                          |
| `featureLimits(doc, f, chords?)`                     | The range of every field. The sidebar clamps to it and the edits clamp to it, so a value inside it is never refused.                                                                                                                           |
| `refitFeatures(doc, chords?)`                        | After a tail or notch change: a curve that starts behind the new notch bottom (or ends past the nose) is squeezed into the room that is left (an affine remap of its keys, handles scaled with it), and channels are brought inside the chord. |

The store actions are one undo step each, labelled "Add vee", "Set depth of double concave", and so on; a slider
drag (`beginEdit` ... `endEdit`, wired to the pointer and the arrow keys) is one step in all.

**Ranges.** Fractions of the chord stay in [5%, 100%] (a double concave: width up to 50%, centre between the width
and one minus the width, so the bumps stay apart and off the outline). Depth is at most 1.5 cm and 30% of the
thinnest stringer thickness under the feature. From and To keep 0.5 cm inside the station range and at least 2 cm
apart. Channels: 1 to 4, 0.2 to 3 cm wide, spacing at least the width, and the far edge of the outermost within
95% of the narrowest chord under the feature, measured on both halves; in a notch zone the chord comes from the
injected `NotchChords` (the zone's chord is short near the notch bottom, which only board2's frame knows; the
first version of this used the rail's half-width and was wrong there, the fuzz found it). When a patch would
break the channel limit, the channels give way in the order rail inset, spacing, count, width, the field being
edited first.

**Deviations from the design above.**

1. **The section ghost needed no new code.** The as-built section comes from the worker's probes (step 2), which
   evaluate the surface with its features, so a concave already shows as a dip. A test pins it
   (`nurbs-core.test.ts`: the section at a station rises by about the depth, the deck point does not move, and a
   smaller depth gives a smaller rise). Like the other ghosts it needs the 3D view mounted.
2. **The sidebar's specs do not include the features.** In the NURBS engine the specs readout is the classic
   specs worker on the projection (step 1, deviation 10), which has no features; the volume in the 3D view's
   **i** popover is the mesh's and does follow (the e2e checks it). Step 5 moves the specs to the mesh.
3. **The depth-key table is in** (inner keys: position, depth, remove, add key), as designed in section 3, with
   the From, To and Depth fields and sliders on top.
4. **The strip draws its own polyline of the depth curve** (`depthPolyline`, the Bézier points taken on the curve,
   no inversion), because the main chunk cannot import board2's evaluator. It repeats board2's automatic-slope rule
   in 20 lines; if that rule changes, the strip drifts (the model is unaffected). Explicit ease handles of a
   loaded file are used; an inner key edited in the table loses its explicit handles.
5. **`chords` as an argument.** The feature edits, `setTail` and `setNotchDepth` take an optional `NotchChords`
   (the store passes its own). Without it the chord floor of a notched board is zero, so no channel fits and a
   channel feature is fitted to nothing; the app loads the provider before a notched board is open (step 2), so
   this only matters to a caller that skips it.
6. **The squeeze is not reversible by dragging back.** A notch-depth drag that pushes a curve's start in squeezes
   its keys; dragging the notch back out leaves them squeezed (undo restores them). Chosen over remembering the
   original keys, which would add a field to the document.
7. **Outline edits can still invalidate channels** (step 3's note stands): the ranges are computed when a field
   is edited, not when the outline is. A narrowed outline can leave a channel past the stringer; the model then
   refuses the board with `feature-invalid` and the reason, and the 3D view keeps the last good surface during a
   drag or shows the classic mesh with the reason after a typed value.
8. **The strip is drawn in screen coordinates** like the volume distribution strip, so a turned (portrait) rocker
   pane has the strip on the same screen edge, not rotated with the board.

**Acceptance (tests).**

| Check                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Characterization snapshots (`board-store`, kernel, io)                        | Unchanged (406 store tests, 82 of them new, pass without edits; the 249 classic ones among them unmodified)                                                                                                                                                                                                                                                                                                  |
| A feature edit refits nothing                                                 | Holds for every edit on the shortboard: outline, rocker, deck, stations (hence every `Section`) and fins are the same objects. Warm `buildBoard(..., { check: false })` after a depth change, 200 changes per golden: median 0.51 ms (shortboard), 0.43 (funboard), 0.43 (longboard); p95 1.3, 0.55, 0.53 ms; the test bounds the median at 3 ms so a loaded machine does not fail it                        |
| Field values round-trip in mm, cm and in                                      | Pass: shown text parses to the value within half a display step (0.05 mm, 0.005 cm, 0.0005 in), the text is stable, and a blur that changes nothing commits nothing                                                                                                                                                                                                                                          |
| Docs coverage                                                                 | Pass: kind `bottom-feature` (vee, single-concave, double-concave, channels), the section `bottomFeatures` has help text, `/docs/editing#bottom-features`                                                                                                                                                                                                                                                     |
| A swallow and a fish made from each golden, with each feature kind, validate  | Pass for 3 goldens x 4 kinds x 2 tails, the feature added before the tail change (squeezed) and after it; also a deeper notch (x1.5, x2: valid or only `notch-chord-angle`), the other kind of notch and back to standard                                                                                                                                                                                    |
| Random feature parameters within their ranges never produce a validator error | Pass: 60 random steps (parameter, depth, From, To, add key, toggle) per row for 3 goldens x (standard, swallow, fish) and the swallow, fish and asymmetric test boards, x 4 kinds (48 rows, 2880 edits): no validator error at any step, the board builds, and going asymmetric keeps it valid. The ranges are what makes this hold (the first run, with a rail-width chord floor, failed on notched boards) |
| One undo step per edit, one per drag                                          | Pass (store test)                                                                                                                                                                                                                                                                                                                                                                                            |
| e2e: add a double concave, change its depth, 3D and volume follow, undo twice | Pass (the volume in the **i** popover falls with the hollow, falls more with the doubled depth, and returns on each undo)                                                                                                                                                                                                                                                                                    |
| Gate                                                                          | `pnpm lint`, `pnpm typecheck`, `CI=1 turbo run test --concurrency=2` (store 406, board2 330, render2d 133, web 909, ...), `pnpm build` (bundle guard), `e2e` (49) and `e2e:offline` (8): all pass. Nothing flaky seen                                                                                                                                                                                        |

**Timings** (`nurbs-timing.mjs --skip open,switch,drag`, two runs: Chromium, software WebGL, production build,
4-core container, the shortboard in the quad view with a double concave added, 30 changes of the Depth slider each,
and a 60-event burst). End to end is measured in the page, from the input event to the badge's update.

| Change                                              | End to end, ms                     | Round trip, ms   | Worker, ms            | Build, ms | Mesh, ms   |
| --------------------------------------------------- | ---------------------------------- | ---------------- | --------------------- | --------- | ---------- |
| Inside a slider drag (pointer down, ladders reused) | median 17.1, 16.9 (p95 25.2, 23.9) | 12 (18)          | 5.9, 6.1 (11.2, 11.7) | 0.5, 0.6  | 5.4, 5.6   |
| 60-event burst like a drag                          | (updates 60 of 60)                 | 12 (25), 12 (20) | 7.5, 5.5 (15.7, 15.4) | 0.5       | 7.1, 5.0   |
| A lone change (typed value; not in a drag)          | median 41.0, 42.4 (p95 77.1, 80.4) | 36, 37 (69, 74)  | 32.8, 35.1 (67, 73)   | 0.8       | 25.2, 26.5 |

The target (a change reaches the 3D view in under 50 ms at the median) is met by both: 17 ms in a drag and 41 to 42 ms
for a lone change. Short of target: the lone change's **p95 is 77 to 80 ms**. A change outside a drag is not
`editing`, so the mesh derives its ladders afresh (the settled-job cost, step 1: 31 to 78 ms), which is what the mesh
column shows. A slider drag, the case that must feel live, is in line with the line drags. The warm build is
0.5 to 0.8 ms in the browser too, so the feature edit itself adds nothing.

**What step 5 must know.**

- The document's `features` are part of the saved document (`boardDocToJson` writes them already); nothing in the
  classic file formats carries them, so save, share, the autosave and the exports of a NURBS board drop them until
  step 5 saves the document and M3 exports the surface. The docs page says so.
- Specs: the readout is still the classic specs worker on the projection (no features). Move it to the mesh's
  `meshProperties`, as planned.
- A restored or opened document may carry features whose keys or channels no longer fit (a hand-edited file): the
  validator refuses it with `feature-invalid`. `refitFeatures(doc, chords)` repairs the keys and the channels and is
  exported, if a repair on open is wanted.
- `featureLimits(doc, f, chords)` is the one place that knows what a field may hold; a new UI for features (a depth
  handle in the rocker pane, which the design leaves for later) should clamp with it, and the strip is read-only.
- A new action that edits `features` goes through `featureEdit` in `section-store.ts` (label, `chords`, one step).
- The strip's polyline repeats board2's auto-slope rule (deviation 4); a shared pure function in board2's `types`-only
  neighbour would remove the copy if the main chunk is ever allowed a small board2 helper.

## 12. As built (step 5)

Landed: files, templates, share and session. With the engine on, Save, the share link and the session autosave write
the NURBS document itself (`.board` version 3), so the asymmetric minus half, the tail settings and the bottom features
are no longer dropped; a `.board` of version 3 opens (or asks, with the engine off); the New menu lists NURBS starter
templates including a swallow and a fish; the sidebar's volume, plan area and centre of mass are measured on the NURBS
mesh; and an edit made while a classic file is still converting is no longer lost. With the engine off nothing changes
(classic characterization snapshots untouched).

**Where it is.**

- `packages/board2`: `BoardMeta.extra` (opaque JSON, optional, so the version stays 3).
- `packages/io`: `readBoardText` (`{ kind: 'classic' | 'sections' }`, sniffs the version only), `encodeShareText`,
  `decodeShareFile`; `decodeShareFragment` stays for classic links. The envelope is still `v1`.
- `apps/web`:
  - `section-files.ts` (Board info in `meta`, `sectionsText`, `readSections`; board2's code arrives through the
    `workers/nurbs-core` chunk, so the bundle guard is unchanged);
  - `use-section-engine.ts` (the conversion loop, `openSectionDoc`, `attachSectionDoc`, `holdSectionsText`,
    `currentSections`, `prepareSectionDoc`);
  - `NurbsOpenPrompt.tsx`; `templates.ts` (`NURBS_TEMPLATES`) with `src/templates/*.board` made by
    `tools/make-nurbs-templates.ts`;
  - `use-mesh-specs.ts`, `nurbs-specs.ts` and the worker's `measure` job;
  - `App.tsx` (open, save, recent, templates, share, restore), `session-store.ts` (`sectionsJson`), the docs pages
    (`/docs/files#nurbs-files`, templates, the Editing note), the registry, `e2e/nurbs-files.spec.ts`.

**How it works.**

- **Save and open.** The text is `boardDocToJson(doc with Board info)`. Board info maps onto `meta` (model to `name`,
  designer to `author`, comments to `comment`) and the other four fields to `meta.extra`; unknown `extra` keys and `source`
  are kept in order, so open then save is byte for byte the same text.
- **Classic import, engine on.** The file is read classically into the classic store (the reference) and converted in the
  worker, as in step 1. A refusal now shows a notice (`data-testid="engine-refusal"`) with the reasons (the converter's
  hint where it has one, else its message in the display unit); the classic editor stays in charge.
- **Version 3 file, engine off.** `NurbsOpenPrompt`: **Turn on and open** (saves the setting) or **Open a classic copy**
  or Cancel. A share link or a recent entry that holds a version 3 document goes through the same prompt.
- **Documents arrive whole.** `openSectionDoc` loads the section store with the document and the classic store with its
  projection, then marks them in step (no conversion follows).
- **Session.** `SessionSnapshot.sectionsJson` is additive (`SESSION_VERSION` stays 1). `boardJson` is the classic board
  that was opened (no longer the projection); `sectionsJson` is the document, written when it belongs to that board. A
  restore with the engine on revives the document before touching either store, so both change in one tick. With the
  engine off the text is held, written back unchanged by the next autosave, and revived (not converted) when the engine
  is turned on.
- **Specs.** `useMeshSpecs` sends the _settled_ document to its own NURBS client (`measure`: build, mesh, four numbers,
  no surface back). `specsFromMesh` replaces volume, plan area and centre of mass in the classic worker's result; the
  lengths, widths, thicknesses and rockers stay the exact classic readouts. While a new value is computed the last one
  holds; a refused document falls back to the classic specs of the projection. The volume-distribution overlay and the
  spec sheet's other integrals are still the classic loft's.
- **Early edits.** The conversion loop converts the _current_ classic board, and a result whose board was edited meanwhile
  (or is being dragged) is dropped and the board converted again, so the document that lands contains the edit. No
  blocking UI. The undo history of that window starts over with the document, like any load.

**Share-link sizes** (whole URL, with a 33-character origin; measured in `files.test.ts`; the classic link is about 2.9 KB;
warn at 30,000, refuse at 50,000):

| Board                                         | Link, characters    |
| --------------------------------------------- | ------------------- |
| Shortboard (golden)                           | 3,078               |
| Funboard (golden)                             | 2,948               |
| Longboard (golden)                            | 3,074               |
| Swallow shortboard (setTail)                  | 2,850               |
| Fish shortboard (setTail)                     | 2,855               |
| Asymmetric shortboard (minus half is a copy)  | 3,344               |
| Shortboard with double concave, channels, vee | 3,439               |
| board2 test boards: swallow, fish, asymmetric | 2,102, 2,002, 2,679 |

A NURBS link is no larger than a classic one in practice (absolute handles compress as well as the classic tangents),
and the largest board measured is 11% of the warning threshold. `SHARE_DECODED_MAX_BYTES` needed no change.

**Deviations from the design above.**

1. **"Open the projection read-only" is "Open a classic copy".** The classic editors have no read-only mode, so the copy is
   an ordinary classic board; the file is never overwritten (saving a copy writes a classic file) and the prompt says so.
2. **The three classic templates are listed once.** The NURBS templates carry the same names (Shortboard, Funboard,
   Longboard) and replace the classic list in the New menu when the engine is on; the registry has one entry per name,
   plus Swallow shortboard and Fish shortboard. `make-nurbs-templates.test.ts` fails when the committed files drift from
   the generator (regenerate with `NURBS_TEMPLATES_WRITE=1`).
3. **A refused classic import keeps the classic editor** (step 1's deviation 3 stands) and the notice is a toast, not
   `ImportWarningsDialog`: nothing is dropped, so there is nothing to confirm.
4. **The session's `boardJson` is the classic board opened**, not the projection (step 1's deviation 9 is retired for the
   session; exports still use the projection, with the Settings and docs text saying so).
5. **Specs run in their own worker client**, not the 3D view's, so they exist with the 3D view hidden (a second NURBS
   worker while the engine is on).
6. **A NURBS file as the comparison (ghost) board** is its classic projection.
7. **`openBoardFile` throws `SectionsFileError`** (carrying the JSON) for a version 3 file, so the existing import path and
   its mocks are unchanged.

**Acceptance (tests).**

| Check                                                                                                                                                                                                            | Result                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Save then open: byte-identical text for the goldens, swallow and fish shortboards, asymmetric, shortboard with features, and board2's three test boards                                                          | Pass (`files.test.ts`, 10 boards; the app path with Board info in `section-files.test.ts`)                                     |
| Share encode then decode gives the same document                                                                                                                                                                 | Pass for the same 10 boards                                                                                                    |
| A session with both documents restores (engine on); the document is held and written back (engine off)                                                                                                           | Pass (`App.session-restore.test.tsx`)                                                                                          |
| Docs coverage for the templates                                                                                                                                                                                  | Pass (`coverage.test.ts`: Swallow shortboard, Fish shortboard added)                                                           |
| Edits made while converting are in the document that lands                                                                                                                                                       | Pass (`use-section-engine.test.tsx`; also waits for a drag to end)                                                             |
| Mesh specs agree with the classic specs of the same board (shortboard)                                                                                                                                           | Volume 0.11% low, plan area 0.03% low, centre of mass 0.05 cm from the classic (`section-files.test.ts` bounds 2%, 1%, 1.5 cm) |
| Classic characterization snapshots (kernel, io roundtrip, store)                                                                                                                                                 | Unchanged                                                                                                                      |
| e2e: template, edit, reload, same saved text; `.brd` with the engine on; v3 with the engine off (copy, then turn on, text identical); refusal notice                                                             | Pass (`e2e/nurbs-files.spec.ts`, `nurbs-viewer.spec.ts`)                                                                       |
| Gate: `pnpm lint`, `pnpm typecheck`, `CI=1 turbo run test --concurrency=2` (store 428, board2 330, io 200, render2d 133, web 937, ...), `pnpm build` (bundle and precache guards), `e2e` (52), `e2e:offline` (8) | All pass. Nothing flaky seen.                                                                                                  |

**Timing** (`nurbs-timing.mjs --skip switch,drag,feature`): one run each, Chromium, software WebGL, production build, 4-core container (slower than the step 1 to 4 runs: the container had just restarted).

| Open with the engine on       | Surface on screen, ms | Board editable, ms | Worker convert / build / mesh, ms |
| ----------------------------- | --------------------- | ------------------ | --------------------------------- |
| shortboard.board (v3)         | 518                   | **524**            | 0 / 1.5 / 36                      |
| swallow-shortboard.board (v3) | 470                   | **475**            | 0 / 1.4 / 58                      |
| shortboard.brd (classic)      | 633                   | 776                | 0 / 1 / 39                        |
| funboard.brd, longboard.brd   | 436, 481              | 651, 705           | 2 / 20, 26 / 37, 88               |

A saved document is editable the moment its surface is on screen (5 ms later); a classic file waits for the conversion
(143 to 240 ms after the surface, as in step 1: 181 ms). The absolute times are higher than step 1's (108 and 289 ms for
the shortboard) because of the container, not the code: the surface-to-editable gap is the same. Drags are unchanged
(round trip median, p95): outline 11 (16), deck 10 (21), rocker 10 (14), section apex 9 (34) ms; the step 3 numbers were
11 (19), 10 (17), 11 (16), 12 (40).

**Still open, for the M2 review and for M3.**

- Exports (STL, DXF, PDF, STEP) of a NURBS board still use its classic projection: no bottom features, no smooth blend,
  the plus half of an asymmetric board. That is M3. The Settings text, the docs and the share dialog say so.
- The volume-distribution overlay, the spec sheet and the weight estimate's other inputs still come from the classic loft
  of the projection; only volume, plan area and centre of mass are the mesh's.
- A classic copy of a NURBS file loses the minus half, the features and the blend; a real NURBS to classic conversion is
  not planned.
- Edits made in the conversion window are kept, but their undo steps are not (history restarts with the document).
- Loading a NURBS document (or turning the engine on with one held) starts a second NURBS worker for the specs, and the
  main thread loads the `nurbs-core` chunk (63 KB) for Save and the autosave; both only with the engine on.
- A hand-edited file whose features no longer fit opens and is refused by the validator (`feature-invalid`);
  `refitFeatures` could repair it on open.
- Per-document view state (selected station, framing) is not in the file or the session's document.
