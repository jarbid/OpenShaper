# STEP export

Status: **shipped**. `Export ▸ STEP (surfaces)` writes an ISO 10303-21 (Part 21)
file describing the board as a solid bounded by true B-spline surfaces.
Code: `packages/kernel/src/bspline-surface.ts`,
`packages/kernel/src/board-surface.ts`, `packages/export/src/step.ts`.

## Why

Roadmap 7.2. Everything we could export before was either a mesh (STL) or 2D
curves (DXF). A mesh is not a surface: a CAD system sees a few hundred thousand
flat triangles, so it cannot offset the body for a hot-wire allowance, shell it
for a hollow build, or run a clean finishing toolpath. STEP is the open format
that carries the actual curved surfaces, so it is the wedge against being locked
into Shape3D or AKU.

**Correction to the roadmap's premise.** `docs/ROADMAP.md` used to say legacy
BoardCAD shipped STEP and we dropped it. It did not — `docs/specs/ASSESSMENT.md`
lists domain I (Export) exhaustively as `DxfExport`, `StlExport`, `GCodeDraw` and
a dead `PdfDraw`. This is new work, not a port, so the golden-data rule's porting
phase does not apply and correctness rests on analytic oracles instead.

## Shape of the file

```
ADVANCED_BREP_SHAPE_REPRESENTATION → MANIFOLD_SOLID_BREP → CLOSED_SHELL
  ADVANCED_FACE  hull +Y   ← B_SPLINE_SURFACE_WITH_KNOTS (deg 3,3)
  ADVANCED_FACE  hull −Y   ← the same net mirrored
  ADVANCED_FACE  end cap   ← PLANE
  ADVANCED_FACE  end cap   ← PLANE
```

Six `EDGE_CURVE`s, four `VERTEX_POINT`s. Schema is AP214 (`AUTOMOTIVE_DESIGN`):
strict AP203 requires a config-control chain of about twenty ceremony entities
that add nothing here, while AP214 is what OCC and FreeCAD emit by default and is
therefore the best-tested import path.

`MANIFOLD_SOLID_BREP` rather than an open shell because a
`SHELL_BASED_SURFACE_MODEL` imports as a surface body — no volume, and no
shell/offset without a manual stitch, which defeats the purpose.

Two hull patches rather than one V-closed patch: a V-bottom is a genuine crease at
the stringer and two faces represent it honestly, and the −Y half carries no new
information so the fit runs once and is mirrored.

### What makes it watertight

Not tolerance. Two exact properties:

- the seam control columns are exactly `y = 0` (the kernel snaps them), so the
  writer's coordinate-keyed `CARTESIAN_POINT` cache resolves both patches' seam
  to the same entity ids;
- a clamped B-spline surface's boundary **is** the B-spline curve over its
  boundary control row with the same knot vector, so each `EDGE_CURVE` references
  the surface's own points.

That is also why there are no `PCURVE`s: `EDGE_CURVE` accepts a plain 3D curve and
the edges lie on the surface exactly, not within tolerance. If an importer ever
objects, wrap the edge geometry in `SURFACE_CURVE` with a 2-D
`B_SPLINE_CURVE_WITH_KNOTS` pcurve — the parameter-space edges are the sides of
the unit rectangle.

### Orientation

Measured, never assumed. A wrong `same_sense` or loop direction produces a file
that parses, imports and looks plausible while being inside-out. The rule is easy
to get wrong: **mirroring flips handedness, so the two hull patches take opposite
`same_sense` flags.** The writer samples the real surface normal and the real loop
winding; `step.test.ts` re-derives both from the emitted text and checks every
face points away from the solid.

## Fitting

Global interpolation, Piegl & Tiller A9.1/A9.4. Three properties of the board made
it harder than a textbook skin.

**Creases.** `loftSection` blends adjacent stations with a weight that is
piecewise linear in x, so the hull has a tangent break at every cross-section. A
single smooth bicubic would round those off and the STEP solid would be a
different board than the STL. Each strip between stations is fitted independently
and the pieces concatenated, landing an interior knot of multiplicity 3 at each
station: C0 there, C∞ elsewhere. The join is exact — both strips are clamped to
the same data row, so their shared control point is the same number.

**The `MIN_DIM` floor.** `loftSection` floors width and thickness at 0.5 cm, so at
a pointed tip it reports a 5 mm ring where the board has none. An interpolating
fit passes through that bad point exactly, and density cannot repair it (measured:
2.9 mm out at the golden longboard's nose, unmoved by tripling the rows). The fit
therefore spans only the region where the floor does not bite, which costs 30 µm
of length on the golden boards, and the cap closes it there.

**Tips.** The nose and tail turn through ninety degrees of outline in a couple of
centimetres while the middle is nearly ruled, so no single density serves both.
Rows cluster quadratically into a pointed tip, then the fit subdivides against a
measured deviation until it is inside tolerance.

Refinement is **not monotone**: subdividing only the failing intervals makes the
chord parameterization sharply non-uniform, and a cubic conditions badly across
that, so a later pass can be worse than an earlier one (0.0103 → 0.0221 cm on the
shortboard). Grading the subdivision did not fix it. The fit keeps the best pass
rather than the last, which makes the result at least as good as the base density
by construction.

## Numbers

Measured on the golden boards (Node 22), against the exporter it sits beside:

| board      | STEP   | time  | STL     | time  | deviation |
| ---------- | ------ | ----- | ------- | ----- | --------- |
| shortboard | 666 KB | 0.5 s | 30.4 MB | 0.9 s | 0.0032 cm |
| funboard   | 882 KB | 0.9 s | 43.2 MB | 1.2 s | 0.0040 cm |
| longboard  | 986 KB | 0.7 s | 54.8 MB | 1.7 s | 0.0121 cm |

Around fifty times smaller, and faster than the STL export already running
synchronously on the main thread — which is why STEP stays synchronous too.
Principle 4 (UI never blocks) is still owed a shared
`packages/export/src/export.worker.ts` covering STL + DXF + STEP together,
following `render3d`'s `tessellate.worker.ts`; the case for it is now driven by
STL, not STEP.

### Tolerance

The fit targets 0.005 cm and is held in CI to **0.015 cm**, measured
independently of the refiner's own metric. Derivation:

- **Physical ceiling.** A CNC blank cutter finishes at 0.1–0.5 mm, hand sanding
  removes at least 1 mm, and EPS/PU blank stock varies by ±1 mm. 0.15 mm is at the
  finest of those and 7× below the rest.
- **Numerical floor.** The lofted surface is itself only defined to about 5 µm:
  `pointAtArcFraction` interpolates linearly between `ARC_TABLE_SAMPLES = 64`
  samples per Bézier segment, so its chord error is (h²/8)·κ — roughly 4e-4 cm on
  a 2 cm rail-apex segment at κ = 3.3 /cm. No fit can beat that.

What remains at 0.15 mm is confined to the last centimetre of a pointed tip.

`BoardSurfaceModel.deviation` is a **sampled estimate, not a bound** — the refiner
probes a coarser grid than the tests do and reads about 3× optimistic on the
funboard.

### The dialog

`Export ▸ STEP (surfaces)…` opens `ExportStepDialog` with exactly two controls,
persisted under `bs.step`:

- **Units** — `auto` (follow the editor's selector) or an explicit mm/cm/in. The
  file declares its own unit, so this is cosmetic: an importer lands the board at
  the right size whatever it says. Worth exposing anyway, because the numbers
  inside the file are what someone reads when debugging a CAM setup.
- **Accuracy** — draft 0.02 cm / standard 0.005 cm / fine 0.002 cm, mapped by
  `STEP_TOLERANCE_CM` onto the fit's `tolerance`.

Station rows and ring columns are deliberately **not** exposed. They are means to
the accuracy end, and surfacing them would ask a shaper to reason about B-spline
control nets to get a board out. Accuracy is the one knob they can judge against
something real — a blank cutter's finishing pass.

Note that even `draft` is finer than that finishing pass, so the control mostly
exists to let someone shrink a longboard file; there is rarely a reason to move
off `standard`.

## Not included, on purpose

- **Fins.** Including them means either fitting foiled blade surfaces (a second,
  harder problem with leading- and trailing-edge degeneracies) or emitting them
  faceted, which contradicts the whole point of the format. The STEP file is the
  blank surface a machine cuts; box and plug footprints are already at true scale
  and position on the DXF's `FINS` layer, which is where a shaper uses them.
- **Concave (swallow / fish) tails.** A different topology — two pods joined by a
  notch wall, nine faces rather than four. `stepExportSupport` reports this and the
  menu item is disabled with the reason, because a wrong board that imports
  cleanly is worse than no file. This is the obvious next increment.
- **Pointed tips carry a sub-millimetre flat**, from the `MIN_DIM` trim above. The
  mesh instead fans such an end to a true apex, so the two differ over the last few
  millimetres of a tip — inside the kernel's own floor — in exchange for a cap face
  every importer accepts.

## What CI cannot prove

The test suite checks the file against our intent: structure, reference
integrity, real-literal legality, knot counts, topology counts, unit scaling,
determinism, and a schema-free Part 21 decoder that reads the file back and
compares the reconstructed surface to the loft. It cannot check that the file
_opens usefully_.

Run this by hand before merging any change to the entity graph, for **Fusion 360,
Rhino, SolidWorks and FreeCAD** × **shortboard, longboard, and a board with an
`80-20-hard` rail**:

1. Imports with no error or repair dialog.
2. Appears as **one solid body**; measured volume within 1% of the spec panel.
3. Length, max width and max thickness match the spec panel to ≤ 1 mm.
4. `Offset` / `Shell` by 3 mm succeeds without failing faces.
5. Zebra or curvature analysis shows C0 bands **at station positions only** —
   bands anywhere else mean the fit is wrong.
6. The tail cap is a planar face of the right width, not a point.
7. A 3-axis parallel finishing toolpath generates on the deck.

Record results (app name + version) below when the pass is run.

| date       | app                    | board                           | result                          |
| ---------- | ---------------------- | ------------------------------- | ------------------------------- |
| 2026-08-14 | Autodesk online viewer | shortboard, funboard, longboard | Imports and displays correctly. |
| 2026-08-14 | Rhino 8                | shortboard, funboard, longboard | Extensive testing, no problems. |

Still unexercised: SolidWorks and FreeCAD, and the `80-20-hard` rail board (whose
profile crease is the case most likely to expose a v-direction fitting problem).
Rhino accepting the solid does settle the two things most likely to be wrong —
that it arrives as one closed solid rather than loose faces, and that it is not
inside-out — so the no-`PCURVE` decision and the per-patch `same_sense` derivation
are both confirmed against a real kernel.
