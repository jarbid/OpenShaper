# M2 review: the NURBS editor

Scope: `e5da256..9f0ca8e` on `experiment/nurbs-overhaul` (steps 1 to 5), read against `m2-editor.md`
(including the as-built §8 to §12), `nurbs-plan.md` and `.claude/CLAUDE.md`. The review read the diffs and the
code they touch, and ran one throwaway store test (deleted, not committed) to check whether an asymmetric
projection's `minus` half leaks into the classic store. It does not: `enforceJunctions` always rebuilds the board
on `load`, so the half is dropped. The gate, the e2e suites and the benchmarks were not re-run.

## Verdict

M2 does what the milestone promised. The section store behind `BoardState`, the shared history and actions, the
projection and write-back, two-sided panes, tails, features, v3 files, share links and the session all hang
together. With the engine off, the classic path is unchanged as far as this review could trace:

- `history.ts` and `board-actions.ts` are a straight extraction, guarded by the characterization snapshots.
- `sameTarget` is unchanged for side-less targets.
- `render3d` takes the new paths only with a live surface.
- Every NURBS chunk stays lazy.

The edit rules hold where the design put them:

- The slice clamps and the apex recompute.
- Station bounds in `moveStation` and `addStation`.
- Shared ends through `alignEnds`.
- `spanHint`, which uses the climb's own acceptance test, so it cannot accept a fit outside tolerance.

One blocker remains, and it is in the part the user test leans on most. A session's NURBS document is thrown away
whenever it cannot be revived on restore. Offline is enough to trigger it, because `nurbs-core` and `nurbs-worker`
are not precached, and so is a chunk that returns 404 after a redeploy. Every NURBS edit is lost. The majors are:

- an export path with no warning that it drops the features, the blend and the minus half;
- two silent document-divergence traps around the engine setting;
- gestures that drop stations and squeeze features irreversibly;
- outline edits that let channels invalidate the whole board;
- a settled-change pipeline that runs three meshes or integrations at once.

All of them are cheap to fix. After the fix pass below, M2 is ready for the shaper preview.

## Findings

### Blocker

**R1. The session's NURBS document is discarded when it cannot be revived, and the next autosave deletes it.** (M)
`apps/web/src/App.tsx:324-341`, `apps/web/src/use-section-engine.ts:207-222`, `:84-90`,
`apps/web/vite.config.ts:123-124`

- _Scenario A (engine on):_ edit a NURBS board, then reopen the PWA offline, or on a stale app shell after a
  deploy, so the hashed `nurbs-core-*.js` returns 404.
  1. `prepareSectionDoc` returns `ok: false` because the chunk does not load.
  2. `sections` stays null, and the text is not held: `holdSectionsText` runs only with the engine off, at line 340.
  3. The classic board restores, and the conversion is attempted. Offline, the worker chunk fails too, so the
     board is refused.
  4. `currentSections()` returns null, because nothing is converted from this `loadCount` and nothing is held.
  5. 800 ms later the autosave writes a session without `sectionsJson`.

  Result: the minus half, the tail, the features and every NURBS edit are gone. When the worker does load but
  revive fails, for example because a newer document key hits the strict `rec` reader, the conversion succeeds
  instead. It replaces the document with a conversion of the classic board as it was opened, before any NURBS
  edit, and the autosave overwrites the stored document.

- _Scenario B (engine off, then turned on):_ the held text reaches `run()`. A revive that fails for any reason,
  including "could not load", sets `held = null` at line 221 and converts. The same loss follows.
- _Fix:_ Never drop a session's `sectionsJson` except when another board is loaded.
  - Hold the text on every failed revive, whether the engine is on or off.
  - In `run()`, keep `held` when the reason is a load failure: refuse with a clear message and do not convert.
    Make `readSections` return a distinguishable `reason: 'unavailable' | 'invalid'`.
  - Show a notice: "The saved NURBS board could not be loaded (offline?). It is kept; the classic board is shown."
  - Also add a Workbox runtime route, `CacheFirst` for `assets/nurbs-(core|worker)-*.js`. The chunks are then
    cached after their first use, which keeps the bytes off the precache of users who never enable the flag.
  - Test it: a restore with the engine on whose revive fails (mock `loadNurbsCore` to reject) keeps
    `sectionsJson` in the next saved snapshot.

### Major

**R2. The exports write the classic projection with no notice.** (S)
`apps/web/src/App.tsx:1553-1630` (`exportMenu`, "Legacy .brd")

- _Scenario:_ make the shortboard asymmetric and add a double concave, then choose Export, STL (or DXF, PDF 1:1,
  STEP, rail bands, Legacy `.brd`). The file is the plus half mirrored, without the concave or the smooth blend.
  Nothing on screen says so: the warning is only in Settings and the docs. §7 of the design names this risk ("or
  users will cut boards from it"), and §5 promised a notice at export.
- _Fix:_ While `sectionEngine.ready`, show the export items with a "(classic projection)" suffix. On the first
  export of each document, show a toast that names what is missing for this board: bottom features (when there
  are any), the minus half (when asymmetric), and the smooth blend.

**R3. A session restored with the engine off silently shows the board as it was before the NURBS edits.** (S)
`apps/web/src/App.tsx:340`, `apps/web/src/use-section-engine.ts:71-77`

- _Scenario:_ a tester edits with `?engine=nurbs` (the engine for one session), then reopens the editor from a
  plain URL.
  1. The classic board that was opened appears, and the NURBS work looks lost.
  2. The text is held. Opening a file or a template from here changes `loadCount`, so `heldFor` stops matching.
  3. The autosave then drops the document for good.
- _Fix:_ When the text is held at restore, show the same choice as `NurbsOpenPrompt` (or a persistent toast with
  a button): "This session has a NURBS board. Turn the NURBS engine on to keep editing it."

**R4. The two documents diverge silently around the engine switch.** (M)
`apps/web/src/use-section-engine.ts:178`, `apps/web/src/App.tsx:719-721`

- _Scenario 1, on to off:_ the classic board shown is the one opened. Save, Legacy `.brd` and Share then write a
  board without the NURBS edits, and no feedback says so.
- _Scenario 2, edits with the engine off:_ edit the classic board, then turn the engine on. `upToDate` compares
  `loadCount` only, so the old NURBS document comes back and the classic edits are ignored without a word. A
  later Save with the engine on writes the NURBS document without them.
- _Fix:_
  - Remember the classic board object a document was converted from or attached to, next to `convertedFrom`.
  - When the engine is turned on and `boardStore.board` is a different object, ask: "The classic board was edited
    while the NURBS engine was off: Convert it (replaces the NURBS board) / Keep the NURBS board."
  - When the engine is turned off with a document held, show a toast: "Showing the classic board you opened; the
    NURBS board is kept and comes back when you turn the engine on."

**R5. A notch-depth drag drops stations and squeezes features irreversibly within one gesture.** (S to M)
`packages/store/src/sections/section-store.ts:279-287`, `packages/store/src/sections/shape.ts:290-307`

- _Scenario:_ on a swallow, drag the notch handle deeper past the first station and then back out, all in one
  drag.
  - Each move applies `setNotchDepth` to the current document. The station is dropped as soon as the notch
    passes it (`stationsFrom`), and every later move works from the document without it.
  - Feature keys are remapped step by step (`refitFeatures`) and never expand again.

  The shaper ends the gesture with one station fewer and a shorter concave, and nothing says so. Undo recovers
  them, but only for someone who noticed.

- _Fix:_ Record the document at `beginEdit` in the section store (`dragOrigin`, cleared at `endEdit`). The notch
  intercept then computes `setNotchDepth(dragOrigin ?? doc, x, chords)`. The result is a pure function of the
  pointer position, so dragging back restores the stations and the keys, and the history still records one step.
  This retires §11 deviation 6 for gestures; across separate edits the squeeze stays as designed.

**R6. Outline edits can push channels past the chord and refuse the whole board.** (S)
`packages/store/src/sections/section-store.ts:224-244`, `packages/store/src/sections/features.ts:636-661`

- _Scenario:_ add Channels near their width limit. Then pull an outline point in near the tail: plus, or the
  minus half on an asymmetric board, where `minChord` takes the narrower half.
  - The validator raises `feature-invalid`.
  - The 3D view keeps a stale surface during the drag. After release, or after a typed inspector value, it shows
    the classic mesh with a refusal.
  - The sidebar volume falls back to the classic loft (see R10).
  - The user has to find the channel in Bottom features and nudge a field to get it re-clamped.

  This is §11 deviation 7. The repair already exists.

- _Fix:_ In `commit` and `commitMinus`, when the outline changed and an enabled `channels` feature exists, set
  `features: refitFeatures(nextDoc, chords)`. Refit against the drag origin's features from R5, so a narrowing
  drag that is undone in the same gesture restores the channels. Add a store test: narrow the outline under the
  channels, and `validateBoard` raises no `feature-invalid`.

**R7. A settled or lone change runs three heavy jobs at once.** (S to M)
`apps/web/src/use-mesh-specs.ts:57-85`, `apps/web/src/nurbs-viewer.ts:252, 389`,
`apps/web/src/App.tsx:423, 743`

Today a lone feature change has p95 77 to 80 ms, and the end of a section drag is no better. For each settled
document:

- the 3D worker runs a `doc` job that derives fresh ladders (`reuseLadders` is false outside a drag) and
  curvature;
- the second NURBS worker runs `measure`, a full build and mesh with no warm ladders;
- the classic specs worker integrates the projection's volume, area and centre of mass, which are then
  overwritten.

On the 4-core container these compete, and a phone has 2 cores. Cheap wins, in order:

1. **Two-phase lone change.** In `reconcile`, give a non-editing change of a document that has a model the
   ladders as a drag would (`reuseLadders: true`, no curvature). Queue the fresh-ladder settled job about 300 ms
   after the input goes quiet. The first frame should then match the 17 ms slider-drag figure. This is the
   same shape as the existing `r.editing && !i.editing` rule.
2. **No duplicate measure while the 3D view is mounted.** The `doc` answer already carries the mesh. Add
   `centreX` to its summary, publish volume, plan area and centre from the layer (as the probes are published),
   and have `useMeshSpecs` start its own `measure` client only when no layer answer is current. Debounce what
   remains by about 250 ms.
3. **No classic integrals with the engine on.** Pass a `wantIntegrals: false` option to `useSpecsWorker` when
   `sectionEngine.ready`, or skip the volume and area sampling in the worker. `specsFromMesh` replaces those
   numbers anyway.

Measure before and after with `nurbs-timing.mjs --skip open,switch` (feature and section rows). Record the
numbers in the commit.

### Minor

**R8. The inspector's centre and apex hints describe the classic toggle on NURBS boards.** (S)
`apps/web/src/ControlPointInspector.tsx:110-113`

The hints say "With Resize cross-sections to rocker/deck … off, the slice keeps its own thickness". With the
engine on, sections always follow, and the setting does nothing. Show engine-aware text: "NURBS sections are
stored relative to the outline, rocker and deck, so they always follow them."

**R9. The keep-side dialog says "upper/lower rail", which is wrong in a turned outline pane.** (S)
`apps/web/src/KeepSideDialog.tsx:34-39`, `apps/web/src/view-toolkit.tsx:660`

On a touch device the outline pane turns nose-up (`allowTurn`), so the halves are drawn left and right. Name each
half by the colour it is drawn in (`paneProps` gives plus `outlineColor` and minus `deckColor`) with a swatch,
plus a board-relative name ("left rail, looking at the deck from the tail"). Drop "upper/lower".

**R10. A refused document silently changes the sidebar volume to the classic loft's.** (S)
`apps/web/src/use-mesh-specs.ts:69`, `apps/web/src/nurbs-specs.ts:11-19`

When `measure` refuses, the result is null and `specsFromMesh` returns the classic numbers: no features, plus half
mirrored. The volume jumps with no sign why. Keep the last good mesh values, marked stale, or label the row
"Volume (classic estimate)" while the surface is refused.

**R11. The station ghost disappears whenever the selected station moves.** (S)
`apps/web/src/App.tsx:1032`, `apps/web/src/nurbs-probes.ts:62`

`probeAt` matches the coordinate exactly. During a station-marker drag, or when stepping stations with
PageUp/PageDown, the as-built ghost vanishes until the worker answers for the new x, so it flickers during the
drag. Keep the last station probe until a newer answer arrives, as the scrub ghost already does.

**R12. `AppShell` re-renders on every probe answer.** (S)
`apps/web/src/App.tsx:1000`

`useProbes()` sits in `AppShell`, which already re-renders per drag move. A hover over the outline with the 3D view
open adds a second full shell render per pointer move. Read the probes inside the cross-section pane instead: pass
a stable `ghostSplinesFor` input and let the pane subscribe. This follows the CLAUDE.md rule that components
needing live data subscribe themselves.

## Won't fix / accept for M2

These §8 to §12 open items are acceptable for M2:

- **Step 2.** Station insertion is within 1.1 mm instead of 1 mm (dev. 1). That is the classic loft against the
  blend, recorded as a divergence.
- **Step 2.** The chord provider parses the core chunk on the main thread for notched boards (dev. 2).
- **Step 2.** The section-drag worker p95 is 15 to 28 ms against a 15 ms target. The medians are far inside the
  target, the remaining cost is the mesh and software-WebGL stalls, and R7 covers the settled path.
- **Step 3.** The tail kind is read from the wall and may mislabel a converted classic notch (dev. 1). No data is
  wrong.
- **Step 3.** A typed refusal shows the classic mesh with the reason, and only gestures keep the stale surface
  (dev. 4).
- **Step 3.** The minus nose cannot be dragged in x (dev. 6).
- **Step 4.** The depth strip repeats board2's auto-slope rule (dev. 4) and is drawn in screen coordinates
  (dev. 8).
- **Step 4.** Feature-key squeezes are irreversible across separate edits (dev. 6). Within a gesture R5 fixes it.
- **Step 5.** Exports are the projection until M3, provided R2 adds the notice.
- **Step 5.** The volume-distribution overlay, the spec sheet and the weight inputs come from the classic loft.
- **Step 5.** A classic copy of a NURBS file loses the minus half, the features and the blend, and the prompt says
  so.
- **Step 5.** The conversion window's undo steps start over with the document.
- **Step 5.** A second NURBS worker runs for the specs (R7.2 reduces its work).
- **Step 5.** A hand-edited file with ill-fitting features opens refused. R6's refit could also run on open; this
  is optional.
- **Step 5.** Per-document view state is not saved.
- **Step 1.** Fins and guides are placed by the live surface's own centre, about 1 mm off the classic hull's.

## Recommended fix pass (one session)

1. **R1** (blocker, M):
   - hold and never drop an unrevivable session document;
   - make `readSections` distinguish an unavailable chunk from an invalid document;
   - add the notice;
   - add the `CacheFirst` runtime route for the NURBS chunks;
   - add the regression test.
2. **R5** (S to M): `dragOrigin` in the section store, and the notch intercept computed from it. Test: deepen past
   a station and come back in one drag, and the station count is unchanged.
3. **R6** (S): refit channels on outline commits, from the drag origin. Test as described in R6.
4. **R2** (S): the export suffix and the toast listing what is missing.
5. **R3** (S): the prompt on restore when the text is held with the engine off.
6. **R7.1 and R7.3** (S each): the two-phase lone change and no classic integrals with the engine on. Run
   `nurbs-timing.mjs` before and after.
7. If time remains:
   - **R4** (M): the board-identity check with its prompt, and the on-to-off toast.
   - **R7.2** (M): reuse the layer's mesh numbers for the specs.
   - **R8 and R10** (S each).

After the pass, run the CI gate: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `e2e` and
`e2e:offline`. Also add an offline e2e case: a session with a NURBS document, reloaded with the NURBS chunks
blocked, keeps its document. That case is the one the blocker came from.
