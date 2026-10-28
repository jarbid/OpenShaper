# `@openshaper/board2` — board model v2 (Phase 2 design)

Status: **design and scaffold, steps S1–S4, S6 and S7 done** for Phase 2 of `docs/design/geometry-overhaul.md` (§6; the
topology and editing model it implements are §3.2 and §3.3). Written 2026-10-21 on
`experiment/nurbs-overhaul`, after Phase 1 (`docs/design/geom-core.md`) was integrated. The
package has its scaffold (`package.json`, the type definitions of §11 in `src/types.ts` and
`src/classic/types.ts`), from step S1 the document layer (issues, parameters, revive and
canonical JSON, keyed curves (laws) and the structural and range part of `validateBoard`),
from step S2 the plan loop, the height fields and symmetry (plan invariants in
`validateBoard`, `stringerLines`, `symmetryRules`, the stadium and notched-loop fixtures) and,
from step S3, the rail band builder (`band/`, `offsets.ts`, `measureLaws`, the band checks of
`validateBoard`, the band's row rules in `symmetryRules`) and, from step S4, the bottom
features, the B-rep, `buildBoard`, `writeBoardStep` and the board through OCCT (geom's
`./testing/occt` protocol) and, from step S6, the converter's first part (classic sampling,
the plan loop with fillets, the stringer lines, the insets, the deck and bottom fits,
internal stages of the converter) and, from step S7, the rest of the converter (the band fit, law extraction
and offsets: `convertClassic`); see the S1–S4, S6 and S7 notes in §14 (S4 and S6 with their
review fixes). The specs (S5), the deviation report (S8) and the benchmarks (S9) are still to
come; §14 is the build order.
When this document and the code disagree, this document wins until the step that changes it
edits this file in the same commit.

"geom §n" refers to `docs/design/geom-core.md`, "plan §n" to `geometry-overhaul.md`, "P&T"
to Piegl & Tiller, _The NURBS Book_. Every number below with a unit is either measured (and
says where) or a named parameter (§12) with its reason.

---

## 0. Decision record

| #   | Topic                | Decision                                                                                                                                                                                                              | Reason                                                                                                                                                                                           |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Two layers           | A plain, JSON-serialisable **`BoardDoc`** is the master; a derived **`BuiltBoard`** holds geom objects. `reviveBoardDoc` validates untrusted JSON once.                                                               | geom's nets are `Float64Array`s (not JSON, not deep-frozen); undo, files and workers want plain immutable data with structural sharing.                                                          |
| 2   | Master data (D7, D8) | Plan loop + deck and bottom **height-field nets** + **rail laws** + **offset layer** + **bottom features** + build parameters. The rail is a law network plus layers (D7's default); deck and bottom are free z-nets. | A z-net is the smallest exact representation of a smooth height field and every deck/bottom edit is a linear constraint on it; a network of section curves would bring the station creases back. |
| 3   | Frame                | cm; x along the board, **tail at x = 0** (the plan loop's minimum x, at loop parameter u = 0), nose at u = ½; z up; the loop runs counter-clockwise seen from +z.                                                     | The project rule (`.claude/CLAUDE.md`), made a checked property of the data rather than detected from shape.                                                                                     |
| 4   | Plan loop            | One periodic cubic B-spline, period 1, C² in Phase 2. Tips are smooth; classic plan corners are filleted by the converter.                                                                                            | geom supports full-multiplicity corners (needed in Phase 5); for standard boards a corner adds a mitred band column for no product gain (D12: tips get a small radius).                          |
| 5   | Deck and bottom      | **Non-parametric** clamped bicubic height fields: x and y are affine in (u, v) through the Greville abscissae, only z is stored.                                                                                      | The pcurve of any plan curve is then its exact affine image, the deck-edge and tuck trims cost no fit, and x/y can never drift (unrepresentable).                                                |
| 6   | Rocker and deck line | **Exact iso-curves** of the bottom and deck at y = 0, derived, never stored. Edits impose them as exact linear constraints (range space).                                                                             | A control-point row would need full v-multiplicity at the stringer: a C⁰ crease along the deck. Iso-curves are exact and cannot contradict the surface.                                          |
| 7   | Rail band            | u periodic along the loop; v clamped cubic with **7 rows**, the apex row at v = ½ with multiplicity 3; the rows either side of the apex are vertical offsets of it (`offsetFrom`, ẑ).                                 | The apex row is then exactly the apex curve and the apex join is G1 by construction, with a horizontal normal (the apex is the plan silhouette).                                                 |
| 8   | Joins                | Deck/band join **G1** (measured, refined to ≤ 0.1°); band/bottom join a **designed crease** of `edgeHardness × φ_chord`.                                                                                              | Exact G1 between a trimmed height field and a tensor band is impossible at low degree; the tuck is where shapers want a controllable edge.                                                       |
| 9   | Tips                 | **No special tip topology.** Every point of the loop, tips included, carries an ordinary rail profile. No poles, caps or collapsed edges; minimum inset, rail height and plan radius are model invariants.            | The loop topology removes the x-slice degeneracy that made the classic floor its tips. geom needs no collapsed-edge support (§4).                                                                |
| 10  | B-rep                | Three faces (deck, band, bottom), three edges (deck edge, tuck, the band's seam), two vertices: the V5 elliptic puck's topology.                                                                                      | geom already validates that topology end to end, OCCT included (geom §15.5).                                                                                                                     |
| 11  | Symmetry             | Data is **always full width**. Symmetric mode adds `mirror` / `fixAxes` rules to every DOF map and an exact mirror overwrite at build; laws are stored on half the loop.                                              | One code path for Phase 6; coordinate-plane mirrors are bitwise in geom's solver (geom §10.3).                                                                                                   |
| 12  | Standard tails       | A **validator rule** (each half of the loop is a graph over x), not a structural assumption. The band builder is loop-generic and is tested on a notched loop.                                                        | Phase 5 then relaxes one rule instead of rewriting the band.                                                                                                                                     |
| 13  | Rail laws            | Six lanes (deck inset, tuck inset, apex height, upper and lower fullness, edge hardness), each keys with Bézier ease handles over **σ**, the arc-length fraction of the loop from the tail centre.                    | Shaper-meaningful values that survive outline edits (σ is geometric, u is not).                                                                                                                  |
| 14  | Auto ease            | Handles at a third of the segment, slopes by the monotone (Fritsch–Carlson) rule.                                                                                                                                     | Thirds give linear precision (the law is then exactly a cubic Hermite); the limiter keeps it inside its key values.                                                                              |
| 15  | Law → rows           | Schoenberg sampling: each band control column takes the laws at its Greville σ; the band is refined until the laws **measured back** from the surface match within tolerance.                                         | Variation diminishing (no overshoot past a lane's range); fidelity is measured, not assumed.                                                                                                     |
| 16  | Profiles             | Each half-profile is a cubic Bézier in its station plane built on a **corner triangle**; fullness is the handle fraction (2/3 = exact parabola), hardness rotates the tuck handle towards the chord.                  | Closed-form, convex for every law value, and gives analytic oracles.                                                                                                                             |
| 17  | Rational rails (D5)  | **Deferred.** Phase 2 profiles are polynomial.                                                                                                                                                                        | Rational fairness assembly measured 0.5–2.8 s against 2.3 ms polynomial (geom P12r, P13r); unit weights keep mirrors bitwise; polynomial faces keep volume quadrature exact.                     |
| 18  | Boundary rows        | Rows 0 and 6 are fitted onto the deck and bottom by `curveOnSurfaceTo3d` (same parameter); rows 1 and 5 move with them (handle vectors kept).                                                                         | The B-rep gap is then the fit (≤ `Tolerances.fit`, measured and declared), as for V5.                                                                                                            |
| 19  | Offset layer         | Per-row periodic spline fields over σ, in the **rail-local frame**, with only the components the structural rules allow.                                                                                              | Survives law changes and refinement; can never break the apex, G1 or outline invariants.                                                                                                         |
| 20  | Bottom features      | Displacement height fields in a lateral coordinate normalised to the tuck half-width, fitted to the bottom's basis and **added exactly** after common refinement.                                                     | Features taper with the outline; addition of compatible splines is exact and order-independent.                                                                                                  |
| 21  | Evaluation order     | Fixed (§6.3).                                                                                                                                                                                                         | Each stage depends only on earlier ones, so Phase 3 can cache by doc sub-object.                                                                                                                 |
| 22  | Specs                | Length and width from the plan loop's exact extremes, thickness from the stringer lines' exact maximum, plan area by Green's theorem (exact), volume/area/centroid by geom's `massProperties`.                        | Exact where the geometry allows; the rest carries geom's quadrature error estimate.                                                                                                              |
| 23  | Converter target     | The converter fits the classic **loft** (what the 3D view, STL and STEP show), not the spec panel's control-point model.                                                                                              | The two classic models differ; the difference is reported separately (§10.4).                                                                                                                    |
| 24  | Converter pipeline   | Lines first (to `lineTol`), height fields with the exact stringer identity and **no parameter correction**, then a free band fit through the DOF map, factorised into laws plus offsets.                              | Height fields have exact foot parameters; the factorisation reproduces the fit to rounding while keeping shaper-meaningful laws.                                                                 |
| 25  | Fairness weights     | Chosen by the **discrepancy principle**: the largest weight that still meets the data tolerance.                                                                                                                      | No magic weights (principle 3); smoothness is bought only where the data allow it.                                                                                                               |
| 26  | Station creases      | Not reproduced. Explained by a crease-free classic counterfactual.                                                                                                                                                    | Removing them is the point of the overhaul (plan §2).                                                                                                                                            |
| 27  | Deviation report     | Two-sided sampling; spec deltas decomposed into causes; a volume budget identity; anything unexplained above 0.1 mm fails.                                                                                            | "Each difference explained" (plan §6) turned into a check.                                                                                                                                       |
| 28  | Layering             | The core imports `@openshaper/geom` only. **`@openshaper/board2/classic`** is a separate entry point that may import `@openshaper/kernel`. Tests may import `@openshaper/io`. Nothing existing imports board2.        | The core stays free of the classic engine and of every UI layer; the app loads the converter lazily.                                                                                             |
| 29  | Issues               | Own `Board2Issue` codes and `Board2Result<T>`, shaped like geom's `Result`, wrapping `GeomIssue` where geom reports.                                                                                                  | geom's error-code union is closed; board concepts (σ, lanes, stations) need their own locations.                                                                                                 |
| 30  | geom changes         | None functional. A test-only `@openshaper/geom/testing/occt` subpath (step S4). Performance tier-2 items are optional (§13.5).                                                                                        | Phase 2 needs nothing geom does not have; see §4 and §13.5.                                                                                                                                      |
| 31  | API review           | `index.ts` lists every export by name; `index.test.ts` pins the runtime export list (empty at the scaffold).                                                                                                          | Same as geom decision 40: every API change shows in a diff.                                                                                                                                      |
| 32  | State                | No module state. Caches (Phase 3) are caller-owned and bounded. Same input, same bits.                                                                                                                                | Project rule; the 200-step undo history keeps docs alive (`.claude/CLAUDE.md`).                                                                                                                  |

---

## 1. Scope and non-goals

**In scope** (plan §6 Phase 2): the full-width board with the symmetry constraint; the closed
apex, deck-edge and tuck loops; the rail band with the apex at full multiplicity and the
vertical-tangent constraint; trimmed deck and bottom; rocker and deck line as exact
constraints; rail laws with ease; the offset layer and bottom feature layers (data model,
evaluation and order); standard tails; the converter from the classic `BezierBoard`; specs
from the surfaces; the deviation report; the three-face B-rep and STEP; benchmarks.

**Not in Phase 2:** editors, drag solving and analysis displays (Phase 3, which uses the DOF
maps defined here); `.board.json` v2 files, share links and imports through the app (Phase 4);
notched tails and plan corners (Phase 5); asymmetric boards (Phase 6, the type and the code
path exist, the validator refuses them); rational rail profiles (D5, §5.6); recognising vee or
concave in a classic board as features (the converter puts the classic bottom in the base
surface); a deck-edge hardness lane; fins (carried through, §3.10).

---

## 2. What a classic board is

The converter must open every classic board, so this is measured from the code and the
files, not assumed.

### 2.1 The model (`packages/kernel`)

- `BezierBoard` (`board.ts`): `outline` (half-width over x), `bottom` (rocker), `deck`,
  `crossSections` (sorted, with one-knot dummies at x = 0 and x = L), `interpolationType`
  (`'controlPoint' | 'sLinear'`), `fins`. Every curve is a cubic Bézier spline of `Knot`s
  (an end point and two handles, a `continuous` flag, an optional handle lock).
- **Two surface models.** The spec panel integrates `getInterpolatedCrossSection`, which
  blends two stations' _control points_ (or the sLinear model when `interpolationType`
  says so); the 3D mesh, the STL, the STEP fit and the guides use `loft.ts`, which blends
  _points_ at equal fractional arc length on a per-board curvature ladder
  (`ringFractions`). They are different surfaces; `loft.ts` documents why.
- **Station creases.** `loftSection` blends adjacent stations with a weight piecewise linear
  in x, so the hull has a tangent break at every real station. `fitBoardSurface` keeps them
  on purpose (`uBreaks`).
- **Tip floors.** `loftSection` and `getInterpolatedCrossSection` floor width and thickness at
  `MIN_DIM` = 0.5 cm; `fitBoardSurface` fits only the `solidSpan` where both reach it and caps
  the ends with planes.
- **Ends.** The outline leaves (0, 0) with a vertical handle; the deck curve starts at the
  rocker height with a **vertical segment** at x = 0 (and ends with one at x = L): the end
  thickness is a jump of the deck curve, not a face of its own.
- **Rails.** Eight `RAIL_PRESETS` (`rail-profile.ts`: apex, edge, fullness, deckBand,
  bottomBand) rewrite a section's rail band through `applyRailProfile`. A file stores only
  the resulting knots, never the preset.
- **Concave tails.** `outline-cutout.ts` models one notch; out of scope (§3.8).

### 2.2 How boards arrive (`packages/io`)

`parseBrd` / `parseBrdFile` (`.brd`, including the encrypted variant), `parseS3d` /
`parseS3dx` (Shape3D), `parseSrf` (SurfCAD, reversed to tail-at-0 by the reader),
`readBoardJson`, and the share-link codec all produce a `BezierBoard`. The converter starts
from `BezierBoard`, so every format the classic engine reads converts, and no reader changes.

### 2.3 The sample files

The fourteen files of `packages/io/src/roundtrip.characterization.test.ts`, measured with the
kernel (2026-10-21, a throwaway probe, not committed). "End t" is the thickness just inside
the end (x = 0.001 cm), "corners" the non-continuous knots per real section.

| File                                                        | L × W × T (cm)              | Tail end                          | Nose end                               | Real sections                          | Classic V (L) |
| ----------------------------------------------------------- | --------------------------- | --------------------------------- | -------------------------------------- | -------------------------------------- | ------------- |
| `docs/specs/golden/shortboard.brd`                          | 187.96 × 46.99 × 5.96       | near-straight transom, end t 1.00 | **1 cm flat, two corners**, end t 0.59 | 5 (x = 1.0 … 185.4), corners 4,3,1,1,3 | 27.370        |
| `docs/specs/golden/funboard.brd`                            | 228.60 × 54.61 × 6.99       | round, end t 1.21                 | round, end t 0.60                      | 5, corners 1,1,3,2,2                   | 47.360        |
| `docs/specs/golden/longboard.brd`                           | 274.32 × 57.78 × 7.56       | round, end t 1.48                 | round, end t 0.61                      | 5, corners 2,0,2,2,1                   | 66.074        |
| `apps/web/src/{sample-board,funboard,longboard}.brd`        | as the three goldens        | identical specs                   |                                        |                                        |               |
| `packages/io/src/__fixtures__/self-authored-shortboard.brd` | as the shortboard           |                                   |                                        |                                        |               |
| seven `__fixtures__/synthetic-*.s3dx`                       | 177.8–220 × 47–56 × 6.2–7.0 | knife or thin (end t 0 to 1.0)    | knife or thin                          | 2–3 **polygonal** 4-knot sections      | 0 to 26.7     |

Facts the design depends on:

- **Tips have positive end thickness** on every `.brd` (0.59–1.48 cm) and zero on two
  synthetic files (`synthetic-clean-6x22x2-75`, `synthetic-fallback-outline-5x10`).
- **Plan corners exist**: the shortboard's nose is a 1 cm flat with two non-continuous knots
  at (L, ±0.5).
- **The classic tail is squarer than it looks**: the shortboard's outline radius at the tail
  centre is about 88 cm (half-width 1.33 cm at x = 0.01 cm), closing to corners near
  (1.4, ±5.8).
- **Polygonal sections** (synthetic files): straight segments with handles on the chords,
  a vertical rail segment and sharp deck-side and bottom-side corners.
- **Classic spec-panel defect**: `synthetic-rocker-absolute-deck` and
  `synthetic-rocker-thickness-deck` report volume 0. On a vertical straight rail
  `ttByNormal(…, 90°)` returns tt = 1, the deck integral is empty and the area is clipped
  to 0. The loft (and so the 3D view) is fine. The deviation report treats this as a
  classic defect (§10.4).
- `synthetic-degenerate-section` has only two real sections (the reader drops a two-point
  one with a warning).

---

## 3. Data model

### 3.1 Two layers

```
BoardDoc (plain JSON, immutable, versioned)  ──buildBoard──▶  BuiltBoard (geom objects, derived)
   plan, deck, bottom, laws, offsets,                          plan curve, loops, surfaces,
   features, build params, meta                                band, B-rep, build report
```

- **`BoardDoc`** contains only numbers, strings, booleans, arrays and plain objects. It
  round-trips through `JSON.stringify`/`JSON.parse` unchanged (a test). Sub-objects are
  shared between versions (a law edit keeps the same `plan`, `deck`, `bottom` objects), so
  Phase 3 can cache each build stage by sub-object identity.
- **`BuiltBoard`** holds geom curves, surfaces and the B-rep. It is never stored, never
  sent to the store, and is rebuilt from the doc deterministically.
- `reviveBoardDoc(json)` validates structure and values once (like geom's `revive*`);
  `validateBoard(doc)` checks the model invariants (§3.7, §3.8, §4) and returns every issue.

### 3.2 Conventions

- Units cm. Right-handed: x towards the nose, y across, z up. **Tail at x = 0** (decision 3).
- **Loop parameter u** ∈ [t₀, t₀ + 1), period 1. u = 0 is the tail centre (x = 0, y = 0),
  u = ½ the nose centre. The loop runs counter-clockwise seen from +z, so u ∈ (0, ½) is the
  −y side and (½, 1) the +y side (sides are named `minusY` / `plusY`; stance names are
  Phase 6's).
- **σ** ∈ [0, 1): arc-length fraction of the plan loop from the tail centre in the same
  direction (σ(u) by geom's `lengthAtParam`, its inverse by `paramAtLength`). Laws and
  offsets are keyed on σ.
- **Rail-local frame** at loop parameter u: `t̂` the plan tangent, `n̂ = ẑ × t̂` the inward
  plan normal (counter-clockwise loop ⇒ left is inside), `ẑ` up, and `ô = −n̂` (outward).
  The **station plane** at u is spanned by `n̂` and `ẑ`. At the self-mirrored stations
  (u = 0, ½) `ô` is set to exactly ∓x̂, not computed, so symmetric rows stay on y = 0 bitwise.

### 3.3 Plan loop (the apex loop's plan projection: the outline)

`PlanLoopJSON`: periodic, degree 3, one period of knots, period 1, control points as (x, y)
pairs. In the `BuiltBoard` it is a `PeriodicCurve<2>`.

Invariants (`validateBoard`):

1. `plan(0)` = (0, 0) within `Tolerances.point` (tail at x = 0, on the stringer).
2. **Standard tail** (§3.8): x′(u) > 0 on (0, ½) and x′(u) < 0 on (½, 1), certified on the
   Bézier pieces of x′ (quadratic: closed-form roots, no sampling). This also makes u = 0
   the minimum x and u = ½ the maximum.
3. Plan radius of curvature ≥ `minInset / insetCurvatureFraction` everywhere (so the minimum
   band fits, §4), measured on each Bézier piece with refinement around the minimum as
   geom's continuity sampling does (geom §11.4).
4. Symmetric mode: the knot set is invariant under u ↦ −u (mod 1) and control points pair as
   in §3.7, bitwise.

Corners (full-multiplicity knots) are rejected in Phase 2 (`plan-corner`); Phase 5 admits
them at notch tips.

### 3.4 Deck and bottom height fields; rocker and deck line

`HeightFieldJSON`: clamped, `degreeU`, `degreeV` (3 by default), knot vectors on [0, 1], the
board-coordinate extent `x: [x0, x1]`, `y: [y0, y1]`, and **z only**, u-major
(`z[i · countV + j]`, geom §4.2's order).

- The control points' x and y are **not stored**: `x_ij = x0 + ū_i (x1 − x0)`,
  `y_ij = y0 + v̄_j (y1 − y0)` with ū, v̄ the Greville abscissae. By the linear precision of
  B-splines, x(u, v) and y(u, v) are then exactly affine, so the surface is the graph
  z = F(x, y) and the (u, v) of a plan point is its affine image. A height field cannot fold.
- Extent: the plan loop's bounding box grown by `planMargin` on every side, so Phase 3 can
  grow the outline that far without re-gridding.
- Symmetric mode: y0 = −y1, symmetric v-knots, `z_ij = z_i,(m−1−j)` bitwise.
- **Rocker line** = the z of `isoCurve(bottom, 'v', v_s)` and **deck line** = the same on the
  deck, where `v_s` is the parameter of y = 0 (½ when symmetric). These are exact 3D curves
  whose x is affine in u; nothing is stored for them.
- **Exact constraints in edits** (Phase 3): with `c_i = Σ_j N_j(v_s) z_ij` the stringer curve's
  control values, a rocker edit imposes `c_i = r_i` (one range-space row per u-column,
  m ≈ 20–60, inside geom's m budget, geom §10.3). The converter imposes the same identity as
  `point` constraints at the n*u Greville sites of the stringer: two splines in the same
  n_u-dimensional space that agree at n_u Schoenberg–Whitney sites are identical, so the
  fitted rocker \_is* the target line to the solver's `constraint` tolerance.

Rejected: rocker and deck line as control-point rows (needs multiplicity 3 at y = 0: a C⁰
crease along the deck and bottom); storing the lines and the surfaces both (two masters that
can disagree).

### 3.5 Rail band

A `NurbsSurface` with u periodic along the loop (its basis is the plan basis refined, §5.4)
and v clamped cubic with knots `[0, 0, 0, 0, ½, ½, ½, 1, 1, 1, 1]`: **seven rows**, two
Bézier patches in v joined at the apex row.

| Row | Name         | Where                                  | Structural rule (DOF map)                                 |
| --- | ------------ | -------------------------------------- | --------------------------------------------------------- |
| 0   | `deckEdge`   | on the deck (v = 0 boundary)           | x, y from the deck-edge plan curve; z on the deck         |
| 1   | `deckHandle` | deck-side handle                       | slides along `τ_d`, the deck tangent in the station plane |
| 2   | `apexUpper`  | upper apex handle                      | `offsetFrom` row 3 along ẑ only                           |
| 3   | `apex`       | the apex curve (v = ½, multiplicity 3) | x, y = the plan loop; z from the apex-height law          |
| 4   | `apexLower`  | lower apex handle                      | `offsetFrom` row 3 along ẑ only                           |
| 5   | `tuckHandle` | tuck-side handle                       | free in the station plane (ô, ẑ)                          |
| 6   | `tuck`       | on the bottom (v = 1 boundary)         | x, y from the tuck plan curve; z on the bottom            |

**Apex G1, exactly.** With knot multiplicity 3 at v = ½, the iso-curve there is row 3 (the
apex curve), and the one-sided v-derivatives are
`S_v⁻(u) = 6 Σ_i M_i(u)(A_i − P2_i) = −6 Σ M_i b_u,i ẑ` and
`S_v⁺(u) = 6 Σ M_i (P4_i − A_i) = −6 Σ M_i b_l,i ẑ`: both vertical, both pointing down.
`S_u` is shared (one row), so the two tangent planes coincide and the normals agree up to
rounding wherever `Σ M_i b > 0`, i.e. whenever fullness > 0 (`fullnessRange` starts at 0.05).
The normal there is `S_u × ẑ`, horizontal: the apex row is the plan silhouette, so the
outline is the widest line of the board. This is the plan's "vertical-tangent constraint"
(plan §3.3) as an identity, not a tolerance.

**Deck join.** Row 1 − row 0 is along the deck's tangent in each station plane, so the deck
and band share a tangent plane at the Greville stations; between them the error is O(h²)
in the station spacing. The join angle is measured (geom `edgeContinuity`) and the band is
refined until it is ≤ `deckJoinAngleTol` (0.1°, the checkpoint's apex bar, plan §7).

**Tuck join.** A designed crease: the angle between band and bottom along the tuck equals the
edge-hardness law times `φ_chord` (§5.3). Hardness 0 is G1.

### 3.6 The three loops

- **Apex loop** = row 3 = (plan(u), z_apex(u)): exact; its plan projection is the plan loop
  (the same curve, refined).
- **Deck-edge loop** = row 0, a closed curve on the deck: plan curve exact (inset of the plan
  by the `deckInset` law, §5.3), z fitted onto the deck within `Tolerances.fit` (§5.5).
- **Tuck loop** = row 6, the same on the bottom with `tuckInset`.

Their plan curves must be simple, strictly inside the plan loop, and the deck-edge loop must
lie inside the deck's domain (`validateBoard`, through geom's certified trim-loop checks).

### 3.7 Symmetry as a constraint

`symmetry: 'mirror-y' | 'none'`. Data is always full width; `'none'` is Phase 6 and refused
by the Phase 2 validator (`asymmetric-unsupported`) so no half-tested path ships.

**Pairing.** For a periodic basis with a mirror-symmetric knot set, column i pairs with the
column whose Greville abscissa is −ū_i (mod 1); it is computed from the basis and checked,
not assumed from index arithmetic. Columns at ū = 0 and ½ pair with themselves. Height
fields pair j ↔ m − 1 − j.

**DOF model** (what Phase 3's solver receives; geom §6.13, §10.3):

| Net           | Masters                                          | Partners              | Self-paired                                                  |
| ------------- | ------------------------------------------------ | --------------------- | ------------------------------------------------------------ |
| Plan loop     | columns with ū ∈ (0, ½)                          | `mirror`, plane y = 0 | `fixAxes` y                                                  |
| Height fields | j < (m − 1)/2, z free (x, y `fixAxes`)           | `mirror`, plane y = 0 | x, y fixed, z free                                           |
| Band          | columns with ū ∈ (0, ½), each row's rule of §3.5 | `mirror`, plane y = 0 | rules of §3.5 with directions whose y-component is exactly 0 |

A mirrored edit is therefore not a second edit: the user drags a master or a partner, the
handle's constraint is expressed on whichever point was grabbed, and the map carries it
across. geom re-applies coordinate-plane mirrors from the masters after the scatter, so both
halves agree with `===`. Asymmetric boards drop the mirror rules and nothing else.

**Build.** The builder computes every column, then in symmetric mode overwrites each partner
with the exact mirror of its master. A test builds the same symmetric doc with the overwrite
disabled and compares: equal within 1e-12 relative, so the overwrite only removes rounding.

### 3.8 Standard tails only

- **Enforced** by `validateBoard`: `tail.kind` must be `'standard'`, and plan invariant 2 (each
  half of the loop is a graph over x) must hold; otherwise `tail-not-standard`, located at the
  first u where x′ changes sign. The converter refuses a classic board with
  `hasTailCutout(outline)` (`unsupported-tail`) before fitting anything.
- **Tested**: a synthetic swallow-like loop is refused with that code; the classic converter
  refuses a kernel cutout board.
- **Room for Phase 5**: nothing below the validator slices by x. The band is built along the
  loop parameter, the deck and bottom are trimmed by loops, and specs use the loop. A test
  calls the band builder and B-rep assembly **directly** (bypassing the validator) on a smooth
  notched loop and requires `checkBrep` to pass. Phase 5 adds `tail.kind: 'notched'` with tip
  descriptions, full-multiplicity plan knots at the notch tips (geom allows them, geom §4.3)
  and mitred band columns there.
- **Room for Phase 6**: §3.7.

### 3.9 Layers on top of the band and bottom

See §6 for the offset layer and the bottom features.

### 3.10 Carried-through data

`meta` (name, author, comment, source format) and `passthrough.fins` (the classic `FinConfig`,
stored as opaque JSON). Phase 4 decides how fins sit on the new surfaces.

---

## 4. Tips

**Decision: no tip topology at all.** The classic engine degenerates at the tips because it
slices at constant x: as x approaches an end, sections shrink to nothing and need a floor.
board2 has no x-slices. The rail profile at every point of the loop, the tail and nose centres
included, lies in the plane perpendicular to the loop. At the tail centre that plane is the
stringer plane, and the profile there runs deck edge → apex → tuck across the transom like
anywhere else. The band is a strip of positive width around the whole loop, and the deck and
bottom are trimmed inside it. Nothing collapses.

What has to hold, and how it is guaranteed:

| Condition                               | Guarantee                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Band width in plan > 0 at every station | Insets ≥ `minInset` (validator); laws are clamped by `insetCurvatureFraction × ρ(u)` near tight tips (§5.3)  |
| Inset loops simple (no offset cusps)    | `inset ≤ insetCurvatureFraction · ρ(u)`: the deck edge never turns tighter than 1/(1 − κ) times the apex     |
| Plan loop can host the minimum band     | `ρ_min ≥ minInset / insetCurvatureFraction` (plan invariant 3); classic corners filleted (§9.3)              |
| Band height > 0 at every station        | `E.z − T.z ≥ minRailHeight` (validator); the converter lifts knife tips to it (§9.6)                         |
| No degenerate normals on the band       | follows from the three above and fullness ≥ 0.05; a test counts `SAMPLE_DEGENERATE` flags on a dense plan: 0 |

**The B-rep needs nothing new.** Three faces: the deck (a clamped height field trimmed by the
deck-edge pcurve), the band (periodic in u, clamped in v, natural boundary, one seam at u = 0)
and the bottom (trimmed by the tuck pcurve). Edges: deck edge (closed), tuck (closed) and the
seam; vertices: the two seam ends. Euler–Poincaré: V − E + F − (L − F) = 2 − 3 + 3 − 0 = 2.
That is V2's and V5's topology, which `checkBrep`, `writeStep` and the OCCT protocol already
accept (geom §15.5). The Phase 1 critic's gap 4 (no poles or collapsed edges in the writer)
does not arise.

**Rejected alternatives:**

| Option                                                    | Why not                                                                                                                                                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collapsed edges / poles in geom                           | `VERTEX_LOOP` or degenerate `EDGE_CURVE`s in STEP, undefined normals at the pole, singular solver rows, OCCT's degenerated-edge handling to validate (V6 is still unbuilt). Needed only by x-slicing. |
| Pole-free multi-patch tip (a Cobb-style tip patch)        | A hand-built patch layout per tip shape: the untrimmed Class-A approach plan §3.2 rejected, and a fourth and fifth face with G1 joins to maintain.                                                    |
| A tiny rounded cap (the classic's planar cap, made round) | Adds a face and a crease at every tip, which is the classic flaw restated.                                                                                                                            |

**Tip finish.** Pointed plan tips become a small radius (`cornerFilletRadius` in the
converter, D12's "small radius"), and the profile at the tip is a rail profile of at least
`minRailHeight`. Where a classic tip is sharper or thinner, the deviation report attributes
the difference to `tip` (§10.3).

---

## 5. Rail laws

### 5.1 Lanes

| Lane            | Unit     | Range (named)                  | Meaning                                                                                     |
| --------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `deckInset`     | cm       | [`minInset`, ∞)                | Plan distance from the apex inwards to the deck edge (the shaper's top band mark).          |
| `tuckInset`     | cm       | [`minInset`, ∞)                | Plan distance from the apex inwards to the tuck.                                            |
| `apexHeight`    | fraction | `apexHeightRange` [0.05, 0.95] | Apex height as a fraction from the tuck to the deck edge (the classic "apex": 0.4 = 60/40). |
| `upperFullness` | fraction | `fullnessRange` [0.05, 1]      | Handle fraction of the upper profile towards its corner (2/3 = parabola, 1 = boxy).         |
| `lowerFullness` | fraction | `fullnessRange`                | The same below the apex.                                                                    |
| `edgeHardness`  | fraction | [0, 1]                         | Tuck crease as a fraction of the chord angle (0 = soft roll, 1 = straight to the apex).     |

Lane values are never clamped silently. `validateBoard` certifies each Bézier segment's value
polygon inside the lane's range (sufficient by the convex hull property) and reports
`law-out-of-range` otherwise. Insets are the exception that is computed, not stored: the
effective inset is `min(law, insetCurvatureFraction · ρ(u))` (§5.3), and the report says
where the curvature limit is active.

Blend bulge (plan §3.3's weight table) is not a separate lane in Phase 2: fullness acts on
both handles of a half-profile. Adding a lane is additive (`laws` is a record keyed by lane).

### 5.2 Keys and ease

`LawCurve = { domain: 'half' | 'full'; keys: LawKey[] }`,
`LawKey = { s, value, in?, out? }`, `EaseHandle = { ds ≥ 0, dv }`.

- **Segment.** Between keys k and k + 1 the law is a cubic Bézier in the (σ, value) plane:
  `(s_k, v_k)`, `(s_k + out.ds, v_k + out.dv)`, `(s_{k+1} − in.ds, v_{k+1} − in.dv)`,
  `(s_{k+1}, v_{k+1})`. With `out.ds + in.ds ≤ s_{k+1} − s_k` the σ-component is monotone
  (its derivative is a quadratic Bézier with non-negative coefficients), so the value at σ is
  unique: bracketed Newton on σ(t) = σ, stopping at `paramRel` (geom tolerance).
- **Auto handles** (an absent `in`/`out`): `ds` = a third of the segment, `dv = m_k · ds`, with
  `m_k` the Fritsch–Carlson monotone slope (finite-difference slope, zero at a local extremum
  of the key values, limited so the segment stays monotone). A third gives σ(t) exactly linear
  in t, so an all-auto law is exactly the monotone cubic Hermite interpolant of its keys: no
  overshoot beyond the key values, C¹, and a closed-form oracle.
- **Half domain** (symmetric boards): keys on σ ∈ [0, ½] with keys at exactly 0 and ½; the
  law on (½, 1) is `v(1 − σ)`. C¹ across the tips requires zero slope there, so the end keys'
  outer handles are flat by construction (auto) or validated (`law-tip-slope`).
- **Full domain** (Phase 6): keys wrap; the segment from the last key to the first runs
  across σ = 1.
- **Keys over x** (bottom features, §6.2) use the same `KeyedCurve` with `s` in cm.

### 5.3 From laws to rows: the profile construction

At a band column i with Greville parameter ū_i and σ_i = σ(ū_i), evaluate the six lanes. In
the station plane (horizontal axis ô outward, ẑ up):

1. **Plan points.** `A.xy` = the plan control point i; `E.xy = A.xy + w_d n̂_i`,
   `T.xy = A.xy + w_t n̂_i` with the effective insets `w = min(law, κ ρ(ū_i))`
   (κ = `insetCurvatureFraction`). The rows are offsets of control points, not of the curve;
   with the frame turning at most `maxFrameTurn` per span (§5.4) the row differs from the
   true offset curve by about `w Δθ² / 8` (≤ 0.05 mm at w = 5 cm, Δθ = 5°), so the lane means
   what it says.
2. **Heights.** `E.z = D(E.xy)`, `T.z = B(T.xy)` (surface evaluations; rows 0 and 6 are fitted
   onto the surfaces exactly in §5.5), `A.z = T.z + α (E.z − T.z)` with α the apex height.
3. **Slopes** in the station plane: `s_d = ∂D/∂ô` at E, `s_b = ∂B/∂ô` at T.
4. **Upper half-profile** (E → A). Corner `C_u = E + w_d ô + s_d w_d ẑ` (the deck's tangent
   line meeting the apex vertical); `H_u = C_u.z − A.z` must be > 0, else
   `rail-profile-invalid` at that σ (the deck already falls below the apex height there).
   `P0 = E`, `P1 = E + f_u (C_u − E)` (along the deck tangent: G1), `P2 = A + f_u H_u ẑ`
   (vertical), `P3 = A`. With f_u = 2/3 this is the degree elevation of the quadratic Bézier
   (E, C_u, A): an exact parabola.
5. **Lower half-profile** (A → T). Soft corner `C_l = T + w_t ô + s_b w_t ẑ`;
   `H_l = A.z − C_l.z > 0` required. `P4 = A − f_l H_l ẑ`. The tuck handle starts along the
   bottom tangent `(C_l − T)` and is rotated in the station plane towards the **handle chord**
   `P4 − T` by `h · φ_chord`, where `φ_chord` is the angle from the bottom tangent to `P4 − T`;
   `P5 = T + f_l |C_l − T| · rot(û_b, h φ_chord)`, `P6 = T`. Every h ∈ [0, 1] keeps the lower
   profile convex (at h = 1, P5 lies on the segment T–P4); the crease angle between bottom and
   band at the tuck, in the station plane, is `h φ_chord`. (Step S3 changed the target from
   the chord `A − T`, which is not convex above `h = φ′/φ`: S3 deviation 1.)

All seven points lie inboard of or on the apex vertical, so by the convex-hull property no
profile reaches past its apex. (The construction puts them there; the two handles an offset
can move, P1 and P5, are refused past it as `rail-profile-invalid`: S3 review fixes.) Classic-preset equivalence: with `deckInset = deckBand ×
halfWidth` and `tuckInset = bottomBand × halfWidth`, the classic `apex` and board2
`apexHeight` are the same quantity (both measured between the band marks); `edge` and
`fullness` map monotonically but not identically, and the converter's preset-recovery test
(§13.2) records the map.

### 5.4 Station spacing: the law basis

The band's u-basis starts as the plan basis and is refined by inserting knots at span
midpoints (in symmetric pairs) until every span satisfies:

1. the plan tangent turns at most `maxFrameTurn` (5°) across it (exact on the Bézier pieces:
   the hodograph's angle range);
2. its arc length is at most `maxStationSpacing` (5 cm), so Phase 3 always has a rail handle
   at least that often;
3. **law fidelity**: the laws measured back from the built band at the span's mid parameter
   (§5.7) match the law values there within `lawTolerance` per lane;
4. the deck join angle (§3.5) is within `deckJoinAngleTol` over the span.

Conditions 3 and 4 need the built band, so the builder iterates stages 4–11 of §6.3 at most
`maxBandRefinePasses` times; the last pass that improved is kept and an unmet target is a
`not-converged` warning with the location, never silent. Law keys do not force knots: laws
are C¹ in σ and the fidelity check sees their curvature.

### 5.5 Boundary rows onto the surfaces

After the rows are built on the law basis, rows 0 and 6 must lie on the deck and bottom:

1. Their plan curves are exact (control-point rows on the band basis).
2. Each has an exact pcurve on its height field (the affine map of §3.4).
3. The edge's height over the **same parameter**, `z(u) = D(x(u), y(u))`, is fitted by
   periodic least squares on the band basis (x and y are exact, so the foot of every sample is
   known) and verified at `verifyFactor ×` denser samples (`build.edgeFit`), to within
   `Tolerances.fit`. (S3 deviation 2: geom's `curveOnSurfaceTo3d` returns a clamped curve,
   whose end knots cannot join a periodic band basis without a C⁰ seam.)
4. Where the fit misses, the failing spans are split (with their mirrors) by the band loop of
   §5.4 and the band is rebuilt on the finer basis, so every row stays on one basis.
5. Rows 0 and 6 take the fitted z (their x, y stay the exact plan rows); in symmetric mode
   partner columns are averaged (a convex combination of curves within `fit` of a symmetric
   target stays within `fit`).
6. Rows 1 and 5 move by the same Δz as their boundary row, so the handle vectors (and the
   deck join) keep their stage-1 quality.

The gap between band and deck is then the z-fit's error: measured by `checkBrep` and declared
as STEP uncertainty, exactly as V5's fitted deck (geom §15.5).

### 5.6 Rational (conic) rails: deferred (D5)

Phase 2 profiles are polynomial cubics. Reasons, all measured or structural:

- Rational fairness assembly costs 1.0–2.8 s for a 64 × 8 band (geom §17, P12r, P13r)
  against 2.3 ms polynomial: every Phase 3 pointer-down on the rail would take seconds.
- geom's bitwise mirror needs unit weights (geom §10.3); rational rows would make the
  symmetric overwrite approximate.
- Volume quadrature of polynomial faces is exact at fixed Gauss–Legendre orders; rational
  faces go adaptive (geom §11.3).

**Left open:** whether a conic profile (weight on rows 1, 2, 4 and 5, one weight per row so u
stays polynomial) is worth it once geom's rational Gram assembly is fixed (the P12r tier-2
candidates); whether fullness should then map to ρ of a conic (ρ = ½ is our f = 2/3
parabola); and whether exact circular rails matter to shapers. The profile construction is
one function (`profileRows`) returning rows and weights (all 1 today), so adopting it later
changes that function and the weights, not the data model.

### 5.7 Measuring laws back

At any u, the iso-curve in v is two cubic Béziers whose control points are
`Σ_i M_i(u) P_ij`. α, f_u, f_l, h and the insets are read off those points with the formulas
of §5.3 inverted (f_u from P2: `(P2.z − A.z)/H_u`, h from P5's angle). This is exact at the
Greville stations of a law-only band and defines "the law the surface actually has" between
them: the fidelity check (§5.4) and the converter's law extraction (§9.7) both use it.

---

## 6. Offset layer, bottom features, evaluation order

### 6.1 Offset layer (rail-local, survives law changes)

`OffsetLayer = { basis: { degree, knots } | null; rows: OffsetField[] }`: one periodic spline
basis over σ (period 1) shared by every field, and per row a field with only the components
that row's structural rule allows:

| Row          | Components | Meaning                                                        |
| ------------ | ---------- | -------------------------------------------------------------- |
| `deckEdge`   | `n`        | inset tweak (moves the deck edge in plan; z stays on the deck) |
| `deckHandle` | `l`        | handle length along τ_d (keeps the deck join G1)               |
| `apexUpper`  | `z`        | vertical handle length                                         |
| `apexLower`  | `z`        | vertical handle length                                         |
| `tuckHandle` | `n`, `z`   | free in the station plane                                      |
| `tuck`       | `n`        | inset tweak (z stays on the bottom)                            |

The apex row has no offset: it is edited only through the outline and the apex-height law
(plan §3.3), so no offset can move the outline. A field is evaluated at each band column's
Greville σ and applied in that column's frame. Because it is keyed on σ and relative to the
frame, a later law change, refinement or outline edit re-applies it in the new geometry.
Phase 3 writes direct control-point edits into it (the solver works in exactly these
components); the converter writes the residual of its band fit into it (§9.7).

### 6.2 Bottom feature layers

`BottomFeature = VeeFeature | ConcaveFeature | ChannelsFeature`, each with an `id`, `enabled`,
a longitudinal `depth: KeyedCurve` over x in cm (zero outside its keys) and a lateral shape in
**η = y / h_t(x)**, where `h_t(x)` is the tuck loop's half-width at x (from the tuck plan
curve, which does not depend on the bottom, so there is no cycle):

| Kind       | Parameters                                                                   | Displacement d(x, η) added to z                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vee`      | `depth`, `stringerRadius` (fraction of h_t)                                  | `depth(x) · g(\|η\|)`, g linear in \|η\| with a C¹ parabolic blend of half-width `stringerRadius` at the stringer, `g(1) = 1` (rails rise by `depth`, the stringer stays)                                                            |
| `concave`  | `layout: 'single' \| 'double'`, `depth`, `centre`, `width` (fractions)       | `depth(x) · bump((\|η\| − centre)/width)` (centre 0 when single), `bump(t) = (1 − t²)²` on \|t\| < 1: zero value and slope at its edges. A positive depth raises the bottom into the board, the hollow a concave is (S4 deviation 1) |
| `channels` | `count`, `depth`, `width` (cm), `pitch` (cm), `railInset` (cm from the tuck) | `count` narrow concaves in absolute cm: `depth(x) · Σ_k bump((\|y\| − (h_t − c_k))/(width/2))`, `c_k = railInset + width/2 + k · pitch`                                                                                              |

Evaluation: each feature is sampled on a grid over the tuck region and fitted onto the
bottom's basis refined by the feature's own knot lines (least squares on fixed bases, no
parameter correction: height fields, §3.4; solved separably, geom's `approximateCurve` down
the grid's columns and then along its rows, the same minimiser as `approximateSurface` on
the grid, S4 as built), within `featureTol`. The fitted displacements are
added to the base bottom after making the bases compatible (exact), so the sum is
independent of order up to rounding (a test). Features end in zero value and slope before the
tuck unless a feature explicitly reaches it, so `edgeHardness` keeps its meaning.

Limit: a channel's steep walls need fine knots, and tensor-product refinement spreads them
across the whole bottom (cost, not correctness). Where `h_t` varies the walls' C¹ break lines
curve across the grid: two 2 cm channels reaching the tail arc refine to a 141 × 337 net in 6
passes (fit 5.0 s, `buildBoard` 22.7 s, measured in S4 as built). Hierarchical splines stay
deferred (plan §3.4); the cost is benchmarked (§13.5, Q7).

### 6.3 Evaluation order

1. Revive and validate the doc.
2. Plan loop → `PeriodicCurve<2>`, frames, σ(u), curvature radius.
3. Deck and base bottom → surfaces.
4. Law basis (§5.4 conditions 1–2).
5. Insets (laws + `n` offsets of rows 0 and 6) → deck-edge and tuck plan curves; check them.
6. Bottom features → bottom total.
7. Heights, slopes and apex z at every column.
8. Profile rows (§5.3).
9. Boundary rows onto the surfaces (§5.5).
10. Offsets on rows 1, 2, 4, 5.
11. Symmetric overwrite.
12. Measure laws, deck join, tuck crease and apex angle; refine and repeat 4–11 if needed.
13. B-rep: assemble with the designed senses of §7, `checkBrep` (which refuses an inside-out
    or non-finite volume; `orientBrep` is not called: S7 as built, item 11).
14. On demand: specs, STEP, tessellation.

Each stage reads only the doc parts and stages above it, so a law edit reuses stages 2, 3 and
6, and a feature edit reuses 2–5.

---

## 7. B-rep and STEP

| Face     | Surface           | Boundary                                                                                             | `sameSense` (designed; `checkBrep` measures the outward volume) |
| -------- | ----------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `deck`   | deck height field | deck-edge pcurve (the exact plan map), CCW                                                           | true (n = +z)                                                   |
| `band`   | band (periodic u) | natural: row 0, seam, row 6, seam                                                                    | false for the u/v orientation of §3.5                           |
| `bottom` | bottom total      | tuck pcurve, clockwise in (u, v) (geom §6.19: a face with `sameSense` false runs its loop backwards) | false (outward is −z)                                           |

Edges: `deckEdge` and `tuck` are closed edges whose 3D curve is the band's boundary iso-curve
(exact on the band; master `.CURVE_3D.`) with an exact pcurve on the height field (gap = the
§5.5 fit, measured); `seam` is the band's u = 0 iso-line, from the deck-edge vertex to the tuck
vertex at the tail centre. `writeBoardStep` calls geom's `writeStep` and inherits its gate
(`checkBrep`), measured uncertainty and precision options. The board is validated through the
OCCT protocol of geom §15.3 by board2's own `*.occt.test.ts` (step S4), run by the root
`pnpm test:occt`.

---

## 8. Specs from the surfaces

| Spec           | Definition                                                                      | Computation                                                                                       | Accuracy                              |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Length         | x-extent of the apex loop (= of the solid, since the apex is the silhouette)    | roots of x′(u) on the plan's Bézier pieces (quadratics, closed form)                              | rounding                              |
| Width          | 2 × max y of the apex loop, and its x                                           | roots of y′(u), same                                                                              | rounding                              |
| Thickness      | max over x of deck − bottom at the stringer, and its x (the classic definition) | the stringer lines made compatible (exact), subtracted, roots of the derivative per piece         | rounding                              |
| Plan area      | area inside the apex loop                                                       | Green's theorem per Bézier piece with Gauss–Legendre of exact order (x·y′ has degree 5: 3 points) | rounding                              |
| Volume         | the solid                                                                       | `massProperties(brep).volume` (divergence theorem; exact rule for polynomial faces and pcurves)   | rounding + edge-gap term (§8.1)       |
| Surface area   | the skin                                                                        | `massProperties(brep).area` (adaptive Gauss–Kronrod to `quadRel`)                                 | `quadRel` + edge gaps                 |
| Centre of mass | centroid (x, y, z), uniform density                                             | `massProperties(brep).centroid`                                                                   | as volume; y = 0 by symmetry (a test) |

The thickness maximum must lie where both deck and bottom faces exist over the stringer
(between the deck-edge loop's and the tuck loop's stringer crossings); a maximum at an end of
that interval is a warning. Classic comparisons use the same definitions (§10.2).

### 8.1 Volume convergence test

Polynomial faces with polynomial trims make the divergence-theorem volume exact to rounding,
so "convergence" tests the geometry pipeline, not a quadrature rule:

1. **Refinement invariance.** Insert knots in every face (and the pcurves): the shape is the
   same, the volume must agree to 1e-12 relative. Catches span splitting and order bugs.
2. **Stadium identity (analytic).** A stadium plan (straight sides from collinear control
   points, round ends), flat deck and bottom, constant laws: the straight part of the band is
   an exact extrusion of the designed profile. Two boards whose straight length differs by Δ
   (extra collinear control points, same knot spacing) differ in volume by exactly
   `Δ × A_section`, where `A_section` is the deck-to-bottom rectangle between the deck edges
   plus two closed-form Bézier profile areas; plan area by `Δ × width`. Tolerance 1e-10
   relative (rounding of two quadratures and a subtraction).
3. **Plan-view quadrature.** An independent algorithm:
   `V = ∫∫ (z_top − z_bot) dA` over the apex loop, with z from the height fields inside the
   inset loops and from the band (plan map inverted by Newton) between them, adaptive
   Gauss–Kronrod per region. Agreement within `1e-7` relative, bounded by `quadRel` and the
   edge-gap term below.
4. **Mesh convergence.** `tessellateBrep` at chord tolerance 0.08, 0.04, 0.02, 0.01 cm: the
   mesh volume error ratio per halving is in 3.5–4.5 (O(h²)) and the Richardson extrapolation
   agrees with `massProperties` within 1e-5 relative.
5. **Fit sweep.** `Tolerances.fit` 1e-3, 1e-4, 1e-5 cm: the volume change is within the
   edge-gap bound `gap · perimeter · reach / 3` (geom's puck test) and shrinks with the gap.

---

## 9. Converter from the classic `BezierBoard`

`convertClassic(board, opts)` in `@openshaper/board2/classic`. It returns the doc, the built
board and a conversion report (achieved errors per stage, what was filleted, floored or
excluded, timings), or a `Board2Result` error.

### 9.1 Preconditions

- `hasTailCutout(board.outline)` → `unsupported-tail` (Phase 5).
- A board with no real station (fewer than three sections) → `too-few-sections`.
- `interpolationType` is irrelevant to the fit (the loft is the same for both); it only
  selects the classic spec-panel model the report compares against.

### 9.2 Classic sampling

- **Solid span and floor zones**: `surfaceStations(board).span` (the kernel's own `solidSpan`);
  the floor zones are the x outside it. No classic sample from a floor zone is used as data.
- **Loft samples**: rows at every `sampleSpacingX` (0.5 cm) and at every real station x ±
  `creaseProbe`; ring points at the classic's own `ringFractions(board, ringSamples)` (128 per
  half), mirrored; each sample keeps (x, ring fraction f, side, point).
- **Crease angles**: at each real station, the largest angle over f between the one-sided
  x-derivatives of the loft (difference quotients at ± `creaseProbe`, converging O(δ)).

### 9.3 Plan loop

- Outline points sampled by arc length (`arcLengthTable`, `pointAtArcFraction`), not by x:
  near the tips the outline is vertical in x. Mirrored into the full loop, CCW from the tail.
- **Corners**: a knot with `continuous: false` whose tangent turn exceeds `cornerAngleMin` is
  replaced by a fillet of radius `min(cornerFilletRadius, what fits in half of each
neighbouring segment)` before fitting. The fillet's plan deviation `r (1/sin(θ/2) − 1)` (θ
  the interior angle) is predicted and reported.
- **Fit**: `approximateCurve`, periodic, cubic, centripetal parameters, adaptive knots until
  `lineTol`, with point constraints `plan(0) = (0, 0)` and `plan(u_nose) = (L, 0)` and tangent
  constraints ∥ ŷ at both; then exact symmetrisation (each pair averaged and mirrored; the
  self-paired y set to 0).
- **Accuracy**: two-sided distance to the classic outline ≤ `lineTol` outside fillet zones,
  ≤ the predicted fillet deviation × 1.1 inside them.

### 9.4 Rocker and deck lines

Classic `valueAt(bottom, x)` and `valueAt(deck, x)` on x ∈ [`endGap`, L − `endGap`] (past the
classic's vertical end segments, which sit at x ≤ 1e-13). Fitted as non-parametric 1D splines
(parameter = affine x over the height fields' x-extent), adaptive knots until `lineTol`, with
fairness only where there are no data (the plan margin), weight by the discrepancy principle
(§9.8).

### 9.5 Insets

Keys at every real classic station σ (on the −y side for a half-domain law) with value
`fraction × halfWidth(x_k)` (`deckInsetFraction` 0.21, `tuckInsetFraction` 0.08: the medians of
the eight `RAIL_PRESETS`' `deckBand` and `bottomBand`), clamped to [`minInset`,
`κ ρ(σ_k)`]; tip keys at σ = 0 and ½ with the smaller of the neighbouring key and `κ ρ(tip)`.

### 9.6 Deck and bottom

- **Data**: upper-side samples inside the deck-edge loop plus a strip of `trimDataMargin`
  outside it (so the deck's slope at its edge follows the classic); lower-side samples inside
  the tuck loop plus the same strip. Membership by geom's certified `classifyUV` on the plan
  loops.
- **Bases**: u knots = the stringer line's knots ∪ uniform at `surfaceKnotSpacing.x`; v knots
  symmetric uniform at `surfaceKnotSpacing.y`.
- **Fit**: `approximateSurface`, parameters = the data's affine plan position (exact feet: a
  height field's vertical residual bounds the normal distance, so **no parameter correction**,
  which is most of P16's cost, geom §17), the stringer identity as n_u point constraints (§3.4),
  fairness by §9.8.
- **Refinement**: insert knots in spans whose residual exceeds `surfaceTol` outside the crease
  windows (± `creaseWindow` of each real station) and tip windows, never below
  `minKnotSpacing` in x (S6 as built, deviation 10: v is not floored), at most
  `maxRefinePasses`: refining further would resolve the classic creases themselves, which is
  what Phase 2 removes.
- **Knife tips**: if a station's rail height `E.z − T.z` is below `minRailHeight`, equality
  constraints `D(E) − B(T) = minRailHeight` are added at the violating stations and the deck
  refitted (active set, at most `maxRefinePasses` rounds). Reported as the board2 tip floor.
- Exact symmetrisation as for the plan.

### 9.7 Band, laws and offsets

As built (S7, §14 "S7 as built" 1–7): the fit is written out with bounds, the apex is a law
fitted to the classic apex before the fit (not a fit unknown), the initial apex follows the
classic, the other lanes interpolate their station values, and the document builds on the
fit's basis.

1. **Initial band**: the doc so far with constant laws from `DEFAULT_RAIL_LAWS` (the 60/40
   tucked preset: apex 0.4, fullness 0.6, hardness 0.5) built by the core builder.
2. **Data**: classic samples outside the inset loops (upper side outside the deck edge, lower
   side outside the tuck), floor zones excluded; initial (u, v) by warm-started batch
   projection onto the initial band (`projectPointsToSurfaceInto`, P17's warm path).
3. **Free fit** with geom's solver: a `FairProblem` whose DOF map holds the structural rules of
   §3.5 plus the symmetry rules of §3.7 (rows 0 and 6 fixed, row 3 z free), data as soft
   targets, fairness on the displacement from the initial band (weight by §9.8), then
   `parameterCorrection` passes (re-project, re-solve) until a pass improves the judged
   maximum by less than `bandCorrectionStall`, at most `maxBandCorrectionPasses` (review of S7).
4. **Law extraction**: at every band column, measure the six lane values (§5.7); fit each
   lane's key values at the classic station σ's by linear least squares (auto handles are
   linear in the values), keys at the tips as §9.5.
5. **Offsets**: rebuild the band from the laws alone; the difference to the fitted band,
   expressed in each column's frame and its row's components, is interpolated at the Greville
   σ's into the offset fields (`interpolatePeriodic`, exact at the data).
6. **Identity**: building the final doc (laws + offsets) reproduces the fitted band within
   1e-9 cm (a test). The laws carry what a shaper reads; the offsets carry the rest.

### 9.8 Fairness weights: the discrepancy principle

Every fit that needs fairness (lines over the margin, height fields, the band) uses the
largest weight whose fit still meets its data tolerance, found by bisection in log scale over
a bracket relative to the data term (`ratio = β · tr(G₂) / tr(AᵀWA)` in
`fairnessRatioBracket`, `fairnessSearchSteps` halvings). No weight is a constant in the code.

### 9.9 Classic presets and the sample files

| Classic                           | board2                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| outline                           | plan loop (§9.3)                                                                                            |
| bottom / deck curves              | the stringer iso-lines of the bottom and deck, identical to the fitted lines (§3.4)                         |
| cross-sections                    | split between deck, bottom and band by the inset loops; the band part becomes laws + offsets                |
| rail preset `apex`                | `apexHeight` (same quantity when the insets equal the preset's band marks)                                  |
| rail preset `edge`, `fullness`    | `edgeHardness`, `upperFullness`/`lowerFullness`: monotone maps measured by the preset-recovery test (§13.2) |
| `deckBand`, `bottomBand`          | `deckInset`, `tuckInset` as fractions of the half-width                                                     |
| corner knots in sections          | tuck side: hardness; deck side: not reproducible (G1 deck join), reported as `profile-corner`               |
| floors, dummy end sections        | not data; tips from the plan loop and the fitted surfaces                                                   |
| vertical end segments of the deck | the band's profile at the tail and nose centres                                                             |
| `fins`, metadata                  | carried (§3.10)                                                                                             |

Per file: the three goldens and their four copies convert with round tips (funboard,
longboard) or the shortboard's nose fillets; the polygonal synthetic files exercise
`profile-corner` and the hardness extraction; the two knife-tip files exercise the rail-height
floor; the two zero-volume files are compared against the classic loft volume (§10.4).

---

## 10. Deviation report

`deviationReport(classic, built, opts)` in `@openshaper/board2/classic`, run for every sample
file by a test and rendered as markdown for the Phase 2 report.

### 10.1 Surface distance

- **Classic → board2**: classic loft samples (rows every `reportSpacingX`, 0.25 cm, and the
  real stations; 256 ring points per half) projected onto the three trimmed faces with warm
  starts along each row (`closestPointOnTrimmed`, batch path); the signed distance is positive
  where board2 lies outside the classic.
- **Board2 → classic**: the vertices of `tessellateBrep` at 0.01 cm chord, each measured in its
  own x-plane against a 1,024-point classic loft ring at that x. That in-plane distance is an
  upper bound of the 3D distance (the same device as `ringDistance` in `board-surface.ts`), so
  it can only over-report.
- The two maxima together estimate the Hausdorff distance. Arrays are kept so Phase 3's
  deviation display can reuse them.

### 10.2 Spec deltas

Length, width, thickness (and their positions), plan area, volume, surface area (board2 only),
centre of mass x, against the classic spec panel (`getLength`, `getMaxWidth`,
`getMaxThicknessAndPos`, `getArea`, `getVolumeAndCenterOfMass`).

### 10.3 Causes

Every distance sample above `unexplainedMax` (0.1 mm) must carry a cause; the report fails
otherwise. Causes and the evidence each one needs:

| Cause            | Where                                                                        | Evidence                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `station-crease` | within `creaseWindow` of a real station with crease angle ≥ `creaseAngleMin` | **Counterfactual**: the same samples against a crease-free classic reference (the kernel's `interpolateSurface` through the same rows **without** `uBreaks`) stay ≤ `unexplainedMax` |
| `tip`            | within `tipWindow` of an end, or a floor zone                                | bounded by the local box: ≤ min(local half-width, local thickness) of the classic                                                                                                    |
| `corner-fillet`  | a converted outline corner's fillet zone                                     | ≤ 1.1 × the predicted fillet deviation                                                                                                                                               |
| `profile-corner` | near a classic section corner on the deck side or upper rail                 | the classic knot is non-continuous with turn ≥ `cornerAngleMin`                                                                                                                      |
| `fit`            | anywhere else                                                                | must be ≤ `unexplainedMax`, else the report fails                                                                                                                                    |

### 10.4 Spec-level causes and the volume budget

- **`classic-model-split`**: `V_loft − V_spec`, with `V_loft` the classic loft's own volume
  (adaptive Simpson over x of the loft ring's polygon area at 1,024 points, Richardson in the
  ring count). board2 fits the loft, so it is compared with `V_loft` and the rest of the spec
  delta is this split.
- **`classic-quadrature`**: the spec panel's inner trapezoid (`sectionSplits` 10) against
  `sectionSplits` 1,000.
- **`classic-defect`**: a spec-panel value that is wrong by the classic's own geometry (the two
  zero-volume files, §2.3).
- **Volume budget identity**: `V_board2 − V_loft ≈ ∮ d dA` (signed distance integrated over the
  classic surface, first order). The report checks
  `|(V_board2 − V_loft) − ∮ d dA| ≤ volumeBudgetTol · V` and splits `∮ d dA` by cause zone, so
  the volume delta is attributed in cm³ to creases, tips, fillets, profile corners and fit.
- Length, width and thickness deltas are explained by the line fits (≤ `lineTol`) and, at the
  ends, by fillets and the tip floor. A flat tip's arc keeps the tip centre; a **pointed**
  tip's fillet moves it inwards by its predicted deviation (S6 as built, deviation 1), so on
  the seven synthetic files the length delta is the two tips' predicted deviations
  (2.4–3.3 cm), attributed to `corner-fillet` exactly, not within the 1 mm checkpoint.

---

## 11. Public API, module layout, layering

### 11.1 Layout

```
packages/board2/
  package.json  tsconfig.json  vitest.config.ts
  src/
    index.ts              explicit named exports (decision 31)
    types.ts              document and built-model types (type-only)        [scaffold]
    issues.ts             Board2Issue codes, Board2Result helpers
    params.ts             DEFAULT_BUILD_PARAMS, DEFAULT_RAIL_LAWS, param validation
    doc.ts                reviveBoardDoc, canonical JSON
    validate.ts           validateBoard (standard tail, symmetry, ranges, loops, tips)
    law.ts                keyed curves: evaluation, auto ease, certificates
    plan.ts               plan loop: frames, σ ↔ u, radius, pairing
    height-field.ts       height fields: surfaces, affine maps, stringer lines
    symmetry.ts           pairing and the DOF rules of §3.7
    band/
      stations.ts         law basis refinement (§5.4)
      profile.ts          profileRows (§5.3), measureLaws (§5.7)
      snap.ts             boundary rows onto the surfaces (§5.5)
      band.ts             band assembly
    offsets.ts            offset layer (§6.1)
    features.ts           bottom features (§6.2)
    build.ts              buildBoard: the order of §6.3
    brep.ts               boardBrep, writeBoardStep
    specs.ts              boardSpecs (§8)
    testing/              subpath ./testing (test-only): stadium and analytic boards
    classic/              subpath ./classic: may import @openshaper/kernel
      index.ts  types.ts  [scaffold]
      sample.ts           loft sampling, floor zones, crease angles
      convert.ts          convertClassic (§9)
      extract.ts          law extraction and offset factorisation
      rail.ts             the rail stage of §9.7 (S7)
      band-fit.ts         the band fit's least squares (S7)
      lsq.ts              the height fields' least squares on z (S7)
      deviation.ts        deviationReport (§10)
      report.ts           markdown rendering
      test-support/       sample-file loading for tests (may import @openshaper/io, node:*)
```

### 11.2 API sketch (signatures; the types are in `src/types.ts` and `src/classic/types.ts`)

```ts
// @openshaper/board2
export function reviveBoardDoc(json: unknown): Board2Result<BoardDoc>;
export function validateBoard(doc: BoardDoc): readonly Board2Issue[];
export function buildBoard(doc: BoardDoc): Board2Result<BuiltBoard>;
export function boardSpecs(b: BuiltBoard): BoardSpecs;
export function writeBoardStep(b: BuiltBoard, opts?: StepWriteOptions): StepResult;
export function evaluateLaw(law: KeyedCurve | LawCurve, s: number): number;
export function measureLaws(b: BuiltBoard, u: number): RailLawValues; // §5.7
export function stringerLines(b: BuiltBoard): {
  readonly rocker: NurbsCurve<3>;
  readonly deck: NurbsCurve<3>;
};
export function symmetryRules(
  b: BuiltBoard,
  net: 'plan' | 'deck' | 'bottom' | 'band',
): readonly DofRule[];
export const DEFAULT_BUILD_PARAMS: BuildParams;
export const DEFAULT_RAIL_LAWS: RailLawValues;

// @openshaper/board2/classic
export function convertClassic(
  board: BezierBoard,
  opts?: Partial<ConvertOptions>,
): Board2Result<Conversion>;
export function deviationReport(
  classic: BezierBoard,
  built: BuiltBoard,
  opts?: Partial<DeviationOptions>,
): DeviationReport;
export function renderDeviationReport(r: DeviationReport): string; // markdown
export const DEFAULT_CONVERT_OPTIONS: ConvertOptions;
export const DEFAULT_DEVIATION_OPTIONS: DeviationOptions;

// @openshaper/board2/testing (tests only)
export function stadiumBoard(opts: StadiumOptions): BoardDoc;
export function notchedLoopFixture(): PlanLoopJSON; // bypasses the validator (§3.8)
```

### 11.3 Layering and dependencies

- `dependencies`: `@openshaper/geom` and `@openshaper/kernel` (`workspace:*`). The kernel is a
  dependency only for the `./classic` entry; the core entry never imports it, so an app that
  imports only `@openshaper/board2` bundles no classic code. `devDependencies`:
  `@openshaper/io` (`workspace:*`, tests load the sample files), `@types/node`, `typescript`,
  `vitest` (the kernel's versions). No runtime third-party dependency (plan §7).
- **ESLint** (`eslint.config.mjs`, additive, done in the scaffold):
  - `board2` joins `LAYERS`: its core (`src/**` except `src/classic/**` and
    `**/test-support/**`) may import `@openshaper/geom` only: no other workspace package, no
    React/DOM/three.js, no `node:*`, and not `./classic`, `./testing`,
    `@openshaper/board2/classic`, `@openshaper/board2/testing` or `@openshaper/geom/testing`.
  - A second entry for `src/classic/**` allows `@openshaper/kernel` and `@openshaper/geom` and
    forbids the rest (no io, units, store, render2d, render3d, export, ui; no UI; no
    `node:*`; no test-only subpaths).
  - Every existing package's entry lists `board2` as forbidden, geom's included.
  - **Apps (updated by the V1 viewer):** only `apps/web` may import `@openshaper/board2` and
    `@openshaper/geom`, and only the viewer's two worker modules,
    `apps/web/src/workers/nurbs-core.ts` and `nurbs-worker.ts` (`NURBS_VIEWER_MODULES` in
    `eslint.config.mjs`). Every other file of every app, the desktop shell included, still
    gets the `no-restricted-imports` error, whose message names those two modules. The rest of
    the app reaches them only through a dynamic `import()` of `nurbs-core` or a
    `new Worker(new URL('./workers/nurbs-worker.ts', ...))`, which is what keeps both packages
    out of the main chunk. Tests are exempt as everywhere. The viewer also imports
    `@openshaper/render3d/curvature-mesh` (a new subpath export of that package, pure: the
    classic mesh's display-scale percentiles), never the package root, so the worker bundles no
    three.js.
  - Tests, benches and `test-support/` are exempt, as for every layer.
- **Lockfile**: the new importer and its workspace links are the only `pnpm-lock.yaml` change;
  no package is downloaded (`pnpm install --frozen-lockfile --offline` passes).
- **Turbo**: no change; its generic `build`, `typecheck`, `test` and `coverage` tasks pick the
  package up.
- **CI**: no change at the scaffold (lint, typecheck and test cover it). Step S4 adds board2's
  OCCT tests to the root `test:occt` script, which the branch's `ci.yml` already runs.

---

## 12. Named parameters

Defaults are frozen records. Every geometry-affecting build parameter is **stored in the doc**
(`BoardDoc.build`), so a saved board rebuilds identically even if a default changes later.
geom's tolerances apply unless `build.tolerances` overrides them.

### 12.1 Build (`DEFAULT_BUILD_PARAMS`)

| Name                     | Default                                                     | Meaning                                                                                | Why this value                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minInset`               | 0.1 cm                                                      | Smallest deck or tuck inset                                                            | 1 mm: the scale of a CNC finishing feature (accuracy 0.1 mm) and 1,000 × `Tolerances.fit`, so the edge fits never touch the apex.                 |
| `insetCurvatureFraction` | 0.5                                                         | Effective inset ≤ this × plan radius of curvature where the loop turns inwards (κ > 0) | An inward offset by d of radius ρ has radius ρ − d; d ≤ ρ/2 keeps the inset loops at most 2× as tight as the apex and far from the cusp at d = ρ. |
| `minRailHeight`          | 0.1 cm                                                      | Smallest deck-edge to tuck height at any station                                       | Same 1 mm scale; below it the band is a knife the B-rep can hold but no blank can.                                                                |
| `apexHeightRange`        | [0.05, 0.95]                                                | Allowed apex heights                                                                   | Keeps both profile triangles of positive height (H_u, H_l > 0 needs margin from 0 and 1); 5% of a 2 cm rail is 1 mm.                              |
| `fullnessRange`          | [0.05, 1]                                                   | Allowed fullness                                                                       | Fullness 0 collapses the apex handles and the apex normal (§3.5); 1 puts the handles at the corner.                                               |
| `maxFrameTurn`           | 5°                                                          | Plan tangent turn per band span                                                        | Inset rows then differ from true offsets by ≈ w Δθ²/8 ≤ 0.05 mm at w = 5 cm.                                                                      |
| `maxStationSpacing`      | 5 cm                                                        | Arc length per band span                                                               | Phase 3's per-station rail handles at least this often; accuracy is the fidelity check's job, not this cap's.                                     |
| `lawTolerance`           | insets 0.005 cm, apex 0.002, fullness 0.005, hardness 0.005 | Law fidelity between stations (§5.4)                                                   | Insets 0.05 mm (half the CNC accuracy); apex 0.2% ≈ 0.04 mm on a 2 cm rail; fullness and hardness one step of a 200-step slider.                  |
| `deckJoinAngleTol`       | 0.1°                                                        | Deck/band normal angle                                                                 | The checkpoint's apex G1 bar (plan §7), applied to the other blended join.                                                                        |
| `apexJoinAngleTol`       | 0.1°                                                        | Acceptance of the apex join                                                            | Plan §7; the construction gives rounding (§3.5).                                                                                                  |
| `maxBandRefinePasses`    | 6                                                           | Refinement passes of §5.4                                                              | Each pass halves the worst spans; O(h²) errors fall 4× per pass, so 6 passes cover a 4,000× miss.                                                 |
| `planMargin`             | 2 cm                                                        | Height-field extent beyond the plan loop                                               | Room for Phase 3 outline edits without re-gridding; the trims never reach the domain edge.                                                        |
| `featureTol`             | 0.001 cm                                                    | Bottom feature fit error                                                               | `lineTol`: features are design intent like the lines.                                                                                             |
| `tolerances`             | `{}`                                                        | geom tolerance overrides                                                               | geom's defaults (`fit` 1e-4 cm) unless a caller needs otherwise.                                                                                  |
| `edgeFit`                | `{}`                                                        | geom `EdgeFitSampling` overrides                                                       | geom's defaults (`DEFAULT_EDGE_FIT`).                                                                                                             |

### 12.2 Converter (`DEFAULT_CONVERT_OPTIONS`)

| Name                      | Default                     | Why                                                                                                                                                                                                                          |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lineTol`                 | 0.001 cm                    | Two orders below the checkpoint's 1 mm, one below CNC accuracy; reachable with adaptive knots on C¹ Bézier data.                                                                                                             |
| `surfaceTol`              | 0.005 cm                    | The classic engine's own STEP-fit target (`DEFAULT_TOLERANCE`, `board-surface.ts`).                                                                                                                                          |
| `deckInsetFraction`       | 0.21                        | Median `deckBand` of the eight `RAIL_PRESETS`.                                                                                                                                                                               |
| `tuckInsetFraction`       | 0.08                        | Median `bottomBand` of the eight `RAIL_PRESETS`.                                                                                                                                                                             |
| `cornerAngleMin`          | 2°                          | Below this a non-continuous knot is smooth for practical purposes (the editor marks knots with zero-length handles as corners).                                                                                              |
| `cornerFilletRadius`      | 0.5 cm                      | D12's small tip radius; ≥ `minInset / insetCurvatureFraction` = 0.2 cm, so the minimum band fits.                                                                                                                            |
| `sampleSpacingX`          | 0.5 cm                      | Three samples per `minKnotSpacing` span.                                                                                                                                                                                     |
| `ringSamples`             | 128 per half                | Twice the classic STEP fit's 64 columns, on the classic's own curvature ladder.                                                                                                                                              |
| `lineSampleSpacing`       | 0.05 cm                     | S6: exact outline and stringer-line samples; a C² cubic needs spans of a few mm next to a 0.5 cm fillet, and the adaptive fit splits only spans with data.                                                                   |
| `creaseProbe`             | 0.01 cm                     | One-sided difference step: O(δ) truncation, and three orders below the closest pair of real stations (27.9 cm on the goldens), so no neighbour enters a quotient.                                                            |
| `endGap`                  | 0.001 cm                    | Past the classic's vertical end segments (x ≤ 1e-13), before any real shape change.                                                                                                                                          |
| `surfaceKnotSpacing`      | x 10 cm, y 5 cm (start)     | Coarse start; refinement decides.                                                                                                                                                                                            |
| `minKnotSpacing`          | 1.5 cm                      | Below this a span would resolve a classic crease (the hull's tangent break) as curvature.                                                                                                                                    |
| `creaseWindow`            | 3 cm (2 × `minKnotSpacing`) | A smoothed crease spreads over about one span each side.                                                                                                                                                                     |
| `tipWindow`               | 2 cm                        | On the goldens the end thickness grows by 8–14% over the first centimetre (the classic's vertical deck segment and outline turn); 2 cm covers that with margin.                                                              |
| `trimDataMargin`          | 1 cm                        | Classic data just outside the inset loops pins the surfaces' slope at their edges.                                                                                                                                           |
| `maxRefinePasses`         | 6                           | As `maxBandRefinePasses`.                                                                                                                                                                                                    |
| `maxBandCorrectionPasses` | 4                           | Review of S7 (was a fixed `bandCorrectionPasses` 2, which stopped before the correction converged): the goldens still gain 5–8 % per pass at the fourth; 6 passes reach the plateau for +41 % conversion time, 4 cost +21 %. |
| `bandCorrectionStall`     | 0.02                        | Stop once a pass (0.7–1.0 s) improves the judged maximum by less than 2 % of it: the synthetic files gain 0.1 % per pass and stop after one.                                                                                 |
| `fairnessRatioBracket`    | [1e-10, 1]                  | Fairness from negligible to equal to the data term; the search picks inside it (§9.8).                                                                                                                                       |
| `fairnessSearchSteps`     | 12                          | Bisection in log scale: 12 halvings of 10 decades ≈ a factor 1.0057 resolution.                                                                                                                                              |

### 12.3 Deviation report (`DEFAULT_DEVIATION_OPTIONS`)

| Name              | Default              | Why                                                                                                          |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `reportSpacingX`  | 0.25 cm              | Twice the converter's sampling density, so the report is not measured where the fit was made.                |
| `reportRing`      | 256 per half         | Same reason, on the ring.                                                                                    |
| `boardChord`      | 0.01 cm              | geom's `DEFAULT_TESSELLATION` chord.                                                                         |
| `unexplainedMax`  | 0.01 cm              | 0.1 mm, CNC accuracy; 2 × `surfaceTol` because the report samples twice as densely as the fit probes.        |
| `creaseAngleMin`  | 0.1°                 | A crease smoothed over `creaseWindow` displaces by about θ·w/4; below 0.1° that is under `unexplainedMax`/7. |
| `volumeBudgetTol` | 0.001                | 0.1% of V: the first-order budget's own error at these deviations.                                           |
| `specTol`         | L, W, T 0.1 cm; V 1% | The checkpoint (plan §7): hard pass/fail.                                                                    |

---

## 13. Tests, exit criteria, benchmarks

### 13.1 Cross-cutting

Public-API pin (`index.test.ts`); JSON round trip of every doc built in tests; immutability
(checksum of inputs before and after every public function, geom's `checksum`); finiteness of
every output; no tolerance literals in `src` (the same scan as geom, decision 16); every
randomised test seeded (`mulberry32`) and printing its seed; at least one recorded mutation
spot check per step (break the code, watch a named test fail, restore), as in Phase 1.

### 13.2 Per component

| Component      | Oracle                                                                                                                                                                                                                                                                                                                                                       | Tolerance and why                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `law`          | All-auto law = monotone cubic Hermite (closed form); keys reproduced exactly; no overshoot on monotone data; half-domain law C¹ at σ = 0, ½; certificate rejects an overshooting handle                                                                                                                                                                      | 1e-14 abs (a few flops); C¹ by one-sided derivatives within 1e-12             |
| `plan`         | Symmetric pairing on random symmetric bases; C(−u) = mirror(C(u)) bitwise after the overwrite; standard-tail certificate against dense sampling; radius on a circle-like loop vs its closed form                                                                                                                                                             | Bitwise; radius 1e-10 rel                                                     |
| `height-field` | x, y affine exactly (linear precision) on random knots; pcurve of a plan curve = affine image; stringer iso = target line after the constrained fit (identity, not closeness)                                                                                                                                                                                | Affine 1e-13 · extent; identity at `constraint`                               |
| `symmetry`     | geom `makeDofMap` accepts every rule set; a random solve on each net leaves partners `===` mirrors                                                                                                                                                                                                                                                           | Bitwise                                                                       |
| `profile`      | Stadium straight part: rows equal the closed-form construction; f = 2/3 gives the exact parabola; measured laws (§5.7) return the inputs at Greville stations; tuck crease angle = h·φ_chord; convexity for a law grid                                                                                                                                       | 1e-12 · scale; angles 1e-12 rad                                               |
| `band`         | **Apex normal angle** along the whole apex (dense, both sides) ≤ 1e-9 rad; **outline invariance**: any law or offset change leaves row 3's x, y bitwise equal; **rocker invariance**: bottom net bitwise unchanged; deck join ≤ `deckJoinAngleTol` after refinement and converging O(h²) before; fidelity met; no degenerate band normal                     | Apex 1e-9 rad (rounding on unit normals, far below 0.1°); invariances bitwise |
| `snap`         | Edge gaps from `checkBrep` ≤ `fit` and equal to independently sampled distances; handle vectors unchanged                                                                                                                                                                                                                                                    | `fit`; gaps 1e-12 · scale against the independent sampling                    |
| `offsets`      | Zero layer = identity (bitwise); an offset survives a law change at the same σ in the new frame; components restricted (apex untouched)                                                                                                                                                                                                                      | Bitwise; 1e-12 · scale                                                        |
| `features`     | Fit error ≤ `featureTol` against the closed-form d(x, η) (where `h_t` varies, with `h_t` inverted by the test); order independence; zero features = identity (bitwise)                                                                                                                                                                                       | `featureTol`; order 1e-12 · scale                                             |
| `brep`         | `checkBrep` ok, Euler 2, genus 0, outward volume; mutation catalogue from geom applied to boards; topology-agnostic notched loop builds (§3.8); **OCCT** (S4): B1–B4, B8 on the stadium and the three goldens                                                                                                                                                | As geom §15.3                                                                 |
| `specs`        | Stadium closed forms (length, width, plan area); Δ-length identity for volume and plan area (§8.1.2); refinement invariance; plan-view quadrature; mesh O(h²); centroid y = 0                                                                                                                                                                                | §8.1                                                                          |
| `convert`      | Every sample file converts and validates; line fits ≤ `lineTol`; factorisation identity ≤ 1e-9 cm; **preset recovery**: each classic preset applied to every station of each golden board (kernel `applyRailProfile`) converts back to its apex within 0.01, and varying one classic param at a time gives strictly monotone recovered hardness and fullness | Apex 0.01: the classic places the apex exactly; the rest is fit error         |
| `deviation`    | A board converted and compared with itself rebuilt (zero deviation); a deliberately shifted board (+δ in z) reads δ everywhere with the right sign; the budget identity on an analytic offset                                                                                                                                                                | 1e-9 cm; δ within 1e-9 cm                                                     |

### 13.3 Exit criteria (plan §6 Phase 2, as checks)

1. **Every sample file converts**: `convertClassic` is ok for all fourteen files; each result
   passes `validateBoard`, `buildBoard` and `checkBrep`; `writeBoardStep` succeeds; the three
   goldens pass the OCCT protocol (B1–B4, B8).
2. **Spec deltas**: |ΔL|, |ΔW|, |ΔT| ≤ 1 mm for every file (the checkpoint); |ΔV| ≤ 1% against
   the classic loft volume, and against the spec panel where it is not a `classic-defect`.
3. **Every difference explained**: no distance sample above `unexplainedMax` without a cause;
   the crease counterfactual holds at every station tagged `station-crease`; the volume budget
   identity holds for every file.
4. **Volume convergence test**: §8.1 items 1–5 green.
5. **Design invariants**: apex G1 ≤ 0.1° (measured; construction gives rounding), deck join ≤
   0.1°, tuck crease = law, outline and rocker bitwise invariant under law and offset changes.
   Law fidelity and the tuck crease are measured on the **law-only band** (the laws on the
   document's basis without the offset layer; review of S7): the offsets move rows by design
   (§6.1), so on a converted board the band with offsets cannot show the laws. The offset
   layer's own effect is reported separately (`BuildReport.offsetContribution`, the largest
   control-point move per row).
6. **Isolation**: `git diff f0c843f` shows no change under `packages/{kernel,io,units,store,render2d,render3d,export,ui}`
   or `apps/`, their tests and snapshots unchanged; geom changed only by the `testing/occt`
   subpath and any tier-2 item explicitly listed in the step that made it.
7. **Report**: the deviation reports of all fourteen files and the benchmark numbers are in the
   Phase 2 report (plan §5).

### 13.4 Benchmarks (`packages/board2/src/board2.bench.ts`)

Targets for the reference desktop (geom §9: Node 22, single thread); measured numbers from the
cloud container are reported beside them, and a miss is reported, not failed (geom decision 41).

| #   | Benchmark                                           | Size                  | Target   | Path (who needs it)                 |
| --- | --------------------------------------------------- | --------------------- | -------- | ----------------------------------- |
| Q1  | `buildBoard`, cold                                  | golden shortboard doc | ≤ 150 ms | file open (worker); Phase 3 settle  |
| Q2  | `buildBoard` after one law-key change (stages 4–13) | same                  | ≤ 60 ms  | Phase 3 rail-law editing, on settle |
| Q3  | `boardSpecs`                                        | same                  | ≤ 150 ms | the specs worker                    |
| Q4  | `writeBoardStep`, round-trip precision              | same                  | ≤ 150 ms | Phase 4 export                      |
| Q5  | `convertClassic`                                    | each golden board     | ≤ 3 s    | file open (worker), once per file   |
| Q6  | `deviationReport`                                   | each golden board     | ≤ 10 s   | tests and the Phase 2 report        |
| Q7  | Bottom features: one concave and one vee            | golden shortboard     | ≤ 50 ms  | Phase 3 feature editing, on settle  |
| Q8  | `measureLaws` at 1,000 u                            | golden shortboard     | ≤ 5 ms   | fidelity loop; Phase 3 law graph    |

### 13.5 Phase 1 misses and the Phase 2 paths they block

| Phase 1 miss (geom §17)                                          | Phase 2 path               | Effect and plan                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P22 `massProperties` 204 ms (target 50)                          | Q3 specs                   | The board has a 3-face B-rep like the puck; expect Q3 at ~P22. Tier-2 candidate: one multi-integrand pass per face (geom §17). Not blocking correctness.                                                                                                                           |
| P16 `approximateSurface` with correction 377 ms                  | Q5 converter               | Height-field fits need no correction (§9.6), which removes most of it; the band fit's correction passes remain (≤ `maxBandCorrectionPasses`, stopped on a stall).                                                                                                                  |
| P17 cold projection 0.25–0.3 ms per point                        | Q6 report, Q5 band data    | Use only the warm batch path (8.7 µs per point): 2·10⁵ report samples ≈ 2 s.                                                                                                                                                                                                       |
| P12r / P13r rational assembly 1–2.8 s                            | rational rails             | The reason D5 is deferred (§5.6).                                                                                                                                                                                                                                                  |
| P18 edge fit 23.6 ms (met)                                       | Q1, Q2 (two edge fits)     | Within budget.                                                                                                                                                                                                                                                                     |
| P22-class trimmed integration (`orientBrep`, `checkBrep` volume) | Q1 with a fine feature net | Channels on the tail arc: a 141 × 337 bottom, 17 s of a 22.7 s `buildBoard` in the two signed-volume integrations (S4 as built). S7 made the tier-2 change (the exact Green rule's strip cache) and dropped `orientBrep`: converted boards build 3–7× faster (S7 as built, 11–12). |
| P13/P14 solver prepare/solve, P7/P8 plans, P20/P21 tessellation  | none in Phase 2            | Phase 3's drag and display paths.                                                                                                                                                                                                                                                  |
| Reference-desktop re-measurement (open)                          | every target above         | Still blocks tier-2 work; board2's numbers are recorded on the same container class and re-measured with geom's.                                                                                                                                                                   |

---

## 14. Implementation steps

Each step is one agent session, lands as its own commit(s) with its oracles, keeps `pnpm
lint`, `pnpm typecheck` and `pnpm test` green, and records one mutation spot check. "Tier"
recommends the difficulty: **G** = geometry correctness (algorithm design, numerical
judgement), **R** = routine (wiring, data, reports against a fixed spec).

| Id  | Title                                       | Tier | Depends  | Contents                                                                                                                                                                                   | Exit check                                                                                                                                                                                 |
| --- | ------------------------------------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | Document, laws and validation               | R    | scaffold | `issues.ts`, `params.ts`, `doc.ts` (revive, JSON), `law.ts` (§5.2), the structural and range parts of `validate.ts`; public-API pin grows                                                  | `pnpm --filter @openshaper/board2 test`: law oracles (Hermite closed form, C¹ at tips, certificate), JSON round trip, revive rejects every malformed field with its code                   |
| S2  | Plan loop, height fields and symmetry       | G    | S1       | `plan.ts`, `height-field.ts`, `symmetry.ts`; plan invariants 1–4 (standard-tail certificate, radius) in `validate.ts`; `stringerLines`; `testing/` stadium plan and notched loop           | Pairing and mirror rules bitwise through geom's solver; affine exactness; stringer identity at `constraint`; notched loop refused with `tail-not-standard`                                 |
| S3  | Rail band builder                           | G    | S2       | `band/` (stations, profile, snap, band), `offsets.ts`, `measureLaws`; build stages 2–5 and 7–12 of §6.3                                                                                    | Apex angle ≤ 1e-9 rad; outline and rocker bitwise invariant under law/offset changes; tuck crease = law; deck join ≤ 0.1° with O(h²) before refinement; fidelity met; no degenerate normal |
| S4  | Bottom features, B-rep, STEP and OCCT       | G    | S3       | `features.ts`, `brep.ts`, `buildBoard` complete; geom `./testing/occt` subpath (the §15.3 protocol extracted from `step.occt.test.ts`); board2 `test:occt`, root script runs both packages | `checkBrep` ok and Euler 2 on the stadium and notched loop; feature oracles; `pnpm test:occt` green for the stadium board                                                                  |
| S5  | Specs and the volume convergence test       | R    | S4       | `specs.ts` (§8), `boardSpecs`; §8.1 items 1–5; benchmarks Q1–Q4, Q7, Q8 scaffolded                                                                                                         | §8.1 green at its tolerances; stadium closed forms; centroid y = 0                                                                                                                         |
| S6  | Converter I: sampling, lines, height fields | G    | S3       | `classic/sample.ts`, plan loop with fillets, stringer lines, insets, deck and bottom fits (§9.2–9.6, §9.8); `classic/test-support/` sample loader                                          | All fourteen files: plan and lines ≤ `lineTol` (fillet zones as predicted); deck/bottom residual ≤ `surfaceTol` outside crease and tip windows; knife tips floored                         |
| S7  | Converter II: band, laws, offsets           | G    | S4, S6   | `classic/extract.ts`, the band fit and factorisation (§9.7), `convertClassic` complete                                                                                                     | Exit criterion 1 for all fourteen files; factorisation identity ≤ 1e-9 cm; preset recovery (apex ≤ 0.01, monotone hardness and fullness)                                                   |
| S8  | Deviation report                            | R    | S5, S7   | `classic/deviation.ts`, `classic/report.ts` (§10); the exit-criteria test over all sample files                                                                                            | Exit criteria 2–3 for every file; the self-comparison and shifted-board oracles                                                                                                            |
| S9  | Benchmarks and the Phase 2 report           | R    | S8       | `board2.bench.ts` Q1–Q8, `bench:check` baseline like geom's, the reports and numbers in this file and `geometry-overhaul.md` §6, `QUALITY_REPORT.md` entry on the branch                   | Exit criteria 4–7; numbers recorded with machine details                                                                                                                                   |

### S1 as built (2026-10-21)

Files: `issues.ts`, `params.ts`, `freeze.ts`, `doc.ts`, `law.ts`, `validate.ts`, the test
fixture `testing/sample-doc.ts`, and tests for each plus `no-magic-tolerances.test.ts` (the
geom scan, over board2's sources; `params.ts` and the `testing/` and `test-support/`
directories are exempt by name). 124 tests. Public values added to the pin: `reviveBoardDoc`,
`boardDocToJson`, `validateBoard`, `validateBuildParams`, `evaluateLaw`, `lawEvaluator`,
`lawSegments` (+ type `LawSegment`), `DEFAULT_BUILD_PARAMS`, `DEFAULT_RAIL_LAWS`, `RAIL_LANES`,
`BOARD2_ISSUE_CODES`, `board2Ok`, `board2Err`, `hasErrors`. Internal to the package (tested
through their modules, not in the pin): `checkLawKeys`, `certifyLawRange`, `lawValueRange`,
`laneRange`, `OFFSET_ROW_COMPONENTS`, `makeIssue`, `causeOf`, `LAW_ROUNDING_REL`.

**Deviations and clarifications** (the design was silent, ambiguous or wrong in these details):

1. **Revive versus validate.** `reviveBoardDoc` checks shape (types, finiteness, enums, no
   unknown keys, array sizes, and every spline basis through geom's `clampedBasis` /
   `periodicBasis` under the document's own `build.tolerances`, with the geom issue as
   `cause`); `validateBoard` judges the board (key order, tips, ranges, parameters). A document
   that is shaped right but designed badly therefore opens and can be repaired. An unknown
   `tail.kind` revives to `tail-not-standard`, not `doc-malformed`; `symmetry: 'none'` revives
   and is refused by `validateBoard`.
2. **End slopes of auto ease.** §5.2 fixes the half-domain tips at slope zero. The same rule
   is used at the first and last key of a plain (feature depth) curve, so a depth that starts
   and ends at zero is C¹ with the zero outside it; a full-domain curve uses its cyclic
   neighbours. The monotone slope is the three-point finite difference limited to 3 × each
   adjacent secant (the Fritsch-Carlson box), and the auto handle value is clamped between its
   two key values so a handle never leaves them even in rounding.
3. **Plain `KeyedCurve` evaluates to 0 outside its keys** (the §6.2 depth convention);
   `LawCurve` wraps (full) or mirrors (half) and is never zero.
4. **Tip-slope check.** The handles that matter for C¹ across the tips of a half-domain law
   are the ones that lead into a segment (`out` of the key at 0, `in` of the key at ½); the
   handles on the far side of those keys are unused. Flatness is judged on the Bézier's end
   tangent (a zero-length handle defers to the next control point), with the rounding
   allowance `LAW_ROUNDING_REL` (4 ε, named in `params.ts`; also the slack of the range
   certificate, relative to the segment's largest value).
5. **No new issue codes.** Handle overlap (`out.ds + in.ds` beyond the segment, within geom's
   `paramRel`), a negative `ds`, fewer than two keys and a half-domain law without keys at
   exactly 0 and ½ are all `law-keys-unsorted`; non-finite numbers are `doc-malformed`; a
   `full`-domain law on a `mirror-y` board is `symmetry-broken`; bottom-feature faults
   (parameter ranges, duplicate ids, depth key faults) are `feature-invalid`.
6. **S1 range rules the design left implicit** (all in `validateBoard`): `stringerRadius`,
   concave `width` in (0, 1]; a single concave has `centre` 0; a double concave has
   `width ≤ centre` and `centre + width ≤ 1`; channels `count ≥ 1`, `width`, `pitch > 0`,
   `pitch ≥ width`, `railInset ≥ 0`. Geometry-dependent feature limits (against the tuck
   half-width) belong to step S4. `validateBuildParams` bounds: `insetCurvatureFraction` in
   (0, 1), `apexHeightRange` inside the open (0, 1), `fullnessRange` in (0, 1],
   `maxFrameTurn` in (0, π/2], the two join tolerances in (0, π/2), counts integers ≥ 0.
7. **Added helpers** beyond the §11.2 sketch: `evaluateLaw` takes an optional third argument
   `tol` (geom tolerances; `paramRel`, `newtonMaxIter` are used); `lawEvaluator` resolves the
   segments once for repeated evaluation (the band builder's loop); `lawSegments` exposes the
   resolved Bézier segments (for the certificate and later the law-graph editor).
8. **DEFAULT_RAIL_LAWS** values (the design names the record, not its values): deck inset
   5.25 cm and tuck inset 2 cm (21% and 8% of a 25 cm half width, the medians of §12.2), apex
   height 0.4, fullness 2/3 (the parabola), hardness 0.5.
9. **Review fixes (S1)**: `checkLawKeys` is total on a `build.tolerances` record geom rejects (it
   falls back to the defaults; `validateBuildParams` reports the record as `doc-malformed`), so
   `validateBoard` never throws on a typed document. The flat-tip test judges the tangent
   slope, `|dv| <= LAW_ROUNDING_REL * scale * ds`, with the value-scale floor named
   `LAW_VALUE_SCALE_FLOOR` (1). Tests added: a cyclic Hermite reference for full-domain laws
   (5e-14 absolute: values span up to 3 and the Bezier route adds a root solve, measured ~1e-14)
   and hand-computed slope pins (half, box clamp, wrap segment).

**Oracles and tolerances.** Hermite closed form (independent evaluation in the Hermite basis)
1e-14 absolute; slope continuity 1e-12; de Casteljau round trip through the root solve 1e-10
(geom `paramRel` 1e-12 times a slope of at most ~10); smoothstep keys converge at O(h³)
(measured error ratios 8.0001, 8.0003, 8.0012 for h halved; the test requires ≥ 7.9);
certificate soundness checked on 200 random laws (every law whose dense samples leave the
range is flagged; 90 of them do). Revive is tested by exhaustive mutation of a known-good
document: a wrong-type value at every leaf (over 150), every key removed, an unknown key at
every object.

**Mutation spot check.** `law.ts`: the limiter `3 · min(|δ_a|, |δ_b|)` changed to `30 ·`:
four tests failed (both Hermite-reference tests, C¹ across the keys, full-domain C¹), restored.

### S2 as built (2026-10-21)

Files: `plan.ts` (pieces from the tail, the standard-tail certificate, exact extent, Green's
area, plan radius, frames, σ ↔ u), `height-field.ts` (Greville abscissae, the surface with
affine x and y, the plan → (u, v) map and exact pcurves, `stringerLines`,
`stringerConstraints`), `symmetry.ts` (pairing, the document checks, DOF rules per net,
`symmetryRules`, the mirror overwrite), plan invariants 1–4 and the height-field and domain
checks in `validate.ts`, `PLAN_RADIUS_SAMPLING` in `params.ts`, the test fixtures
`testing/stadium.ts` (`stadiumBoard`, `stadiumPlan`, `stadiumFacts`, `flatField`) and
`testing/notched.ts` (`notchedLoopFixture`) behind a `./testing` subpath, and tests for each.
181 tests (57 new; 189 after the review fixes). Public values added to the pin: `stringerLines`, `symmetryRules` (+ type
`SymmetryNet`). No geom change.

**Deviations and clarifications:**

1. **Inputs of `stringerLines` and `symmetryRules`.** `buildBoard` arrives in S4, so both take
   the parts of a built board they read (`Pick<BuiltBoard, 'deck' | 'bottom'>` and
   `Partial<Pick<BuiltBoard, 'plan' | 'deck' | 'bottom' | 'band'>>`); a `BuiltBoard` satisfies
   both. `symmetryRules` returns `Board2Result<readonly DofRule[]>` rather than a bare array:
   the pairing is computed from the net's basis and checked, and a net built outside
   `buildBoard` can fail that check (`symmetry-broken`), which is reported, never thrown.
2. **Band rules in S2 are the mirror part.** Partner columns mirror their master column in every
   row; self-paired columns get `fixAxes` y. S3 adds the §3.5 row rules on master columns and
   replaces the y lock of self-paired columns with its rules whose directions have y exactly 0.
   Tested through geom's solver on a synthetic seven-row band over the stadium's plan basis.
3. **"C(−u) = mirror(C(u)) bitwise" (§13.2 `plan`) is not achievable as stated.** Bitwise holds
   for the control net (what the solver, the overwrite and Phase 3 act on): partner points
   `===` mirrors, self-paired y `=== 0`. Point evaluation at mirrored parameters agrees within
   rounding only, because Cox–de Boor rounds `u − t_k` and `(1 − u) − t'_k` differently: on
   the stadium and sample loops 55 and 125 of 998 mirrored pairs are bitwise, the worst
   difference 2.6 ε × 200 cm; the test allows 16 ε × scale. Likewise plan(0).y is
   3·10⁻¹⁵ cm, not 0 (invariant 1 is judged at `Tolerances.point`). σ is exact where it can
   be: σ(0) = 0, σ(½) = ½ and σ(w) = 1 − σ(1 − w) bitwise on (½, 1) (`1 − w` is exact there);
   a partner station's parameter is the rounded `1 − u` of its master, so S3 assigns a partner
   column `1 − σ_master`.
4. **C² means simple knots.** Decision 4 makes the Phase 2 plan C², so a repeated knot of
   multiplicity 2 is refused as well as a full-multiplicity corner (both `plan-corner`, with
   the multiplicity in `value`; the message names a corner only at full multiplicity).
5. **Orientation is checked.** The standard-tail certificate does not see a clockwise loop (a
   reversed loop keeps u = 0 at the tail and runs forward along +y), so `validateBoard` also
   requires a positive signed area (Green's theorem, exact) and reports a clockwise loop as
   `doc-malformed`: decision 3 is a frame convention like the format tag, so no new code.
6. **Domain and height-field checks added.** The plan loop's exact extent (closed-form roots
   of x′, y′ per piece) must lie inside both height fields' extents (`domain-too-small`,
   located at the face; `planMargin` is how documents are made, not a validity rule). In
   symmetric mode each height field needs `y0 === −y1`, v knots symmetric within `paramRel`
   and `z_ij === z_i,(m−1−j)` (`symmetry-broken` at the face): §3.4's symmetric mode.
7. **Knot symmetry is judged within `paramRel`, control points bitwise.** Knots are data, but
   `1 − t` need not round to the stored partner knot; the slack only absorbs that rounding.
   The pairing likewise matches Greville abscissae within `paramRel × T` and must be an
   involution.
8. **Symmetric height-field build.** `heightFieldSurface(hf, 'mirror-y')` writes each partner
   row's y as the exact negation of its master's and the middle row's y as 0 (the §3.7
   overwrite applied to the affine y; it changes values by rounding only, ≤ 4 ε × extent,
   tested). z is the document's, already bitwise paired by the validator.
9. **Plan radius sampling** (`PLAN_RADIUS_SAMPLING`, `params.ts`): 16 samples of |κ| per Bézier
   piece (`d|κ|/ds` has at most five roots on a cubic piece) and a 40-step golden-section
   search (geom's `refineSteps`) round **every** sampled local maximum, not only the worst.
   It is a measurement setting, so it is not stored in `BuildParams`.
10. **Fixtures.** `sampleDoc`'s plan (S1) was not a valid loop (plan(0) was not the origin);
    its tail and nose control points were moved so it passes every S2 invariant, and it stays
    the small fixture of the document tests. The stadium (`StadiumOptions`: `halfWidth`,
    `spacing`, `straightPoints`, `arcSteps`, `thickness`, `spansX`, `spansY`) is the geometric
    fixture: exact straight sides at y = ±ρ, closed-form length and width, congruent ends for
    the Δ identity. The notched loop has its notch bottom (u = 0) at the origin and swallow
    tips near x = −7, so only invariant 2 fails. The package gains the `./testing` export
    (§11.1's subpath; ESLint already kept the core from importing it).
11. **Internal helpers** (not in the pin): `grevilleAbscissae`, `heightFieldBases`,
    `heightFieldSurface`, `planToUV`, `uvOfPlanPoint`, `planCurvePcurve`, `stringerParam`,
    `stringerConstraints`; `planCurve`, `planPieces`, `quadraticRoots`,
    `standardTailViolation`, `planSideViolation`, `planExtent`, `planSignedArea`,
    `planMinRadius`, `planFrame`,
    `planArc`, `sigmaAt`, `paramAtSigma`, `wrapUnit`; `periodicPairing`, `clampedPairing`,
    `basisPairing`, `periodicKnotsSymmetric`, `checkPlanSymmetry`, `checkHeightFieldSymmetry`,
    `planSymmetryRules`, `heightFieldSymmetryRules`, `bandSymmetryRules`,
    `mirrorOverwriteCurve`, `mirrorOverwriteColumns`, `MIRROR_PLANE`.

12. **Review fixes (S2).**
    - **A simple loop is certified.** Invariants 1–4 and the orientation check accepted a
      figure-8 (a −y half bent across the stringer, its +y mirror kept bitwise: the signed
      area stays positive). §3.2's "u ∈ (0, ½) is the −y side" is now checked in symmetric
      mode by `planSideViolation`: y < 0 on (0, ½) and y > 0 on (½, 1), exact on the Bézier
      pieces (y is monotone between the closed-form roots of y′, so the interval ends decide).
      With invariant 2 (each half a graph over x on the same x-range) this proves the loop
      simple. An interval end at a tip (within `paramRel` of u = 0, ½) may be at most
      `Tolerances.point` on the wrong side (y is 0 there up to rounding); intervals inside
      the `paramRel` tip zone are not judged, as for x′. Reported as `doc-malformed` (like the
      orientation, a frame convention of decision 3, so no new code), only when the tail
      certificate and the orientation pass, so a clockwise or non-standard loop is not
      reported twice.
    - **`symmetryRules` checks a height field's grid.** Symmetric v knots are not enough: the
      mirror rules overwrite a partner's x and y from its master, so a grid on an asymmetric
      extent (y ∈ [−10, 30]) would leave the affine graph after a solve. The rules now also
      require x, y paired bitwise (partner `(x_m, −y_m)`, middle row y === 0, what
      `heightFieldSurface(hf, 'mirror-y')` builds), else `symmetry-broken`. z, and the plan's
      and band's control points, are what the rules pair (they come from the mirror
      overwrite; `validateBoard` checks the document's).
    - **Tests on knot sets without knots at the tips.** `testing/off-knot.ts`
      (`offKnotLoop(rng, opts)`): random symmetric loops on non-uniform symmetric knots with
      no knot at u = 0 and/or ½, placed from the Greville abscissae on an ellipse-like
      outline, mirror-overwritten and translated to the origin. They run the non-knot tail
      (`toClamped` inserting it) and the piece straddling ½ through the dense-sampling
      certificate test (240 loops, 103 refused, 180 with a straddling piece) and a validator
      positive control (20 seeds).
    - **σ and roles against independent oracles.** The σ mirror assertion restated the code;
      σ on the +y half, on a loop stored from another period start and on an off-knot loop is
      now compared with geom's direct adaptive arc length from the tail (`curveLength`, not
      the table) within 1e-9. The random-pairing test no longer re-derives roles with the
      implementation's formula; it checks roles against the involution (master ↔ partner,
      self exactly at fixed points), and roles are pinned on a hand-worked off-knot case
      (knots (i + ½)/8: no self point, masters 6, 7, 0, 1, pairs i ↔ 3 − i mod 8).

**Oracles and tolerances.** Affine exactness of x, y on 20 random knot sets, 1e-13 × extent;
pcurve = affine image, 1e-13 × extent. **Stringer identity**: after `approximateSurface` with
`stringerConstraints`, the stringer iso-curve's control values equal the target line's within
`‖A⁻¹‖∞ · constraint` (A the Greville collocation matrix, computed in the test; measured
‖A⁻¹‖∞ 3.9–5.2) plus rounding; measured 2.7–6.2·10⁻¹⁵ cm on six seeds, while the same fit
without the constraints misses the line by 2.9–7.4 cm. **Pairing and mirror rules through geom's
solver**: `makeDofMap` accepts the rule set of each net; random drags on the plan (40 random
symmetric bases, master and partner drags), the stadium deck and a seven-row band leave every
partner `===` the mirror of its master and every self-paired y `=== 0`, with something moved.
Pairing on 200 random symmetric bases: partner abscissae mirror within `paramRel`, involution,
roles consistent with it (hand-worked: the stadium, knots (i + ½)/8). **Standard-tail certificate** against 4,000 samples of geom's x′ on 300 random
symmetric loops (143 refused, each at or before the first bad sample; none accepted with a bad
sample) and 240 off-knot loops (103 refused); the notched loop refused near u = 0; a straight
transom refused. **Side certificate** against 4,000 samples of geom's y on 240 off-knot loops
(62 refused): no certified loop has a sample beyond `Tolerances.point` on the wrong side, every
loop with a wrong-side sample is refused, and the reported u is on the wrong side (1e-12 × 200
cm); the figure-8 stadium refused. **Extent**: the
stadium's closed forms within 1e-12 × L. **Area**: the Δ identity (one more straight point adds
exactly 2ρh) within 1e-11 relative, ×2 scaling bitwise, reversal negates. **Radius**: closed
forms on regular N-gons (knot `R(1 + cos θ)/2`, mid-span `R(sin 3θ/2 + 5 sin θ/2)² / 16(cos
θ/2 − cos 3θ/2)`) and the stadium's arc knots within 1e-10 relative; where a transition span is
tighter (K ≥ 3) a dense geom judge (20,000 samples plus every knot) with an allowance computed
from the measured r″. **σ**: exact at the tips, equal to geom's direct arc length from the tail within 1e-9 (the +y
half, a shifted period start, an off-knot loop), inverse within 1e-12, and Δσ · total = Δx on the straight side within 1e-9 × total. **Validator**: each new code with a
negative control, boundary controls for the tail (`point`) and the radius (1e-9 either side).

**Mutation spot check.** `height-field.ts`: the clamped Greville average `s / p` changed to
`s / (p + 1)`: six tests failed (the Greville closed form, affine exactness, the pcurve image,
the symmetric build, the stadium stringer lines, the stringer identity), restored.
Review fixes: `plan.ts` `planSideViolation`'s interior test `v > 0` changed to `v > −1`: two
tests failed (the on-stringer loop, the dense-sampling side test), restored; with the side
check disabled in `validate.ts` the figure-8 test fails (`[]` returned); with the grid check
disabled in `symmetryRules` the asymmetric-extent test fails.

### S3 as built (2026-10-21)

Files: `band/stations.ts` (the band basis as the plan refined by a list of inserted knots,
span geometry, conditions 1–2, symmetric midpoint insertion, columns), `band/profile.ts`
(`profileRows`, `measureColumn`, `measureLaws`), `band/snap.ts` (the boundary-row z-fits),
`band/band.ts` (context, one pass, measurement, the refinement loop `buildBand`, the inset
loop check, `bandChecks`), `offsets.ts` (the layer's evaluator), `heightSampler` in
`height-field.ts`, the band checks in `validate.ts`, the band's row rules in `symmetry.ts`,
the fixtures `quadraticField` and the stadium's `crown` / `rocker` options and
`notchedBoard`, and tests for each. 236 tests (47 new; 241 after the review fixes). Public value added to the pin:
`measureLaws`. Internal (tested through their modules): `buildBand`, `bandContext`,
`bandPass`, `measurePass`, `columnAt`, `designedLawsAt`, `apexAngleAt`, `tuckCreaseAt`,
`insetLoopIssues`, `bandChecks`, `BAND_V_KNOTS`, `ROW`; `bandBasis`, `basisSpans`,
`spanIndex`, `insertMidpoints`, `spanGeometry`, `stationBasis`, `bandColumns`;
`profileRows`, `measureColumn`, `isoColumn`, `measuredLawsAt`, `BAND_ROWS`; `snapRow`;
`offsetEvaluator`, `ZERO_OFFSETS`; `heightSampler`, `OutsideFieldError`; `bandRowRules`. No
geom change. `buildBoard` (S4) wraps `buildBand`; until then the band build is internal and
`measureLaws` takes `Pick<BuiltBoard, 'doc' | 'plan' | 'band' | 'bottom'>` (as S2 did for
`stringerLines`).

**How a build runs.** `buildBand(doc)` builds the station basis (§5.4 conditions 1–2), then
passes: columns (stage 5 and 7–8, handle offsets included), the boundary-row z-fits (9), the
mirror overwrite (11), measurement (12): at every span's mid parameter the laws read off the
band's iso-curve against a **virtual column** built at that u (the design there, offsets and
the curvature limit included), the deck join and both edge gaps by geom's `edgeContinuity`,
and the apex angle and tuck crease at every knot and span midpoint. Spans that miss a lane's
`lawTolerance`, `deckJoinAngleTol` or (when an edge misses `fit`) `safety · fit` are split
with their mirrors and the band is rebuilt, at most `maxBandRefinePasses` times; the pass
with the smallest worst ratio (measure / target) is kept, a remaining miss is a
`not-converged` warning at the worst span. The deck-edge and tuck loops are certified on the
kept pass (geom's trim checks, plan loop outer, inset loop a hole).

**Deviations and clarifications:**

1. **The tuck handle rotates towards the handle chord `P4 − T`, not the chord `A − T`**
   (§5.3 item 5, edited). With the chord, P5 lies inside the line `P4 − T` (an inflection,
   a concave dip above the tuck) for every hardness above `φ′/φ_chord`, φ′ the angle of
   `P4 − T`: at h = 1 always, since P4 is below A on the apex vertical. The design's claim
   "every h ∈ [0, 1] keeps the lower profile convex" holds for the handle chord (tested on a
   law grid), and the crease is still exactly `h · φ_chord`. Hardness 1 now leaves the tuck
   straight towards the lower apex handle (towards the apex as `f_l → 0`). `φ_chord` uses
   the law's P4, before an `apexLower` offset, so that offset moves its own row only.
   Measuring (`measureColumn`, `measureLaws`) reads hardness against the column's actual
   P4, the only one the points carry: an `apexLower` offset keeps P5 and the crease but
   shifts the measured hardness to `h · φ_law / φ_actual` (pinned by a closed-form test).
   Fidelity is unaffected, as the design side goes through the same measurement.
2. **Boundary-row z by periodic least squares on the band basis** (§5.5 items 3–4, edited):
   geom's `curveOnSurfaceTo3d` returns a clamped curve over one period whose
   full-multiplicity end knots cannot join the periodic band without a C⁰ seam. x and y are
   the exact plan rows, so only z is fitted (`approximateCurve`, periodic, fixed knots,
   `samplesPerSpan` per span), verified at `verifyFactor ×` the samples, and refined through
   the band loop (`safety`). `edgeFit.degree`, `maxPasses` and `kinkFraction` are unused (the
   band's degree is the plan's; passes are `maxBandRefinePasses`; the composition is smooth
   across the band's own knots).
3. **Refinement rebuilds the rows on the finer basis** (Schoenberg sampling at the new
   columns) instead of inserting knots into the old rows. The band is then a pure function
   of the document and the list of inserted knots, which is what makes outline invariance
   exact: the apex row's x, y are `refineKnots(plan, inserted)` in one pass, mirror-overwritten,
   so two builds on the same basis agree bitwise whatever their laws and offsets, and on any
   basis the row is the plan refined to it (the same curve to rounding). §13.2's "row 3's x, y
   bitwise equal" is tested in that form: across law and offset changes on one basis, and
   against `bandBasis` on a refined one.
4. **Stages 9 and 10 commute.** The handle offsets (rows 1, 2, 4, 5) move along directions the
   snap does not change, so the column construction applies them and the snap then shifts
   rows 0–1 and 5–6 by one Δz each.
5. **Offsets on a symmetric board are read on σ ∈ [0, ½] and mirrored**, like a half-domain law
   (the overwrite would discard the other half; reading it would make the measured design on
   the +y half disagree with the built band).
6. **Effective insets**: `min(law + edge offset, κ ρ(u))`, ρ = 1/κ_plan where the loop turns
   inwards (κ_plan > 0 on the counter-clockwise loop) and ∞ elsewhere (`insetRadiusAt`);
   `inset-invalid` below `minInset` after the offset. §12.1's reason (an inward offset by d of
   radius ρ has radius ρ − d, a cusp at d = ρ) holds only on convex stretches: on a concave
   one the offset's radius is ρ + d, and global overlap of the inset loop is certified
   separately (`insetLoopIssues`). As first built the cap used |κ| and cut the notched
   loop's 5.25 cm deck inset to 0.375 cm at its notch bottom (κ = −4/3), leaving it 4.4×
   over `lawTolerance` after 6 passes (`not-converged`); the review fix limits only where
   κ > 0, and the notched loop converges. Plan invariant 3 still bounds |κ| everywhere,
   which is now conservative on concave stretches (left as designed). The limit is only C⁰
   in σ where it becomes active, so fidelity converges O(h) there rather than O(h²): the
   sample board needs 6 passes.
7. **The tuck crease is measured in the station plane**: the angle between the traces of the
   band (at v = 1) and of the bottom in the plane normal to the plan tangent, compared with
   the virtual column's crease (the angle of its final `P5 − T`; `h · φ_chord` without a
   tuck-handle offset). Where the tuck slopes along t̂ (rocker) the 3D dihedral differs from
   it; the station-plane angle is what the construction designs. The crease is **reported,
   not gated**: the refinement gate is the lane fidelity. The measured crease is the
   measured hardness times the measured `φ_chord` (both read off the same iso-curve), so it
   is held by the hardness lane and the lanes that fix `φ_chord` (tuck inset, apex height,
   lower fullness). A direct gate in hardness units, `lawTolerance.edgeHardness · |φ_chord|`,
   has a zero target at `f_l = 1` (P4 at the corner, `φ_chord = 0`, inside `fullnessRange`)
   and would report `not-converged` on a valid law. The tests bound the reported error by
   `lawTolerance.edgeHardness · max |φ_chord|` over the columns (the crease change one
   hardness tolerance step makes at the steepest chord), not a fixed angle.
8. **validateBoard runs the band checks** (§3.6, §4, §5.3), only on a document with no error
   so far: every column of the station basis (insets, `rail-height`, `rail-profile-invalid`
   for `H_u ≤ 0`, `H_l ≤ 0`, a handle of no length or a tuck handle past the apex vertical)
   and the inset loops (`inset-loop-invalid` with geom's issue as cause). `buildBand` repeats
   the column checks on its finer columns and certifies the loops of the kept pass; an apex
   angle above `apexJoinAngleTol` would be `rail-profile-invalid` (the construction gives
   rounding). The column checks are pointwise, so **passing `validateBoard` does not imply
   that `buildBand` succeeds**: a column that refinement inserts between two valid stations
   can still fail (`rail-height`, `inset-invalid`, `rail-profile-invalid`), and `buildBand`
   then returns that pass's errors, not an earlier valid pass. Certifying the conditions
   between stations is left open (S4's `buildBoard` reports it the same way). Two earlier tests changed with it: the S1 law-range tests now drop the band
   codes (a 1000 cm inset is in range for the certificate but not buildable on the sample
   board), and the S2 off-knot loops use 2 and 1 cm insets (seed 13's nose is narrower than
   twice 5.25 cm: its deck edges cross, correctly refused).
9. **The band's DOF rules** (`symmetryRules(b, 'band')`, S2 deviation 2 completed): partners
   mirror their masters in every row; master and self-paired columns get row 0 and 6 `fix`,
   row 1 `slide` along `τ̂_d` = row 1 − row 0, rows 2 and 4 `offsetFrom` row 3 along ẑ, row 3
   `fixAxes` x, y, row 5 `slide` along n̂ (the horizontal part of row 0 − row 3) and ẑ. On a
   self-paired column every direction has y exactly 0, replacing S2's y lock. A degenerate
   direction is `rail-profile-invalid`. Row 1's slide and row 5's moves are not bounded
   here: Phase 3 needs the same "inboard of the apex vertical" bound the builder now checks
   (review fixes).
10. **Self-paired columns sit at exactly u = 0 and ½** (the pairing names them; the Greville
    sum can be one rounding off), so they get the exact tip frames and σ. A partner column's
    issues are not reported (it is overwritten by its master's mirror).
11. **`heightSampler`** evaluates a height field at plan points and refuses points outside the
    field (geom's evaluator would clamp them silently); in a build that is `inset-loop-invalid`.
12. **Fixtures**: `stadiumBoard({ crown, rocker })` builds exact quadratic deck and bottom
    (`quadraticField`, control values by the blossom, symmetric bitwise); defaults leave the
    stadium bitwise as before. `notchedBoard()` puts flat surfaces under the notched loop
    (refused by the validator, built directly).
13. **Review fixes (S3).**
    - **`validateBoard` is total again.** It now checks the offset layer's structure (a basis
      geom accepts or `null` with no rows, each row once, `count × components` values, all
      finite) as `doc-malformed`, before the band checks; and `buildBand` / `bandChecks` turn
      any thrown error into an issue (geom's as `geom`, anything else as `doc-malformed`)
      instead of rethrowing it. A wrongly sized field used to escape as a `RangeError`.
    - **P1 inboard of the apex vertical.** `profileRows` refused only P5 past it; with
      `upperFullness = 1` any positive `deckHandle` offset put P1 outboard (1 cm on a flat
      deck for an offset of 1) with no issue. Now `rail-profile-invalid`.
    - **The inset cap acts only where κ > 0** (deviation 6).
    - **Documented**: the crease is gated through the lanes (deviation 7), measured hardness
      reads the actual P4 (deviation 1), and the validator does not certify refined columns
      (deviation 8).

**Oracles and tolerances.** Profile closed form (independent 3D construction on planar
samplers in random frames, 200 cases) 1e-12 × 250 cm; f = 2/3 is the degree-elevated
quadratic, 1e-12 × scale; `measureColumn` inverts `profileRows`, 1e-12 (insets × scale);
crease `h · φ_chord` 1e-12 rad; convexity on a 4 × 4 × 4 × 5 law grid (≥ 300 valid profiles).
Station basis judged by geom's direct `curveLength` (1e-9 relative) and 64 tangent samples
per span (the cone bound holds and is within 2× of the sampled turn). Apex angle at 2,000
parameters per board (stadium, crowned, sample, notched): ≤ 1e-9 rad, measured ≤ 1.8e-16;
apex normal horizontal 1e-12. Deck join after the build ≤ 0.1° (crowned 7.6e-3°); before
refinement under uniform halving of the crowned stadium the angle falls by 3.06, 3.35, 3.66
(test: each ≥ 2.9, the last ≥ 3.5: O(h²)), the fidelity by 3.1–4.0. Fidelity: the sample
board starts 30× over and meets every lane after 6 passes. Snap: gaps ≤ `fit` and equal to
the independently sampled vertical error at every profile sample (1e-12 × scale); a
`fit` of 1e-7 cm refines the crowned board until both edges meet it. Mirror overwrite
removes ≤ 1e-12 × scale. Band DOF rules through geom's solver: rows 0, 6 and the apex x, y
bitwise fixed, rows 2, 4 on the apex vertical, row 1 along its handle, partners mirrored,
apex angle ≤ 1e-9 after the solve. Validator: one negative control per band code.

**Measured** (Node 22, the cloud container, warm; full `buildBand` including measurement):

| Board   | Columns | Passes | Apex angle | Deck join | Crease error | Fidelity (insets, apex, fullness ×2, hardness) | Edge gaps deck / tuck (cm) | Inset-limited columns | Time    |
| ------- | ------- | ------ | ---------- | --------- | ------------ | ---------------------------------------------- | -------------------------- | --------------------- | ------- |
| stadium | 184     | 0      | 1.5e-16    | 1.9e-13°  | 1.5e-4 rad   | 4.0e-3/1.5e-3/2e-16/6e-16/1e-16/2.7e-5         | 1.1e-13 / 1.1e-13          | 0                     | 161 ms  |
| crowned | 196     | 1      | 1.1e-16    | 7.6e-3°   | 1.1e-4 rad   | 4.0e-3/1.5e-3/1.4e-3/1.9e-3/2.4e-3/5.0e-3      | 9.8e-6 / 3.7e-6            | 0                     | 253 ms  |
| sample  | 204     | 6      | 1.4e-16    | 6.3e-4°   | 1.4e-4 rad   | 4.2e-3/1.6e-3/5.3e-4/2.7e-4/1.2e-3/1.4e-3      | 2.4e-7 / 4.5e-7            | 58                    | 899 ms  |
| notched | 308     | 6      | 1.8e-16    | 1.5e-11°  | 1.8e-4 rad   | 4.6e-3/1.7e-3/2e-16/7e-16/1e-16/3.0e-5         | 1.1e-13 / 1.1e-13          | 119                   | 1248 ms |

One pass of the stadium costs about 130 ms warm (station basis 13 ms, columns and z-fits
40 ms, measurement 70 ms, of which most is the two `edgeContinuity` profiles, inset loops
13 ms): above Q2's 60 ms target, reported here and left to S9's benchmarks (a miss is
reported, not failed, §13.4).

**Mutation spot check.** `band/profile.ts`: the upper apex handle's x moved off the apex
vertical (`p[6] = spec.ax + 0.01 · n̂.x`): 21 tests failed, among them the apex-G1 test on
all four boards, the closed-form profile, the convexity grid and the band row rules through
the solver; restored. `band/band.ts`: the snap's Δz not applied to the handle rows: two
tests failed (handle vectors kept; the handle-offset test), restored. Review fixes, one
mutation each, each failing exactly its new test and restored: `geomIssue` rethrowing a
non-geom error (the wrong-size offset test); the offset-structure check skipped in
`validate.ts` (its message no longer names the size rule); the P1 check disabled (the
deck-handle test); the cap on |κ| again (the concave-notch test); `measureColumn`'s
`φ_chord` shifted by 0.01 rad (the `apexLower` hardness pin).

### S4 as built (2026-10-22)

Files: `features.ts` (stage 6: the tuck half-width `tuckWidth`, the closed forms, the
geometric feature checks, the fit and the exact sum `bottomWithFeatures`), `brep.ts`
(`boardBrep`, `writeBoardStep`), `build.ts` (`buildBoard` in the order of §6.3, and the
internal `assembleBoard`: stages 2–13 without the document checks, for the notched loop), stage
5 as functions of its own in `band/band.ts` (`effectiveInsets`, `insetPlanCurve`: the tuck plan
curve before the bottom exists), `validate.ts` (the feature checks and fits before the band
checks), `testing/volume.ts` (the independent volume oracle), `vitest.occt.config.ts` and
`brep.occt.test.ts`; in geom the `./testing/occt` subpath (`src/testing/occt/index.ts`), with
`step.occt.test.ts` and `curved-puck.occt.test.ts` running on it. Public values added to the
pin: `buildBoard`, `writeBoardStep`. 275 board2 tests under `pnpm test` (34 new; the OCCT
suite is 6 more, under `test:occt`), counts after the review fixes below. Root `pnpm test:occt` runs geom's
suite, then board2's (`--workspace-concurrency=1`: one 21 MB WASM kernel at a time); board2's
`pnpm test` excludes `*.occt.test.ts`. Isolation (§11.3): the protocol module is the one geom
source file besides the test files allowed to import `occt-wasm`; `occt-isolation.test.ts` now
checks that it is the only one, that it is reachable from no shipping-safe entry (`.`,
`./testing`) and that only `*.occt.test.ts` files import it, workspace-wide; ESLint gives it
its own layer entry. board2's `package.json` does not name `occt-wasm`: the import resolves
from the module's real path in geom.

**How a build runs.** `buildBoard(doc)`: `validateDocument` (every check of `validateBoard`
but the geometric ones of stages 4–8, which the stages report as they build), then the plan,
σ, deck and base bottom (`bandContext`), the station basis, the tuck plan curve on it
(`insetPlanCurve`: each column's apex plan point moved in by its effective inset, mirror
overwritten), the features against that curve (`bottomWithFeatures`), the band on the bottom
with its features (`buildBand`, S3), and the B-rep. `validateBoard` runs the same stages
through the features and the station basis's band checks (`geometryChecks`), so it never
builds the band twice. Errors of any stage are returned, never thrown; warnings ride on the
result and in `report.issues`. `report.edgeGaps` are `checkBrep`'s measurements of the two
trimmed edges, `report.featureFitError` the largest verified feature fit error.

**Features.** `h_t(x)` is the −y half of the tuck plan curve inverted by bisection on its loop
parameter to the last bit (x is strictly increasing there by the standard-tail certificate
applied to the tuck loop; a tuck loop that fails it leaves η undefined and every enabled
feature `feature-invalid`); `minOver(a, b)` is exact (ends and the closed-form roots of y′
per quadratic piece). Each feature is sampled at `samplesPerSpan` points per span of its own
basis (the bottom's knots plus double knots at its depth keys' x and at its lateral break
lines, both sides), fitted by least squares on fixed bases with the exact affine
parameters (separably, deviation 11), verified at `verifyFactor ×` the samples, and the spans whose error exceeds
`safety · featureTol` are split (v spans in mirror pairs), at most `maxPasses` times. The
fitted nets are refined to the union of the knots (exact) and added to the base bottom; on a
symmetric board the partner rows of the sum then take their masters' z (bitwise symmetric,
§3.7).

**Deviations and clarifications:**

1. **Concave and channel sign** (§6.2 table, edited). The design had `−depth · bump`, which
   with z up and the bottom below the board lowers the bottom: a belly, not a concave. A
   positive depth now raises the bottom into the board, the hollow a concave or channel is,
   the same sign as the vee (whose positive depth raises the rails).
2. **The fit's sampling and refinement are the document's edge-fit parameters**
   (`samplesPerSpan`, `verifyFactor`, `safety`, `maxPasses` of `DEFAULT_EDGE_FIT` merged with
   `build.edgeFit`), not new ones: the same discrete least-squares verification problem as
   the boundary rows (§5.5). A miss after `maxPasses` is a `not-converged` warning with the
   measured error, never silent. The lateral break lines are placed with `h_t` at the depth's
   largest key: exact where the tuck is straight; where `h_t` varies, the lines curve and
   refinement resolves them (tested on a concave and on two channels reaching the tail arc,
   against `h_t` inverted by the test). The refinement there is near the tensor grid's
   inherent need, not wasteful: a C¹ wall with a second-derivative jump of 8 · depth /
   (width/2)² = 2.4 cm⁻¹ needs spans of about 0.1 cm across the 12 cm the four walls sweep
   per side on the arc (≈ 240 v spans) and along the 24 cm of arc where they move (≈ 120 u
   spans); the fit ends on 141 × 337. Placing break-line knots per u span would not shrink
   that net (each knot line is global), so the review's cost fix is the solve (deviation 11).
3. **η uses the tuck plan curve on the station basis** (stage 5 before refinement), not the
   kept band's tuck row. The band's refinement depends on the bottom, so the refined row
   cannot define the bottom without a cycle; the two curves are the same design sampled on
   two bases (they differ by about w Δθ²/8, §12.1 `maxFrameTurn`, ≤ 0.05 mm at w = 5 cm). The
   features are sampled over the whole field, not only inside the tuck loop: the bottom face's
   trim keeps the part that matters.
4. **Geometric feature checks** (`feature-invalid`, left to S4 by S1 deviation 6): an enabled
   feature's depth must start and end at 0 (it is 0 outside its keys, so anything else is a
   jump no fit follows); its keys must lie strictly inside the tuck loop's x-range (η needs
   `h_t > 0`); channels must not reach the stringer anywhere on their support (`minOver`).
5. **Knots of different features closer than `knotRel`** (geom refuses distinct knots that
   close) share one value: the base bottom's knot if the cluster has one, else on the v knots
   of a symmetric board the knot nearest ½ (so mirror clusters get an exact mirror pair of
   representatives and the total's v knots stay symmetric), else the smallest. The
   choice depends on the pooled values only, so the sum stays order-independent.
6. **The B-rep** is §7's: edges `deckEdge` and `tuck` are rows 0 and 6 clamped at the band's
   domain start `t0` (`toClamped`), with exact pcurves on the height fields (the rows' plan
   curves under the affine map) and `bandLine` on the band; `seam` is the band's iso-curve
   `u = t0`, its two ends the two vertices. `orientBrep` confirms the designed senses and never
   flips (tested on every board; S4 reported a `flipped` flag, which S7 removed with the call:
   S7 as built, item 11). `writeBoardStep` names the product
   after `doc.meta.name` and checks under the document's tolerances, `opts.tol` overriding.
7. **The OCCT protocol module** exports the §15.3 runners (`pathB`: B1–B6 and B8 facts;
   `pathA`: the same unhealed plus B7; `orientationControls`: §15.6) that measure and return
   plain data, the helpers (`meshVolume`, `meshVolumeCheck`, `maxShapeTolerance`,
   `flipSubShape`, …) and the protocol's thresholds as named constants (`B7_REL`,
   `ENCODING_TOL_MM`, `GPROP_SANITY_REL`, `MESH_BOUND_MAX_REL`, …); the calling test asserts.
   geom's no-magic-tolerances scan exempts the file by name, as test protocol thresholds,
   like a test file's own. In `step.occt.test.ts` the three orientation tests per solid
   (flips, inside out, mutations) became one, on one `orientationControls` call, with the
   same assertions: `test:occt` in geom is 85 tests (97 before), its assertions unchanged.
8. **GProp on the board is 2.23 % high** (both paths and units alike: B7 is bit-equal), above
   the protocol's 1 % sanity bound that held on geom's corpus. The first explanation (a fixed
   rule per surface span of the trimmed planar faces) was tested in the review and is
   **refuted**: refining the flat deck and bottom exactly from 2 × 2 to 128 × 64 spans leaves
   GProp's face areas equal to 1e-14 and its volume error at 2.229 % (the OCCT suite pins
   2 × 2 against 32 × 16 at `B7_REL`), and
   154 to 406 band columns (station spacing 10 to 1.25 cm, frame turn 2.5° to 20°) keep it
   between 2.225 % and 2.234 %. GProp's face areas are 0.13 % (deck, bottom) and 0.56 %
   (band) low against the exact plan areas and a 16-point Gauss–Legendre band area. The cause
   is inside OCCT and not identified; no refinement of ours converges it. The board's test
   bounds it at 2.5 % (`GPROP_BOARD_REL`, the measured 2.23 % plus a quarter of a percent; it
   was 3 % before the measurement) as a sanity check only; the accuracy oracles are OCCT's
   mesh and our `massProperties` against the independent volume.
9. **`corrupt a weight`** (geom's mutation catalogue) is missed by OCCT's unhealed check on
   the stadium (pinned: `BRepCheck` samples an edge at 23 parameters, and the deck edge
   crosses the corner patch only near the nose), and caught by `checkBrep`. On the notched
   loop's deck the edge never enters the corner patch, so the mutation changes no point of
   the face: not a defect there, accepted by `checkBrep` with the same volume (tested; the
   catalogue's premise holds for untrimmed faces).
10. **Found while resuming the step**: the vee's linear branch lacked its normalisation
    `1/(1 − r/2)` (continuous only at r → 0; the vee fit then missed `featureTol` after 8
    passes and the full suite took 8 minutes). Fixed; it is the step's first mutation spot
    check below.
11. **The feature fit is solved separably** (review fix). On a grid the collocation matrix is
    the Kronecker product `Bu ⊗ Bv`, whose pseudo-inverse is `Bu⁺ ⊗ Bv⁺`, so fitting every
    sample column in u and then every resulting row in v (`tensorLeastSquares`: geom's
    `approximateCurve` on the fixed bases, three columns per call) is the same minimiser as
    `approximateSurface` on the whole grid (tested: 8e-14 apart on random data and random
    bases with a double knot). `approximateSurface` solved one banded system with
    `nu · nv` unknowns and bandwidth ≈ `3 nv`: 111 s of the 141 s that two channels on the
    tail arc took (6 passes, net 141 × 337). The verification evaluates z alone by its tensor
    basis one u sample at a time (the field's x, y are affine) instead of a 3D grid of
    44 M points (1 GB). Same passes, nets and errors to rounding; that case now fits in
    5.0 s.

**Oracles and tolerances.** Features against the closed forms written out in the test (the
stadium's straight tuck `h_t = ρ − w_t` exactly, an all-auto depth a smoothstep per segment):
at 400 seeded random points the built bottom minus the base is within `featureTol`; the vee
lies in the spline space once its knot lines are in, so 1e-12. On the tail arc (`h_t` from
17.1 to 23 cm) the same closed forms with `h_t` inverted in the test (dense bracketing and
Newton on geom's derivatives, not `tuckWidth`): a single concave (worst 8.2e-4 cm) and two
channels (7.5e-5 cm at the random points, verified maximum 5.7e-4 cm), both within
`featureTol`. `h_t` against its definition
(`at(x(u)) = −y(u)`, 200 random u, 1e-9: |y′/x′| × an ulp of u); `minOver` never above dense
sampling (4,000 points). Order independence 1e-12 × 6 cm, and checkHeightFieldSymmetry on the
sum. No enabled feature: the base surface itself (`toBe`). B-rep: `checkBrep` ok, V 2, E 3,
F 3, L 3, χ = 2, genus 0, positive volume, senses deck true, band and bottom false, no flip,
on the stadium, crowned stadium, sample board and notched loop; geom's mutation catalogue on
the stadium and notched loop, each defect refused by its layer. Edge gaps: the report's are
`checkBrep`'s, ≤ `fit`, and equal to an independent measurement of `|row(t) − F(row.xy(t))|`
(20,000 samples, then golden-section on the largest sample's bracket to 1e-15) within
1e-12 × the 6 cm thickness, §13.2's bound (measured 5.3e-15 and 1.8e-15 cm on gaps of
7.1e-6 and 4.3e-6 cm; the first version of this test accepted 1 %). Volume: `testing/volume.ts` (divergence theorem with `F = (0, 0, z)`
on the flat stadium: deck height × the plan area inside the deck-edge row, Green's theorem by
3-point Gauss–Legendre per cubic span, plus the band's flux by 5 × 5 points per bicubic patch,
both exact; point evaluations only) against `massProperties` and `checkBrep`'s signed volume,
1e-10 relative (measured 4.8e-15). STEP: three faces, three edges, two vertices; geom's subset
reader reads a solid `checkBrep` accepts, volume 1e-12 relative. OCCT (stadium, 188.7 × 50 ×
6 cm): Path B in mm and cm (B1–B6, B4 grown 1e-7 mm ≤ 2 × 1e-5 mm declared), the mesh oracle
at 0.03 mm (−7.2e-5 relative against a bound of 2.7e-4), Path A valid unhealed with every
tolerance as written, B7 bit-equal, every face flip and edge-use flip invalid, inside out
valid with exactly the negated volume, the STEP reader healing it to the reference within
`B7_REL`, and every `checkBrep` mutation but `corrupt a weight` invalid.

**Measured** (Node 22, the cloud container, warm; `buildBoard` including the B-rep):

| Board               | Columns | Passes | Build   | `validateBoard` | `massProperties` | Edge gaps deck / tuck (cm) | Feature fit (cm) | Bottom net |
| ------------------- | ------- | ------ | ------- | --------------- | ---------------- | -------------------------- | ---------------- | ---------- |
| stadium             | 184     | 0      | 700 ms  | 87 ms           | 2.2 s            | 1.1e-13 / 1.1e-13          | —                | 11 × 7     |
| crowned             | 184     | 0      | 773 ms  | 60 ms           | 1.9 s            | 7.1e-6 / 4.3e-6            | —                | 11 × 7     |
| sample (concave)    | 204     | 6      | 1627 ms | 129 ms          | 3.0 s            | 2.4e-7 / 7.3e-7            | 6.5e-4           | 26 × 23    |
| notched (direct)    | 308     | 6      | 1947 ms | —               | 2.2 s            | 8.6e-14 / 1.1e-13          | —                | 11 × 7     |
| stadium vee+concave | 242     | 2      | 1321 ms | 98 ms           | 3.6 s            | 1.1e-13 / 2.2e-5           | 9.0e-4           | 22 × 21    |
| channels, tail arc  | 184     | 0      | 22.7 s  | 4.4 s           | —                | 1.1e-13 / 3.1e-6           | 5.7e-4           | 141 × 337  |

Per feature on the stadium (fit only, after the separable fit of deviation 11; before it in
brackets): vee 34 ms (26 ms; 0 passes, 7.8e-16 cm), single concave 65 ms (81 ms; 1 pass,
9.0e-4), double concave 63 ms (351 ms; 2 passes, 1.4e-4), two channels 107 ms (766 ms; 2
passes, 6.8e-4, a 31 × 57 net); one vee and one concave 29 ms (177 ms; Q7's target 50 ms,
met). Reaching the tail arc (depth keys at x = 10, 30, 70): vee 21 ms, double concave 61 ms,
two channels 4.95 s (149 s; 6 passes, a 141 × 337 net). The build and validation rows above
were re-measured with it. The channels' `buildBoard` spends 17 s of its 22.7 s in geom's
`orientBrep` and `checkBrep` (each integrates the signed volume over the 141 × 337 bottom's
spans): recorded in §13.5, left to tier-2 work. A build without features spends most of its time past the band (S3 measured the
stadium's band at 161 ms): `orientBrep` and `checkBrep` each integrate the signed volume.
The board's OCCT suite takes about 27 s.

**Mutation spot check.** `features.ts`: the vee's linear branch without `/ (1 − r/2)` (as
found in the resumed worktree): 4 tests failed (the vee closed-form fit with a 6.2e-3 cm
`not-converged`, the order test by timeout, the `buildBoard` vee test), restored.
`features.ts`: the mirrored cluster representative replaced by the smallest knot: the new
`knotRel` cluster test failed (`symmetry-broken`), restored. `brep.ts`: the band face's
`sameSense` set to true: 12 of 13 `brep.test.ts` tests failed (`checkBrep` refuses the trim
orientation), restored. Review fixes: `features.ts` with the one banded `approximateSurface`
solve back in place of `tensorLeastSquares`: the channels-on-the-tail-arc test timed out at
20 s (123 s), restored. `featureDisplacement` with a stale straight-part `h_t`
(`max(h_t, 23)`): both tail-arc tests failed against the test's own `h_t` (errors 3.7e-3 and
0.16 cm; the former oracle, `featureDisplacement` itself, could not see it), restored.
`build.ts` reporting the deck-edge gap × 1.005: the edge-gap test failed (3.5e-8 cm > 6e-12;
the former 1 % test passed it), restored.

S5 and S6 can run in parallel after S4 and S3 respectively; S7 needs both S4 (validity through
the B-rep) and S6.

### S6 as built (2026-10-22)

Files, all under `src/classic/`: `params.ts` (`DEFAULT_CONVERT_OPTIONS`, the §12.2 table plus
`lineSampleSpacing`, and `LINE_CORRECTION_PASSES`; exempt by name from the no-magic-tolerances
scan like the core's `params.ts`), `sample.ts` (§9.2: `classicFloors`, `classicStations`,
`loftRowPositions`, `sampleLoft`, `creaseAngles`), `outline.ts` (the classic outline and
stringer curves as exact pieces, corners and fillets, exact arc-length sampling), `lines.ts`
(the plan-loop and stringer-line fits), `membership.ts` (row membership in a plan loop),
`fairness.ts` (§9.8: exact traces, `discrepancySearch`), `fields.ts` (the height-field fit),
`convert.ts` (`convertGeometry`: §9.1–§9.6 in order, and `liftKnifeTips`), and
`test-support/` (`samples.ts`, the fourteen files through the io readers; `oracles.ts`, exact
classic curve points, polyline distances and polygon crossings; `conversion-checks.ts` and
`exit.ts`, the exit measurements). Public value added to the pin: `DEFAULT_CONVERT_OPTIONS`
(`./classic`); the stages stay internal until S7 completes `convertClassic`. 324 board2 tests
under `pnpm test` (49 new; 335 after the review fixes, deviations 6 and 10–13).

**How a conversion runs (S6 part).** Preconditions (§9.1); sampling (§9.2: rows at most
`sampleSpacingX` apart across the kernel's solid span plus station ± `creaseProbe`, the
+y half of the classic's own ring ladder, the row's widest ring point splitting deck side from
bottom side); the outline filleted and sampled exactly, mirrored into the loop data
(centripetal parameters, u = ½ at the nose exactly) and fitted (§9.3); the rocker and deck
lines (§9.4); the inset laws (§9.5) and a draft document with constant `DEFAULT_RAIL_LAWS` on
the four profile lanes (§9.7 item 1); the deck-edge and tuck plan curves on the station basis
(S4's `insetPlanCurve` construction) and the same moved out by the data strip; the field data
by row membership; the bottom and deck fits; the knife-tip lift. `convertGeometry` returns the
draft and per-stage measurements (errors, fillets, knots, passes, fairness ratios, timings).

**Deviations and clarifications:**

1. **Pointed tips retreat; the board is shifted back to x = 0.** A pointed classic tip
   (all seven synthetic files, interior angle 27–34°) is filleted like any corner: the circle
   of radius `cornerFilletRadius`, centred on the stringer, tangent to the side, so the tip
   centre moves in by the predicted deviation (1.21–1.67 cm). The tail's retreat is taken
   out by a shift (board2 x = classic x − `shift`, reported), so the tail centre is at x = 0
   (decision 3) and the nose constraint of §9.3 is the filleted nose, not the classic L. §10.4
   said fillets keep the tip centres: true for a flat tip (2 below), impossible for a pointed
   one with a convex tip (a curve tangent to a straight side and ending on that side's line
   must cross it: an inflection). §10.4 is edited and the consequence for S8's length
   checkpoint is §15 risk 8.
2. **Flat tips.** An end segment within `cornerAngleMin` of perpendicular to the stringer whose
   inner end is a corner (the shortboard's 1 cm flat nose, whose handle pokes 0.002 cm past the
   tip, so x is not monotone there) is replaced, with its corner, by one arc centred on the
   stringer through the tip centre and tangent to the neighbouring segment (radius 0.971 cm, set
   by that geometry, not `cornerFilletRadius`). The length is kept; the corners' predicted
   deviation is 0.121 cm.
3. **Corners by the curve's tangents, not `continuous`.** The synthetic outlines are polygons
   with zero-length handles on knots flagged continuous (the editor treats them as corners), so
   a knot is a corner when the one-sided tangents (a zero handle falls back to the next distinct
   control point) turn by more than `cornerAngleMin`. The predicted deviation is the corner's
   exact distance to the arc, `|K − c| − r`, which is `r (1/sin(θ/2) − 1)` on straight
   neighbours (tested) and differs on curved ones (by 0.03 cm at the rocker files' tips).
   Fillets on curved neighbours are solved by Newton on the two tangent parameters; the radius
   shrinks until the tangent points fit in half of each neighbouring segment.
4. **Exact samples.** The outline and stringer curves are sampled on the cubics themselves at
   arc-length steps of the kernel's chord table, not at the table's interpolated points (up to
   `h²/8ρ` off the curve: 2.4e-3 cm on a 90 cm segment of radius 100 cm, above `lineTol`).
   Spacing `lineSampleSpacing` (0.05 cm, added to §12.2).
5. **Adaptive knots kept symmetric.** geom's adaptive `approximateCurve` picks knots worst span
   first and would break the plan's mirror-symmetric knot set (§3.7), so `lines.ts` runs the fit
   on given knots and refines them itself: geom's split rule (midway between the two middle
   distinct parameters of each failing span), candidates from the −y half with their exact
   mirrors. One parameter-correction pass (`LINE_CORRECTION_PASSES`, named in
   `classic/params.ts`: on the goldens it cuts 490–534 knots to 116–224, further passes change
   them by under 3 %), so the adaptive loop judges distance to the loop rather than a parametric
   error with a tangential part. The loop is then symmetrised exactly (§9.3).
6. **Fillet zones: §9.3's 1.1 × and the arcs themselves** (corrected in the S6 review: the
   first version judged a zone by its corner's distance alone, one point per zone, and called
   that tighter; it covered less). Outside the zones both one-sided distances to the classic
   outline are ≤ `lineTol`. Inside them, both ways: the fillet arcs, sampled 0.005 cm apart,
   against the loop and the loop against the filleted outline (the fit's target) ≤ `lineTol`;
   the loop and the classic outline against each other ≤ 1.1 × the zone's predicted deviation
   (§9.3's own criterion; measured at most 1.0000 ×, the corner itself); each corner's distance
   to the loop equals its prediction within `lineTol`. The arcs come from the converter's
   `filletOutline`, so they are checked against the classic independently: every fillet
   circle is inscribed (its centre's distance to the classic outline is its radius, within
   the polylines' 1e-5 cm), and a pointed tip on a straight end segment has the closed form
   `r (1/sin(θ/2) − 1)` with θ from the classic's own end tangent (within 1e-12 cm; the
   rocker files' tips are curved, where only the inscribed check applies). The converter's
   own fillet-zone errors (`plan.filletError`, the lines' `filletError`) are asserted
   ≤ `lineTol` too. Measured: arcs → loop at most 9.6e-4 cm, loop → filleted outline 9.6e-4
   cm, line arcs → line 7.3e-4 cm.
7. **Stringer lines.** Their knots come from the data's own parameters, so every span holds data
   and the end spans reach over the plan margin as the polynomial continuation of the last data
   span: no data-free span, so §9.4's fairness is not needed and not used. The synthetic decks
   are polygonal (a ridge a C² line cannot follow within `lineTol`): their interior corners are
   filleted like the outline's (one per deck, predicted deviation reported and checked), and the
   vertical end segments within `endGap` of an end are dropped first.
8. **Membership by rows, not `classifyUV`.** The samples come in rows of constant x, so each row
   costs one exact root solve per monotone Bézier piece of the loop and the ray-crossing rule
   along the row (`membership.ts`); `classifyUV` decomposes the loop on every call. Tested
   against `classifyUV` on the sample plan, an off-knot loop, the notched loop (not a graph over
   x) and rows through piece ends.
9. **The data strip stays in the band's inner half.** §9.6's strip of `trimDataMargin` outside
   each inset loop is capped at half the local inset (`inset − min(trimDataMargin, inset/2)`),
   so near the tips, where the insets shrink to `minInset`, it never reaches the classic rail.
10. **Basis first, then fairness.** Refinement runs with the least fairness that determines the
    net (the bracket's bottom, or the first feasible ratio of a log grid when data-free control
    points leave the system singular): every u and v span holding a judged sample above
    `surfaceTol` is halved, u spans only while the halves stay ≥ `minKnotSpacing`, v spans in
    mirror pairs (the v knots stay symmetric). The discrepancy search then runs once, on the
    final basis. **`minKnotSpacing` floors u only** (recorded in the S6 review). §12.2's reason
    for it is the classic station crease, a tangent break along a line of constant x that a
    finer u basis would resolve as curvature; a v knot is a line of constant y, which no station
    crease follows, and what v refinement resolves is the sections' own shape across the face
    (the synthetic files' polygonal sections above all), bounded by `maxRefinePasses`. Smallest
    v spans measured: 0.15 cm on the five synthetic files with five passes, 0.58–1.2 cm on the
    others. **The line's knots enter the u basis as they are**, below `minKnotSpacing` where a
    line fillet needs them (the stringer identity needs the line on the field's basis): the
    polygonal decks' ridge fillets (the five synthetic files with a side corner) put deck u
    spans of 0.04–0.15 cm into those decks. A failing sample splits both its u and its v span,
    whichever direction its residual comes from; splitting only the direction a residual
    indicates would cut the nets and the time (Q5), and is left to S9 as a candidate with the
    others. The thin-plate energy is geom's parametric metric; the ratio's traces are exact
    (`fairness.ts`: Gauss–Legendre per span, separable `tr(G₂)`).
11. **Knife tips lift the deck by a function of x.** §9.6's equality constraints at violating
    stations are replaced by `Λ(x) = Σ λ_i N_i(u(x))` added to every control row (λ_i the
    largest deficit of the violating stations in the support of N_i, so Λ meets every deficit in
    one round, as the N_i are non-negative and sum to 1), after inserting `degree + 1` knots
    (exact) between the innermost violating station and the tip zone's edge so the lift stays
    inside it. At most `maxRefinePasses` rounds in all (§9.6; the first version allowed one
    more). Two cases are reported as `rail-height` warnings (S6 review): a violating station
    outside the tip zone, where no knots are inserted and the lift reaches into the fitted deck,
    and a rail height still short after the last round. At a tip the stations crowd within
    millimetres on centimetre spans and the stringer identity already fixes the deck at the tip
    centre: pointwise equalities there are dependent and in general inconsistent. The lift
    raises the deck line with the deck (inside the tip zone only). **No sample file needs it at
    the default 1 mm** once its tips are filleted: the two knife-tip files' smallest station
    rail heights are 1.09 and 1.23 mm; the lift is tested with `minRailHeight` raised to 2 mm on
    the first (`validateBoard` finds no `rail-height` issue after it, the deck is unchanged
    outside the tip zone to 1e-11 cm, and stays bitwise symmetric).
12. **Line fits are capped and reported** (S6 review). The plan-loop and stringer-line
    refinements stop after `LINE_REFINE_PASSES` (16, in `classic/params.ts`: twice the
    ⌈log₂ 200⌉ halvings after which a 10 cm start span of 0.05 cm samples cannot hold two;
    measured at most 6) or when no failing span can be split. `convertGeometry` reports every
    stage whose achieved error is above its target as `not-converged` (`convergenceIssues`):
    the plan loop and both lines against `lineTol`, the two fields' judged residual against
    `surfaceTol`. Before, only the fields were reported, so a plan or a line stopping above
    `lineTol` on a board outside the fourteen was silent.
13. **A failed solve at one fairness ratio no longer fails the field** (S6 review). A geom
    failure other than `schoenberg-whitney` is a third trial outcome (`'failed'`):
    `discrepancySearch` does not take it and continues below it, `smallestFeasible` passes over
    it, and `fitField` returns the failure only when no ratio gives a fit. Before, one such
    failure anywhere in the search discarded the fit already found (tested by wrapping geom's
    `approximateSurface` to fail chosen solves).
14. **What S6 hands to S7.** The draft passes `validateBoard` on the shortboard and all seven
    synthetic files. On the funboard and longboard it reports only `rail-profile-invalid` within
    σ ± 0.02 of the nose: with the constant profile laws the steep nose rocker lifts the
    bottom's tangent corner above the apex. Fitting the laws is S7's job; the exit test pins it.

**Oracles and tolerances.** Plan (`conversion-checks.ts`, `measurePlan`, independent of the
converter): the classic outline evaluated from its control points about 0.005 cm apart against
a polyline of 100,001 points of the loop, both ways, less the polylines' chord error
(1e-5 cm), ≤ `lineTol` outside the fillet zones; inside, deviation 6's checks (arcs and loop
both ways ≤ `lineTol`, ≤ 1.1 × predicted to the classic both ways, corners at their
prediction within `lineTol`, circles inscribed within 1e-5 cm, straight pointed tips at the
closed form within 1e-12 cm); `conversion-checks.test.ts` shows the zone checks catch a loop
bent 0.013 cm off a tip arc that the outside checks and the corner distance pass. Lines: the
document's own stringer iso-curves (so the stringer identity is checked with the line fit)
against the classic curves' exact points in `[endGap, L − endGap]`, ≤ `lineTol` outside line
fillets, ≤ the predicted deviation + `lineTol` inside, and the line fillet arcs ≤ `lineTol`
from the line. Surfaces: the classic loft resampled by the kernel on every other converter row,
membership by crossings with 40,000-point polygons of the face loops (points within 1e-4 cm of a
loop skipped), windows recomputed from the classic stations and floors: vertical residual ≤
`surfaceTol` + 1e-12 (rounding of a re-evaluation); on rows halfway between the converter's rows,
never fitted, ≤ 2 × `surfaceTol` (§12.3's reason). No `not-converged` warning; at least 5,000
judged samples per file. The four copies are shown to be the goldens' input (byte-equal files,
or a deep-equal parse for the self-authored shortboard), so they convert identically. Unit
oracles: fillets against the straight-line closed forms (1e-12 × L) and tangency on curves
(1e-9 relative); crease angles converge O(δ) (halving δ halves the change: ratios 2.00–2.02);
ring samples bitwise the kernel's `loftRing`; row membership equals `classifyUV`; the traces
against geom's energies and independent basis functions; the discrepancy search finds the
largest passing ratio to its resolution; `fitField` on an analytic field with a narrow bump in
an unjudged window: judged residual ≤ `surfaceTol`, the bump not followed, the stringer identity
at `constraint` (1e-9 cm), bitwise symmetry, and **maximality** (a fit at the next ratio of the
bisection's resolution, made with geom directly, misses `surfaceTol`).

**Measured** (Node 22, the cloud container, one conversion at a time; the copies as their
goldens). Plan: largest one-sided distance outside fillet zones, knots, passes; lines: worst of
rocker and deck line; fields: judged residual at fitted rows / at mid rows, net (u × v control points),
refinement passes, fairness ratio; rail: smallest station rail height.

| File                  | Plan (cm) | Plan knots, passes | Tip fillets δ (cm) | Lines (cm) | Deck residual, net, passes, ratio  | Bottom residual, net, passes, ratio | Rail (mm) | Time   |
| --------------------- | --------- | ------------------ | ------------------ | ---------- | ---------------------------------- | ----------------------------------- | --------- | ------ |
| shortboard            | 9.1e-4    | 160, 6             | flat nose 0.121    | 6.3e-4     | 4.6e-3 / 4.8e-3, 35 × 25, 2, 6e-4  | 5.0e-3 / 4.4e-3, 59 × 55, 3, 4e-4   | 4.4       | 12.4 s |
| funboard              | 9.2e-4    | 108, 2             | —                  | 6.6e-4     | 5.0e-3 / 4.3e-3, 33 × 23, 2, 2e-4  | 5.0e-3 / 5.1e-3, 78 × 43, 3, 2e-4   | 1.6       | 12.8 s |
| longboard             | 7.7e-4    | 138, 3             | —                  | 5.1e-4     | 5.0e-3 / 4.9e-3, 36 × 20, 2, 6e-4  | 5.0e-3 / 5.0e-3, 61 × 28, 2, 7e-3   | 2.9       | 9.4 s  |
| clean-6x22x2-75       | 7.4e-4    | 298, 6             | 1.21               | 4.0e-4     | 3.9e-3 / 3.9e-3, 100 × 27, 3, 1    | 5.0e-3 / 5.0e-3, 77 × 27, 3, 0.19   | 1.09      | 7.2 s  |
| degenerate-section    | 8.3e-4    | 300, 6             | 1.58               | 4.0e-4     | 5.0e-3 / 4.6e-3, 105 × 37, 5, 0.07 | 5.0e-3 / 5.0e-3, 91 × 37, 5, 0.03   | 9.2       | 20.7 s |
| fallback-outline-5x10 | 8.2e-4    | 282, 6             | 1.46               | 6.4e-4     | 4.1e-3 / 4.1e-3, 93 × 29, 3, 1     | 5.0e-3 / 5.0e-3, 73 × 29, 3, 0.16   | 1.23      | 7.2 s  |
| rocker-absolute-deck  | 8.2e-4    | 196, 6             | 1.48               | 2.8e-4     | 5.0e-3 / 4.9e-3, 87 × 39, 5, 0.24  | 5.0e-3 / 4.9e-3, 87 × 39, 5, 0.21   | 5.8       | 16.4 s |
| rocker-thickness-deck | 8.2e-4    | 196, 6             | 1.48               | 6.8e-4     | 5.0e-3 / 4.9e-3, 87 × 39, 5, 0.26  | 5.0e-3 / 4.9e-3, 87 × 39, 5, 0.23   | 5.7       | 17.1 s |
| stringer-fold-a       | 8.3e-4    | 296, 6             | 1.56               | 8.4e-4     | 3.1e-3 / 3.1e-3, 106 × 39, 5, 1    | 5.0e-3 / 5.0e-3, 87 × 39, 5, 0.28   | 3.7       | 13.0 s |
| stringer-fold-b       | 8.4e-4    | 304, 6             | 1.67               | 4.1e-4     | 5.0e-3 / 5.1e-3, 109 × 37, 5, 0.74 | 5.0e-3 / 5.1e-3, 95 × 37, 5, 0.02   | 8.9       | 19.9 s |

The five synthetic files with a side corner also fillet it (predicted 0.014–0.023 cm), and their
polygonal decks one ridge each. Corner distance minus prediction is at most 6.1e-4 cm. Most of
the time is the two field fits (13–26 `approximateSurface` solves of 27,000–49,000 samples
each): the goldens take 9.4–12.8 s against Q5's 3 s for the whole conversion, a miss recorded for
S9 (candidates: the separable solve of S4 deviation 11 does not apply to scattered data; fewer
bisection steps once the bracket is narrowed by the refinement's ratio). The exit tests convert the
ten distinct files in about 60 s (three test files in parallel).

**Mutation spot check.** `fields.ts` judging a trial as meeting at `2 × surfaceTol`: the two
residual tests of `fields.test.ts` failed (judged residual 1.0e-2 cm), restored. `fairness.ts`
moving the upper end of the bracket (instead of the lower) after a passing trial: three tests
failed (the two search tests of `fairness.test.ts` and the maximality test of `fields.test.ts`,
whose ratio fell to a fit 9.0e-4 cm off), restored. Review fixes: `lines.ts` splitting only
the plan-loop spans whose failing samples lie outside the fillet zones: on the first four
synthetic files the exit's new zone checks failed (fillet arcs → loop 1.10e-3 to 1.32e-3 cm,
plan fit in the zones above 1.07e-3 cm) and so did the new `not-converged` warning; on
`clean-6x22x2-75` and `fallback-outline-5x10` the checks of the first version (both one-sided
distances outside the zones, corner distances) all passed, restored. `fields.ts` and
`fairness.ts` back to the sticky failure flag: two of the three `fields.failure.test.ts`
tests failed (the injected failure returned instead of a fit), restored.

### S7 as built (2026-10-22)

Files, under `src/classic/`: `rail.ts` (the rail stage of §9.7: initial band, apex law, data,
fit, the other lanes, offsets), `band-fit.ts` (the band's data, DOF frame, bounds, normal
equations, active-set solve, fairness search and parameter correction), `extract.ts` (station
keys, windows, the apex bounds of §5.3, the adaptive apex law, lane measurement, the offset
layer), `lsq.ts` (the height-field least squares on z alone, deviation 10) and `convert.ts`
(`convertClassic`, public, and `convertDetailed`, internal, which keeps the stages for the tests
and S8). `sample.ts` gains the exact classic apex per row. Tests: `extract.test.ts`,
`band-fit.test.ts`, `lsq.test.ts`, the S7 half of the three `convert.*.exit.test.ts` files
(`test-support/exit.ts`, `expectS7Exit`), `presets.{shortboard,funboard,longboard}.test.ts`
(`test-support/presets.ts`) and `convert.occt.test.ts` (under `pnpm test:occt`). Public value
added to the pin: `convertClassic` (`./classic`). 373 board2 tests under `pnpm test` (37
files, about 6 min on the container, the conversions on four workers).

**How a conversion runs (S7 part).** After `convertGeometry` (§9.1–§9.6): the initial band on
constant profile laws with the apex at the classic's own apex per station (deviation 4); the
band refined by the build gives the fit's basis, which the document then carries as its
plan's knots (deviation 5); the apex law from the classic apex curve (deviation 2); rail
samples, projected onto the band on that law; the band fit (deviation 1) with
parameter corrections until they stall (review of S7: `bandCorrectionStall`, at most
`maxBandCorrectionPasses`); fullness and hardness measured at the stations
and tips (deviation 3); the offsets (§9.7 item 5); `buildBoard` of the document; the identity
measured on that build. Warnings: every stage above its target (`not-converged`), the band
against `surfaceTol` on its judged samples included, and the build's own.

**Deviations and clarifications:**

1. **The band fit is written out, not geom's `FairProblem`** (`band-fit.ts`). The DOF rules of
   §3.5 and §3.7 are linear, so `S = S₀ + J w` and the fit is a linear least squares in the
   displacements `w`: per master column outside the tip windows, row 1 along `τ̂_d`, rows 2
   and 4 along ẑ, row 5 along `n̂` and ẑ; rows 0, 3 and 6 fixed; partners the exact mirrors.
   Written out, the data's normal equations are assembled once per parameter set and every
   fairness trial is one banded factorisation; and it takes **bounds**, which geom's solver
   does not: every column stays a convex profile (`fullnessRange[0]` of the way along each
   handle at least, the handles inboard of the apex vertical by at least geom's `point`),
   kept by an active set (held unknowns eliminated, re-solved until none leaves its bounds).
   **Data-scale unknowns**: the band basis crowds its columns at a plan fillet (hundredths of
   a millimetre for `maxFrameTurn`), far closer than the data rows; there the least squares
   cannot tell neighbours apart and, at small fairness, zig-zags by metres. Only masters at
   least `sampleSpacingX / L_loop` apart in σ are unknowns; the others interpolate their kept
   neighbours linearly in σ. **Tips**: columns within `tipWindow` of an end are not fitted
   (they keep the band built on the laws) and their samples are not data. **Fairness** (§9.8)
   on the displacement from the initial band: the largest ratio whose fit meets `surfaceTol` on
   the judged samples; when even the bracket's smallest cannot, the largest whose judged
   samples all stay within `surfaceTol` of where the smallest puts them.
2. **The apex is not a fit unknown.** §9.7 item 3 left row 3's z free and item 4 measured the
   apex law back. But the apex row has no offset (§6.1), so the law alone must carry it, and
   the apex is a datum: the outline's height. So the apex law is fitted first, to the classic
   apex curve (each row's exact widest point, golden-section search on the ring fraction in
   `sample.ts`; one ring step is up to a millimetre of rail there), as a fraction of each
   column's rail height, at every column outside the tip windows: keys at the stations and
   tips, then a key at the worst column of every segment missing by more than
   `lawTolerance.apexHeight`, until none does (`adaptiveLaw`; 37–49 keys added on the goldens,
   6–11 on the synthetic files). The fit then moves rows 1, 2, 4, 5 with the apex fixed.
3. **The other lanes interpolate the measured values at the stations**, not a least squares:
   §9.7 item 4's "auto handles are linear in the values" is not so (Fritsch–Carlson slopes are
   limited, zero at extrema, §5.2). Keys at every station and both tips, the values measured
   by §5.7 on the fitted band, clamped into the lane's range (`ConversionReport.stationLaws`
   keeps them unclamped: a hard classic edge reads above 1). The offsets carry the rest.
4. **The initial band's apex.** §9.7 item 1 started from the constant 0.4. On the funboard and
   longboard that is the S6 failure (S6 item 14: the steep nose rocker lifts the bottom's
   tangent corner above the apex). The apex starts at the classic apex at each station,
   clamped into the profile's feasible interval (`apexBounds`: `H_l > 0` and `H_u > 0` of §5.3,
   with `apexHeightRange`'s 5 % margins applied to the interval). A column the build still
   refuses gets an apex key inside its interval, its insets halved together first while no
   interval exists, at most `maxRefinePasses` rounds: the funboard needs 6 apex keys and 7
   inset keys, `stringer-fold-a` and `-b` 10 and 20 apex keys, the rest none.
5. **The document builds on the fit's basis; the identity is exact.** The initial design is
   built by the band builder with its refinement (§5.4); that basis is the fit's, and the plan
   JSON from then on carries its knots (the same curve, refined exactly), so every pass and the
   final document's build compute the same columns, σ and frames bitwise. The final document
   has `maxBandRefinePasses: 0`. The identity (§9.7 item 6) is then exact in exact arithmetic:
   measured 2.8e-14–5.7e-14 cm on every file, by the converter on its build and, independently,
   by the exit test on a rebuild from the document's JSON. At S7, `buildBoard`
   measured law fidelity on the band **with** offsets, which by design differs from the laws
   by what the offsets carry, so every converted board warned `not-converged` ("law fidelity
   at 21–78,000 × its target") and the warning carried no signal. **Review of S7**: fidelity
   and the tuck crease are measured on the law-only band (review item 3 below); a later law
   edit keeps `maxBandRefinePasses: 0` (§15 risk 10).
6. **Offsets** (item 5) as designed, plus one step of iterative refinement: the columns crowd
   at a plan fillet, where `interpolatePeriodic` is ill-conditioned, and its residual reached
   the identity's 1e-9 cm once the offsets are large; the residual, read back as the build reads
   the layer, is interpolated on the same parameters and added.
7. **The band fit does not meet `surfaceTol`** (reported as `not-converged`, §15 risk 9). The
   largest projected distance over the judged rail samples is 0.059–0.076 cm on the goldens
   after the review of S7's correction stall (0.067–0.088 cm at S7's two passes; shortboard
   at S7: 42 % of 33,000 judged samples above 0.005 cm, none above 0.1, the worst at the
   tail, x 4–12 cm), 0.13–0.17 cm on five synthetic files and 0.88 cm on the two rocker files
   (one real station, a box section whose deck-side corner the G1 deck join cannot follow:
   §9.9's `profile-corner`). The likely limit is the seven-row profile with five displacements per column
   (not profiled further). S8 must explain these by causes, or the band needs more freedom.
8. **Field data stop where the classic leaves the face** (`convert.ts`, a change to S6's data):
   a deck or bottom sample past a ring turn of `cornerAngleMin` outside the face, or past a
   classic section corner within the data strip's width of the face edge, is the rail, not
   the face. On preset boards with the tuck on the band mark the bottom fit otherwise refined
   without end (a height field cannot turn the corner): 250 s conversions. The S6 exit checks
   are unchanged and pass.
9. **Knife-tip lift**: each deficit gets one spacing of doubles at the deck's largest height
   added, so a deficit below the last round's rounding still lifts (seen on the funboard with
   the 80/20 preset).
10. **Height fields solved on z alone** (`lsq.ts`, performance). geom's `approximateSurface`
    solved x, y and z with multipliers for the stringer identity at every fairness trial; a
    height field's x and y are affine and need no solve, and the search solves one basis a
    dozen times. `lsq.ts` assembles the data's normal equations once per basis, eliminates one
    control value per column with the identity (exact by construction) and factors the banded
    reduced system per trial, refusing an undetermined one as geom does (`pivotRel`, a
    Hager–Higham condition estimate). Same minimiser as geom's within 1e-9 × the z range
    (tested). The geometry stage of the goldens fell from 9.4–12.8 s (S6) to 3.3–4.3 s.
11. **`orientBrep` is not called** by `boardBrep`: it integrated the signed volume a second time
    to confirm what `checkBrep` already refuses (an inside-out shell is one of its errors).
    `BoardBrep.flipped` is gone; `brep.test.ts` still checks that `orientBrep` would not flip.
12. **geom: the exact Green rule caches its inner strips** (`integrate.ts`, the tier-2 item of
    §13.5's P22-class row). `F(u, v) = ∫ f du` summed the inner rule over every u-span from
    `uRef` for every outer point; on one v-span the integral over a whole strip is a polynomial
    in v of the promised degree, so it is stored at that degree's Chebyshev points (first kind
    since the review of S7, item 1: the Lobatto points of S7 put a node on each v-knot and
    were wrong across a C0 one), prefix-summed and interpolated (barycentric), and only the last partial strip is
    integrated directly. `buildBoard` of the converted shortboard 5.6–5.9 s → 1.8–1.9 s,
    longboard 5.4–5.8 → 1.7–2.0 s, `stringer-fold-b` 21.5–22.9 → 3.1–3.5 s; it runs on every
    file open. geom-core §17 holds tier-2 work until the reference-desktop re-measurement; this
    is an algorithmic change (one interpolation per outer point instead of a sum over up to M
    strips), not a constant-factor tuning a faster machine could make unnecessary, so it is
    made now and recorded here. Tests: two new `integrate.test.ts` cases on an 11 × 6-span
    bicubic (natural loop: equal to the tensor rule; a curved trim crossing every knot line:
    equal to adaptive integration at `quadRel` 1e-13, within 1e-12); all 1,301 geom tests pass.
13. **Preset recovery as tested** (§13.2). The kernel's `applyRailProfile` on every real station
    of each golden, converted with the insets at the preset's own band marks
    (`deckInsetFraction = deckBand`, `tuckInsetFraction = bottomBand`). The oracle reads the
    classic loft itself in board2's station plane between the document's own band marks
    (`test-support/presets.ts`: bisection on the ring fraction, dense apex sampling), at the
    stations outside the tip windows whose classic reading lies inside `apexHeightRange` (near
    the nose the station plane cuts the rail at 49–52° and the classic apex lies above the deck
    mark; the law is clamped to 0.95 there). The classic `apex` parameter itself is checked at
    the station nearest the widest point (tangent 0.4–0.7° off x). Hardness: the classic edge is
    binary (`HARD_EDGE` 0.75 in the kernel), so 0.5 against 1; fullness 0.2 < 0.6 < 0.9.
14. **OCCT on the converted goldens at 0.03 mm deflection**, as the stadium's suite (S4), not
    the protocol's 0.01 mm: all three faces of a converted board are curved, and at 0.01 mm
    OCCT meshes a golden for 2–5 min per file unit (the first run timed out at 370–605 s per
    file). At 0.03 mm the B8 bound is 1.3e-3–1.6e-3 of the volume (under
    `MESH_BOUND_MAX_REL` 5e-3; the shortboard's measured mesh error is a sixth of it). The suite still
    takes about 10 min for the three goldens (conversion 12 s, `massProperties` 11–14 s,
    OCCT's mesh 1–2 min per file unit), so the per-test timeout is 600 s.

**Oracles and tolerances.** Exit criterion 1 (`expectS7Exit`, every one of the ten distinct
files; the four copies are their goldens' input, S6): `convertClassic` ok with warnings of
the two expected kinds only, matched by code and message (review of S7, item 2): the band
against `surfaceTol` (exactly when `bandError` exceeds it) and the law-only band's law fidelity
(at most one, within 20 cm of an end); `bandError`, the fidelity ratio and the law-only tuck
crease within 1.2 × their per-file measured values (`S7_MEASURED`, characterization, not
accuracy); the offsets never move the apex row; the document deep-frozen; `validateBoard` no error; JSON revive equal; a rebuild from that JSON
reproduces the fitted band within 1e-9 cm (the design's bound; measured ≤ 5.7e-14) and so does
the converter's own measure; `checkBrep` ok, 3 faces, 3 edges, 2 vertices, positive volume;
`writeBoardStep` writes 3/3/2; the input board unchanged. OCCT (`convert.occt.test.ts`, the
three goldens, mm and cm, deflection 0.03 mm: deviation 14): B1–B4, B5/B6 (every edge and face equal to ours), B8 (OCCT's mesh
volume within its bound of `massProperties`). Preset recovery: apex within 0.01 (the classic
places the apex exactly; the rest is fit error) at every in-range station of 24 conversions
(measured at most 7.3e-3 on the shortboard, 3.3e-3 longboard, 6.2e-4 funboard; at the widest
station at most 3.7e-3); hardness strictly greater with the hard edge at every station
(margin ≥ 0.95); upper and lower fullness strictly increasing at every station. Units:
factorisation on a crowned stadium band displaced along every offset direction (seeded) within
1e-12 × 200 cm; apex bounds against the construction's own `H_u`, `H_l`; the adaptive law
meets every target within its tolerance; the band fit recovers a known displaced band from
its own samples within 1e-9 cm at the bracket's smallest weight, moves rows 1, 2, 4, 5 only,
keeps rows 2 and 4 on the apex vertical bitwise, mirrors partners, and holds every unknown in
its bounds; `lsq.ts` against geom (above); the exact apex against 2·10⁵ dense ring samples.
Measured on the converted shortboard, longboard and `stringer-fold-b` (not a test; exit
criterion 5 is S9's): deck join 0.039–0.048° (≤ 0.1°), apex join at rounding (≤ 1.9e-16 rad),
and, at S7, the tuck crease 0.40–0.61 rad away from the hardness law on the band with offsets
(the offsets move row 5); on the law-only band (review of S7) 1.5e-4–9.1e-3 rad on the ten
files.

**Measured** (Node 22, the cloud container, one conversion at a time; the copies as their
goldens). Geometry: §9.1–§9.6; rail: §9.7 (the band fit in brackets); build: `buildBoard` of
the document inside `convertClassic`; rebuild: `buildBoard` of the document alone (what a file
open costs once the document is stored); band: largest projected distance, judged / all
samples; ratio: the band's fairness ratio; columns: band columns; apex keys: added by the
adaptive law; identity: `factorisationError`.

| File                  | Geometry (s) | Rail (s)      | Build (s) | `convertClassic` (s) | Rebuild (s) | Band (cm)     | Ratio  | Columns | Apex keys | Identity (cm) |
| --------------------- | ------------ | ------------- | --------- | -------------------- | ----------- | ------------- | ------ | ------- | --------- | ------------- |
| shortboard            | 3.4          | 7.0 (fit 3.1) | 1.9       | 12.3                 | 1.9         | 0.067 / 0.108 | 0.20   | 352     | 37        | 2.8e-14       |
| funboard              | 4.3          | 6.3 (fit 3.4) | 1.9       | 12.6                 | 1.7         | 0.088 / 0.088 | 1      | 294     | 49        | 2.8e-14       |
| longboard             | 3.3          | 7.6 (fit 4.2) | 1.6       | 12.5                 | 1.6         | 0.077 / 0.115 | 0.91   | 324     | 48        | 5.7e-14       |
| clean-6x22x2-75       | 4.6          | 5.8 (fit 1.5) | 3.3       | 13.7                 | 3.5         | 0.151 / 0.168 | 1      | 496     | 6         | 2.8e-14       |
| degenerate-section    | 8.5          | 7.3 (fit 2.8) | 3.3       | 19.0                 | 3.2         | 0.168 / 0.168 | 0.036  | 394     | 11        | 2.8e-14       |
| fallback-outline-5x10 | 4.8          | 5.9 (fit 1.6) | 3.5       | 14.2                 | 3.2         | 0.137 / 0.151 | 1      | 484     | 6         | 2.8e-14       |
| rocker-absolute-deck  | 7.7          | 9.9 (fit 3.4) | 4.6       | 22.3                 | 4.6         | 0.885 / 0.886 | 2.9e-6 | 606     | 6         | 2.8e-14       |
| rocker-thickness-deck | 7.8          | 9.9 (fit 3.4) | 4.6       | 22.3                 | 4.4         | 0.884 / 0.886 | 3.1e-6 | 600     | 6         | 2.8e-14       |
| stringer-fold-a       | 7.6          | 5.7 (fit 2.1) | 3.1       | 16.4                 | 3.0         | 0.134 / 0.134 | 0.10   | 402     | 8         | 2.8e-14       |
| stringer-fold-b       | 8.8          | 5.9 (fit 2.3) | 3.0       | 17.7                 | 3.2         | 0.129 / 0.146 | 0.23   | 422     | 7         | 2.8e-14       |

`convertClassic` + its `buildBoard` takes 12.3–22.3 s per file against Q5's 3 s (a miss,
reported, for S9), and a stored document rebuilds in 1.6–4.6 s against Q1's 150 ms: both must
run in a Web Worker on file open (the project's "UI never blocks"). Preset conversions take 11–90 s each with three running at once (the slowest, `knifey` and
`pinched` on the shortboard; not profiled). **Speed-ups not done** (follow-ups for S9): the
initial band (1.7–4.5 s) builds and refines the band once more than the fit needs; the
band fit reassembles the normal equations per correction pass and searches 12 ratios each
time where the previous ratio brackets the next; the build inside `convertClassic` repeats
the last pass of the rail stage; the field refinement splits both u and v spans of a failing
sample (S6 deviation 10's candidate); the fairness search of a field could start from the
previous basis's ratio.

**Mutation spot check.** `extract.ts` with the z part of the deck-handle offset's `τ̂_d`
component negated: the factorisation test failed on the crowned stadium (1.8e-3 cm against
2e-10), restored. The first version of that test used the flat stadium, where `s_d = 0` hides
the z part: the mutation passed it, so the test now uses a crowned deck. geom `integrate.ts`
with one Chebyshev–Lobatto point too few in the strip cache: five `integrate.test.ts` tests
failed (relative errors 3.9e-4 to 4.8e-3 against 1e-12, one NaN), restored.

**Review of S7** (an independent review; each finding verified, then fixed):

1. **geom strip cache across a C0 v-knot** (blocker, confirmed: 2.1 % on a bicubic with a
   triple v-knot under a triangle trim, 0.9 % natural loop against the tensor rule, 1.3 % under
   a rational circle). The Chebyshev–Lobatto end node on the knot was evaluated with the
   right-hand span. Fixed with first-kind Chebyshev points (all interior; robust whatever the
   span convention, rather than a left-hand evaluation of the end node): the reviewer's case
   matches the S6 rule and adaptive integration to 4e-16. New cases (geom-core §11.3): C0 in v
   and in u, a C1 v-knot under an `S_vv` integrand. Mutations: one node too few now fails two
   tests (the volume integrand's top v-coefficient vanishes, `det(S, S_u, S_v)` of the leading
   terms, so its true v-degree is `3q − 2`), two too few fail seven. Also measured: the
   natural loop of the reviewer's C0 surface differs from the tensor rule by 1.75e-12 in both
   the S6 and the fixed rule (the crossing bisection places the C0 break to `paramRel`, within
   the reported error estimate); not changed.
2. **Exit checks with teeth** (`expectS7Exit`): the allow-list and characterization above.
   Mutation: `maxBandCorrectionPasses` 0 fails the shortboard (0.126 against 0.071) and the
   funboard (0.134 against 0.091).
3. **Law fidelity and the crease on the law-only band** (decision of the lead): `buildBand`
   builds, beside each pass, the band of the laws alone on the same basis (one more band pass
   on a document with offsets: a converted golden's build 1.3–1.6 s against 1.2–1.4 s, noisy)
   and measures fidelity and the crease there; the apex and deck joins and the edge z-fits stay
   the built band's. `BuildReport.offsetContribution` reports, per row, the largest
   control-point move the offsets make. If the law-only band cannot be built its issues become
   warnings and the built band is measured. Measured: fidelity 1.1–5.1 × its target on eight
   files (none on `clean-6x22x2-75` and `fallback-outline-5x10`), 1.4–4.1 cm from an end on six,
   17.8 cm on the two rocker files; the crease 1.5e-4–9.1e-3 rad. The scaled bound of
   `band.test.ts` (`lawTolerance.edgeHardness · max |φ_chord|` × the fidelity miss) fails on
   three files, so the crease is characterized. Test: `band.test.ts`, the same fidelity and
   crease bits with or without an offset layer, and its contribution exactly on its row
   (fails with the old measure). `maxBandRefinePasses: 0`: §15 risk 10.
4. **Correction stall** (`maxBandCorrectionPasses` 4, `bandCorrectionStall` 0.02, §12.2).
   Per-pass judged maximum (cm): shortboard 0.126, 0.086, 0.067, 0.063, 0.059 (8 passes:
   0.056), funboard 0.135 → 0.076, longboard 0.082 → 0.069; the synthetic files improve by
   0.1 % per pass and stop after one. Conversion times, same container, one at a time, two
   fixed passes against the stall: shortboard 10.5 → 11.4 s, funboard 8.3 → 9.9 s, longboard
   8.8 → 10.7 s (goldens +16 % together; 5 passes would be about +31 %, 6 +41 %); the synthetic
   files 4–12 % faster. The pass with the smallest judged maximum is kept.
5. **`checkBrep` refuses a non-finite volume** (geom; `check.volume.test.ts` with the measured
   volume mocked: NaN and ±∞ were accepted before).
6. **Preset apex check labelled**: the in-range comparison is a consistency check (the law is
   fitted to the same widest points), the preset's own `apex` the independent oracle; the
   monotonicity tests assert non-empty, identical station sets.
7. **Stale text** (§6.3 step 13, §7, S4 item 6) corrected; `convertClassic`'s document is
   deep-frozen like a revived one (checked by `expectS7Exit`).

| File (after the review) | Geometry (s) | Rail (s)      | Build (s) | `convertDetailed` (s) | Band (cm)     | Ratio  | Corrections | Fidelity (×) | Crease (rad) |
| ----------------------- | ------------ | ------------- | --------- | --------------------- | ------------- | ------ | ----------- | ------------ | ------------ |
| shortboard              | 2.6          | 7.1 (fit 4.2) | 1.6       | 11.4                  | 0.059 / 0.109 | 0.37   | 4           | 3.46         | 2.2e-3       |
| funboard                | 2.8          | 5.7 (fit 4.0) | 1.4       | 9.9                   | 0.076 / 0.076 | 1      | 4           | 2.37         | 2.1e-3       |
| longboard               | 2.3          | 7.1 (fit 5.1) | 1.3       | 10.7                  | 0.069 / 0.115 | 0.95   | 4           | 5.11         | 2.4e-3       |
| clean-6x22x2-75         | 3.2          | 4.1 (fit 0.8) | 2.7       | 10.0                  | 0.151 / 0.168 | 1      | 1           | met          | 1.5e-4       |
| degenerate-section      | 6.9          | 4.2 (fit 1.2) | 2.3       | 13.4                  | 0.169 / 0.169 | 0.032  | 1           | 2.18         | 9.1e-3       |
| fallback-outline-5x10   | 3.1          | 3.8 (fit 0.7) | 2.5       | 9.4                   | 0.137 / 0.151 | 1      | 1           | met          | 2.7e-4       |
| rocker-absolute-deck    | 6.2          | 6.6 (fit 1.8) | 3.9       | 16.8                  | 0.885 / 0.886 | 1.3e-6 | 1           | 1.73         | 1.5e-3       |
| rocker-thickness-deck   | 6.0          | 6.6 (fit 1.8) | 3.8       | 16.4                  | 0.884 / 0.887 | 1.4e-6 | 1           | 1.75         | 1.5e-3       |
| stringer-fold-a         | 5.9          | 3.4 (fit 1.1) | 2.2       | 11.6                  | 0.134 / 0.134 | 0.10   | 1           | 1.22         | 6.0e-4       |
| stringer-fold-b         | 6.9          | 3.9 (fit 1.3) | 2.6       | 13.5                  | 0.129 / 0.146 | 0.23   | 1           | 1.14         | 6.7e-4       |

(Fidelity: the law-only band's worst lane ratio, the build's warning; crease: its tuck-crease
error. The container ran these faster than the S7 table's run; compare within a table.)

---

### V1 viewer (2026-10-23)

The first user-visible use of board2: a read-only NURBS view of the board in the browser, behind
the experimental-engine flag (plan §5), so the new geometry can be judged by eye before the
Phase 3 editors exist. Editing, saving and every export stay classic; nothing of board2 is
written to a file.

**What it shows.**

- **The flag.** "Engine: NURBS (experimental)" in Settings (`EditorSettings.nurbsEngine`,
  persisted with the other settings, default off) or `?engine=nurbs` (this session only, never
  saved; `nurbs-flag.ts`). With it off the app is unchanged: no NURBS UI, no request for any
  NURBS chunk (an e2e test checks both), and the 3D view's props are the old ones.
- **The surface.** The board on screen is converted (`convertClassic`, which builds it),
  tessellated with geom's `tessellateBrep` (watertight, deck + band + bottom) and drawn in the 3D
  pane in place of the classic hull, placed by the classic hull's centre so fins, guides and
  every overlay still line up. The classic mesh stays on screen until the NURBS surface is ready
  and whenever the board has changed since.
- **Progress.** A status line, "Converting to NURBS… 12 s · classic shown meanwhile", ticks
  while the worker runs. A hull change (outline, rocker curves, cross-sections: `sameHull`)
  starts a 1.2 s quiet period (`DEBOUNCE_MS`) that every further change, and every moment the
  store is mid-drag, restarts; a conversion in flight when the hull changes is cancelled and its
  worker terminated. A fin edit is not a hull change.
- **Cache.** Converted (and failed) hulls are kept three at a time by hull identity, in a
  viewer that outlives the 3D pane, so undo, a view switch or a layout change shows the surface
  again without converting. A change of mesh quality re-meshes the held model (the worker keeps
  two; it rebuilds from the stored document if it was restarted) and never converts again.
- **Badge and toggle.** "NURBS (experimental) — read-only" over the view, a Classic / NURBS
  switch to compare the same board, and an "i" popover: the converter's warnings
  (`not-converged`, band-fit residuals, law fidelity), how well each part was fitted (in the
  display unit; lengths inside converter messages are rewritten into it, `localizeLengths`),
  the conversion and mesh times and the vertex count. A failed conversion (a concave tail is
  refused with `unsupported-tail`, a crashed worker) shows the classic mesh and the reason there.
  Every converted board warns `not-converged` (S7 deviation 5), so the dot on the button is
  always lit for now.
- **Analysis on the NURBS surface**, through Phase 0's menu and legend. Mean curvature, Gaussian
  curvature and rail radius are geom's exact principal curvatures at the tessellation vertices
  (`FaceMesh.curvature`, from `Su`, `Sv`, `Suu`, `Suv`, `Svv`; not from the mesh), mapped to the
  view's signs (`nurbs-curvature.ts`: with the outward normal, `mean = −(k1 + k2)/2`, so convex
  is positive; a face with `sameSense = false` swaps to `(−k2, −k1)`), with the same area-weighted
  percentile scales as the classic surface, so a board reads alike on both. Zebra and the other
  screen-space modes use the exact normals. **Deviation from classic** (new, offered only with
  the flag on) is the signed distance from the NURBS vertices to the classic surface,
  positive where the NURBS surface has more foam, reusing the ± band control and the legend,
  in the display unit. `ghostDeviation` of the kernel measures within the station plane; the
  value is multiplied by `√(1 − nx²)` (`nx` the NURBS normal's length component), which is the
  distance along the normal to first order (`nurbs-deviation.ts`). The NURBS vertices are not
  in station rings, so the classic is measured at sections every 0.25 cm and interpolated in x.
  Mean-curvature jumps at a station crease of the classic loft do not appear on the NURBS
  surface (nor do they need to), but nothing was done to make the NURBS surface smoother than
  its fit: it is what S7 produces.

**Layout.** `apps/web/src/`: `nurbs-flag.ts`; `nurbs-client.ts` (ids, supersession,
synchronous fallback, `use-specs-worker.ts`'s protocol as a plain object); `nurbs-viewer.ts`
(the debounce, cancel and cache state machine); `nurbs-layer.tsx` (badge, toggle, popover;
lazy); `nurbs-surface.ts`, `nurbs-text.ts`; `workers/nurbs-protocol.ts` (types, no board2),
`nurbs-curvature.ts`, `nurbs-deviation.ts` (pure), `nurbs-core.ts` (the only board2/geom
importer with the worker shell `nurbs-worker.ts`). `render3d` gains the `ExternalSurface` prop
of `Board3DView` (`external-surface.ts`), `nurbs-deviation` in the analysis modes
(`DeviationAnalysisMode`) and the exact modes' ready status from a supplied surface. Typed
arrays come back from the worker as transferables.

**Tessellation sizing.** The classic mesh is a grid of about `faceSize` cells; geom's is
adaptive, so `tessellationFor(faceSize)` sizes it by error: chord tolerance 5 % of the face size
(0.01 to 0.1 cm), normal turn 0.4·√(faceSize/0.9) rad (0.2 to 0.55), longest edge six faces.
geom's defaults (0.1 mm, 0.1 rad) gave 160,000 vertices in 15 s on the shortboard.

**Timings and sizes.** Measured in Chromium (headless, software GL, the cloud container: 4 cores, nothing else
running) on a production build, one file at a time, by `apps/web/tools/perf/nurbs-timing.mjs`
(opens each file in the editor with `?engine=nurbs`; the worker's own clock). _Convert_: `convertClassic`,
its build included; _mesh_: tessellation, exact curvature and the deviation from classic at the
standard quality (0.9 cm); _wall_: from opening the file to the surface on screen, the 1.2 s
quiet period included.

| File                     | Convert (s) | Mesh (s) | Wall (s)     | Vertices |
| ------------------------ | ----------- | -------- | ------------ | -------- |
| shortboard (golden)      | 7.4         | 2.2      | 11.3         | 31,916   |
| funboard (golden)        | 7.8         | 1.5      | 10.9         | 20,188   |
| longboard (golden)       | 8.3         | 1.7      | 11.7         | 22,772   |
| self-authored-shortboard | 7.9         | 2.3      | 11.8         | 31,916   |
| clean-6x22x2-75          | 9.8 to 10.1 | 5.9 to 7 | 17.3 to 18.8 | 71,691   |
| degenerate-section       | 14.0        | 6.2      | 21.9         | 74,235   |
| fallback-outline-5x10    | 9.8         | 3.6      | 15.0         | 43,967   |
| rocker-absolute-deck     | 15.3        | 4.9      | 21.8         | 62,917   |
| rocker-thickness-deck    | 16.5        | 4.9      | 23.1         | 62,714   |
| stringer-fold-a          | 12.8        | 5.8      | 20.4         | 71,586   |
| stringer-fold-b          | 13.3        | 7.1      | 22.0         | 73,401   |

clean-6x22x2-75 was timed in two runs (the range in its row); run-to-run noise is about 5 to
15 %. The goldens convert in 7 to 8 s, below the S7 table's Node figures (12 to 22 s), which
were measured with other work running on the machine: the browser worker is not slower than
Node. Every file converted (phase `ready`, no page error). `degenerate-section` opens with
an import warning, which the script accepts. A re-mesh at another quality of a held model
costs the "mesh" column again. The bundled sample board converts to the same 31,916-vertex
mesh as the shortboard (the same board).

Bundle (`pnpm build`, raw / gzip; the baseline is the build of the commit before the
viewer): the **main entry chunk is unchanged** (`app`: 446,016 B, 145 KB gzip), and so is every
chunk a flag-off user fetches apart from these small additions: the editor chunk `App`
183,069 to 185,290 B (+2.2 KB; 56.1 to 56.9 KB gzip: the flag, the settings row, the
`ThreeDPane` wiring), the shared render3d chunk +1.3 KB (the external-surface prop and the
deviation mode), the `Editing` docs page +2.4 KB. New chunks, fetched only with the flag on:
`nurbs-layer` 11.7 KB (4.6 KB gzip, the badge and viewer state machine), `nurbs-worker`
297 KB (106 KB gzip: board2, geom, the converter, the kernel pieces they use) and
`nurbs-core` 284 KB (101 KB gzip), which only the no-`Worker` fallback fetches and no browser
does. board2 and geom are in no other chunk (grep of the build for the document format string
and geom's issue codes finds only those two files). None of the three is precached, and none is preloaded: vite-react-ssg writes a
`modulepreload` hint into the prerendered page for every lazy chunk it can reach, which put all
three (0.6 MB) on every `/app` load until `tools/nurbs-preload.ts` (run from `ssgOptions.onPageRendered`)
stripped them and failed the build if one came back. The offline e2e suite caught it: the
preload of an unprecached chunk is a console error with the network cut.

**Known limits.**

- Conversion is 8 to 20 s per board (the S7 table above is Node; the browser worker is not
  slower for the shortboard, see the table). The classic mesh is shown meanwhile; nothing can
  be edited in NURBS.
- Concave (swallow, fish) tails are refused by the converter: the classic mesh is shown with the
  reason.
- A conversion in flight is lost when the 3D pane is left and the board changes, and a refresh
  loses the cache (nothing is stored); a stored document would rebuild in 2 to 5 s (S7 table).
- The NURBS chunks are not precached by the service worker (`assets/nurbs-*.js` is in
  `globIgnores`), so the viewer needs a connection the first time it is used.
- The band fit misses its target on every file (S7 deviation 7: 0.67 mm on the shortboard in
  the popover; the rocker files 8.8 mm), and "Deviation from classic" shows exactly that. The
  deviation is measured at the NURBS vertices only, and is no data within a quarter of a
  centimetre of a tip where the classic section degenerates.
- Curvature at a knot line of the band or the height fields where the surface is not C2 is
  read from one side.
- Mesh quality "Fine" is slow (several seconds; the vertex count grows about with the square
  of the quality).

## 15. Risks and open questions

1. **Deck join quality at tight tips.** G1 at the deck edge is control-point-wise; where the
   frame turns fast the refinement loop may need many stations. Mitigation: `maxFrameTurn`,
   the fidelity loop, and the measured report.
2. **Profile validity on steep decks** (`H_u ≤ 0`): a domed deck falling below the apex height
   over a wide inset has no convex G1 profile. The validator reports it; the converter's
   insets avoid it; Phase 3's editor must prevent it. Open: whether an S-shaped upper profile
   should be allowed.
3. **Classic data the band cannot follow**: deck-side profile corners (polygonal synthetic
   files) and the classic's square transom edges. Explained, not reproduced
   (`profile-corner`, `tip`). Open: a deck-edge hardness lane, if shapers want crisp deck
   edges.
4. **Channel cost** under tensor-product refinement (§6.2): channels whose walls curve with
   `h_t` (the tail arc) need a fine tensor net. The fit is separable (5 s for two channels
   there, 149 s as one banded solve); `validateBoard` pays the fit (4.4 s), `buildBoard`
   also the B-rep's two volume integrations over that net (17 s, §13.5).
5. **Converter conditioning** of the free band fit near tips where classic data are sparse:
   fairness by the discrepancy principle and the tip keys of §9.5.
6. **Benchmarks** measured on the cloud container only, like Phase 1's.
7. **Two classic volume models** (spec panel vs loft) differ; the report separates them so a
   board2 change is never blamed for a classic split.
8. **Pointed plan tips and the length checkpoint** (S6). A smooth tip of plan radius ≥
   `minInset / insetCurvatureFraction` either retreats from a pointed classic tip (the
   fillet: 1.2–1.7 cm per tip at `cornerFilletRadius` on the synthetic files' 27–34° tips, still
   ≥ 0.48 cm at the smallest admissible radius) or keeps the tip centre with an inflection (a
   bulb). S6 fillets; S8 must explain the synthetic files' length delta by the predicted
   fillet deviations (§10.4) rather than hold it to 1 mm. Open: whether the checkpoint should
   say so for pointed tips, or Phase 3 offer a tip-keeping blend.
9. **The converted band: accuracy and what the offsets carry** (S7). The band fit misses
   `surfaceTol` on every sample file (0.067–0.088 cm on the goldens, 0.13–0.17 cm on five
   synthetic files, 0.88 cm on the two rocker files' box section), against S8's
   `unexplainedMax` 0.01 cm: S8 must attribute it to causes (`profile-corner` and the like) or
   the band needs more freedom per column. And because the offsets carry what the laws do not,
   fidelity and the "tuck crease = law" invariant (exit criterion 5) did not hold on the band
   with offsets (fidelity 21–78,000 × its target; crease 0.4–0.6 rad off). **Resolved in the
   review of S7**: both are measured on the law-only band, where the crease is the law to
   1.5e-4–9.1e-3 rad and fidelity misses by 1.1–5.1 × on eight files, within 20 cm of an end
   (1.4–4.1 cm on six; the fit's basis was refined for the initial laws, not the final ones);
   the offsets' contribution is reported per row. Still open: whether the converter should
   refine the basis for its final laws (that
   would remove the remaining fidelity warning, at the cost of a second band build and fit).
10. **`maxBandRefinePasses: 0` in converted documents** (S7 as built, item 5; review of S7).
    The converter stores it so the build reproduces the fitted band bitwise. A later law edit
    keeps it: the edited band is built on the converter's basis without refinement, and if
    that basis is too coarse for the new laws the law-only fidelity warns `not-converged`
    (no longer drowned by the offsets) rather than refining. Restoring the default is safe
    (the offset fields are functions of σ and re-apply on a refined basis). Decision: no
    converter-specific setting now; board2 has no edit operations (they are Phase 3's store
    edits), so there is nothing to reset it. Phase 3's law-edit operation must set
    `maxBandRefinePasses` back to `DEFAULT_BUILD_PARAMS.maxBandRefinePasses` on a converted
    document (`meta.source` `'classic'`) unless the user set it.

---

## 16. References

- `docs/design/geometry-overhaul.md` (§3.2, §3.3, §6, §7, §8), `docs/design/geom-core.md`.
- `packages/kernel/src/{board,cross-section,loft,board-surface,rail-profile,outline-cutout}.ts`.
- `packages/io/src/roundtrip.characterization.test.ts` (the sample-file list).
- L. Piegl, W. Tiller, _The NURBS Book_, 2nd ed. (§9.4 least squares, §6.1 point inversion,
  §5.2 knot insertion, linear precision of Greville abscissae).
- F. N. Fritsch, R. E. Carlson, "Monotone piecewise cubic interpolation", _SIAM J. Numer.
  Anal._ 17 (1980).
- I. J. Schoenberg, variation-diminishing spline approximation (as in C. de Boor, _A
  Practical Guide to Splines_, ch. XI).
- W. Welch, A. Witkin, _Variational surface modeling_, SIGGRAPH '92.
- P. C. Hansen, _Rank-Deficient and Discrete Ill-Posed Problems_ (the discrepancy principle).
