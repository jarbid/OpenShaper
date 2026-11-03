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
