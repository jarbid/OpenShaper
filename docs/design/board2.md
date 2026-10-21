# `@openshaper/board2` — board model v2 (Phase 2 design)

Status: **design and scaffold** for Phase 2 of `docs/design/geometry-overhaul.md` (§6; the
topology and editing model it implements are §3.2 and §3.3). Written 2026-10-21 on
`experiment/nurbs-overhaul`, after Phase 1 (`docs/design/geom-core.md`) was integrated. The
package exists as a scaffold: `package.json`, the type definitions of §11 in
`src/types.ts` and `src/classic/types.ts`, and a smoke test. Nothing is implemented yet; §14 is the build
order. When this document and the code disagree, this document wins until the step that
changes it edits this file in the same commit.

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
   bottom tangent `(C_l − T)` and is rotated in the station plane towards the chord `A − T`
   by `h · φ_chord`, where `φ_chord` is the angle from the bottom tangent to the chord;
   `P5 = T + f_l |C_l − T| · rot(û_b, h φ_chord)`, `P6 = T`. Every h ∈ [0, 1] keeps the lower
   profile convex; the crease angle between bottom and band at the tuck is `h φ_chord`.

All seven points lie inboard of or on the apex vertical, so by the convex-hull property no
profile reaches past its apex. Classic-preset equivalence: with `deckInset = deckBand ×
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
3. `curveOnSurfaceTo3d(curveOnSurface(D, pcurve))` fits the 3D edge with the **same
   parameter** within `Tolerances.fit` (geom §6.15). It may add knots.
4. The band basis becomes the union of its knots and both fits' knots, symmetrised (a knot
   and its mirror); knot insertion leaves every row's shape unchanged.
5. Rows 0 and 6 take the fitted z (their x, y stay the exact plan rows, which a fit of the
   same space reproduces to rounding); in symmetric mode partner columns are averaged (a
   convex combination of curves within `fit` of a symmetric target stays within `fit`).
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

| Kind       | Parameters                                                                   | Displacement d(x, η) added to z        |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------- | --- | ------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------- |
| `vee`      | `depth`, `stringerRadius` (fraction of h_t)                                  | `depth(x) · g(                         | η   | )`, g linear in                             | η   | with a C¹ parabolic blend of half-width `stringerRadius` at the stringer (rails rise, the stringer stays) |
| `concave`  | `layout: 'single' \| 'double'`, `depth`, `centre`, `width` (fractions)       | `−depth(x) · bump((                    | η   | − centre)/width)`, `bump(t) = (1 − t²)²` on | t   | < 1: zero value and slope at its edges                                                                    |
| `channels` | `count`, `depth`, `width` (cm), `pitch` (cm), `railInset` (cm from the tuck) | `count` narrow concaves in absolute cm |

Evaluation: each feature is sampled on a grid over the tuck region and fitted onto the
bottom's basis refined by the feature's own knot lines (`approximateSurface`, fixed bases, no
parameter correction: height fields, §3.4), within `featureTol`. The fitted displacements are
added to the base bottom after making the bases compatible (exact), so the sum is
independent of order up to rounding (a test). Features end in zero value and slope before the
tuck unless a feature explicitly reaches it, so `edgeHardness` keeps its meaning.

Limit: a channel's steep walls need fine knots, and tensor-product refinement spreads them
across the whole bottom (cost, not correctness). Hierarchical splines stay deferred (plan
§3.4); the cost is benchmarked (§13.5, Q7).

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
13. B-rep: assemble, orient (`orientBrep`), `checkBrep`.
14. On demand: specs, STEP, tessellation.

Each stage reads only the doc parts and stages above it, so a law edit reuses stages 2, 3 and
6, and a feature edit reuses 2–5.

---

## 7. B-rep and STEP

| Face     | Surface           | Boundary                                                                                             | `sameSense` (measured by `orientBrep`) |
| -------- | ----------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `deck`   | deck height field | deck-edge pcurve (the exact plan map), CCW                                                           | true (n = +z)                          |
| `band`   | band (periodic u) | natural: row 0, seam, row 6, seam                                                                    | false for the u/v orientation of §3.5  |
| `bottom` | bottom total      | tuck pcurve, clockwise in (u, v) (geom §6.19: a face with `sameSense` false runs its loop backwards) | false (outward is −z)                  |

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
  `minKnotSpacing`, at most `maxRefinePasses`: refining further would resolve the classic
  creases themselves, which is what Phase 2 removes.
- **Knife tips**: if a station's rail height `E.z − T.z` is below `minRailHeight`, equality
  constraints `D(E) − B(T) = minRailHeight` are added at the violating stations and the deck
  refitted (active set, at most `maxRefinePasses` rounds). Reported as the board2 tip floor.
- Exact symmetrisation as for the plan.

### 9.7 Band, laws and offsets

1. **Initial band**: the doc so far with constant laws from `DEFAULT_RAIL_LAWS` (the 60/40
   tucked preset: apex 0.4, fullness 0.6, hardness 0.5) built by the core builder.
2. **Data**: classic samples outside the inset loops (upper side outside the deck edge, lower
   side outside the tuck), floor zones excluded; initial (u, v) by warm-started batch
   projection onto the initial band (`projectPointsToSurfaceInto`, P17's warm path).
3. **Free fit** with geom's solver: a `FairProblem` whose DOF map holds the structural rules of
   §3.5 plus the symmetry rules of §3.7 (rows 0 and 6 fixed, row 3 z free), data as soft
   targets, fairness on the displacement from the initial band (weight by §9.8), then
   `parameterCorrection` passes (re-project, re-solve) up to `bandCorrectionPasses`.
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
  ends, by fillets (which keep the tip centres) and the tip floor.

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
  - Every existing package's entry lists `board2` as forbidden, geom's included; the apps rule
    forbids `@openshaper/board2` and `@openshaper/board2/*` until a later phase wires the flag.
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

| Name                     | Default                                                     | Meaning                                           | Why this value                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minInset`               | 0.1 cm                                                      | Smallest deck or tuck inset                       | 1 mm: the scale of a CNC finishing feature (accuracy 0.1 mm) and 1,000 × `Tolerances.fit`, so the edge fits never touch the apex.                 |
| `insetCurvatureFraction` | 0.5                                                         | Effective inset ≤ this × plan radius of curvature | An inward offset by d of radius ρ has radius ρ − d; d ≤ ρ/2 keeps the inset loops at most 2× as tight as the apex and far from the cusp at d = ρ. |
| `minRailHeight`          | 0.1 cm                                                      | Smallest deck-edge to tuck height at any station  | Same 1 mm scale; below it the band is a knife the B-rep can hold but no blank can.                                                                |
| `apexHeightRange`        | [0.05, 0.95]                                                | Allowed apex heights                              | Keeps both profile triangles of positive height (H_u, H_l > 0 needs margin from 0 and 1); 5% of a 2 cm rail is 1 mm.                              |
| `fullnessRange`          | [0.05, 1]                                                   | Allowed fullness                                  | Fullness 0 collapses the apex handles and the apex normal (§3.5); 1 puts the handles at the corner.                                               |
| `maxFrameTurn`           | 5°                                                          | Plan tangent turn per band span                   | Inset rows then differ from true offsets by ≈ w Δθ²/8 ≤ 0.05 mm at w = 5 cm.                                                                      |
| `maxStationSpacing`      | 5 cm                                                        | Arc length per band span                          | Phase 3's per-station rail handles at least this often; accuracy is the fidelity check's job, not this cap's.                                     |
| `lawTolerance`           | insets 0.005 cm, apex 0.002, fullness 0.005, hardness 0.005 | Law fidelity between stations (§5.4)              | Insets 0.05 mm (half the CNC accuracy); apex 0.2% ≈ 0.04 mm on a 2 cm rail; fullness and hardness one step of a 200-step slider.                  |
| `deckJoinAngleTol`       | 0.1°                                                        | Deck/band normal angle                            | The checkpoint's apex G1 bar (plan §7), applied to the other blended join.                                                                        |
| `apexJoinAngleTol`       | 0.1°                                                        | Acceptance of the apex join                       | Plan §7; the construction gives rounding (§3.5).                                                                                                  |
| `maxBandRefinePasses`    | 6                                                           | Refinement passes of §5.4                         | Each pass halves the worst spans; O(h²) errors fall 4× per pass, so 6 passes cover a 4,000× miss.                                                 |
| `planMargin`             | 2 cm                                                        | Height-field extent beyond the plan loop          | Room for Phase 3 outline edits without re-gridding; the trims never reach the domain edge.                                                        |
| `featureTol`             | 0.001 cm                                                    | Bottom feature fit error                          | `lineTol`: features are design intent like the lines.                                                                                             |
| `tolerances`             | `{}`                                                        | geom tolerance overrides                          | geom's defaults (`fit` 1e-4 cm) unless a caller needs otherwise.                                                                                  |
| `edgeFit`                | `{}`                                                        | geom `EdgeFitSampling` overrides                  | geom's defaults (`DEFAULT_EDGE_FIT`).                                                                                                             |

### 12.2 Converter (`DEFAULT_CONVERT_OPTIONS`)

| Name                   | Default                     | Why                                                                                                                                                               |
| ---------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lineTol`              | 0.001 cm                    | Two orders below the checkpoint's 1 mm, one below CNC accuracy; reachable with adaptive knots on C¹ Bézier data.                                                  |
| `surfaceTol`           | 0.005 cm                    | The classic engine's own STEP-fit target (`DEFAULT_TOLERANCE`, `board-surface.ts`).                                                                               |
| `deckInsetFraction`    | 0.21                        | Median `deckBand` of the eight `RAIL_PRESETS`.                                                                                                                    |
| `tuckInsetFraction`    | 0.08                        | Median `bottomBand` of the eight `RAIL_PRESETS`.                                                                                                                  |
| `cornerAngleMin`       | 2°                          | Below this a non-continuous knot is smooth for practical purposes (the editor marks knots with zero-length handles as corners).                                   |
| `cornerFilletRadius`   | 0.5 cm                      | D12's small tip radius; ≥ `minInset / insetCurvatureFraction` = 0.2 cm, so the minimum band fits.                                                                 |
| `sampleSpacingX`       | 0.5 cm                      | Three samples per `minKnotSpacing` span.                                                                                                                          |
| `ringSamples`          | 128 per half                | Twice the classic STEP fit's 64 columns, on the classic's own curvature ladder.                                                                                   |
| `creaseProbe`          | 0.01 cm                     | One-sided difference step: O(δ) truncation, and three orders below the closest pair of real stations (27.9 cm on the goldens), so no neighbour enters a quotient. |
| `endGap`               | 0.001 cm                    | Past the classic's vertical end segments (x ≤ 1e-13), before any real shape change.                                                                               |
| `surfaceKnotSpacing`   | x 10 cm, y 5 cm (start)     | Coarse start; refinement decides.                                                                                                                                 |
| `minKnotSpacing`       | 1.5 cm                      | Below this a span would resolve a classic crease (the hull's tangent break) as curvature.                                                                         |
| `creaseWindow`         | 3 cm (2 × `minKnotSpacing`) | A smoothed crease spreads over about one span each side.                                                                                                          |
| `tipWindow`            | 2 cm                        | On the goldens the end thickness grows by 8–14% over the first centimetre (the classic's vertical deck segment and outline turn); 2 cm covers that with margin.   |
| `trimDataMargin`       | 1 cm                        | Classic data just outside the inset loops pins the surfaces' slope at their edges.                                                                                |
| `maxRefinePasses`      | 6                           | As `maxBandRefinePasses`.                                                                                                                                         |
| `bandCorrectionPasses` | 2                           | P&T parameter correction converges quadratically from a projected start; geom's P16 measured two passes.                                                          |
| `fairnessRatioBracket` | [1e-10, 1]                  | Fairness from negligible to equal to the data term; the search picks inside it (§9.8).                                                                            |
| `fairnessSearchSteps`  | 12                          | Bisection in log scale: 12 halvings of 10 decades ≈ a factor 1.0057 resolution.                                                                                   |

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
| `features`     | Fit error ≤ `featureTol` against the closed-form d(x, η); order independence; zero features = identity (bitwise)                                                                                                                                                                                                                                             | `featureTol`; order 1e-12 · scale                                             |
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

| Phase 1 miss (geom §17)                                         | Phase 2 path            | Effect and plan                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P22 `massProperties` 204 ms (target 50)                         | Q3 specs                | The board has a 3-face B-rep like the puck; expect Q3 at ~P22. Tier-2 candidate: one multi-integrand pass per face (geom §17). Not blocking correctness. |
| P16 `approximateSurface` with correction 377 ms                 | Q5 converter            | Height-field fits need no correction (§9.6), which removes most of it; the band fit's correction passes remain (≤ `bandCorrectionPasses`).               |
| P17 cold projection 0.25–0.3 ms per point                       | Q6 report, Q5 band data | Use only the warm batch path (8.7 µs per point): 2·10⁵ report samples ≈ 2 s.                                                                             |
| P12r / P13r rational assembly 1–2.8 s                           | rational rails          | The reason D5 is deferred (§5.6).                                                                                                                        |
| P18 edge fit 23.6 ms (met)                                      | Q1, Q2 (two edge fits)  | Within budget.                                                                                                                                           |
| P13/P14 solver prepare/solve, P7/P8 plans, P20/P21 tessellation | none in Phase 2         | Phase 3's drag and display paths.                                                                                                                        |
| Reference-desktop re-measurement (open)                         | every target above      | Still blocks tier-2 work; board2's numbers are recorded on the same container class and re-measured with geom's.                                         |

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

S5 and S6 can run in parallel after S4 and S3 respectively; S7 needs both S4 (validity through
the B-rep) and S6.

---

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
4. **Channel cost** under tensor-product refinement (§6.2).
5. **Converter conditioning** of the free band fit near tips where classic data are sparse:
   fairness by the discrepancy principle and the tip keys of §9.5.
6. **Benchmarks** measured on the cloud container only, like Phase 1's.
7. **Two classic volume models** (spec panel vs loft) differ; the report separates them so a
   board2 change is never blamed for a classic split.

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
