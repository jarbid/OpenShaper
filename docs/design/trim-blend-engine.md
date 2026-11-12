# Trim and blend: the rails engine

Status: **design, being built**. Step 3 of `trim-blend-plan.md`. It says what the native
engine is, what it has to give the app, and in what order it is built.

Frame as everywhere: cm, **tail at x = 0**, nose toward +x.

## Why the order changed

The plan had the app switch to the new kernel while boards were still stored as sections,
converting on every build. Converting takes one to two seconds (fitting rails, placing keys),
so every edit would lag by that much, and the code that made it tolerable would be thrown away
one step later. The end state is the same; the order is now:

|     | Step                                                                                                                                                       | Gate                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | **The rails engine, native.** A rails board in memory, built with no old surface behind it; mesh, section, half width and apex line from it; the converter | Every board, converted and built natively: closed; 1 mm except tips against today's engine; volume within 1%; build and mesh in 30 ms at view quality |
| 4   | **STEP** for a rails board: two trimmed faces and the strips                                                                                               | OCCT reads one valid closed solid                                                                                                                     |
| 5   | **The document and the swap.** `model: 'rails'` in the document, conversion once on open, the app's seam dispatching on the model                          | The app's own suites; every export still works                                                                                                        |
| 6   | **Rails editing**                                                                                                                                          | `trim-blend-workflow.md`                                                                                                                              |
| 7   | **Remove** the chord frame, the notch zone and the caps                                                                                                    | Nothing imports them                                                                                                                                  |

STEP moves ahead of the swap so that no export is lost when the app changes engine.

## What the app asks of an engine

Only `apps/web/src/workers/nurbs-core.ts` calls the engine at run time. The store and the
other packages import types; the store is handed the half-width function.

| Need                    | Today                                                  | What the app reads                                                                                                                   | The rails engine offers                                                                     |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Build                   | `buildBoard(doc, { check, spanHint })`                 | `doc`, `xiMin`, `xiMax`, `report.{stationFitError, clampedControls, blendOvershoot}`, `report.sectionSpans[0]`                       | `buildRails(board, { check })`: issues, `xiMin`, `xiMax`, the board, the same report fields |
| Mesh                    | `meshBoard(built, { curvature, ladders, maxEdge })`    | `positions`, `normals`, `indices`, `vertexCount`, `k1`, `k2`, `volume`, `planArea`, `surfaceArea`, `ladders` (an opaque reuse token) | `meshRails(built, { tolerance, maxEdge, curvature, draft })` with the same fields           |
| Section at a station    | `probeSection(built, ev, side, x, n)`                  | `n` points from the bottom centre over the apex to the deck centre: distance from the stringer, height above the rocker              | `probeRails(built, side, x, n)`, same framing                                               |
| Half width at a station | `createChordFn(doc, side)`                             | Scales a normalised section to physical units; fits features                                                                         | `halfWidthRails(board, side)`: the width the loft normalises by, with a notch filled in     |
| Apex line, plan point   | `createEvaluator`, `ev.row`, `ev.eval(0.5)` (DXF, PDF) | The outline point and the apex height at a station                                                                                   | `apexRails(built, side, x)`                                                                 |
| STEP                    | `boardStep`                                            | Text                                                                                                                                 | Step 4                                                                                      |

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

No way of running the curves reproduces today's surface from the stored stations alone. So
the converter does for panels what it does for rails: it adds a station where the loft
misses. To a loft bar of 0.4 mm, checked every 2.5 cm, that is ten stations a side on the
Diamond Twin's deck (4.59 mm to 0.24 mm), eight on the hyptocrypto's, three on the MLC's
bottom, and none to three on most boards; 14 to 270 ms a board. Tip stations are kept and
read in normalised coordinates: dropping them made the swallow's deck 1.37 mm worse.

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

| File                 | What it holds                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `board.ts`           | The types: `RailsBoard`, `RailsStation`, `StationCurves`, `RailKey`, `RailsCorners`                                                |
| `along.ts`           | The blend along the board: the quintic through stations, as `sections.ts` blends a control point                                   |
| `loft.ts`            | The panels: `buildLoft`, `loftPanels`, the stringer tables                                                                         |
| `keys.ts`            | Rail keys to laws: `railsAlong`, `lawsFromKeys` (out of the bridge)                                                                |
| `outline.ts`         | The outline to a loop definition with its radii, and the half width with a notch filled in (out of the bridge)                     |
| `relief.ts`          | Bottom features as a relief                                                                                                        |
| `native.ts`          | `BuiltRails`, `buildRails`, `meshRails`                                                                                            |
| `curvature.ts`       | Principal curvatures at the mesh's vertices, from its exact normals                                                                |
| `probe.ts`           | `probeRails`, `apexRails`, `halfWidthRails`: the lofted panels to the band edge, then the rail built in the section's plane        |
| `fit-chain.ts`       | A sampled curve to a chain, within a tolerance                                                                                     |
| `sections-reader.ts` | A sections board's section at any x, from the section blend alone (no surface, no frame)                                           |
| `convert.ts`         | `convertSections`: a built sections board to a rails board, adding a station where the loft misses and a key where the rail misses |

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
  readonly report: BuildReport;
}
export function buildRails(
  board: RailsBoard,
  opts?: { check?: boolean; previous?: BuiltRails },
): Board2Result<BuiltRails>;
export function meshRails(built: BuiltRails, opts?: MeshOptions & { draft?: boolean }): RailsMesh;
export function probeRails(built: BuiltRails, side: 0 | 1, x: number, samples: number): number[];
export function apexRails(built: BuiltRails, side: 0 | 1, x: number): { y: number; z: number };
export function halfWidthRails(board: RailsBoard, side?: 'minus'): ChordFn;
export function convertSections(
  built: BuiltBoard,
  opts?: { loftBar?: number; railBar?: number; most?: number },
): Board2Result<{
  board: RailsBoard;
  report: { addedStations: number; addedKeys: number; worstGap: number };
}>;
```

**Converting.** Read the source with its features off, a notched board through its notch-free
twin and its loop from its own outline. At every station, tips included, read the two halves
from the section blend, find the band edge (`sectionRail`; a tip station borrows the nearest
usable station's band share), cut the panel there as `panelCurve` does and fit a chain. Put a
rail key at each usable station. Then, every 4 cm away from the tips, measure the loft's gap
to the source's panel and the rail's gap (`recipeGap`): over the loft bar, add a station and
a key; otherwise over the rail bar, add a key; worst first, until nothing is over a bar. The
bars are options: how faithful a conversion is to the old surface between stations is the
caller's choice.

## How it is proved

`native.measure.test.ts`, on demand like the bridge's: each board with its features off goes
through `convertSections`, `buildRails` and the kernel mesh, and is sliced and measured
against today's engine at the same 41 stations with the same tip rule and bar. It reports the
stations and keys added, the time to build and mesh, and, not gated, the gap with features on.

Unit tests: the blend along the board equals `sections.ts`'s; the loft passes through its
station curves, is held beyond the end stations, is C1 across the stringer, and its gradient
matches a finite difference; the loop and laws equal the bridge's; the half width equals
`createChordFn` on a standard board; a channel reaching the band edge leaves the rail where it
was and the mesh closed; the section probe is within 0.2 mm of a slice away from the tips; the
fast panel path builds the same mesh as the slow one; a timing test.

## Order of building

| Group | Tasks                                                                                                | Needs |
| ----- | ---------------------------------------------------------------------------------------------------- | ----- |
| A     | `along.ts`, `loft.ts` with the stringer tables and the combined height-and-gradient call             |       |
| B     | `board.ts`, `keys.ts`, `outline.ts`: the types, and the bridge's laws and loop moved into the engine |       |
| C     | `solid.ts` faster: the combined call, no thickening where thick, typed arrays, a loop spacing option |       |
| D     | `fit-chain.ts`, `sections-reader.ts`, `convert.ts` with placement                                    | A, B  |
| E     | `relief.ts` and the kernel's use of it; `native.ts`, `meshRails`, `curvature.ts`                     | A–C   |
| F     | `probe.ts`; `native.measure.test.ts`; the plan's "As built"                                          | D, E  |

## Decided

- Stations the converter adds are ordinary stations; the conversion reports how many.
- Principal curvatures for the curvature view come from the mesh's exact normals.
- `railFade` is not read by this engine: features fade along the tuck.
- Station curves are stored normalised, as a `Section` is.
- Rail keys are placed along x, per side.
- A section probed inside a notch's lobes is the lobe, as one polyline, flagged.

## Open, for the project owner

**How faithful a conversion should be between stations.** The 1 mm bar was set against the
old surface everywhere. Between stations the old surface is one interpolation of the
designer's stations and the new one is another; neither is the design. Holding the new one to
the old within 1 mm costs added stations (up to ten a side on a board with three) and added
rail keys. The alternative keeps a board's own stations and lets the new engine run between
them, at up to 4.6 mm from the old surface on a board with few stations and 0.4 mm or less on
most. The converter takes the bars as options, and step 3 measures both.
