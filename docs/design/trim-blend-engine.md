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
| 5.10 × 19.8 × 2.6 MLC               | 5                     | 0.39           | 0.13            | 41                     | 3.49           | 0.29            | 0.08                  | 0          |
| 5.8 × 20 × 2.6 Trusther White Tiger | 2                     | 0.10           | 0.10            | 39                     | 2.05           | 1.09            | 0                     | 0          |
| 6.0 × 22 × 2.75 Master Trusther 3   | 5                     | 0.19           | 0.10            | 41                     | 0.84           | 0.23            | 0.07                  | 0          |
| 6.11 × 21.3 × 2.8 Diamond Twin      | 2                     | 0.19           | 0.19            | 38                     | 2.63           | 1.51            | 0.16                  | 0          |
| Go fish                             | 5                     | 0.26           | 0.09            | 40                     | 1.70           | 0.50            | -0.04                 | 0          |
| gremilin56                          | 3                     | 0.09           | 0.05            | 39                     | 0.74           | 0.53            | 0.03                  | 0          |
| hyptocrypto                         | 3                     | 0.22           | 0.04            | 41                     | 1.17           | 0.30            | 0.02                  | 0          |
| long classico 9'6"                  | 3                     | 0.11           | 0.07            | 39                     | 1.82           | 0.40            | 0.17                  | 0          |
| shortboard                          | 3                     | 0.19           | 0.14            | 40                     | 0.77           | 0.22            | 0.05                  | 0          |
| funboard                            | 3                     | 0.10           | 0.10            | 39                     | 0.72           | 0.22            | 0.07                  | 0          |
| longboard                           | 3                     | 0.07           | 0.07            | 39                     | 0.88           | 0.24            | 0.09                  | 0          |
| swallow                             | 6                     | 0.17           | 0.16            | 40                     | 1.02           | 0.17            | 0.26                  | 0          |
| fish                                | 6                     | 0.83           | 0.16            | 40                     | 1.61           | 0.17            | 0.16                  | 0          |
| asymmetric                          | 10                    | 0.25           | 0.12            | 41                     | 0.25           | 0.17            | -0.03                 | 0          |

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

The budget is 30 ms to build again and mesh at view quality, and 20 ms in draft. Build again
plus mesh at view quality is over 30 ms on 5 boards: 5.10 × 19.8 × 2.6 MLC (41.4 ms), 6.11 × 21.3 × 2.8 Diamond Twin (31.5 ms), long classico 9'6" (52.3 ms), funboard (31.5 ms), longboard (40.0 ms). Build again plus mesh in draft is over 20 ms on 2 boards: long classico 9'6" (26.6 ms), longboard (23.3 ms).

**Why the long boards are over, and why the grid is not simply made coarser.** The mesh is 44
to 86 thousand vertices because the two panels are cut on a 0.7 cm grid.

| Board                 | Grid (cm) | Vertices | Mesh (ms) | Volume against the 0.7 cm grid (%) |
| --------------------- | --------- | -------- | --------- | ---------------------------------- |
| 5.10 × 19.8 × 2.6 MLC | 0.7       | 44409    | 29        | 0.000                              |
| 5.10 × 19.8 × 2.6 MLC | 1.0       | 31459    | 11        | -0.199                             |
| 5.10 × 19.8 × 2.6 MLC | 1.4       | 25445    | 12        | -0.416                             |
| 5.10 × 19.8 × 2.6 MLC | 2.0       | 22294    | 6         | -0.908                             |
| long classico 9'6"    | 0.7       | 85811    | 35        | 0.000                              |
| long classico 9'6"    | 1.0       | 57834    | 21        | -0.228                             |
| long classico 9'6"    | 1.4       | 44784    | 15        | -0.282                             |
| long classico 9'6"    | 2.0       | 37968    | 12        | -0.920                             |
| shortboard            | 0.7       | 44510    | 17        | 0.000                              |
| shortboard            | 1.0       | 31846    | 10        | -0.173                             |
| shortboard            | 1.4       | 25936    | 7         | -0.407                             |
| shortboard            | 2.0       | 22867    | 6         | -0.961                             |

A coarser grid meshes faster but the reported volume falls with it, because the volume is
summed over the mesh's flat triangles; so the grid stays at 0.7 cm until the volume is taken
from the panels themselves.

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
- `native.test.ts`: the board builds, is closed at view and draft quality and has a volume within 1.5% of the sections engine's; the loop is reused; a board that cannot be built is refused; a channel reaching the band edge leaves the rail and the deck where they were.
- `curvature.test.ts`: principal curvatures on a sphere, cylinder, plane, saddle and torus.
- `probe.test.ts`: the probe returns the points asked for, has the outline half width, and stands within the bound of the kernel mesh away from the tips.

**Open.**

- The rebuild budget is missed on the long boards, for the reason above.
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
