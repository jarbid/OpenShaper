# M3 design note: exports from the NURBS board

Status: **current**, written at the start of M3 (`nurbs-plan.md`, milestone M3). Coordinates as everywhere:
tail at x = 0, nose toward +x, y across (plus side y > 0), z up.

## Goal

With the engine on, the STL, DXF, PDF 1:1 and STEP exports come from the NURBS document itself: both
halves of an asymmetric board, the swallow or fish tail, the bottom features and the smooth blend. The
"(classic projection)" label and the "what this export misses" notice go away for those four. Rail bands
and Legacy `.brd` stay projection exports with the label: Legacy `.brd` is a classic format by
definition, and rail bands are not worth porting in M3.

## Decisions

1. **Exports run in the NURBS worker**, as a new `export` job (format, options) that returns bytes or text.
   They are the one place a multi-second wait is accepted (plan decision 7), so the menu shows a progress
   state and a Cancel; a newer edit does not cancel an export already running (the export is of the board
   as it was when asked).
2. **One tolerance, 0.5 mm** (plan decision 6), against the evaluator (`createEvaluator`). Every fitted or
   sampled output is checked against it by dense sampling in a test, not trusted.
3. **STL:** `meshBoard` at an export face size (finer than live; an option with a sensible default), welded and
   watertight, written by the existing `stl.ts` encoder. Check: closed manifold, volume within 1 % of the
   mesh specs at live resolution.
4. **DXF and PDF 1:1:** feed the existing drawing code in `packages/export` with curves from the document,
   not the projection.
   - Outline (both halves when asymmetric), rocker and deck are the document's Bézier chains: exact.
   - Cross-sections are the as-built sections (`probeSection`, features included) at each station, as
     polylines or Béziers fitted within 0.5 mm. In a notch zone, they are drawn on their chord and labelled
     "rail section".
   - Where the existing code takes a classic `Board`, add a small curves input type rather than faking a
     `Board`.
   - The classic exports' outputs must not change, byte for byte (their tests and characterization snapshots).
5. **STEP:** one B-spline surface per side, fitted to the evaluator, in the existing B-rep (`geom/brep`)
   and written by the existing writer (`geom/step`).
   - **Fit:** `approximateSurface` on evaluator samples in (ξ, t), refining knots until the dense-sample
     deviation is ≤ 0.5 mm.
   - **Seams by construction:** the plus and minus sides share their ξ knot vector, and their stringer
     rows (bottom t = 0, deck t = 1) are constrained to the same control points on y = 0. A symmetric board
     mirrors the plus fit exactly.
   - **Topology:** follow the classic `export/src/step.ts` shell (two hull faces, end caps where an end is
     blunt) and its end handling.
   - **Swallow and fish:** first read how `board2` parametrises the notch zone (`m1-model.md`). If each
     side is still one (ξ, t) rectangle the same shell holds; if not, the implementer chooses the face
     layout and records it.
   - **Checks:** `checkBrep` passes for the three goldens, swallow, fish, asymmetric and a board with every
     feature kind, and the surface is within 0.5 mm of the evaluator.
   - **The one OCCT check** of the plan: the existing `step.occt` harness reads two or three of these files
     as one valid solid.
   - Report file size and export time; target under 10 s in the worker for the shortboard.
6. **Classic engine untouched.** With the engine off, every export is byte-identical to before M3.

## Steps (one session each; the app works after every step)

1. **Export job, STL, DXF and PDF 1:1.**
   - _Build:_ the worker `export` job with progress and cancel; the menu wiring; STL; DXF; PDF 1:1.
   - _Check:_ STL closed and within 1 %; DXF and PDF outline within 0.01 mm of the chains and sections
     within 0.5 mm of the probes; both halves of an asymmetric board; classic exports byte-identical.
   - _e2e:_ with the engine on, each of the three downloads, non-empty, of the right type.
2. **STEP.**
   - _Build:_ the fit, the B-rep and the writer, in the worker.
   - _Check:_ `checkBrep` and the 0.5 mm deviation on the seven boards; the one OCCT check; the size and
     time table.
   - _e2e:_ a STEP download with the engine on.
   - Then: the docs pages (Files, Editing, Settings text) without the projection caveat for these four,
     and the full gate.

Then one review of M3, a fix pass, and a stop for testing: open the files in Rhino, Fusion, FreeCAD and the
user's CAM software.

## Risks

- **Channels in STEP.** Their side walls are steep, so the fit may need many knots across t, which means
  large files and slow exports. If the 0.5 mm fit over a channel needs more than about 4× the knots of a
  plain board, record it, and fall back to inserting knots only near channel walls.
- **Pointed nose and tips.** ∂S/∂ξ is singular there; the fit samples must avoid the degenerate row or
  the constraint rows will fight it. The classic STEP solved the same problem; reuse its answer.
- **The notch zone's chord map** may make the side surfaces non-rectangular in the B-rep. Step 2 reads
  that before it builds.

## As built (step 1)

Landed: the export job, STL, DXF (polyline and spline) and PDF 1:1 from the NURBS document. With the engine
off nothing changes: the classic exports are byte-identical (SHA-1 of DXF polyline, DXF spline, STL and both
PDF packagings, on the export package's test board, before and after: equal) and every classic test and
characterization snapshot is untouched.

**Where it is.**

- `packages/export`:
  - `curves-input.ts`: `BoardCurves` and `CurveSection`, the small plain-data input type the drawing code reads
    (the document's outline chains, rocker, deck, the apex line, one record per station, resolved fins). No
    board model, no `Board` faked.
  - `dxf.ts`: `exportDxfCurves`. `board-pdf.ts`: `exportBoardPdf1to1FilesFromCurves` (the classic function's
    packaging step was lifted into `packageParts`, unchanged). `stl-mesh.ts`: `stlFromMesh`.
  - `board-curves.ts`: `flattenAdaptive`, `reverseMirrorY` exported.
- `apps/web`:
  - `workers/nurbs-protocol.ts`: `ExportRequest`, `ExportResponse`, `ExportJob`, `DEFAULT_STL_FACE_SIZE`.
  - `workers/nurbs-core.ts`: `exportDocument` and `curvesOfBuilt`. All board2 code stays here and in
    `nurbs-worker.ts`, so the bundle guard is unchanged and passes.
  - `nurbs-export-client.ts` (a worker per export, cancel = terminate), `use-nurbs-export.ts` (state for the
    menu and the progress chip), wiring in `App.tsx`.
  - `file-io.ts`: `pdf1to1Options` (the dialog's settings to options, shared by the classic and NURBS paths)
    and `downloadFiles`.
- `packages/render2d/src/draw.ts`: `drawFeatureDepth` stacks overlapping labels.

**How it works.**

- **Job and cancel.** An export gets its own worker (the same module as the editing worker, a second
  instance), so an edit's mesh is never queued behind it and Cancel is `terminate()`: a worker busy computing
  cannot read a cancel message. The document is cloned into the request, so later edits do not touch it. Stages
  are posted between steps (`building`, `meshing` or `sampling`, `drawing`, `writing`). The Export menu shows
  `Exporting STL: meshing…` with a `Cancel export` item and disables the formats; a toast chip
  (`data-testid="export-progress"`) shows the same with a Cancel button. A failure or a cancel is a toast.
  Without `Worker` (jsdom) the job runs on the calling thread and cannot be cancelled.
- **STL.** `meshBoard(built, { maxEdge: faceSize })`, default 0.5 cm (`DEFAULT_STL_FACE_SIZE`, the job's
  `faceSize`; there is no UI field yet). The mesh tolerance still holds, `maxEdge` only caps. `stlFromMesh`
  welds vertices by float32 position (the collapsed end rows keep two vertices per position in the grid mesh),
  drops the triangles that then have no area, and writes a binary STL with facet normals from the triangles.
- **DXF and PDF.** Outline, rocker and deck are the document's chains, exactly (PDF: Bézier operators; DXF
  spline mode: SPLINE entities; DXF polyline mode: adaptive flattening to 5 microns, `CURVE_TOL = 0.0005` cm,
  instead of the classic fixed 200 samples). An asymmetric board is drawn whole: the loop is the plus chain and
  the mirrored minus chain, the stations draw both chords, the half-outline and half-section options are ignored
  (a half template would hide a half), and each section is the full ring from both probes. The sections are
  `probeSection` at the stations (400 points per half, thinned by Douglas-Peucker to 0.05 mm), so bottom
  features are in. A station inside the notch zone (`ξ < d + zone`) is on its chord, labelled `rail section` in
  the DXF label and the PDF page title. Stations are evenly spaced over the stringer's extent (`d` to `L`).
  Fins are resolved on the main thread from the projection (`doc.fins` passes through it) and sent along; the
  ghost board of the DXF is sent as is.
- **Labels.** With the engine on, STL, DXF (polyline), DXF (spline) and PDF 1:1 have no suffix and no longer
  raise the misses toast. STEP, Rail bands and Legacy `.brd` keep both. The Settings and docs text (Files,
  Editing) say which is which.

**Acceptance (tests).**

| Check                                                                                                         | Result                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| STL a closed manifold (every directed edge once, its reverse once, by position) and volume within 1 % of live | Pass for shortboard, funboard, longboard, swallow (vee, double concave), fish, asymmetric (channels), at 1 cm |
| DXF outline within 0.01 mm of the chains, both directions (vertices to chain, chain to polyline)              | Pass for the shortboard, the swallow and the asymmetric board (polyline within 0.001 cm)                      |
| Asymmetric board shows both halves                                                                            | Pass (the drawn minus width differs from the plus width; PDF is whole whatever the half options)              |
| Sections within 0.5 mm of the probes, features included                                                       | Pass against 1,500-point probes on swallow and asymmetric, bound 0.05 cm                                      |
| Rail section label (DXF and PDF) for a notch-zone station, none on a standard tail                            | Pass                                                                                                          |
| Classic exports byte-identical with the engine off                                                            | Pass (hashes equal, existing tests unchanged)                                                                 |
| Client: exports the document it was given, Cancel terminates once, stage and answer routing                   | Pass                                                                                                          |
| `drawFeatureDepth` labels stack when two features overlap, share a row when far apart                         | Pass                                                                                                          |
| e2e with the engine on: STL, DXF, PDF 1:1 each download, non-empty, right type; labels                        | Pass (`e2e/nurbs-export.spec.ts`)                                                                             |

**Times and sizes** (shortboard, `sample-board.brd` converted; the job in the worker module, median of three after
a warm-up, 4-core container, Node via Vitest; the browser worker runs the same code):

| Format                        | Export time, ms | File size                      | Classic export of the same board |
| ----------------------------- | --------------- | ------------------------------ | -------------------------------- |
| STL, face size 1 cm (default) | 82              | 4.3 MB (about 85,000 facets)   | 7.6 MB                           |
| STL, face size 0.5 cm         | 334             | 15.2 MB (about 300,000 facets) |                                  |
| DXF, polyline                 | 8               | 126 KB                         | 669 KB                           |
| DXF, spline                   | 5               | 50 KB                          |                                  |
| PDF 1:1 (untiled, 7 sections) | 6               | 14.7 KB                        | 41 KB                            |

The live mesh of the same board is 16,000 facets, so the default STL is about 19 times finer in facets. The DXF is
smaller than the classic one because its sections are thinned polylines (0.05 mm) and its polylines are adaptive.

**Gate** (one run, at the end): `pnpm lint` pass; `pnpm typecheck` pass (12 tasks); `CI=1 turbo run test
--concurrency=2` pass (store 431, io 200, kernel 537, units 42, render3d 131, geom 1,310, worker 14, export 201,
board2 330, render2d 134, web 966); `pnpm build` pass (bundle guard and precache guard: board2 code in the worker
chunks only); `e2e` 56 passed (52 plus the 4 new); `e2e:offline` 9 passed. Nothing flaky seen.

**Deviations from the design above.**

1. **Cancel is a terminate, not a message.** The design says a Cancel in the menu; a worker computing in one
   synchronous call cannot read a cancel message, so each export has its own worker and Cancel ends it. The
   benefit is that an edit's mesh is never queued behind an export. The cost is one worker start per export
   (the module is cached; not measured separately).
2. **The progress state is in the menu and in a toast chip.** The menu closes when an item is chosen, so the
   Export menu alone would show nothing unless reopened. Both show the stage and offer Cancel.
3. **No UI for the STL face size.** It is a field of the job (`faceSize`, default 0.5 cm), called with the
   default. A field in Settings can follow when someone asks for it.
4. **DXF polylines are adaptive (5 microns), not the classic 200 samples.** The classic sampling is about
   0.1 mm off a nose curve, which misses the 0.01 mm check; the classic exporter is unchanged.
5. **DXF sections are polylines in spline mode too.** The as-built section is sampled, not a stored chain, so
   it is a polyline (0.05 mm) in both modes; the outline, rocker and deck are SPLINE entities in spline mode.
6. **An asymmetric board ignores the half-outline and half-section options** and is printed whole.
7. **Stations** are evenly spaced over the stringer (`d` to `L`), so on a notched tail the first few are rail
   sections. The classic exports space them over `0` to `L`.
8. **Quick PDF path.** The command-palette and `exportBoard('pdf-1to1')` path still writes the classic PDF; the
   menu item opens the dialog, which is the NURBS path. Nothing in the UI reaches the quick one with the engine on.

**What step 2 must know.**

- The job plumbing is done: add `{ format: 'step', … }` to `ExportJob`, a case in `exportDocument`
  (`nurbs-core.ts`), a `startEngineExport` call in the STEP dialog's `onExport` and drop the suffix and the
  `noteProjection()` call from the STEP menu item. `exportDocument` already builds the board once and has
  `built.sides`, `built.xiMin/xiMax`, and `createEvaluator` for the fit samples.
- Progress stages are a closed union (`ExportStage`); add `fitting` for the surface fit, which is the slow step.
  The menu and the chip read `EXPORT_STAGE_TEXT`.
- A job runs to the end: there is no check point to stop at. If the fit takes seconds, post progress from inside
  it (the worker's `postMessage` works mid-job) rather than relying on stage changes.
- The notch zone: the chords of `curvesOfBuilt` come from `ev.eval(0.5, …)` at the apex, and `rail` is
  `ξ < d + zone` with `d = built.xiMin`; the same chord map applies to a side surface in (ξ, t).
- The surface is not trimmed: a collapsed end row (pointed tail or nose, notch bottom) is a degenerate edge of the
  grid, which `stlFromMesh` handles by welding; the fit must avoid it (see Risks).
- STL needs a closed mesh only up to float32 positions; a B-rep must be closed exactly.
- The `Files`, `Editing` and Settings text now say STL, DXF and PDF 1:1 are made from the NURBS board and STEP,
  rail bands and `.brd` are the projection; step 2 removes STEP from that list.
- Remaining labels: `projSuffix` in `App.tsx` is applied to STEP, Rail bands and Legacy `.brd`.

## As built (step 2)

Landed: STEP from the NURBS board, as the `step` format of the export job, with the engine on. With the engine
off nothing changes (`packages/export/src/step.ts`, its tests and snapshots are untouched).

**Where it is.**

- `packages/board2/src/step.ts` (`boardSolid`, `boardStep`; constants in `params.ts` under "STEP solid"): the fit, the
  B-rep and the file. board2 now also imports `writeStep`, `makeBrep`, `orientBrep` and `approximateSurface` from
  geom (it already depended on it). `packages/board2/src/step.occt.test.ts` is the OCCT check.
- `apps/web`: `ExportJob` gains `{ format: 'step', unit, slug }`, `ExportStage` gains `fitting`
  (`building` → `fitting` → `writing`, where `writing` is the `checkBrep` and the file); `exportDocument` has the
  case; `engine-export-job.ts` (`engineQuickJob`, `stepUnitOf`) is the one place that says which job a format
  runs; the STEP dialog hides the accuracy choice with the engine on (the fit is fixed at 0.5 mm).
- Root `test:occt` now runs geom's suite and board2's (`pnpm --workspace-concurrency=1 --filter
@openshaper/geom --filter @openshaper/board2 test:occt`); board2's default config excludes `*.occt.test.ts`.

**Face layout.** Each side is one rectangle in (s, t), `s = (ξ − lo)/(hi − lo)`, on a notched tail too: the notch zone
changes the chord map inside the same rectangle (m1-model.md §2). The notch bottom is the row `s = 0` collapsed
to the vertical stringer line at x = d (chord 0, thickness > 0). So the classic shell holds, with one change:

- Standard tail and nose: 4 faces (plus hull, minus hull, two planar caps), 4 vertices, 6 edges. Same as classic.
- Notched tail (swallow, fish): 3 faces and 5 edges. The two sides meet along one shared vertical edge at the notch
  bottom, so there is no tail cap (a cap would have zero area). The nose has its cap.
- Untrimmed hull faces, trimmed plane caps; `writeStep` is called with `pcurves: 'trimmedOnly'`, so only the caps carry
  pcurves.

**Fit.**

- Cubic in both directions, a triple knot at t = ½ (the section's apex is C0, as in the evaluator). `approximateSurface` on
  evaluator samples at known (s, t) (3 per span per direction), start grid 12 × 8 spans plus the stations.
- Refinement: measure the distance to the evaluator at the same (s, t) on a dense grid (6 points per span, offset from the
  data), bisect the spans of cells over 0.8 × 0.5 mm. A cell's miss is assigned to s, t or both by the fourth
  difference of the evaluator's samples along each (a channel wall adds t knots only, a tip s knots only).
- Seams: the plus and minus sides share their s and t knots. Boundary rows (stringer, notch edge, caps) are held by a
  data weight of 100 and then **snapped exactly** (stringer y = 0, cap rows in their x-plane, notch row on x = d, y = 0), and the minus side's
  stringer and notch rows take the plus side's control points. A symmetric board's minus is the plus with `0 − y`.
  The deviation is measured after the snap. (A first version used point constraints, which solved the same fit with a
  Schur complement; it was 5 to 6 times slower for the same deviation.)
- Tips: the surface is clipped where the half-chord reaches 2.5 mm (the classic export's 5 mm `MIN_DIM`) and the thickness
  0.5 mm, and a planar cap closes the clip. A rounded tip is cut within 0.2 mm of its end; a thin or sharp one (the
  asymmetric board's tail) by up to 1.5 mm. The clip lengths are in `BoardSolidReport.clipped`.

**Channels.** Not needed: the refinement is local in t already, so no separate knot insertion near the walls. Control points
(s × t), with and without the feature: swallow 65 × 72 with vee and double concave, 69 × 71 without (equal within the
fit's noise); asymmetric 54 × 44 with its two channels, 41 × 26 without (2.2 times the control points, 1.7 times the t
knots); the swallow with all three feature kinds 75 × 81 (1.3 times the plain swallow). All under the 4 times of the risk note.
What drives the knot count is the rail radius and the notch fan, not the features.

**Acceptance.**

| Check                                                                                                                                                                             | Result                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `checkBrep` ok, positive volume, within 0.5 mm of the evaluator on an independent 7 per span grid                                                                                 | Pass on the three goldens, swallow, fish, asymmetric (channels) and the swallow with every feature kind    |
| Shared stringer rows bit-equal, y = 0, a mirror board's minus is `0 − y` of the plus                                                                                              | Pass (same test)                                                                                           |
| OCCT (`occt-wasm` 5.3.5, `pnpm test:occt`): one solid, one shell, `isValid`, counts, no tolerance growth, mesh volume within area × deflection of ours, inside and outside probes | Pass for the shortboard, the swallow and the asymmetric board (runs in this container, 38 s for the three) |
| Job: Part 21 file, unit, stages `building`, `fitting`, `writing`                                                                                                                  | Pass (shortboard and swallow)                                                                              |
| Labels: STEP has no suffix with the engine on, is not in the misses toast, is enabled for a notched tail                                                                          | Pass (e2e labels test)                                                                                     |
| e2e with the engine on: STEP downloads, starts `ISO-10303-21;`, non-empty                                                                                                         | Pass (`e2e/nurbs-export.spec.ts`)                                                                          |
| `engineQuickJob` gives an engine job for every format but rail bands                                                                                                              | Pass                                                                                                       |

**Times and sizes** (the job in the worker module, Node via Vitest, median of three for the shortboard after a warm-up and
one run for the others, 4-core container; the browser worker runs the same code):

| Board                       | Export time, ms | File size | Control points s × t | Passes | Fitted deviation, mm | Worst fold vs evaluator, ° (bottom / deck) | Ends            |
| --------------------------- | --------------- | --------- | -------------------- | ------ | -------------------- | ------------------------------------------ | --------------- |
| shortboard                  | 1,600           | 363 KB    | 49 × 40              | 9      | 0.26                 | 0.006 / 0.047                              | cap, cap        |
| funboard                    | 840             | 312 KB    | 57 × 30              | 6      | 0.38                 | 0.012 / 0.023                              | cap, cap        |
| longboard                   | 2,250           | 562 KB    | 67 × 46              | 9      | 0.36                 | 0.007 / 0.027                              | cap, cap        |
| swallow                     | 4,440           | 1.02 MB   | 73 × 78              | 8      | 0.30                 | 0.107 / 0.110                              | notch edge, cap |
| fish                        | 2,280           | 655 KB    | 71 × 52              | 8      | 0.33                 | 0.027 / 0.066                              | notch edge, cap |
| asymmetric (channels)       | 2,150           | 438 KB    | 54 × 44              | 8      | 0.31                 | 0.004 / 0.064                              | cap, cap        |
| swallow, every feature      | 6,220           | 1.29 MB   | 84 × 86              | 8      | 0.30                 | 0.107 / 0.110                              | notch edge, cap |
| asymmetric swallow, Δv 0.06 | 8,390           | 1.04 MB   | 75 × 78              | 8      | 0.30                 | 0.107 / 0.110                              | notch edge, cap |

Fold = the angle between the plus face's cross tangent and the reversed minus face's, along the stringer row, minus the
evaluator's own fold at the same s (so a designed crease, such as the swallow's notch zone, is not counted), worst over s
from 3 % to 97 %. All are at most 0.11°. Standard tails are at most 0.047° except 0.066° and 0.064° within 3 % of the nose
tip (s = 0.97). The 0.11° is at the end of the notch zone, where the fan chord direction stops changing. Before the fix
the deck folds were 0.1–0.38° (1.2° near the nose) and the swallow bottom 0.25–0.4° (M3 review R3).

Asymmetric swallow with a raised minus apex (the review's R2 case, Δv = 0.06): before, no result in 150 s; now 8 passes,
8.4 s. The control budget (`STEP_MAX_CONTROLS`, 12,000 per side; the largest board above is 7,224) fails a fit that
cannot converge with a message instead.

The shortboard target (under 10 s) is met by a factor of 9.

**Gate** (one run, at the end): `pnpm lint` pass; `pnpm typecheck` pass (12 tasks); `CI=1 turbo run test --concurrency=2`
pass (store 431, io 200, kernel 537, units 42, render3d 131, geom 1,310, worker 14, export 201, board2 338, render2d 134,
web 971); `pnpm build` pass (bundle guard and precache guard); `e2e` 57 passed (56 plus the STEP one); `e2e:offline` 9
passed; `pnpm test:occt` pass (geom 85, board2 3), which runs in this container. Nothing flaky seen. The first test run
failed once: `no-magic-tolerances` caught a `1e-3` literal in `step.ts`, now `STEP_STATION_GAP`.
test runs.

**Deviations from the design above.**

1. **Point constraints replaced by data weights and a snap** for the shared rows (above): not exact in the solve, exact
   after it, and the 0.5 mm is measured on the snapped surface.
2. **Tip clips are not tiny on a thin tip.** A knife-thin tail (the asymmetric test board) is clipped by 1.5 mm; the cap is 5 mm wide.
   The classic export does the same with a 5 mm flat, but its clip is the lofted floor, not a measured length.
3. **A notch bottom with no thickness would be clipped and capped like a tip**; none of the test boards has one.
4. **The accuracy choice of the STEP dialog is hidden with the engine on.** The classic dialog's 0.02 to 0.002 cm
   presets are 2.5 to 25 times tighter than the plan's 0.5 mm and would cost many more knots; the fit has the one tolerance.
5. **A fit that does not reach 0.5 mm in 30 passes fails the export** with the deviation it reached, instead of writing
   a looser file. No test board needed more than 9 passes.
6. **Quick exports.** There was no menu or palette path to `exportBoard('pdf-1to1')` in this branch (the palette is derived
   from the menus, whose PDF item opens the dialog), so "routing" it means the one wrapper `exportQuick` in `App.tsx`
   (via `engineQuickJob`) that the STL and DXF items now use, and which maps pdf-1to1 and step to engine jobs with the
   saved dialog settings. `exportBoard` is reached only with the engine off or for rail bands.
7. **Docs.** Files, Editing and Settings lose the caveat for STEP too; the Export page also says that the accuracy choice
   and the concave-tail refusal belong to the classic engine.

**Open for the M3 review.**

- Open the files in Rhino, Fusion, FreeCAD and the CAM software (the planned stop for testing). OCCT is happy; the
  commercial importers are not tested.
- File size: 0.3 to 1.1 MB, mostly the swallow's notch fan and the rail radius. A degree 5 fit or a smarter knot placement could halve it; not
  tried.
- The surface has a triple knot at t = ½ (the section's apex is C0 in the model), so it is C0 in t there, and stays tangent-continuous only as far as the fit makes it. Not measured separately.
- Tip clips (2.5 mm half-chord): measure what a CAM user thinks of the 5 mm flats at the tail and nose.
- The fit's time grows with the control net (swallow with all features 4.6 s): the slow step is the banded solve
  per pass, 8 to 11 passes. Starting from the previous export's knots would skip most of it.
- No UI for the STL face size or the STEP tolerance (still fixed).

## M3 review fix pass

- **Rail sections (R1).** A notch-zone station's plan marker is the two fan chords from `(pos, 0)`; its halves are drawn as
  separate open half-sections, each on its own chord (DXF band; one PDF page per half, without a width label or "flip" note).
- **STEP (R2, R3, R8).** The minus side of an asymmetric notched board is sampled at a `t` shifted near the notch bottom
  (`notchWarp`, a reparametrisation over 6 % of s) so its collapsed row equals the plus row. The control row next to each
  stringer row is placed along the evaluator's own cross direction (collocation at the Greville abscissae), offset only in y,
  so the faces meet G1 wherever the evaluator does. The check also samples the stringer, apex and end rows.
- **STL (R4).** Default face size 1 cm. Chord error at 1 cm (triangle centres and edge midpoints against the surface, every 60th
  triangle): shortboard 0.18 mm, funboard 0.20, longboard 0.19, swallow 0.13, fish 0.22, asymmetric 0.23; all under 0.5 mm.
