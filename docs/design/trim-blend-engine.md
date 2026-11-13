# Trim and blend: the rails engine

Status: **built** (step 3 of `trim-blend-plan.md`). The app can build its 3D model with it,
behind a switch. What the editor becomes, and the order from here, is `rails-editor-plan.md`.

This document says what the native engine is, what it gives the app, and how it was measured.

Frame as everywhere: cm, **tail at x = 0**, nose toward +x.

## Why the order changed

The plan had the app switch to the new kernel while boards were still stored as sections,
converting on every build. Converting takes one to two seconds (fitting rails, placing keys),
so every edit would lag by that much, and the code that made it tolerable would be thrown away
one step later. The end state is the same; the order is now:

|     | Step                                                                                                                                                       | Gate                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | **The rails engine, native.** A rails board in memory, built with no old surface behind it; mesh, section, half width and apex line from it; the converter | Every board, converted and built natively: closed; within 1 mm of its original at its own stations, tips excepted; volume and the gap between stations reported; build and mesh in 30 ms at view quality |
| 4   | **STEP** for a rails board: two trimmed faces and the strips                                                                                               | OCCT reads one valid closed solid                                                                                                                                                                        |
| 5   | **The document and the swap.** `model: 'rails'` in the document, conversion once on open, the app's seam dispatching on the model                          | The app's own suites; every export still works                                                                                                                                                           |
| 6   | **Rails editing**                                                                                                                                          | `trim-blend-workflow.md`                                                                                                                                                                                 |
| 7   | **Remove** the chord frame, the notch zone and the caps                                                                                                    | Nothing imports them                                                                                                                                                                                     |

STEP moves ahead of the swap so that no export is lost when the app changes engine.

## What the app asks of an engine

Only `apps/web/src/workers/nurbs-core.ts` calls the engine at run time. The store and the
other packages import types; the store is handed the half-width function.

| Need                    | Today                                                  | What the app reads                                                                                                                   | The rails engine offers                                                                               |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Build                   | `buildBoard(doc, { check, spanHint })`                 | `doc`, `xiMin`, `xiMax`, `report.{stationFitError, clampedControls, blendOvershoot}`, `report.sectionSpans[0]`                       | `buildRails(board, { check, previous })`: issues, `xiMin`, `xiMax`, the board, the same report fields |
| Mesh                    | `meshBoard(built, { curvature, ladders, maxEdge })`    | `positions`, `normals`, `indices`, `vertexCount`, `k1`, `k2`, `volume`, `planArea`, `surfaceArea`, `ladders` (an opaque reuse token) | `meshRails(built, { maxEdge, draft, curvature })` with the same fields                                |
| Section at a station    | `probeSection(built, ev, side, x, n)`                  | `n` points from the bottom centre over the apex to the deck centre: distance from the stringer, height above the rocker              | `probeRails(built, side, x, n)`, same framing                                                         |
| Half width at a station | `createChordFn(doc, side)`                             | Scales a normalised section to physical units; fits features                                                                         | `halfWidthRails(board, side)`: the width the loft normalises by, with a notch filled in               |
| Apex line, plan point   | `createEvaluator`, `ev.row`, `ev.eval(0.5)` (DXF, PDF) | The outline point and the apex height at a station                                                                                   | `apexRails(built, side, x)`                                                                           |
| STEP                    | `boardStep`                                            | Text                                                                                                                                 | Step 4                                                                                                |

The centre of mass is computed in the app from the mesh.

## The rails board

A rails board keeps `outline`, `rocker`, `deck`, `features`, `fins` and `build` as a sections
board has them, and carries:

- **Corner radii**: one for the nose, one for the tail, one per corner knot of each side.
- **Stations**, each with a **bottom curve and a deck curve** per side. A curve is a chain in
  normalised (u, v): u from the stringer (0) to the wall (1), v the height above the rocker
  over the thickness. It is a function of u, and flat at u = 0. This is the form a `Section`
  has today, so the store's projection and the way a section follows an outline edit stay as
  they are.
- **Rail keys** per side: a place along the board and a rail (`RailRecipe`). Each of a rail's
  seven numbers runs between keys as a keyed curve, held outside them. Keys are placed along
  x; placing them along the outline is for later.

## The panels are lofted at fixed u

Today's engine fits every station's section on one shared knot vector, with the rail
registered at a landmark, and blends each control point along the board at fixed section
parameter, by a local C2 quintic through the stations (monotone slopes; the end sections held
beyond the first and last station). The point is then `z = R(x) + T(x) v` at `y = u w(x)`.

A panel has no rail to register a parameter to, so that blend cannot be reused. The panels
are a height field **v(x, u)**, u = y / w(x), blended along x **at fixed u** with the same
quintic. Averaging two domes at fixed u gives a dome: the blend keeps a deck convex.

It is not today's surface between stations. Measured on fourteen boards, with the stored
stations only, the worst vertical gap inboard of the band edge:

|                                        | Fixed u (chosen) | Fixed share of the band edge | Arc length to the band edge |
| -------------------------------------- | ---------------- | ---------------------------- | --------------------------- |
| Worst over all boards (mm)             | 4.62             | 7.04                         | 4.55                        |
| Diamond Twin deck, inboard / near edge | 3.0 / 4.6        | 4.6 / 7.0                    | 2.7 / 4.6                   |
| MLC bottom, inboard / near edge        | 0.3 / 2.9        | 0.3 / 2.9                    | 0.3 / 2.9                   |
| Shortboard, longboard, the made boards | 0.4 or less      | worse                        | about the same              |

No way of running the curves reproduces today's surface from the stored stations alone. A
conversion that held the new surface to the old between stations would have to add a station
where the loft misses. To a loft bar of 0.4 mm, checked every 2.5 cm, that is ten stations a
side on the Diamond Twin's deck (4.59 mm to 0.24 mm), eight on the hyptocrypto's, three on the
MLC's bottom, and none to three on most boards; 14 to 270 ms a board. The converter does not
add them (see "Decided by the project owner"). Tip stations are kept and read in normalised
coordinates: dropping them made the swallow's deck 1.37 mm worse.

**Representation.** At build time each station curve is sampled on a uniform u grid (0.05 cm
or finer at the widest half width, about 600 samples). Each u sample carries the station
value and the first and second derivatives along x. A point is the quintic in x and a
Catmull-Rom cubic in u, with the grid extended evenly across the stringer (the surface is C1
there) and linearly past the wall. `R`, `T` and `w` come from tables. About 70 to 95 ns an
evaluation with the gradient; under 2 ms to build.

## Bottom features

Today a feature's depth is added on the bottom and faded out over the last part of the
section before the apex. It is at full value at the band edge, and a channel that reaches the
band edge moved the rail by 21 mm in the bridge.

- The kernel reads the band edge's height and slope from the **feature-free** panel.
- Features are a separate **relief** r(x, y), added at full value to the bottom panel's grid
  nodes and rim vertices.
- On the tuck strip the relief is multiplied by a C2 fade from 1 at the band edge to 0 at the
  apex. The fade has no slope at the band edge, so the joint stays C1.
- The least thickness is applied to the base panels only.

Against today: the fade runs along the tuck where today it runs over the section parameter
(about the same region), `railFade` has no meaning in this engine, and a channel that reaches
the band edge no longer moves the rail.

## Cost

|                                            | MLC            | Shortboard |
| ------------------------------------------ | -------------- | ---------- |
| Today: `buildBoard`, warm                  | 1.0 ms         | 0.3 ms     |
| Today: `meshBoard`, tolerance 0.05, fresh  | 13 to 14 ms    | 7 to 8 ms  |
| Today: `meshBoard` reusing its ladders     | 2.8 ms         | 2.5 ms     |
| Today: `meshBoard` for STL, edge 0.5       | 63 ms          | 70 ms      |
| Today's mesh                               | 9.2 k vertices | 8.2 k      |
| Loop (piece sampling and `buildLoop`)      | 14 ms          | 16 ms      |
| `railLaws`                                 | 2.4 ms         | 3.2 ms     |
| `buildTrimMesh`, constant panels, grid 0.7 | 47 ms, 44 k    | 52 ms      |
| `buildTrimMesh` with the fixed-u loft      | 90 ms          | 67 ms      |
| A rail key (`sectionRail`)                 | 3.3 ms         | 1.1 ms     |
| `placeKeys`                                | 145 ms         | 25 ms      |

One mesh makes about 270 thousand panel calls, and the time is there: the least thickness
takes two powers a call (a third of the mesh build), and a normal takes five calls, each a
deck and a bottom. So: one call that gives both heights and both gradients; no thickening
where the board is over four times the least thickness; typed arrays; the loop cached on the
outline and its radii.

**Budget:** 30 ms for build and mesh at view quality with the loop cached, 50 ms after an
outline edit, 20 ms in draft. Today's is 15 ms.

| Quality                | Panel grid (cm) | Strip rows (deck, tuck)             |
| ---------------------- | --------------- | ----------------------------------- |
| View, specs            | 0.7             | 14, 10                              |
| Draft (while dragging) | 1.0             | 8, 6                                |
| STL with face size `f` | min(0.7, f)     | at least 28, 20; more for a small f |

## Files

All under `packages/board2/src/trim/`.

| File                           | What it holds                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board.ts`                     | The types: `RailsBoard`, `RailsStation`, `StationCurves`, `RailKey`, `RailsCorners`                                                                                   |
| `along.ts`                     | The blend along the board: the quintic through stations, as `sections.ts` blends a control point                                                                      |
| `loft.ts`                      | The panels: `buildLoft`, `loftPanels`, the stringer tables                                                                                                            |
| `keys.ts`                      | Rail keys to laws: `railsAlong`, `lawsFromKeys` (out of the bridge)                                                                                                   |
| `outline.ts`                   | The outline to a loop definition with its radii, and the half width with a notch filled in (out of the bridge)                                                        |
| `relief.ts`                    | Bottom features as a relief                                                                                                                                           |
| `native.ts`                    | `BuiltRails`, `buildRails`, `meshRails`                                                                                                                               |
| `curvature.ts`                 | Principal curvatures at the mesh's vertices, from its exact normals                                                                                                   |
| `probe.ts`                     | `probeRails`, `apexRails`, `halfWidthRails`: the lofted panels to the band edge, then the rail built in the section's plane                                           |
| `convert.ts`                   | `convertSections(doc)`: a sections document to a rails board, from the document alone                                                                                 |
| `test-support/panel-fit.ts`    | Test only: how far a mesh's flat panel triangles are off the panels, and their longest plan edge                                                                      |
| `test-support/measure.ts`      | Test only: the two-sided gap between a mesh slice and a section polyline, the distance from a point to a segment, the thickness of a closed mesh through a plan point |
| `test-support/native-study.ts` | Test only: a study board put through the rails engine and held against today's engine                                                                                 |
| `native.measure.test.ts`       | The gate of this step, run on demand: `TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/trim/native.measure.test.ts`                  |
| `grid.measure.test.ts`         | The panel grid study, run on demand: `TRIM_STUDY=1 TRIM_OUT=<dir> pnpm --filter @openshaper/board2 exec vitest run src/trim/grid.measure.test.ts`                     |

`fit-chain.ts` and `sections-reader.ts` were only needed to follow the old surface between
stations, which a clean conversion does not do, so they were not built.

```ts
export interface StationCurves {
  readonly bottom: Chain;
  readonly deck: Chain;
}
export interface RailsStation {
  readonly id: string;
  readonly x: number;
  readonly plus: StationCurves;
  readonly minus?: StationCurves;
}
export interface RailKey {
  readonly x: number;
  readonly rail: RailRecipe;
}
export interface RailsCorners {
  readonly nose: number;
  readonly tail: number;
  readonly plus: readonly number[];
  readonly minus?: readonly number[];
}
export interface RailsBoard {
  readonly model: 'rails';
  readonly meta: BoardMeta;
  readonly symmetry: Symmetry;
  readonly outline: Outline;
  readonly corners: RailsCorners;
  readonly rocker: Chain;
  readonly deck: Chain;
  readonly stations: readonly RailsStation[];
  readonly rails: { readonly plus: readonly RailKey[]; readonly minus?: readonly RailKey[] };
  readonly features: readonly BottomFeature[];
  readonly fins?: JsonValue;
  readonly build: BuildSettings;
}
export interface BuiltRails {
  readonly board: RailsBoard;
  readonly xiMin: number;
  readonly xiMax: number;
  readonly loop: Loop;
  readonly laws: RailLaws;
  readonly panels: Panels;
  readonly halfWidth: readonly [(x: number) => number, (x: number) => number];
  readonly report: RailsBuildReport;
}
export function buildRails(board: RailsBoard, opts?: BuildRailsOptions): Board2Result<BuiltRails>;
export function meshRails(built: BuiltRails, opts?: MeshRailsOptions): RailsMesh;
export function probeRails(built: BuiltRails, side: 0 | 1, x: number, samples: number): number[];
export function apexRails(built: BuiltRails, side: 0 | 1, x: number): { y: number; z: number };
export function halfWidthRails(board: RailsBoard, side?: 'minus'): (x: number) => number;
export function convertSections(
  doc: BoardDoc,
): Board2Result<{ board: RailsBoard; report: ConvertReport }>;
```

**Converting.** The converter reads the document and nothing else: no surface of the old
engine is built.

At each station and side the stored section is scaled to physical units by the half width (a
notch filled in) and the thickness, and its rail is read off it (`sectionRail`). A usable
station gets one rail key. A station thinner than 0.6 cm or narrower than 2.5 cm is a tip: it
gets no key and borrows the band share of the nearest usable station.

Each of the station's two curves is the stored section's own curve as far as the panel's end,
with the designer's knots and handles kept as drawn, the segment that holds the end split
there, and one straight segment from there to the wall at the panel's slope. The deck's knots
are taken in reverse so that both curves run from the stringer out.

A stored half that is not a function of u inboard of its end (a vertical piece at the
stringer, a fold) is kept as drawn and flagged in the conversion's report; the loft reads it
with the samples that do not rise dropped.

Nothing is added between stations. Following the old surface between stations is not built.

## As built

**The gate.** Closed; within 1 mm of today's engine at the board's own stations, tips
excepted; the rest reported. It is measured on each board with its features off, through
`convertSections`, `buildRails` and the kernel mesh, cut with 28 and 20 rows across the
blends. The gap is the worst distance, both ways, between the solid's section and today's
engine's section. A tip is a station within 3 cm of an end of the board or of a corner of its
outline, and on a notched board every station aft of 3 cm beyond the crotch. A notched board's
sections are measured against today's engine on the same board with its notch filled in,
because a rails board reads its stations as plane sections and today's notched engine fans
them inside its notch zone; its volume is compared with the real notched board's.

| Board                               | Own stations measured | Worst gap (mm) | Median gap (mm) | Even stations measured | Worst gap (mm) | Median gap (mm) | Volume difference (%) | Open edges |
| ----------------------------------- | --------------------- | -------------- | --------------- | ---------------------- | -------------- | --------------- | --------------------- | ---------- |
| 5.10 × 19.8 × 2.6 MLC               | 5                     | 0.39           | 0.13            | 41                     | 3.49           | 0.29            | 0.22                  | 0          |
| 5.8 × 20 × 2.6 Trusther White Tiger | 2                     | 0.10           | 0.10            | 39                     | 2.05           | 1.09            | 0.12                  | 0          |
| 6.0 × 22 × 2.75 Master Trusther 3   | 5                     | 0.19           | 0.10            | 41                     | 0.84           | 0.23            | 0.19                  | 0          |
| 6.11 × 21.3 × 2.8 Diamond Twin      | 2                     | 0.19           | 0.19            | 38                     | 2.63           | 1.51            | 0.30                  | 0          |
| Go fish                             | 5                     | 0.26           | 0.09            | 40                     | 1.70           | 0.50            | 0.13                  | 0          |
| gremilin56                          | 3                     | 0.09           | 0.05            | 39                     | 0.74           | 0.53            | 0.17                  | 0          |
| hyptocrypto                         | 3                     | 0.22           | 0.04            | 41                     | 1.17           | 0.30            | 0.15                  | 0          |
| long classico 9'6"                  | 3                     | 0.11           | 0.07            | 39                     | 1.82           | 0.40            | 0.27                  | 0          |
| shortboard                          | 3                     | 0.19           | 0.14            | 40                     | 0.77           | 0.22            | 0.20                  | 0          |
| funboard                            | 3                     | 0.10           | 0.10            | 39                     | 0.72           | 0.22            | 0.18                  | 0          |
| longboard                           | 3                     | 0.07           | 0.07            | 39                     | 0.88           | 0.24            | 0.20                  | 0          |
| swallow                             | 6                     | 0.17           | 0.16            | 40                     | 1.02           | 0.17            | 0.44                  | 0          |
| fish                                | 6                     | 0.83           | 0.16            | 40                     | 1.61           | 0.17            | 0.35                  | 0          |
| asymmetric                          | 10                    | 0.25           | 0.12            | 41                     | 0.25           | 0.17            | 0.20                  | 0          |

At the boards' own stations: 59 stations, worst 0.83 mm, median 0.10 mm; 98.3% are within
0.5 mm and 100.0% within 1 mm. At the 41 even stations: 557 stations, worst 3.49 mm, median
0.26 mm; 69.7% are within 0.5 mm and 88.3% within 1 mm. Between stations the shape is the new
engine's own by decision, so the second figure is a description, not a miss.

**Cost.**

| Board                               | Vertices (view) | Convert (ms) | Build (ms) | Build again (ms) | Mesh, view (ms) | Mesh, draft (ms) |
| ----------------------------------- | --------------- | ------------ | ---------- | ---------------- | --------------- | ---------------- |
| 5.10 × 19.8 × 2.6 MLC               | 44409           | 10.0         | 41.2       | 7.4              | 34.0            | 11.3             |
| 5.8 × 20 × 2.6 Trusther White Tiger | 43841           | 15.0         | 18.5       | 2.6              | 22.4            | 12.0             |
| 6.0 × 22 × 2.75 Master Trusther 3   | 49009           | 23.5         | 23.1       | 4.3              | 22.8            | 12.6             |
| 6.11 × 21.3 × 2.8 Diamond Twin      | 55299           | 17.4         | 28.4       | 3.5              | 28.1            | 15.1             |
| Go fish                             | 47553           | 17.6         | 22.5       | 3.8              | 22.1            | 11.5             |
| gremilin56                          | 42212           | 13.1         | 18.9       | 3.3              | 25.2            | 10.7             |
| hyptocrypto                         | 45357           | 10.4         | 20.0       | 3.3              | 20.8            | 11.7             |
| long classico 9'6"                  | 85811           | 8.1          | 45.8       | 4.4              | 47.9            | 22.2             |
| shortboard                          | 44510           | 5.5          | 21.4       | 3.1              | 20.0            | 11.7             |
| funboard                            | 60296           | 6.7          | 24.9       | 3.6              | 27.9            | 15.8             |
| longboard                           | 75030           | 6.6          | 40.0       | 4.1              | 35.9            | 19.2             |
| swallow                             | 47310           | 8.8          | 25.7       | 4.5              | 25.0            | 11.6             |
| fish                                | 45119           | 9.5          | 21.8       | 4.1              | 20.9            | 12.1             |
| asymmetric                          | 44046           | 13.1         | 21.3       | 5.7              | 20.5            | 11.8             |

These times were taken before the stitch was flipped; meshing with and without the flips, alternated in one process, differs by less than this machine's noise ("Time" below). The budget is 30 ms to build again and mesh at view quality, and 20 ms in draft. Build again
plus mesh at view quality is over 30 ms on 5 boards: 5.10 × 19.8 × 2.6 MLC (41.4 ms), 6.11 × 21.3 × 2.8 Diamond Twin (31.5 ms), long classico 9'6" (52.3 ms), funboard (31.5 ms), longboard (40.0 ms). Build again plus mesh in draft is over 20 ms on 2 boards: long classico 9'6" (26.6 ms), longboard (23.3 ms).

**The panel mesh.** Each panel (the deck, and the bottom with its relief) is a height field
cut on a square grid of `grid` cm, with nodes nudged by `gridJitter` so that no three stitch
vertices are in line. A cell is kept when its four corners are inside the band edge and it is
not within one cell of a cell the band edge passes through, so the kept cells stop one to two
and a half cells short of the band edge. The gap between the kept cells' boundary rings and the
band edge's own vertices (the strip's first row, in the same places) is the **stitch**:
`earcut` triangulates it with the rings as holes, `restoreRim` puts back any band edge vertex
it dropped as in line with its neighbours, and `flipToDelaunay` then flips the stitch to
Delaunay in plan (Lawson's algorithm). An edge is flipped only when two stitch triangles share
it, the corners opposite it see it at more than π together (by `stitchFlipSine` in the sine)
and the quad is strictly convex; the band edge's and the rings' own edges are never flipped, so
the mesh stays closed and every band edge vertex stays used. No vertex is moved or added. The
flips number 2.4 to 4.7 a stitch triangle; `stitchFlipCap` (50 a triangle) is a guard only.

Without the flips the triangulator joins far apart band edge vertices wherever the chord fits
in the gap: 1,300 to 3,600 triangles a board at view quality had a plan edge over twice the
grid, up to 28 to 80 cm long, and their interiors were 4 to 13 mm off the panel (2.4 to 9.7 mm
in an STL at face 0.5). Their corners were on the panel, so it showed as a faint dotted
speckle along the band edge: 800 to 2,000 stitch triangles a board had an angle under 1°, and
up to ten a face normal more than 90° from its corners' normals. With the flips none has an
angle under 2°, none a face more than 30° from its corners' normals (the channel walls
aside), and the longest panel edge is 1.6 to 2.2 cm at view quality.

The distance off the panel (`test-support/panel-fit.ts`: |panel − flat triangle| at each panel
triangle's centroid and edge midpoints) on the made boards without features, 99th percentile
and worst, with the vertices and the median time to mesh of a shortboard (view rows):

| Grid (cm) | 99th percentile (mm) | Worst (mm)   | Longest panel edge (cm) | Shortboard vertices | Shortboard mesh (ms) |
| --------- | -------------------- | ------------ | ----------------------- | ------------------- | -------------------- |
| 0.4       | 0.04 to 0.07         | 0.30 to 0.46 |                         | 96383               | 72                   |
| 0.5       | 0.07 to 0.10         | 0.36 to 0.63 |                         | 68607               | 66                   |
| 0.7       | 0.14 to 0.19         | 0.46 to 0.74 | 1.6 to 2.2              | 44510               | 30                   |
| 1.0       | 0.29 to 0.35         | 0.57 to 1.06 | 2.3 to 2.95             | 31846               | 18                   |
| 1.4       | 0.52 to 0.60         | 0.72 to 1.44 | 3.2 to 4.0              | 25936               | 12                   |
| 2.0       | 0.86 to 1.06         | 1.02 to 2.16 | 4.5 to 5.7              | 22867               | 10                   |

The grid's own cells are within 0.05 mm at 0.7 cm; both the 99th percentile and the worst are
set by the stitch, whose triangles span the gap where the panel rolls fastest. So the grids
stay at 0.7 cm for view quality (the finest of those, 0.14 to 0.19 mm at the 99th
percentile, under 0.75 mm at worst) and 1 cm while dragging (the coarsest within 0.5 mm at the
99th percentile). The 14 sample boards are closed at view, draft and STL faces 0.5 and 0.3,
within 0.22 mm at the 99th percentile at view quality; the Diamond Twin's worst is 5.8 mm at
every grid, so a feature of its panel is narrower than any of them.

**The volume** is the closed mesh's own plus `panelGap`: the volume between the flat panel
triangles and the panels over them, by the three-edge-midpoint rule on each triangle (exact for
a quadratic gap). On a grid cell the midpoint's gap is read from the cubic through the edge's
ends, their heights and their slopes from their exact normals, with no panel call. A stitch
triangle reads the panel at its edges' midpoints: its edges cross the band edge's strip, where
the panel rolls fastest and a channel can reach, and there the cubic moved the volume by up to
4 parts in 10^4 at a 1 cm grid. Against a 0.25 cm grid the volume is then within 0.37 parts in
10^4 up to a 1.4 cm grid and 0.93 at 2 cm on the made boards without features, and within 0.82
on the channel board up to 1.4 cm (4.5 at 2 cm, where the channel walls are narrower than the
cells).

**Time.** The flips take 0.7 to 2.5 ms a mesh at view, draft or STL face 0.5 quality, timed
inside the mesh. Meshing with and without them, alternated in one process (median of 9, summed
over nine boards), was within the noise of this machine: −3% at view, −7% in draft, −2% at
STL face 0.5, 0% at STL face 0.2. The panel calls of the stitch's volume are a few thousand a
mesh.

**Channels.** The asymmetric board's channel walls are narrower than any of the grids, and its
grid cells over them are off the panel by 1.3 mm at the 99th percentile and 3.0 mm at worst at
view quality, 0.91 and 2.4 mm at STL face 0.5, 0.20 and 0.57 mm at 0.2. The stitch does not
change this.

**The section probe is first order.** `probeRails` builds a station's rail in the plane of the
station; the kernel sweeps it square to the outline. They agree within 0.1 mm where the
outline runs along the stringer and differ by up to 0.88 mm where it runs at 15 to 35 degrees
to it, near the tail and nose curves.

**Bottom features.** They are evaluated through `features.ts`'s own feature terms at
(x, |y| / w(x)), with an analytic gradient, added in full on the bottom panel and faded along
the tuck. On a board whose channels reach the band edge, the rail's wall and apex and every
deck vertex are identical to the same board without features, and the bottom's normal and the
tuck's first-row normal agree within 0.07 degrees.

**Tests.** Under `src/trim` there are 14 test files; 11 run and pass (194 tests) and 3, the
measurement files, are skipped unless `TRIM_STUDY=1`. The main ones pin:

- `along.test.ts`: the blend equals `sections.ts`'s; it passes through the station values, holds the ends, and is continuous in value, slope and second derivative.
- `loft.test.ts`: the loft is each station's curve at its x, holds the end curves, is C1 across the stringer, has gradients that match the heights' derivatives, and blends two domes into a dome.
- `keys.test.ts`: the key laws pass through their keys, are held flat outside them and never overshoot.
- `outline.test.ts`: the loop keeps the samples of the study boards' loops; the half width equals the chord function.
- `convert.test.ts`: one rail key at each usable station and none at a tip; each curve is the stored section to the panel's end, then straight to the wall; the converted station lofts back to the stored section; a fold is flagged and a clean board has none; a notched board is read with its notch filled.
- `relief.test.ts`: the relief equals `features.ts`'s depth and its gradient matches finite differences.
- `native.test.ts`: the board builds, is closed at view and draft quality and has a volume within 1.5% of the sections engine's, and within 2 parts in 10^4 of a 0.25 cm grid's at the view and draft grids; on the made boards no panel triangle's plan edge is over 4 times the grid or the loop's spacing, and without features the flat panel triangles are within 0.3 mm at the 99th percentile and 1 mm at worst at view quality (0.15 and 0.8 mm at STL face 0.5); the loop is reused; a board that cannot be built is refused; a channel reaching the band edge leaves the rail and the deck where they were.
- `curvature.test.ts`: principal curvatures on a sphere, cylinder, plane, saddle and torus.
- `probe.test.ts`: the probe returns the points asked for, has the outline half width, and stands within the bound of the kernel mesh away from the tips.

**Open.**

- The rebuild budget is missed on the long boards: the grid cannot be coarsened without the
  stitch moving further off the panel (table above).
- **A narrower stitch.** The stitch is one to two and a half cells wide because a cell is
  dropped within one cell of any cell the band edge passes through. A rule that keeps a cell
  whose corners are at least about half a cell inside the band edge would make the gap half a
  cell to one and a half cells wide, which by the table should take the 99th percentile at a
  0.7 cm grid to about that of a 0.4 to 0.5 cm grid with a few percent more vertices, or let
  the grid coarsen at the same distance. It adds and moves vertices, and the closedness rests
  on it: with no margin at all (only the cells the band edge passes through dropped) the mesh
  opened, with 20 to 650 open edges a board, and the slivers came back. A ring that comes too
  close to the band edge, or touches it at a concave turn, has to be kept off it.
- **Channels within 0.1 mm** need cells finer over the walls only: from 0.57 mm at a 0.2 cm
  grid, about 0.08 cm there, three halvings of a 0.7 cm cell. The cubic midpoint gap already
  computed on each cell edge cannot find a wall that falls between two nodes (both ends are
  flat); reading the relief at the midpoints, or the walls' places from the feature, can.
- **A squash tail's bottom near its edge.** On the shortboard the bottom's slope along x is
  −0.151 everywhere at x = 0 and at x = 0.3 cm, but at x = 0.05 cm it runs from −0.15 at the
  stringer to +1.07 at y = ±3 cm, and at 0.1 cm to +0.05: the loft reads the panel at u = y /
  w(x) with the half width from its 0.1 cm table, and w is steep at the tail's edge. The tuck's
  first-row normals along the tail edge then swing between neighbouring samples (x
  component −0.13, +0.08, +0.20, +0.05, −0.13 across y = ±2.8 cm), which shades as a bright
  line along the tail edge near its corners. It is in the loft and its table, not the mesh.
- **Tight rows on a near-hard edge.** Where a band is a fraction of a millimetre (0.67 mm on
  the fish's inner tail lobe, the 0.5 mm `bandMin` on the shortboard's tail tuck), the rows at
  even conic parameter put most of the turn in the first row: the normal turns about 40° from
  row 0 to row 1 across 0.03 mm, and 88 strip triangles on the fish (12 on the shortboard) have
  a face normal 25 to 37° from their corners'. It renders as a narrow bright edge; spacing the
  rows by turn would even it.
- The section probe is first order. An exact probe slices the blends near the station.
- A rails build has no issue codes of its own: a side with no rail key reports `too-few-sections`, rail keys out of order `station-order`, an outline no loop can be built from `geom`.
- `meshRails` accepts `tolerance` and it changes nothing.
- The Diamond Twin's tail-tip station has stored curves that are not functions of u (two halves flagged); they are kept as drawn. Its thinnest rail wall is 1.0 mm, at the kernel's floor.
- Station curves are stored with the designer's own knots; the editor that will keep them functions of u is step 6.

**Not done in this step:** nothing in the app uses the engine; STEP for a rails board (step 4); the document model and the swap (step 5).

## Decided

- The converter adds no station and no rail key beyond one at each usable station.
- Principal curvatures for the curvature view come from the mesh's exact normals.
- `railFade` is not read by this engine: features fade along the tuck.
- Station curves are stored normalised, as a `Section` is.
- Rail keys are placed along x, per side.
- A section probed inside a notch's lobes is the lobe, as one polyline, flagged.

## Decided by the project owner (2026-11-12)

**A conversion is clean.** Between stations the old surface is one interpolation of the
designer's stations and the new one is another; neither is the design. Holding the new one
to the old within 1 mm between stations would cost added stations (up to ten a side on a
board with three) and added rail keys. A converted board keeps its own stations instead and
the new engine runs between them: up to 4.6 mm from the old surface on a board with few
stations, 0.4 mm or less on most. "That's the whole point of this experimental rebuild."
