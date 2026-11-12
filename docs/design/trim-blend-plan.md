# Trim and blend: the integration plan

Status: **plan in progress**. It replaces the surface core of the NURBS engine on
`experiment/nurbs-overhaul` and keeps everything else on that branch. The evidence is
`docs/design/trim-blend-test.md` and `docs/design/rail-laws-test.md`; the editing model is
`docs/design/trim-blend-workflow.md`.

Frame as everywhere: cm, **tail at x = 0**, nose toward +x.

## Decisions

Taken by the project owner on 2026-11-11.

|     | Decision                                                 | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Rails only**                                           | A section is edited through its rail: apex, band, tuck, hardness, edge. Free-form section drawing goes. An older board is converted when it is opened                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **Clean: 1 mm at its own stations** (revised 2026-11-12) | A converted board keeps its own stations and nothing else. At them it is within 1 mm of its original, tips excepted; between them the shape is the new engine's own, which is the point of the rebuild. No station or rail key is added to follow the old surface between stations. The first form of this decision held a board to 1 mm everywhere; step 2 met that with added rail keys, and step 3 would have needed up to ten added stations a side. The tips differ on purpose and are recorded in `docs/specs/divergences.md` |
| 3   | **Deck and bottom are drawn at stations**                | A station keeps a deck curve and a bottom curve. Only the rail is taken over by rail keys                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Carried from earlier in the project and unchanged: a board never ends in a point (tips are
a 5 to 10 mm ball); the outline is the plan silhouette; a concave tail is not built by
fanning sections.

## The seam

Every call the app makes into the engine goes through one file,
`apps/web/src/workers/nurbs-core.ts`, and five functions of `@openshaper/board2`:

| Function                              | Gives the app                                 |
| ------------------------------------- | --------------------------------------------- |
| `buildBoard(doc)`                     | A compiled board, or the issues that stop it  |
| `meshBoard(built, opts)`              | Positions, normals, indices, volume and areas |
| `probeSection(built, ev, side, x, n)` | A section's polyline at a station             |
| `createChordFn(doc, side)`            | The half width at a station                   |
| `boardStep(built, opts)`              | The STEP text                                 |

The new engine is built behind these. The editor, the store, the viewer, the exports' front
ends, share and the importers do not change in the swap.

## What is kept, replaced and added

|                    | Files                                                                                   |                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kept**           | `chain.ts`, `bspline.ts`, `features.ts`, `doc.ts`, `issues.ts`, `params.ts`, `classic/` | Curves, bottom features, the document and its JSON, the classic converter                                                                                      |
| **Kept, narrowed** | `sections.ts`, `section-lsq.ts`                                                         | The blend of station curves along the board. It carries panel curves in place of whole sections                                                                |
| **Replaced**       | `surface.ts`, `frame.ts`, `mesh.ts`, `step.ts`                                          | The chord frame and its notch zone, the grid mesh, the two-face solid and its caps                                                                             |
| **Added**          | `trim/`                                                                                 | The outline as a closed loop with a radius on every corner; rail laws along it; the two blend strips; trimmed panels; the mesh, the slice and, last, the solid |

## The document

The board document already names its model: `model: 'sections'`. The new model is
`'rails'`. A rails board keeps `outline`, `rocker`, `deck`, `features`, `fins` and `build`
as they are and changes three things.

|               | Sections board                            | Rails board                                                                                                                                           |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Station       | One closed section chain with an apex     | A bottom curve and a deck curve, each from the stringer out to the outline wall                                                                       |
| Rail          | Part of the section                       | **Rail keys** along the outline. Each holds a rail; the numbers move smoothly between keys. They use the keyed-curve type bottom features already use |
| Tail and tips | `tail: standard` or `notched` with a zone | The tail is the shape of the outline. Every corner carries a radius                                                                                   |

## Converting a sections board

No surface is fitted.

1. The outline becomes a closed loop: its pieces between corner knots, with a radius on
   every corner. The bridge's defaults are 8 mm at the nose, 6 mm at tail tips and corners,
   and 2 mm in the crotch of a notch.
2. At a station each half of the section (bottom and deck, from the stringer out to the
   apex) gives up its rail (`trim/station.ts`):
   - The band edge is found by one rule per half, from the shape alone, so the band line
     runs smoothly along the board. A deck's band starts where the deck, walking in from the
     apex, has come down to 20 degrees above level. A bottom's band starts where the bottom
     has come back to within 6 degrees of the direction of the panel just inboard, which is
     where it stops turning. A crease is found by itself, because the turn drops to nothing
     across it. Where a bottom only curls up a little before a hard edge, the figure is half
     its curl, and under a degree of curl the bottom is a hard edge.
   - The panel ends 0.3 mm short of the band edge, or 1 mm inboard of a crease, and carries
     on from there as a straight line to the wall. Its direction is read over up to 4 mm of
     clean panel before its end. The fit and the kernel are given the same panel, so they
     read the same tangent.
   - One blend replaces everything outboard of the band edge. Its shape (rho) is fitted. It
     leaves the panel at an angle only where the section has a crease there; a smooth rail
     comes out tangent.
   - The two halves' fits become the rail's seven numbers. A band is measured square to the
     outline, so widths are scaled by the cosine of the angle the outline makes with the
     stringer.
3. Rail keys. One key at each stored station. Then a key is added wherever the rail
   interpolated between keys stands more than 0.7 mm off the board's own section
   (`placeKeys`), until none does. The check (`recipeGap`) builds the rail in the section's
   plane and never builds a mesh. It takes about 20 to 230 ms a board (one measurement of
   each).
4. Panels. In the bridge they are read off the current surface row by row; that is test
   code and too slow for the app. A notched board's panels and keys are read off the same
   board with its notch filled in, and the loop of the notched outline cuts the notch out.
5. Tips. The kernel holds the panels to a least thickness of 5 mm, smoothly; a board 1 cm
   thick moves by 0.03 mm.

## Order of work

Each step leaves the branch working.

|     | Step                                                                                                       | Gate                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Kernel.** `trim/`: loop, corners, rail laws, strips, trimmed panels, mesh, slice                         | Closed mesh on every case of the sketch's test matrix; volumes match the sketch                                                              |
| 2   | **Bridge.** A sections board compiled for the new kernel, panels read from the existing section blend      | Every golden and sample board builds closed; **1 mm except tips** against today's engine, per station and between stations; volume within 1% |
| 3   | **Swap.** `meshBoard`, `probeSection` and `createChordFn` served by the new kernel under `nurbs-core.ts`   | The app's own suites; the viewer and the 2D views unchanged in behaviour                                                                     |
| 4   | **Rails board.** The `'rails'` model in the document, conversion on open, undo                             | Round-trip; a converted board builds to the same surface as step 2                                                                           |
| 5   | **Rails editing.** Rail map; rail handles on the section view; band lines on the plan; tap-to-choose in 3D | `trim-blend-workflow.md`                                                                                                                     |
| 6   | **STEP.** Two trimmed faces and the strips                                                                 | OCCT reads one valid closed solid                                                                                                            |
| 7   | **Remove** the chord frame, the notch zone and the caps                                                    | Nothing imports them                                                                                                                         |

Steps 1 and 2 are built; see the two As built sections. From step 3 on the order has
changed: `trim-blend-engine.md` has the new order, the reason, and the design of step 3.

## Open

- **How a new board's panels start.** Decision 3 says they are drawn at stations; templates
  have to supply them.
- **Curvature across a band edge.** The blends meet the panels tangent.
- **The deck-side edge** has no control yet.
- **`earcut`** becomes a runtime dependency of `@openshaper/board2`, which until now needed
  only `@openshaper/geom`. It is small, has no dependencies of its own and is ISC licensed.
- **Panels between stations.** The bridge reads the panels from the existing section blend.
  A rails board has to loft its own panel curves (step 4), and that loft has not been
  measured against this one.
- **Where today's engine cross-fades two rails.** Between two stations whose rails differ (a
  hard edge and a tucked rail, or two tuck widths), the section blend passes through shapes
  neither station has: a bevel, or a double turn-up. The new engine morphs one rail instead.
  Conversion adds keys there to stay inside the bar; with keys at 21 even stations one
  funboard station is still 1.05 mm off.
- **The band limit narrows every band a little.** The soft minimum in `rails.ts` that keeps
  bands from crossing takes 0.08 mm off a band at a 10 cm half width and 0.7 mm at 5 cm. It
  is pinned against the sketch, so changing it is its own change.
- **Strip rows.** The mesh's default 14 and 10 rows across the blends facet a blend by up to
  about 0.08 mm. The measurements here use 28 and 20. Exports will want more.
- **Faint edges.** A blend is given an edge only where the section has a crease of 8 degrees
  or more. A fainter edge is fitted tangent, within 0.25 mm. Trying an edge everywhere was
  declined: it puts small kinks into smooth rails.
- **A hard edge is a very small blend.** The kernel never leaves a blend out: a hard edge is
  built 0.5 mm wide to an apex a fiftieth of the way up the wall, and stands about 0.2 mm off
  a sharp corner.

## As built: step 1, the kernel

`packages/board2/src/trim/`, about 900 lines with its tests. Nothing in the engine or the app
imports it yet, and `@openshaper/board2`'s export list is unchanged.

| File                   | What it holds                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loop.ts`              | `buildLoop`: the outline as a closed loop from smooth pieces, every corner replaced by an arc of its radius, resampled finely where it turns, with the inward normal, the distance along it and the local feature size at every sample. `smoothAlong` |
| `rails.ts`             | `RailRecipe`, the seven numbers of a rail. `railLaws`: the rail at every sample, with the bands held to a share of the local feature size                                                                                                             |
| `solid.ts`             | `buildTrimMesh`: the two blend strips and the two trimmed panels as one mesh with exact normals. `checkClosed`. `sliceX`                                                                                                                              |
| `test-support/demo.ts` | The sketch's three boards, for the tests                                                                                                                                                                                                              |

Its numbers live in `TRIM` in `params.ts`.

**The gate.** The port is pinned against the sketch on three tails with two sets of rails
each. The loops agree exactly: the same number of samples, the same perimeter to a thousandth
of a centimetre, the same narrowest band. The volumes agree to 0.006 L in 30. That last
difference is the triangulator: the sketch and the kernel put every vertex in the same place
and stitch the panels to the rail with different libraries.

Beyond the sketch's own cases, the tests hold the kernel to what it promises:

- **Closed at the ends of every control.** Thirty boards: no notch and the deepest, the
  sharpest and roundest corners, the blends pushed to the tail, to the nose and squeezed to 2%
  of the length each, and the harshest neighbouring rails. None has an open edge.
- **Bands cannot cross.** With the widest rail everywhere, no band or tuck exceeds 0.9 of the
  local feature size at any sample.
- **Corners are the radius asked for.** The two tips of a fish measure 6 mm and its nose 8 mm.
- **The apex is on the outline** and the surface is vertical there.
- **The rail meets the deck tangent**, within a degree, where it has no edge.

`earcut` 3 is the one new dependency.

**Not done in this step:** no real board has been through the kernel, the panels are
still the sketch's invented foil, and there is no STEP. Those are steps 2 and 6.

## As built: step 2, the bridge

Real boards now go through the kernel and are measured against the current engine. Nothing
in the engine or the app imports the new code yet.

| File                     | What it holds                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `station.ts`             | The rail of one section: `fitHalf`, `sectionRail`, `panelCurve`, `builtWidth`, `recipeGap`                                                                       |
| `solid.ts` (additions)   | `withLeastThickness`; the mesh options for strip rows and least thickness; the panels as built on the mesh; the rule that a rail wall is never shorter than 1 mm |
| `test-support/bridge.ts` | Test only: `boardLoop`, `notchFreeTwin`, `boardPanels`, `railKeysAt`, `placeKeys`, `railsAlong`, `boardRails`                                                    |
| `bridge.measure.test.ts` | The measurement, run on demand: `TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/trim/bridge.measure.test.ts`                   |

Its new numbers live in `TRIM` in `params.ts`.

**How it is measured.** 41 even stations per board, both sides of an asymmetric board. The
gap is the worst distance, both ways, between the kernel solid's section and the current
engine's section. Bottom features are removed from both, since they ride on the panel inboard
of the tuck and are the same functions in either engine. Tips are left out: a station within
3 cm of an end of the board or of a corner of its outline, and on a notched board every
station aft of 3 cm beyond its notch zone, where the current engine's sections are not plane.
The mesh is cut with 28 and 20 rows across the blends.

**The gate.**

| Board                               | Tail     | Stored stations | Keys placed | Worst gap (mm) | Median gap (mm) | Stations measured | Volume difference (%) | Open edges |
| ----------------------------------- | -------- | --------------- | ----------- | -------------- | --------------- | ----------------- | --------------------- | ---------- |
| 5.10 × 19.8 × 2.6 MLC               | standard | 5               | 8           | 0.54           | 0.15            | 41                | 0                     | 0          |
| 5.8 × 20 × 2.6 Trusther White Tiger | standard | 3               | 4           | 0.57           | 0.33            | 39                | 0.03                  | 0          |
| 6.0 × 22 × 2.75 Master Trusther 3   | standard | 5               | 5           | 0.48           | 0.22            | 41                | 0.01                  | 0          |
| 6.11 × 21.3 × 2.8 Diamond Twin      | standard | 3               | 4           | 0.61           | 0.46            | 38                | 0.03                  | 0          |
| Go fish                             | standard | 6               | 10          | 0.57           | 0.19            | 40                | -0.02                 | 0          |
| gremilin56                          | standard | 4               | 5           | 0.57           | 0.24            | 39                | 0                     | 0          |
| hyptocrypto                         | standard | 3               | 7           | 0.52           | 0.14            | 41                | 0                     | 0          |
| long classico 9'6"                  | standard | 5               | 9           | 0.53           | 0.16            | 39                | 0.03                  | 0          |
| shortboard                          | standard | 4               | 4           | 0.64           | 0.25            | 40                | 0.02                  | 0          |
| funboard                            | standard | 5               | 6           | 0.70           | 0.11            | 39                | 0.04                  | 0          |
| longboard                           | standard | 5               | 5           | 0.65           | 0.21            | 39                | 0.04                  | 0          |
| swallow                             | notched  | 7               | 7           | 0.18           | 0.16            | 33                | 0.27                  | 0          |
| fish                                | notched  | 7               | 7           | 0.20           | 0.17            | 35                | 0.17                  | 0          |
| asymmetric                          | standard | 5               | 5           | 0.28           | 0.17            | 41                | -0.02                 | 0          |

The 545 stations measured have a worst gap of 0.70 mm and a median of 0.18 mm; 91.7% are
within 0.5 mm and 100% within 1 mm. The gate has three conditions: every board closed, 1 mm
everywhere except the tips, and volume within 1%. Every board meets them.

**Fewer or other keys.**

| Keys                             | Worst (mm) | Median (mm) | Within 0.5 mm (%) | Within 1 mm (%) |
| -------------------------------- | ---------- | ----------- | ----------------- | --------------- |
| At the stored stations only      | 1.90       | 0.20        | 78.7              | 91.4            |
| At 6 even stations               | 1.28       | 0.16        | 94.9              | 99.1            |
| At 21 even stations              | 1.05       | 0.11        | 99.6              | 99.8            |
| Added where a mesh showed a miss | 0.91       | 0.19        | 86.2              | 100             |
| Placed by `recipeGap`            | 0.70       | 0.18        | 91.7              | 100             |

Keys at the stored stations alone are not enough, because between stations the current engine
blends sections where the new one blends rail numbers.

**What differs on purpose.**

- Every corner and tip is rounded in plan.
- A tip is never thinner than 5 mm.
- Inside the lobes of a notched tail the kernel is thicker than the current engine. On the
  swallow it measures 5.23 to 11.53 mm against 2.69 to 10.08 mm; on the fish 5.14 to 8.48 mm
  against 2.63 to 7.49 mm. The current engine fans its sections back from the stringer there;
  the kernel uses the deck and bottom as they are at that x.
- Where the current engine cross-fades two rails (see Open).

These go into `docs/specs/divergences.md` when the engine is switched (step 3), not before.

**Reviewed.** `station.ts` was reviewed adversarially, by experiment. Seven defects were
confirmed and fixed, each with a test that fails without its fix:

- A bevel inboard of the band edge was flattened, by up to 1.3 mm.
- The deck's panel was not mirrored as the fit's is.
- A rule that found no band edge fell back to a hard edge.
- Samples the fit drops did not show in its gap.
- The fit, the gap estimate and the bridge each had their own narrowest blend.
- A section nearly tangent to the outline gave no number.
- A bottom that curls up a little flipped between a hard edge and a blend.

Two were declined (see Open: faint edges, the band limit).

**Not done in this step:** nothing in the app uses the kernel; the panels are still read off
the current surface, by test code; the conversion is not yet a document change (step 4);
there is no STEP (step 6).
