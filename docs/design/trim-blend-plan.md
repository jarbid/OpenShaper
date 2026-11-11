# Trim and blend: the integration plan

Status: **plan in progress**. It replaces the surface core of the NURBS engine on
`experiment/nurbs-overhaul` and keeps everything else on that branch. The evidence is
`docs/design/trim-blend-test.md` and `docs/design/rail-laws-test.md`; the editing model is
`docs/design/trim-blend-workflow.md`.

Frame as everywhere: cm, **tail at x = 0**, nose toward +x.

## Decisions

Taken by the project owner on 2026-11-11.

|     | Decision                                  | What it means                                                                                                                                                      |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Rails only**                            | A section is edited through its rail: apex, band, tuck, hardness, edge. Free-form section drawing goes. An older board is converted when it is opened              |
| 2   | **1 mm, except the tips**                 | The bar a converted board must meet against its original before the engine is switched. The tips differ on purpose and are recorded in `docs/specs/divergences.md` |
| 3   | **Deck and bottom are drawn at stations** | A station keeps a deck curve and a bottom curve. Only the rail is taken over by rail keys                                                                          |

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

1. At each stored station, find the band edge on the bottom and on the deck
   (`forward.ts`: the bottom's is where it stops being flat; the deck's is the narrowest
   that fits).
2. Split the section chain there. The two inboard pieces are the station's bottom and deck
   curves, kept exactly, each carried on along its own tangent to the wall.
3. Fit one rail to what is left of each half. That is the station's rail key.
4. Round the tips.

At the stations the error is the rail fit's: 0.26 mm at worst over 574 stations
(`trim-blend-test.md`, stage 1). Between stations it is not yet measured.

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

## Open

- **Between stations.** A rail interpolated between two keys against a section blended
  between two stations. Step 2 measures it.
- **How a new board's panels start.** Decision 3 says they are drawn at stations; templates
  have to supply them.
- **Curvature across a band edge.** The blends meet the panels tangent.
- **The deck-side edge** has no control yet.
- **`earcut`** becomes a runtime dependency of `@openshaper/board2`, which until now needed
  only `@openshaper/geom`. It is small, has no dependencies of its own and is ISC licensed.

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
