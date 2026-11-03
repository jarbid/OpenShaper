# M3 review: exports from the NURBS board

Scope: `f11c39a..189c20d` on `experiment/nurbs-overhaul` (STL, DXF, PDF 1:1 and STEP from the NURBS
document), plus a glance at `89b2e49` (bottom-features labels). Read against `m3-exports.md` (both
"As built" sections), `nurbs-plan.md` and `.claude/CLAUDE.md`. Checks run for this review: three
throwaway board2 probes (deleted afterwards), described under the findings they support. Nothing else
was run: no gate, no e2e, no `test:occt`.

## Verdict

M3 is close. The plumbing is sound. Each export gets its own worker, which is terminated on success,
error, cancel and unmount. The document is cloned when the export is asked for. board2 stays in the
worker and the existing lazy `nurbs-core` chunk. With the engine off, every path still reaches the
classic exporter: I traced `exportQuick`, `startEngineExport`, the STEP and PDF dialogs, and the menu's
labels and disabled states, and found no classic regression. The STEP solid matches what the report
says on the seven test boards. I re-measured it: the boundary rows and the apex row are within
0.33 mm, and the seam is bit-exact in position. Three things should be fixed before the testing stop
in Rhino, Fusion and FreeCAD:

- On every swallow and fish, the DXF draws its notch-zone ("rail section") stations wrongly. The PDF
  does too when it prints whole sections. A shaper would cut a template from that drawing.
- STEP of an asymmetric notched board never finishes when the two sides' apex heights differ by more
  than about 0.4 mm at the notch bottom.
- The plus and minus STEP faces meet at a small fold (up to about 1°) along the stringer, where the
  board itself is smooth.

The rest are small UX and hygiene items.

Counts: **1 blocker, 2 major, 8 minor.**

## Findings

### Blocker

**R1. Notch-zone stations are drawn on a chord they don't lie on, and the two halves are joined into one
fake ring (DXF always; PDF for whole sections).** Size **M**.

- Where:
  - `packages/export/src/dxf.ts:403` (marker) and `:437` (ring)
  - `packages/export/src/board-pdf.ts:414`, `:417` and `:463`
  - `apps/web/src/workers/nurbs-core.ts:813`
- Scenario:
  1. Open any swallow or fish with the engine on and choose Export, DXF.
  2. With the default 7 stations spaced over `d…L`, the first station is in the notch zone (the
     design note's deviation 7).
  3. In the model, the section at ξ in that zone runs along the fan chord from the stringer point
     `(ξ, 0)` to the outline point `P(ξ)` (m1-model §2). Its plus and minus halves are two chords at
     an angle to each other, not one line.
- What the files show:
  - **Plan marker.** It runs from `chordMinus` to `chordPlus`, which for a mirror board is
    `(cp.x, ±cp.y)`. That is a transverse line at the apex x. It crosses the notch void, and it is
    not where the section was cut.
  - **DXF section band.** `curvesSectionRing` mirrors the minus half and puts it end to end with the
    plus half. The drawing is a flat "full section" of a V-shaped cut, which exists nowhere on the
    board.
  - **PDF.** The same happens when it prints whole: on an asymmetric board, or with half templates
    off. The PDF's `w` label (`chordPlus.y − chordMinus.y`) is not a width of anything at that
    station.
  - **Half template.** Its note says "flip about the stringer". For a rail section that would put
    the mirrored half on the wrong chord.
  - The "rail section" label is there, but the geometry is wrong. A template cut from it, and laid
    on the drawn line, misses the board by centimetres.
- Fix:
  - For `sec.rail` stations, draw two marker segments, `(pos, 0) → chordPlus` and
    `(pos, 0) → chordMinus`.
  - Draw the plus and minus rail sections as two separate half profiles, each labelled with its side
    and chord length, never joined into a ring.
  - Drop the `w` label and the "flip" note on rail stations.
  - Add a DXF and PDF test on the swallow: the marker passes through `(pos, 0)`, and no closed ring
    is drawn for a rail station.

### Major

**R2. STEP of an asymmetric notched board refines without end when the sides' sections differ at the notch
bottom.** Size **M**.

- Where:
  - `packages/board2/src/step.ts:300-304` (the minus notch row takes the plus row's control points)
  - `step.ts:333-401` (the deviation is measured at the same `(s, t)`)
  - `step.ts:461-479` (no time or size budget)
- Scenario: an asymmetric swallow or fish whose minus rail has a different apex height. This is
  ordinary for an asymmetric design.
  - At ξ = d, both sides collapse to the same vertical segment, but at different heights for the
    same t.
  - Probe: the swallow made asymmetric, with the minus sections' apex v raised. The plus and minus
    points at the same t differed at ξ = d by 0.34 mm for Δv = 0.02 and by 1.03 mm for Δv = 0.06.
  - `snap` gives the minus surface the plus row, so near s = 0 the parametric miss can never fall
    below about 1 mm. Every pass bisects the first s spans, and s knots span all of t, so the net
    grows.
  - Measured with Δv = 0.06: pass 8 at 4.7 s, pass 14 at 34 s, pass 15 at 95 s, and the probe was
    stopped at 150 s. Δv = 0.02 finishes in 8 passes, because 0.34 mm is under the 0.4 mm
    acceptance.
  - The user sees "fitting the surfaces…" for many minutes. The 30-pass cap only helps after hours,
    and then the export fails.
  - None of the seven test boards is asymmetric and notched.
- Fix:
  - On shared rows that are degenerate (the notch edge), measure the geometric distance, such as
    distance to the evaluator's segment or closest point, instead of the same-t distance.
  - Or let the minus row keep its own parametrisation of the same segment.
  - Add a wall-clock or control-count budget that fails the export with a clear message.
  - Add an asymmetric swallow with different minus sections to `step.test.ts`.

**R3. The STEP faces meet at a fold along the stringer where the board is smooth (G0 only).** Size **M**.

- Where: `packages/board2/src/step.ts:280-299` (`snap` makes the stringer row y = 0 but leaves the next
  row free) and `:313-317` (mirror).
- Scenario: export STEP for the shortboard and open it in Rhino or Fusion with zebra or environment
  shading. There is a crease line down the deck centre.
- Probe: the fold angle across the stringer, `2·atan(|Sv.z| / |Sv.y|)` on the plus face, compared with
  the evaluator's own:
  - Shortboard deck: 0.1–0.38° along most of the length and 1.2° near the nose. The evaluator gives
    0.000–0.001°.
  - Swallow bottom: 0.25–0.4° mid-board. The evaluator gives 0.000°.
  - Longboard: within 0.01° on the bottom and 0.11° on the deck.
- Impact: this is not a tolerance failure; position is within 0.5 mm and the seam is bit-exact. It
  is the first thing a CAD user sees, it puts a ridge into finishing toolpaths, and the planned stop
  for testing is exactly that check.
- Fix: make the stringer tangent continuous where the evaluator is.
  - Mirror board: snap row 1's x and z to row 0's wherever the evaluator's cross-slope at the
    stringer is below a named tolerance. A vee keeps its intended crease.
  - Asymmetric board: constrain rows 1 of both sides to be collinear through the shared row 0.
  - In both cases, measure after the snap, as now.
  - Add the fold angle against the evaluator to `step.test.ts`.

### Minor

**R4. The default STL face size, 0.5 cm, makes the file 3.5× bigger for no gain in accuracy.** Size **S**.

- Where: `apps/web/src/workers/nurbs-protocol.ts:274`, used by `engine-export-job.ts:257`.
- `meshBoard`'s refinement keeps 0.5 mm whatever `maxEdge` is. It uses 0.4 of the tolerance at
  midpoints, plus the twist term, for a design bound of 0.85 of the tolerance (m1-model, mesh
  criterion). The cap only adds facets.
- At 1 cm the shortboard STL is already within 0.5 mm, and is 4.3 MB against 15.2 MB at 0.5 cm. The
  classic export is 7.6 MB. Even the uncapped live mesh meets the bound.
- I did not measure the chord error separately; the mesh's own tests cover it.
- Fix: default to 1 cm, and record the size in the docs. A face-size field can wait.

**R5. The NURBS STL silently drops the fin blades that the classic STL includes.** Size **S**.

- Where: `apps/web/src/workers/nurbs-core.ts:870`; classic at `packages/export/src/stl.ts:118` and
  `:182` (`includeFins`, default on).
- Scenario: a board with a fin setup, exported as STL for a 3D print. With the engine on the fins
  are gone. The "what this export misses" toast was removed for STL, so nothing says so.
- Fix: the job already resolves the fins on the main thread for DXF. Send them with the STL job and
  append `buildFinBladeMesh` triangles. Or, if fins are left out on purpose for CAM, say so on the
  Files and Export pages and record it in `divergences.md`.

**R6. The STEP fit has no live progress, and its failure and clip reports are hidden or unit-blind.** Size **S**.

- Where:
  - `nurbs-core.ts:897`: `onPass` is not wired, so the chip reads "fitting the surfaces…" for
    1–5 s, or much longer on a phone or in the R2 case.
  - `packages/board2/src/step.ts:666`: the message is always in mm.
  - `BoardSolidReport.clipped` is never shown.
- Scenario: an inch user gets "Could not export STEP: The surface could not be fitted within 0.50 mm
  (it reached 0.62 mm)." There is no hint of what to do. The STEP is also 1.5 mm short at a
  knife-thin tail and nothing says so.
- Fix:
  - Post `fitting` with the pass number (e.g. "fitting the surfaces, pass 6").
  - Return the deviation as a number, and format it in the editor's units in the toast.
  - Say what to try: fewer stations near the tail, or a smaller feature.
  - When a clip is longer than 1 mm, name it in the done toast.

**R7. A progress message after cancel can leave the Exporting chip and the disabled menu up for good.**
Size **S**.

- Where: `apps/web/src/nurbs-export-client.ts:106` (progress is not checked against `settled`) and
  `apps/web/src/use-nurbs-export.ts:46` and `:76`.
- Scenario:
  1. The user clicks Cancel while a stage message is already queued on the main thread.
  2. `settle` terminates the worker, and the promise's `finally` runs as a microtask:
     `setActive(null)`.
  3. Then the queued message, a task, calls `setActive({ stage })` again. After this,
     `active` stays non-null, so every export item stays disabled until the page is reloaded.
  4. Whether a terminated worker's queued messages are still delivered depends on the browser.
- Also, `gone` is set in an effect cleanup and never reset. Under StrictMode or a remount, every
  later export would finish without downloading.
- Fix: return early in `onMessage` when `settled`. Ignore stage callbacks in the hook unless
  `run.current === r`. Reset `gone.current = false` in the effect body.

**R8. The STEP deviation check never samples the rows the snap moves.** Size **S**.

- Where: `packages/board2/src/step.ts:143-146` (`CHECK_FRACS` are span-interior), and the same blind
  spot in `step.test.ts:43` (`independentDeviation`).
- The stringer (t = 0, 1), the apex (t = ½, the outline in plan) and the end rows (s = 0, 1) are
  never measured after `snap`.
- Probe at 2,000 points along each such row:
  - The apex row is the worst at 0.20–0.33 mm, still within 0.5 mm. Boundary rows are at 0.013 mm
    or less.
  - So today's files are fine, but nothing would catch a regression in `snap`.
- Fix: add the five rows to `measureSide` (the knots include s = 0, 1 and t = 0, ½, 1) and to
  `independentDeviation`.

**R9. The OCCT check's comment does not match its assertion, and the board STEP files are not kept.** Size **S**.

- Where: `packages/board2/src/step.occt.test.ts:12` says the GProp volume check is 1 %, but `:107`
  asserts 5 %. `.github/workflows/ci.yml:42` uploads `packages/geom/.occt-corpus/*.step` only.
- Scenario: the planned Rhino, Fusion, FreeCAD and CAM stop needs the board files. CI produces none,
  so someone has to export them by hand from the app.
- Fix: make the comment and the bound agree. Have the board2 OCCT test write its three files to a
  corpus directory, and upload it with geom's.

**R10. The worker chunk grew and nobody measured it.** Size **S**.

- Where: `apps/web/src/workers/nurbs-core.ts:65-73` and `:897`.
- The editing worker is the same module as the export worker. Every editing-worker start now also
  loads the STEP fit, geom's STEP writer and the DXF and PDF drawing code from `@openshaper/export`.
- CLAUDE.md asks for before and after numbers; the as-built gives none. It also affects the
  first-load cost of the NURBS engine and the precache size.
- Fix: record the worker chunk's size before and after M3 with `pnpm build`. If the growth matters,
  give exports their own worker entry (`nurbs-export-worker.ts`, importing only `exportDocument`).
  The cancel design already uses a separate instance, so this is a small change.

**R11. The DXF apex line is the plus side only, on an asymmetric board.** Size **S**.

- Where: `apps/web/src/workers/nurbs-core.ts:820-824`.
- The rocker band draws one `APEX` polyline, from side 0. On an asymmetric board the minus rail's
  apex height differs, which is the asymmetry the shaper is cutting.
- Fix: also sample side 1 when `asymmetric`, and draw it as a second `APEX` polyline with a label or
  line type that says which side it is.

## Accept / won't fix

- **Cancel = terminate, one worker per export.** This is right for a job that runs as one synchronous
  call. Workers are terminated on every outcome and on unmount. The chip plus the menu label is a good
  answer to a menu that closes on select.
- **Hidden STEP accuracy choice with the engine on.** One 0.5 mm tolerance matches plan decision 6. The
  saved classic choice is kept for the engine-off path.
- **Stations evenly spaced over `d…L`.** This is documented (deviation 7) and labelled. It is fine once
  R1 draws rail stations correctly.
- **The tip clip at 2.5 mm half-chord and 0.5 mm thickness.** The measured clips are 0.2 mm or less on
  the rounded test boards and 1.5 mm at the asymmetric board's knife-thin tail. The volume lost is a
  wedge of at most about 2.5 mm × 0.5 mm × 1.5 mm, which is negligible. Only reporting it is missing
  (R6).
- **STEP units, scale and orientation.** `stepUnitOf` matches the classic `downloadStep` mapping. The
  file unit follows the dialog and the model unit is cm. `checkBrep` gives a positive signed volume,
  `orientBrep` is applied, and OCCT's inside and outside probes pass. Nothing to change.
- **STL welding by float32 position.** This is safe for the notch bottom and the plus/minus seam, which
  are identical positions by construction. Distinct points closer than a float32 ulp (about 0.15 µm at
  2 m) are not realistic. Facets whose corners weld together are dropped, which only collapses an edge,
  so it opens no hole. The closed-manifold test on six boards backs this up.
- **About 23 s of board2 STEP tests in `pnpm test`.** This is acceptable with the 60 s per-test
  timeouts. The `*.occt.test.ts` exclusion plus the root `test:occt` (which CI runs) is the right
  split. `no-magic-tolerances` passes in board2. The scan covers board2 only, and the new
  `packages/export` constants are named.
- **STL in cm, and DXF polyline mode without `$INSUNITS`.** Both are pre-existing classic behaviour,
  unchanged by M3. They are out of scope here.
- **Analytics.** With the engine on, the event fires when the export completes, not on click. A
  cancelled or failed export is no longer counted. This is engine-only and fine.
- **Downloads now start seconds after the click**, outside user activation. Chromium accepts it (e2e).
  Check once on Safari and iOS during the testing stop; no change unless it fails there.
- **`89b2e49` (bottom-features labels).** The stored data is unchanged and the helpers are pure and
  tested. The nose-end slider runs opposite to its "from nose" number, which is deliberate (the commit
  says so). No findings.

## Recommended fix pass (one session)

1. **R1**: the notch-zone station drawing in DXF and PDF, with the swallow tests.
2. **R2**: geometric measurement on the shared notch row, plus a fit budget, with an asymmetric swallow
   in `step.test.ts`.
3. **R3**: a tangent-continuous stringer where the evaluator is smooth, with the fold-angle test.
4. **R8**: the boundary and apex rows in the measure and the independent check. Do this together with
   R3, since R3 changes what `snap` does.
5. **R7, R4, R6**: small changes in the client, the protocol and the toast.
6. If time is left: R5, R9, R10, R11.

Then run the full gate, `test:occt`, and the e2e suites. Update the size and time table in
`m3-exports.md` for any change R3 or R2 makes to the STEP control nets.
