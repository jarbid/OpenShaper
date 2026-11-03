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

| Format                          | Export time, ms | File size                      | Classic export of the same board |
| ------------------------------- | --------------- | ------------------------------ | -------------------------------- |
| STL, face size 0.5 cm (default) | 334             | 15.2 MB (about 300,000 facets) | 7.6 MB                           |
| STL, face size 1 cm             | 82              | 4.3 MB (about 85,000 facets)   |                                  |
| DXF, polyline                   | 8               | 126 KB                         | 669 KB                           |
| DXF, spline                     | 5               | 50 KB                          |                                  |
| PDF 1:1 (untiled, 7 sections)   | 6               | 14.7 KB                        | 41 KB                            |

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
