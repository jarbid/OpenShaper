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
