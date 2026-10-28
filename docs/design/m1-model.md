# M1 design note: the section-based model

Status: **M1 design**, under `nurbs-plan.md` (which wins on any conflict). Frame as everywhere: cm,
**tail at x = 0**, nose toward +x, y across, z up.

## 1. Document (`.board.json`, NURBS model)

The plan's "v2": on disk `format: 'openshaper', version: 3, model: 'sections'`, because classic
`.board.json` already uses version 2. Plain JSON, no derived data.

| Field                   | Content                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symmetry`              | `'mirror'` or `'asymmetric'`.                                                                                                                                                                                         |
| `outline`               | `{ plus, minus? }`: half-outlines as **Bézier chains** (classic knots: `p`, `in`, `out`, `smooth`), both stored with y ≥ 0; `minus` only when asymmetric. Each runs from a stringer point (y = 0) to the nose (L, 0). |
| `tail`                  | `{ kind: 'standard' }` or `{ kind: 'notched', zone }`. Standard: the chain starts at (0, 0). Notched (swallow, fish): it starts at the notch bottom (d, 0), its tips at x = 0. Stored, never detected.                |
| `rocker`, `deck`        | Bézier chains z(x) on the stringer over [0, L]; thickness T(x) = deck − rocker. Shared by both sides.                                                                                                                 |
| `stations[]`            | `{ id, x, plus, minus? }`: `x` is the **stringer coordinate ξ** (§2), so both sides and classic positions share it.                                                                                                   |
| section                 | A Bézier chain in the normalised frame (u, v) plus `apex` (knot index).                                                                                                                                               |
| `features[]`            | board2's `vee`, `concave`, `channels` with their keyed depth over x, unchanged.                                                                                                                                       |
| `meta`, `fins`, `build` | Name and source; classic fin config passed through; build settings (tolerance 0.05 cm, feature rail fade).                                                                                                            |

**Normalised section.** u ∈ [0, 1] runs along the station's chord from the stringer (u = 0) to the
outline point (u = 1). v is height over the rocker in units of the thickness at the point's own x. The
chain runs from bottom centre to deck centre. The Phase 0 rules become exact equalities and bounds,
checked by the validator: the centre knots are fixed at (0, 0) and (0, 1) (their handles are free
since step 4, see §11: horizontal means G1 across the stringer, a V bottom or pitched deck is a
crease along it); the apex knot has u = 1 and moves in v only; **every control point has
0 ≤ u ≤ 1**. By the convex hull property, no section can then pass the outline or
the stringer. The rocker and deck are pinned at u = 0, so a section cannot change outline, rocker or
deck.

## 2. Surface construction (one code path)

Each side is `S(ξ, t) = frame(ξ, section(ξ, t))`: standard, notched, mirror and asymmetric boards all
run through this function. The minus side is called with its own outline and sections, and y is
negated.

- **Chord frame.** At station coordinate ξ, the chord runs from the stringer point C = (ξ, 0) to an
  outline point P(ξ). Plan point = C + u·(P − C); z = rocker(x) + T(x)·v, where x is the plan point's
  own x. P(ξ) is the outline point at x = ξ. Inside the notch zone [d, d + zone], P(ξ) = O(p(ξ))
  instead: a quintic Hermite map of the outline parameter that starts at the notch bottom and joins
  the x = ξ branch with C2 at d + zone. Chords therefore fan from the short stringer segment across
  the inner wall, the tip and the rear outer rail: in the notch, **sections run across the rail**,
  and the inner wall gets a real rail. A standard board has d = zone = 0, which gives plain
  x-planes, exactly classic. The validator checks that p′ > 0 (chords never cross) and that every
  chord crosses the outline at ≥ 20°.
- **Tips.** At a pointed end the chord length goes to 0, so the section collapses to the true point
  or vertical edge. There is no `MIN_DIM` floor. An end with real width (a transom) is closed by a
  planar cap: the end section, filled. ∂S/∂ξ is singular at pointed tips; normals there use the
  limit, and curvature is flagged undefined there, as the V1 viewer already does.
- **Smooth blend.** Each side's station chains are resampled by arc-length fraction, separately on
  each half: bottom → apex and apex → deck. Arc-length fraction is the correspondence `loft.ts`
  proved pinch-free. The samples are fitted with `approximateCurve` onto **one common cubic knot
  vector per side**: single knots except a triple knot at t = ½ (the apex). The fit is refined until
  every station is within 0.01 cm, clamps any fitted control that lands outside the bounds, and is
  cached per section. Each control coordinate is then interpolated along ξ with `interpolateCurve`
  (cubic, parameter ξ, zero end slopes, held constant beyond the end stations).
  - The result is **C2 along the board**, C2 around the section except G1 at the apex, and exact at
    the stations to within the fit. The remaining joins are those of the outline, rocker and deck
    chains themselves.
  - If the interpolation pushes a blended control past a bound, it is clamped at evaluation and
    reported as an issue.
- **Features.** board2's closed forms (`featureDisplacement`, `bump`, `veeProfile`), with η = u.
  They apply to the bottom half only, faded to zero over the rail by a C2 fade, so the apex and the
  deck never move.
- **geom used.** `makeCurve`/`bezierCurve` for chains, `curveEvalInto` and `curveDerivatives`,
  `approximateCurve`, `interpolateCurve`, `arcLengthTable` and `paramAtLength`. Curvature comes from
  the existing `surfaceMeasureAt` kernel, newly exported (a one-line export, no new geometry).
- **Evaluator.** It returns S and its first and second partials in (ξ, t) by a hand-written chain
  rule. Normals and principal curvatures are therefore exact to the surface.

## 3. Fast live mesh

- **Grid.** A regular grid of rows (ξ) × columns (t) per side. There is no trimming and no B-rep.
  - Both halves evaluate u = 0 with the same code, so the stringer seam is bitwise shared.
  - Caps and the degenerate rows at the tips and the notch bottom are welded, so the mesh is closed
    and volume comes from the divergence theorem (about 1 %). Plan area comes from the outline.
- **0.5 mm.** The row and column ladders are refined until each midpoint between two neighbours is
  within 0.05 cm of their chord. Rows are first spaced by outline arc length, which densifies the
  tips and the notch fan; columns are graded by section curvature across all stations. Expected
  size: 10–25 k vertices on a shortboard.
  - While dragging, the last ladders are reused and only re-derived when the edit settles.
  - The viewport face size only caps edge length; the 0.5 mm bound always holds.
- **Where it runs.** In the existing NURBS worker, latest request wins and stale answers are
  dropped, with the synchronous fallback for tests. Buffers are transferred. Curvature arrays are
  computed with the mesh while their mode is shown, and otherwise on settle.
- **Viewer changes.** `nurbs-core.ts` switches to the direct converter and `meshBoard`.
  - Removed: `tessellateBrep`, `tessellationFor`, held models, `remesh` from held state.
  - The viewer drops the 1.2 s debounce and the "not while dragging" gate, and updates on every
    board change.
  - The protocol accepts either a classic board or a NURBS doc. The summary reports station fit
    error and bound clamps. Timings are convert, build and mesh.
  - A small test-board picker in the NURBS panel loads swallow, fish and asymmetric boards.
  - Curvature, zebra and deviation-from-classic modes keep their code.

**Targets (laptop browser):** classic open + convert + first mesh < 1 s, engine switch the same, and
every rebuild during a drag < 50 ms end to end. Only export may take seconds.

## 4. Direct classic converter (`@openshaper/board2/classic`, < 50 ms)

- **Copied exactly:** the outline into `outline.plus`, and the classic bottom and deck into `rocker`
  and `deck`. Classic notched outlines already start at the notch bottom, which sets the tail kind.
- **Normalised:** each real slice (the dummy end slices are dropped). The chain is split at its
  widest point (exact de Casteljau split, which becomes the apex knot), then x is divided by the
  half-width and y by the centre thickness. A slice at x behind the notch zone maps to the ξ whose
  chord ends at that outer-rail x.
- **Deviation:**
  - The outline, rocker and deck lines are exact. Stations are within 0.01 cm.
  - Between stations, the smooth blend **differs from classic's linear blend by design**. It will be
    measured per golden and recorded in `docs/specs/divergences.md`; expected ≤ 1–2 mm.
  - Tips differ by up to `MIN_DIM`/2, because classic's 5 mm flat is gone.
  - Classic notch pods (which have a vertical inner wall) are reshaped with a real inner rail. They
    are not within 0.5 mm, and this is reported.

**What the user should see improve:**

- zebra stripes run unbroken across station positions;
- the curvature modes show no bands at the stations;
- pointed tips come to a true point;
- swallow and fish pods have an inner rail.

V1 "looked exactly like classic" because S6/S7 fitted the creased classic surface.

## 5. board2: kept, deleted, layout

- **Deleted:**
  - `band/`, `law.ts` except the keyed-curve evaluator (moved into `features.ts`), `offsets.ts`,
    `height-field.ts`, `plan.ts`, `symmetry.ts`, `brep.ts` (M3 builds a new B-rep), `params.ts`;
  - all of `classic/` (S6/S7);
  - the feature tensor fit (`tensorLeastSquares`, `bottomWithFeatures`);
  - `testing/stadium`, `notched` and `off-knot`.
- **Kept:**
  - `issues.ts`, `freeze.ts`;
  - the features' closed forms and `featureIssues` (adapted to u);
  - the doc, validate and types modules, rewritten.
- **Layout:** `@openshaper/board2`, with `chain.ts`, `frame.ts`, `sections.ts`, `surface.ts` and
  `mesh.ts`. Entries: `.` (doc, validate, `buildBoard` → evaluator, `meshBoard`), `./classic`
  (converter; the only part importing kernel) and `./testing` (swallow, fish and asymmetric boards).
  The ESLint import boundary is unchanged.

## 6. Steps (one implementation session each)

1. **Model and evaluator.** Delete the retired code; add the doc, validator, chains, chord frame,
   section fit and blend, features and the evaluator with second derivatives; add test boards
   (swallow, fish, asymmetric, plus an analytic stadium with one constant section).
   - _Check:_ the u = 0 and u = 1 lines lie on the rocker, deck and outline within 1e-9 for every ξ,
     including the notch zone.
   - _Check:_ at each station the evaluated section is within 0.01 cm of the stored one.
   - _Check:_ the analytic board matches its closed form.
   - _Check:_ derivatives agree with finite differences.
   - _Check:_ across every station the normal jump is < 1e-5 rad and the curvature jump < 1 %.
   - _Check:_ the validator refuses each Phase 0 or notch-zone violation with its own code, and the
     JSON round-trips exactly.
2. **Grid mesh and direct converter.** Add `meshBoard` and `classic/convert.ts`, and the divergence
   entry.
   - _Check:_ on the three goldens and three test boards, triangle centres and edge midpoints are
     within 0.05 cm of the surface, and every edge is shared by two triangles.
   - _Check:_ volume is within 1 % of a 0.005 cm reference mesh.
   - _Check:_ converted goldens match classic within 0.05 cm at the stations and lines, and the
     report records the between-station deviation.
   - _Check (crease):_ the normal-angle jump across each station on the converted goldens is at
     least 100× smaller than the classic loft's (`loftRing`), measured the same way.
   - _Check (timing, Node, shortboard, median of 20):_ convert ≤ 50 ms; build + mesh ≤ 15 ms, or
     ≤ 30 ms with curvature.
3. **Viewer.** Rewire `nurbs-core`, the protocol and the viewer as in §3, and add the test-board
   picker.
   - _Check:_ the web Vitest suites for core and viewer pass, with the debounce gone and stale
     answers dropped; lint, typecheck and build pass.
   - _Preview:_ opening a golden and switching the engine shows the NURBS hull in < 1 s.
   - _Preview:_ dragging a classic point updates it live; the timings readout shows < 50 ms per
     update.
   - _Preview:_ zebra and curvature are seamless across the stations next to the classic view.
   - _Preview:_ the swallow, fish and asymmetric boards display with every analysis mode.

## 7. Open risks

- Classic slices with hard corner knots need dense knots in the common fit. That means more
  columns, or a 0.01 cm miss.
- The C2 interpolation can overshoot a bound between very different stations. It is clamped and
  reported; if this happens often, switch to a shape-preserving C1 blend.
- Users will see a between-station difference from classic (by design). The deviation mode shows
  it, and §4 sizes it.
- In deep fish notches, the zone ramp's monotonicity and the sliver cells near the stringer are
  unproven until the test boards run.
- The browser timing of the second-derivative evaluator and worker transfer is unproven. The
  fallback is curvature on settle only.
- Curvature lines at the outline, rocker and deck chain knots (G1 joins) remain. They are inherent
  to the input curves and are not station creases.

## 8. As built (step 1)

Landed in `packages/board2` (`chain.ts`, `bspline.ts`, `frame.ts`, `sections.ts`, `features.ts`,
`surface.ts`, `validate.ts`, `doc.ts`, `params.ts`, `testing/`), with the rail-law model, the B-rep,
the S6/S7 converter and their tests deleted. Deviations from the design above, and what step 2 must know:

- **Blend.** The interpolation along ξ is the complete cubic spline with its breakpoints _at the
  stations_ (zero end slopes, a tridiagonal solve for all coordinates at once, `blendAt`), not geom's
  `interpolateCurve` (averaged knots, at most three coordinates per call). It is still exact at the
  stations and C2 at every interior one. At an end station that lies inside the board the curvature
  jumps (the section is held constant beyond it): put the end stations at the board's ends. The first
  derivative is 0 at both ends.
- **Fit.** Each half is fitted separately by `approximateCurve` on `m` equal spans with explicit
  arc-length-fraction parameters (192 samples per half), then the halves are joined (same space as one
  curve with a triple knot at ½). Held exactly: both centre points and horizontal tangents, the apex
  point, and a vertical apex tangent only when the stored apex handles are both at u = 1. The ladder is
  12, 16, 24, 32, 48 spans per half; a rung is accepted when `error × max(chord length, thickness)` at
  every station is within 0.01 cm (conservative: the error is in normalised units). A miss is the
  `section-fit` warning. Fits are cached per `Section` object, so an edit that keeps the other
  sections' identity refits one section; `reviveBoardDoc` makes fresh objects, so revive only at load.
- **Chains** store absolute handle positions (`{ p, in, out, smooth }`), parameter `s` ∈ [0, knots − 1].
  The first knot's `in` and the last knot's `out` are unused.
- **Notch map.** The start slope of the quintic map is chosen from the wall: it asks for chords that
  cross the wall at twice the 20° minimum near the notch bottom, capped at the mean slope
  (`frame.ts`). Consequently a notch whose inner wall leaves the stringer at less than about 30°, or a
  very short zone, fails `notch-chord-angle`; that is the validator doing its job. A notched board's
  stations lie in [d, L] (nothing exists at ξ < d), and a station at ξ = d is the collapsed notch-bottom
  edge.
- **Features.** The depth is read at ξ. Channels measure their distance from the outline along the chord
  (ℓ, with exact ℓ′ and ℓ″). The fade is a quintic in t over the last `railFade` share of the bottom
  half, so a vee also returns to zero at the apex.
- **Issue codes.** `chain-too-short`, `station-id`, `symmetry-fields`, `outline-endpoints`,
  `tail-start`, `outline-not-function`, `notch-zone`, `notch-tip`, `notch-chords-cross`,
  `notch-chord-angle`, `line-domain`, `line-not-function`, `thickness`, `section-*` (five), `feature-invalid`,
  `build-invalid`; warnings `section-fit` and `blend-overshoot` (reported above 0.01 cm; the overshoot
  is clamped at evaluation, the clamp zeroing the control's ξ-derivatives).
- **API.** `buildBoard(doc, { check? })` returns `BuiltBoard`; `createEvaluator(built)` returns the
  allocation-free `row` / `eval` / `at` / `measure` (layout of a point: S, S*ξ, S_t, S*ξξ, S_ξt, S_tt,
  stride 3, geom's `SKL` order). `MEASURE` gives the offsets of `measure`'s output (outward unit normal,
  k1 ≥ k2, H, K, convex positive). Derivatives at the section's apex breakpoint (t = ½) are right-hand;
  pass `left` for the left-hand ones. At a vertical outline end (blunt nose or tail) dx/ds is floored at
  `TIP_SLOPE_FLOOR`, so ∂S/∂ξ stays finite there (and the normal is flagged degenerate at true tips).
- **geom.** Only `surfaceMeasureAt` was exported (the `MEASURE_*` offsets are repeated in `surface.ts`).
- **Viewer.** `apps/web/src/workers/nurbs-core.ts` is a marked "not yet wired (M1 step 3)" stub: every
  job answers with an error outcome; its golden-conversion test is deleted. The e2e and perf scripts
  that expect a mesh (`e2e/nurbs-viewer.spec.ts`, `tools/perf/nurbs-timing.mjs`) are not updated.
- **Root.** `test:occt` no longer includes board2 (no OCCT suite until M3).

Measured (Node, laptop container): the u = 0 / u = 1 lines are within 1e-13 of the rocker, deck and
outline; station fit errors 0.002 to 0.008 cm (limit 0.01); across interior stations the normal jump
is below 1e-7 rad and the relative curvature jump below 2e-6. A grid of 20,000 points costs 5 to 10 ms
at any derivative order, 17 ms with `measure` (normal and curvatures). `buildBoard` is 1 to 4 ms with
the section fits cached, 27 ms (8 sections) to 45 ms (14 sections) cold: about 3.5 ms per section per
ladder rung, which is the cost of the first build after a conversion. Step 2's budget (build + mesh
≤ 15 ms, ≤ 30 ms with curvature) therefore holds with warm fits; the first build after convert is in the
convert-plus-first-mesh budget of < 1 s. Blend overshoot of a few hundredths of a cm occurs near the
apex plateau when stations differ (0.007 to 0.03 cm on the test boards).

## 9. As built (step 2)

Landed in `packages/board2`: `mesh.ts` (`meshBoard`, `deriveLadders`, `meshProperties`, `meshVertex`),
`classic/convert.ts` (`convertClassic`, the `./classic` entry), `test-support/` (sample loaders and the
mesh checks), `perf.bench.ts` (`pnpm --filter @openshaper/board2 bench`) and `timing.test.ts`. Deviations
from the design above, and what step 3 must know:

- **API.** `buildBoard(doc)` then `meshBoard(built, { tolerance?, maxEdge?, curvature?, ladders? })`
  returns `{ positions: Float32Array (xyz), normals: Float32Array (unit, outward), k1?, k2?
(Float32Array, convex positive, k1 >= k2), indices: Uint32Array (counter-clockwise from outside),
vertexCount, triangleCount, layout, ladders, volume, planArea, surfaceArea }`. `deriveLadders(built)` is
  the costly part (about 60 % of a fresh mesh); pass `mesh.ladders` back as `ladders` to re-mesh an edited
  board without it (drag), and re-derive when the edit settles. Buffers are plain typed arrays and can be
  transferred. `meshVertex(layout, side, i, j)` gives the vertex of grid node (row i, column j) on side 0
  (plus) or 1 (minus): the plus grid first (`i * cols + j`), then the minus interior columns; columns 0 and
  last are shared by both sides, and a collapsed end row (pointed tail, nose or notch bottom) is welded.
  Volume is the divergence theorem about the box centre, plan area the projected upward-facing
  triangles, both from the triangles. `convertClassic(board, { name?, source? })` returns a
  `Board2Result<{ doc, report }>`: refusals carry the validator's issues or `convert-slice` /
  `convert-plan`, repairs a `convert-adjusted` warning; it never throws.
- **Criterion.** A pair of neighbouring rows (columns) is split while the surface at their midpoint is
  further than `MESH_DEV_FRACTION` (0.4) of the tolerance from the chord between them (distance to the
  segment, so sliding along the surface costs nothing), or while a cell's twist `|a + d - b - c| / 4`
  exceeds `MESH_TWIST_FRACTION` (0.45): the diagonal of a long thin cell sits that far from the cell
  centre. Without the twist term a diagonal midpoint was 0.53 mm off on the longboard; with it the design
  bound is 0.85 of the tolerance. Columns are refined first on probe rows (stations, their midpoints, six
  uniform rows), then rows on the final columns (a stride of at most 64), then the columns are verified
  at the final rows (a feature's lateral track moves along the board, the asymmetric board's channels
  need it) and, if they grew, the rows are redone.
- **Normals** are exact (`S_t x S_xi`, or `measure` with curvature). At a collapsed end row they are the
  limit half a row into the board. On an asymmetric board a welded end row takes the plus side's
  positions (the minus section's z at the collapsed edge differs by up to 0.015 cm).
- **Converter.** Outline, rocker and deck are copied knot for knot; the deck's vertical end walls
  (tail and nose thickness) are dropped; handles whose x steps outside their segment are pulled back
  (golden noses: 0.0022 cm, reported as `lineAdjust`); y < 0 handles are clamped. A slice is split at its
  widest point (a tie, a vertical plateau, takes the middle candidate), x / half-width, y / thickness,
  centre handles made horizontal, and any segment with a control point beyond 0 <= u <= 1 is halved (up to
  six times, then clamped): the funboard and longboard add 6 knots. The result is cached per classic
  slice (`WeakMap` on the slice's spline), so an unchanged slice returns the same `Section` object (tested:
  an edit to one slice changes one section; an outline edit changes none). A repair of more than the build
  tolerance (0.05 cm) refuses the board with the reason; so does a deck that starts at the rocker (zero
  thickness at an end), a blunt tail (the outline must start on the stringer) and a slice whose bottom
  centre tangent is not horizontal. A classic outline with a cutout becomes `notched` with the shortest
  zone of `[1.5, 2, 3, 4, 6, 8, 12] x d` that validates (swallow 16.8 cm, fish 13.3 cm on the test
  outlines); a slice inside the zone is placed at the station whose chord meets the outer rail at its x.
  `xiOfParam` moved into `frame.ts` for this. No sample file has a notch, so the notched path is tested
  on the shortboard with the swallow and fish test outlines.
- **New issue codes:** `convert-slice`, `convert-plan`, `convert-adjusted` (warning). Test directory
  `test-support/` is exempt from the no-magic-tolerance scan like `testing/`.

Measured (Node, laptop container; `pnpm --filter @openshaper/board2 bench`, median of 20):

| Board (vertices)       | convert | first build | build + mesh, fresh ladders | reused ladders | curvature, fresh / reused |
| ---------------------- | ------- | ----------- | --------------------------- | -------------- | ------------------------- |
| shortboard (10.0 k)    | 0.6 ms  | 18 ms       | 0.1 + 10.1 ms               | 3.9 ms         | 14.7 / 7.5 ms             |
| funboard (11.3 k)      | 0.7 ms  | 22 ms       | 0.2 + 22.9 ms               | 7.2 ms         | 27.7 / 12.7 ms            |
| longboard (12.8 k)     | 0.6 ms  | 25 ms       | 0.1 + 22.3 ms               | 7.0 ms         | 27.1 / 12.7 ms            |
| classic swallow (20 k) | 0.5 ms  | 0.1 ms\*    | 0.1 + 39 ms                 | 13.5 ms        | 51 / 21.5 ms              |

(\*sections shared with the shortboard, already fitted.) The shortboard meets both budgets (build + mesh
fresh 10 ms <= 15, with curvature 15 ms <= 30); the larger boards meet them only with reused ladders.
The first build after a convert is the cold section fit (about 4 ms per section); the figures for opening
a file are therefore parse + convert + 18 to 25 ms + a fresh mesh, far under the 1 s target.

Acceptance (tests in `mesh.accept.test.ts`, `classic/convert.test.ts`): every triangle centre and
edge midpoint, the diagonals included (full check, all triangles), is within the 0.5 mm tolerance of the
surface: shortboard 0.22 / 0.24 mm (centre / edge midpoint), funboard 0.27 / 0.30, longboard 0.32 / 0.43,
swallow 0.31 / 0.37, fish 0.31 / 0.38, asymmetric 0.21 / 0.26. All six meshes are closed (every directed edge
once, its reverse once, Euler characteristic 2). Volume against a 0.005 cm reference mesh (5 to 20 x the
vertices): -0.17 %, -0.13 %, -0.13 %, -0.18 %, -0.19 %, -0.12 % (limit 1 %). Converted goldens against the
classic: sections at the stations within 0.01 to 0.19 mm (limit 0.5), outline, rocker and deck lines within
0.02 mm. Between the stations they differ by up to 4.7 (shortboard), 2.9 (funboard) and 5.0 mm
(longboard), mean 1.2 to 2.4 mm: more than the 1 to 2 mm expected in section 4, because real stations
are far apart and the cubic spline through them is not the linear blend; recorded in
`docs/specs/divergences.md`. Crease: the normal-angle jump across a station (finite differences at 1e-5 cm,
the same procedure on both surfaces) is 4e-8 to 5e-6 rad for the NURBS surface against 1.6e-3 to 2.9e-2
rad for the classic loft, 700 to 390,000 times smaller (the least favourable are the end stations next to
the tips, where the normal moves fastest). No crease elsewhere: the jump along the whole board, scanned
every 0.25 cm, is at most 5e-6 rad.

Conversion of the 14 sample files (11 distinct boards; three copies of each golden), each in under 1 ms:
shortboard (x3), funboard (x2), longboard (x2), `synthetic-degenerate-section`, `synthetic-stringer-fold-a`
and `-fold-b` convert; `synthetic-clean-6x22x2-75` and `synthetic-fallback-outline-5x10` are refused
(`thickness`: the deck meets the rocker at x = 0), `synthetic-rocker-absolute-deck` and
`synthetic-rocker-thickness-deck` are refused (`convert-slice`: the bottom centre handle rises 0.55 to
0.97 cm off the stringer, a V bottom the model cannot hold).

Open points for the lead. (1) **Blend overshoot is common on real boards**: the funboard (0.4 cm) and
longboard (1.4 cm, before clamping, in cm at the widest chord) trigger `blend-overshoot`, as does any board
with sparse, uneven stations; the clamp leaves no visible crease (jump <= 5e-6 rad) but the plan says to
consider a shape-preserving C1 blend if it is frequent. (2) Section fits report 0.017 to 0.047 cm on the
goldens (the conservative bound; the measured station deviation is under 0.2 mm). (3) A V bottom, a zero
thickness end and a blunt tail are refused; the first matters for real files.

## 10. As built (step 3)

Landed in `apps/web` (`workers/nurbs-core.ts`, `nurbs-protocol.ts`, `nurbs-worker.ts`, `nurbs-curvature.ts`,
`nurbs-client.ts`, `nurbs-viewer.ts`, `nurbs-surface.ts`, `nurbs-layer.tsx`, `nurbs-text.ts`) and a small
extension of `ExternalSurface` in `render3d`. Deviations from the design above, and what step 4 must know:

- **Job.** `convertAndMesh(classic, options)` is `convertClassic` → `buildBoard(doc, { check: false })` →
  `meshBoard(built, { curvature, ladders })`; `meshTestBoard(name, options)` does the same for swallow, fish,
  asymmetric and analytic (the board2 test boards, built with the validator on). The result is the transferred
  typed arrays (float32 positions and normals, uint32 indices, optional curvature and deviation) plus the volume,
  plan and surface area from `meshProperties`, which the "i" popover shows (volume in litres). Nothing is
  serialised: no document JSON crosses the worker boundary any more.
- **Protocol.** Requests are `classic` (the live board, by structured clone, 0.15 ms for the shortboard) and
  `test`; the face size and `remesh` are gone (the 0.5 mm tolerance always holds). The client keeps its ids and
  stale-answer dropping, and posts **one request at a time**: while the worker runs, only the newest later
  request waits (it replaces an earlier waiting one), so a drag never builds a backlog and the worker is never
  terminated for being slow. The worker posts no progress messages (a job is milliseconds).
- **Identity.** A structured clone makes fresh objects, which would refit every section on every edit (the fit
  cache is per `Section`, the converter's slice cache per classic `Spline`). `canonical()` in the core hands the
  converter the earlier job's spline for every cross-section whose control points are unchanged (96 remembered),
  which keeps both caches warm. `reviveBoardDoc` is never called per edit.
- **Every edit converts at once.** The 1.2 s debounce, the `waiting` phase, the "not while dragging" gate and the
  conversion cache are gone. The surface on screen is the last answer and is `tracking: 'live'`, so the 3D view
  draws it whatever hull the store holds now: a drag never falls back to the classic hull between answers. While
  the store is `editing`, a job reuses the last mesh's ladders (checked against the new board's ξ range) and
  skips the curvature unless an exact analysis mode is shown; when the gesture ends one more job derives fresh
  ladders and computes the curvature. The layer reads the analysis mode: an exact mode asks for curvature on
  every update, "Deviation from classic" for the deviation (the old `classicDeviation` code and its tip and
  no-data handling, unchanged). A drag in a non-exact mode hands the view zero curvature arrays, read only in an
  exact mode, which asks for curvature and gets it with the next update.
- **Curvature.** `meshBoard` already gives convex-positive `k1 >= k2`, so mean is `(k1 + k2) / 2`, Gaussian
  `k1 k2`, radius `1 / max(|k1|, |k2|)` capped at the view's `MAX_RADIUS`; non-finite curvature is undefined and
  has no weight in the display scales (the same percentile scales as before, so legends read as they did). Zebra
  needs only the normals. `repairNormals` is deleted (the mesh's normals are exact, a collapsed end row takes the
  limit half a row in).
- **Refusals.** A refused board has no model: the classic mesh is shown, the badge says the phase is `failed`,
  and the "i" popover gives a plain sentence per known code (zero thickness at an end, blunt tail off the
  stringer, V bottom, folded curve, no sections) above the converter's own message with its numbers in the display
  unit. A failed worker is shown the same way.
- **Test boards.** With the engine on, a "Test board" menu in the badge area (My board, Swallow, Fish,
  Asymmetric, Analytic) shows one on its own, read-only. The surface is `tracking: 'standalone'`: the view
  centres it by its own bounding box and hides the classic board's fins and guides; the classic editors keep
  editing the classic board, and classic edits are ignored while a test board is shown.
- **render3d.** `ExternalSurface.board` may be null and `tracking?: 'hull' | 'live' | 'standalone'` says when the
  surface counts (`surfaceApplies`); `surfaceCenter` places it. The default (`'hull'`) is the old behaviour.
- **Flag off is unchanged.** `ThreeDPane` still imports only the lazy layer; board2 and geom (and the test boards)
  stay in the worker and the dynamic-import chunks, there is no modulepreload of `nurbs-*` chunks (the build's
  guard and the e2e flag-off test pass), the offline fallback and `NurbsBoundary` are untouched. The Settings
  text and the `/docs/editing` section describe the live viewer.

Measured in Chromium on a production build (`node tools/perf/nurbs-timing.mjs`; 4-core container, software
WebGL, so the main thread is busier than on a laptop with a GPU):

| What                                                                                   | Result                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Engine switch (Apply in Settings to the NURBS hull on screen, 3 runs)                  | 0.50, 0.54, 0.50 s, including the lazy chunk and the worker start            |
| Open a golden with the 3D view up (import to the surface on screen)                    | shortboard 0.50 s, funboard 0.37 s, longboard 0.48 s                         |
| First job of a board (worker): convert / build / mesh                                  | 1 / 6-57 / 80-100 ms (cold fits and a cold mesh); 100 to 175 ms in all       |
| Drag of the shortboard's wide outline knot, quad view, 60 moves                        | 56 updates, all with reused ladders                                          |
| Per drag update, request to answer on the main thread (convert, build, mesh, transfer) | median 32 to 43 ms, p95 57 to 62 ms, max 88 to 129 ms (two runs)             |
| Per drag update, worker only                                                           | median 16 to 18 ms (convert 0.4, build 10 to 12, mesh 4.5), p95 34 ms        |
| One update after release (fresh ladders and curvature)                                 | 87 ms in the worker, 88 ms round trip; the surface on screen stays meanwhile |

The target (< 50 ms) holds for the median; the p95 is slightly above it. Two things set the numbers:

- **Build is 10 to 12 ms during an outline drag, not the 1 to 4 ms of step 1's bench.** The editor's outline
  drag also rescales the cross-sections (the "Resize cross-sections" behaviour), so 4 of the 5 real sections
  have new control points on every move and are refitted cold. A cold fit tries every rung of the span ladder
  (12 to 48) because the goldens' fits sit above the 0.01 cm limit at every rung (the conservative bound of
  step 2's open point 2). With that setting on (the default) the sections follow the outline, rocker and deck views. Stopping the ladder at the rung where the error stops improving could cut the cold fit substantially
  (a board2 change, not done here).
- **About 25 ms of the round trip is the main thread**, not the clone (0.15 ms) or the transfer: the answer
  waits for the main thread, which software WebGL keeps busy re-rendering the 3D view and the three 2D panes on
  every update.

Known limits: `Deviation from classic` is first-order and blank within 0.5 cm of the tips (its code is
unchanged); with a test board shown the classic board's fins and guides are hidden and its overlays are not
registered with it; the V-bottom, zero-thickness and blunt-tail refusals are the model's, not the viewer's
(of the 11 sample files timed above, 7 convert and 4 are refused with the reasons listed in step 2).

Checks at this commit: `pnpm lint`, `pnpm typecheck`, `turbo run test` (web: 90 files, 867 tests), `pnpm build`,
`e2e` (45 tests, 7 of them the NURBS viewer's: open, live drag, test boards, refusal, chunk unavailable, flag
off, settings toggle) and `e2e:offline` (8) all pass.

## 11. As built (step 4)

Landed in `packages/board2` (`validate.ts`, `sections.ts`, `frame.ts`, `mesh.ts`, `params.ts`,
`classic/convert.ts`, tests and `perf.bench.ts`) and a few lines of `apps/web` (refusal wording, tests, the
refusal e2e). Every classic file now converts (decision Q33, `nurbs-plan.md`); the smooth blend between
stations stays (Q32 = a, `divergences.md`).

**Rule change (Phase 0).** The centre **points** stay fixed at (0, 0) and (0, 1) on the stringer, the apex
stays vertical-only and **no control point may pass 0 ≤ u ≤ 1**. The rule that the centre **handles are
horizontal** is dropped, for the bottom and the deck: a handle must only be finite (`section-centre-tangent`
now means that). A section that leaves the stringer at an angle has a crease along it, as in the classic loft.
The converter no longer flattens a handle (it used to refuse more than 0.05 cm of it). The fit holds a centre
tangent horizontal, and an apex tangent vertical, only when the stored curve really leaves that way: the
direction is read from the Bézier control polygon (first non-zero difference), so a zero-length handle counts
as the polygon direction, not as "horizontal". The mesh takes the mean of the two sides' normals on the
stringer of a mirror board (no sideways part), so a keel shades as a ridge.

**What changed per refused case.**

| Case (files)                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero thickness at an end (`synthetic-clean-6x22x2-75`, `-fallback-outline-5x10`) | The validator accepts a deck on the rocker at x = 0 and x = L (thickness ≥ 0 there, > 0 everywhere between). The surface already collapsed to the point or edge (chord and thickness go to 0); the welded end row keeps the mesh closed and the normals come from half a row in, so there is no NaN. Tested on both files (points at x = 0 and x = L, finite mesh and curvature, closed, within 0.5 mm of the surface). |
| V bottom (`synthetic-rocker-absolute-deck`, `-rocker-thickness-deck`)            | The rule change above. The section keeps its straight vee; the surface at the middle station follows the stored line within 0.5 mm. The fit pins a tangent only when the curve has it.                                                                                                                                                                                                                                  |
| Blunt tail (a squash tail) or nose (no sample file; tested on the shortboard)    | The converter adds a straight edge from the stringer to the first (last) outline knot, as a corner, so the tail stays at x = 0. The frame starts the forward branch at the end of that vertical edge, so the end station is the whole transom (a planar cap, 6 cm wide in the test). Reported as `bluntEnds`.                                                                                                           |

**Other changes that came with it.**

- **Bounded blend.** A u coordinate that the C2 spline would push past 0 or 1 now uses a monotone C1
  cubic (Fritsch-Carlson, zero end slopes) instead of the clamp. The clamp made the derivative jump at a
  station whose control sits on the bound (longboard station 30.5: 1.2e-3 rad once the fit stopped at
  24 spans). The `blend-overshoot` warnings of the funboard and longboard are gone; the other coordinates
  stay C2. Only the u coordinates that would overshoot have a curvature jump (C1) at the stations.
- **Section fit.** The limit is the project tolerance, `SECTION_FIT_TOL = 0.05` cm (it was 0.01 cm, which the
  goldens never reached at any rung: the measure is conservative, normalised error times the larger of chord
  length and thickness, and rail corners converge slowly). The ladder (12, 16, 24, 32, 48 spans) stops at the first
  rung within the limit, or after `SECTION_STALL_PATIENCE` = 2 rungs in a row that fail to beat the best error
  by `SECTION_STALL_RATIO` = 0.85, and keeps the best rung. The real deviation from the classic slice is about
  half the conservative bound. Rungs reached: shortboard 32, funboard 48, longboard 24.
- **Converter cache by content.** A normalised section is looked up by its coordinates rounded to 1e-9
  (96 remembered): a slice that was only rescaled (the editor's "Resize cross-sections" while the outline,
  rocker or deck is dragged) gets the earlier `Section` object back, so `buildBoard`'s fit cache stays warm.
  This, not the ladder, is what removes the refits from an outline drag. A root of the widest-point search
  that lies within 1e-9 of a knot is that knot (no spurious apex split from rounding).

**All sample files** (Node, median of 6 fresh loads; deviation = Hausdorff distance of the section ring from the
classic loft's, interior stations more than 1 cm from a tip; the stations 0.2 cm from a tip differ by the
classic's 5 mm tip floor, so they are listed apart):

| File                            | Converts | Convert (ms) | Spans | Interior station dev (mm) | Tip station dev (mm) | Vertices | Warnings    |
| ------------------------------- | -------- | ------------ | ----- | ------------------------- | -------------------- | -------- | ----------- |
| shortboard.brd (x3 copies)      | yes      | 0.9          | 32    | 0.18                      | 0.19                 | 9,419    | none        |
| funboard.brd (x2)               | yes      | 1.2          | 48    | 0.15                      | 0.16                 | 12,220   | none        |
| longboard.brd (x2)              | yes      | 0.8          | 24    | 0.08                      | 0.34                 | 11,934   | none        |
| synthetic-clean-6x22x2-75       | yes      | 0.3          | 48    | 1.09                      | 4.85                 | 6,434    | section-fit |
| synthetic-degenerate-section    | yes      | 0.3          | 12    | 0.00                      | 2.02                 | 6,970    | none        |
| synthetic-fallback-outline-5x10 | yes      | 0.3          | 48    | 0.83                      | 4.85                 | 6,166    | section-fit |
| synthetic-rocker-absolute-deck  | yes      | 0.3          | 48    | 1.01                      | 1.99                 | 5,522    | section-fit |
| synthetic-rocker-thickness-deck | yes      | 0.2          | 48    | 1.01                      | 1.99                 | 5,522    | section-fit |
| synthetic-stringer-fold-a       | yes      | 0.2          | 48    | 0.92                      | 2.54                 | 6,434    | section-fit |
| synthetic-stringer-fold-b       | yes      | 0.4          | 48    | 1.01                      | 2.03                 | 6,166    | section-fit |

Every file also builds, meshes closed (every edge twice, Euler 2), has finite positions, normals and curvature,
and round-trips through JSON (`classic/convert.test.ts`, `classic/convert.files.test.ts`; the second one lists the
board files of the repository and fails if one is not in the test). The four formerly refused files also pass
the 0.5 mm mesh check and the 1 % volume check (`mesh.accept.test.ts`). The synthetic files are hand-made
polygon sections (four knots with straight edges): the cubic fit rounds their rail corners by about 1 mm,
which is the `section-fit` warning (0.07 to 0.09 cm, the conservative bound). Real boards stay under 0.4 mm.
Templates are the three golden boards; no other classic board file exists in the repository.

**Speed.**

- Node (`pnpm --filter @openshaper/board2 bench`, `step 4 drag`: the wide outline knot moves 40 times with
  the sections resized, each move converted, built without validation and meshed with the first mesh's
  ladders, so this is the board2 share of a drag update). Build per move, median (p95): shortboard
  **14.8 (31.7) ms before, 0.3 (1.8) ms after**; funboard 19.0 (32.4) before, 0.3 (0.4) after; longboard 18.2
  (29.3) before, 0.2 (0.5) after. Whole move (convert + build + mesh): shortboard 18.9 (39.8) before, 5.9 (17.0)
  after; funboard 25.0 (40.8) before, 5.3 (8.7) after; longboard 24.0 (37.2) before, 5.2 (7.7) after. "Before"
  is the same code with the old limit (0.01 cm, every rung) and no content cache.
- A section drag (one slice changes per move) is unchanged by the ladder: build 4 ms (p95 6 to 8 ms), whole move
  8 ms (p95 10 to 22 ms); a cold build of a whole new board is 12 to 18 ms (one section 3 to 4 ms).
- Browser (`node tools/perf/nurbs-timing.mjs` on a production build, Chromium with software WebGL in the
  4-core container, drag of the shortboard's wide knot in the quad view, 60 moves, three runs): round trip
  per update, request to answer on the main thread, **median 28, 36 and 15 ms, p95 48, 53 and 49 ms** (max 68,
  59, 93), against 32 to 43 ms (p95 57 to 62) at step 3. The worker's share is now **median 5.1 to 5.5 ms**
  (convert 0.5, build 0.2, mesh 4.1 to 4.6), p95 15 to 25 ms, against 16 to 18 ms (p95 34) at step 3. What is left of
  the round trip is the main thread, which software WebGL keeps busy repainting the 3D view and the 2D panes;
  on a machine with a GPU it is smaller. The p95 target of 50 ms is met in two of three runs here and missed by
  3 ms in the third. After release: one update with fresh ladders and curvature, 59 to 85 ms in the worker.
  Open (one run of each file, wall time from import to the surface on screen): the goldens 0.33 to 0.62 s; engine switch
  0.50 s (three runs); the four formerly refused files open in 0.34 to 0.41 s (they were "failed" before).

**Known limits.** (1) Rail corners of polygon sections are rounded by up to about 1 mm (a common knot vector
cannot place a knot on every corner); (2) a creased stringer shows a tiny normal step in the curvature modes
(curvature there is one-sided); (3) the zero
thickness of an end is allowed only at the two ends (a deck that touches the rocker in the middle is refused as
`thickness`).

Checks at this commit: `pnpm --filter @openshaper/board2 test` (15 files, 231 tests), `pnpm lint`,
`pnpm typecheck`, `turbo run test` (web: 90 files, 868 tests), `pnpm build`, `e2e` (45 tests; the refusal test
now loads a deck that dips below the rocker, because the V-bottom file converts) and `e2e:offline` (8) all pass.
