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
checked by the validator: the centre knots are fixed at (0, 0) and (0, 1) with horizontal handles
(G1 across the stringer, mirrored or not); the apex knot has u = 1 and moves in v only; **every
control point has 0 ≤ u ≤ 1**. By the convex hull property, no section can then pass the outline or
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
