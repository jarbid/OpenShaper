# `@openshaper/geom` — the NURBS core (Phase 1 design)

Status: **binding design** for Phase 1 of `docs/design/geometry-overhaul.md` (§6,
rationale in §3). Written 2026-10-10 on `experiment/nurbs-overhaul`.

It merges two independent proposals: **A** (performance first: data-oriented layout,
allocation-free kernels, incremental evaluation) and **B** (correctness first: literal
ports of _The NURBS Book_, invalid states unrepresentable, an auditable STEP path). At
each point the stronger idea was taken and the best of the other grafted on. §0 records
every choice in one line. When this document and a proposal disagree, this document
wins. Changing a decision recorded here needs an edit to this file in the same commit.

"P&T" is Piegl & Tiller, _The NURBS Book_, 2nd ed. (Springer, 1997). Algorithm numbers
(A2.1 …) and equation numbers refer to it and are cited in code comments where used.
Check each number against the book when the module is reviewed.

---

## 0. Decision record

| #   | Topic                    | Decision                                                                                                                                                                                                 | From  | Reason                                                                                                                         |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Code structure           | Internal `book/` layer of literal P&T ports in the book's notation, written allocation-free on typed arrays; the validating typed API calls it.                                                          | B + A | Each algorithm can be diffed against the book line by line, and the same code is the hot path, with no wrapper copies.         |
| 2   | Control-net storage      | One homogeneous `Float64Array` per net (`[w·x, w·y, w·z, w]`, P&T's **Pw**), stride `dim + 1`, surfaces u-major.                                                                                         | A     | Insertion, elevation and rational derivatives all act on Pw; one layout for curves, surfaces, pcurves and STEP; transferable.  |
| 3   | API boundary             | Inputs and outputs are Euclidean points plus separate weights; homogeneous data stays inside the package.                                                                                                | B     | P&T and STEP both write P and w separately, so tests and files compare like with like.                                         |
| 4   | `rational` flag          | Derived from the weights by the factory, never passed by a caller.                                                                                                                                       | B     | A flag a caller sets can lie; the polynomial fast path must be safe.                                                           |
| 5   | Knot vectors             | A validated `Basis` object per direction (`kind`, `degree`, `count`, `knots`, `domain`, `period`), shared by reference between versions.                                                                 | B + A | One validated object; `===` on it is the O(1) validity key for sample plans and solver factors.                                |
| 6   | Naming                   | `'clamped'` and `'periodic'`. "Open" is not used.                                                                                                                                                        | A + B | "Open" means "unclamped" in part of the literature.                                                                            |
| 7   | Periodic storage         | Unique control points, one period of knots, explicit period. No wrapped duplicates.                                                                                                                      | B     | Nothing can fall out of sync; hot loops stay branch-free through sample plans and precomputed windows.                         |
| 8   | Periodic operations      | Unroll to a clamped window three periods long (exact), run the clamped algorithm, read back the middle period.                                                                                           | new   | Reuses the clamped book code unchanged; no periodic variants of A5.x to get wrong.                                             |
| 9   | Near-coincident knots    | Rejected at construction (`knots-near-coincident`); knots computed inside geom snap to existing ones within `knotRel`.                                                                                   | B + A | Caller data never changes silently; our own rounding never creates sliver spans (which OCCT also rejects).                     |
| 10  | Domains                  | Never normalised implicitly. Fitters and primitives produce `[0,1]` (period 1); `reparameterize` is explicit and affine.                                                                                 | A + B | Derivative magnitudes and pcurves depend on the domain; silent changes break both.                                             |
| 11  | Out-of-domain parameters | Allocating evaluators throw beyond `paramRel`; `*Into` kernels and plans clamp (clamped) or wrap (periodic) without branching or throwing.                                                               | B + A | Catch caller bugs at the API; never throw inside a per-frame loop.                                                             |
| 12  | Immutability             | Factories freeze records; typed arrays are typed `ReadonlyF64`; copy-on-write; checksum property tests. No runtime registry.                                                                             | A     | Typed arrays cannot be frozen; B's `WeakSet` registry is hidden global state and does not survive a worker's structured clone. |
| 13  | Brands                   | Compile-time brands on validated types; `reviveCurve` / `reviveSurface` re-validate cloned or JSON values.                                                                                               | B     | Hand-built literals fail type-checking; data from a worker or file is validated once, explicitly.                              |
| 14  | Module state             | None. Scratch buffers are caller-owned and required by every `*Into` kernel. Constant tables (Gauss–Legendre) are computed at module load and never mutated.                                             | new   | Project rule (no hidden global state); reentrant by construction. Rejects A's default module scratch.                          |
| 15  | Dimensions               | `Dim = 1 \| 2 \| 3` with generic `NurbsCurve<D>`.                                                                                                                                                        | A + B | Rail laws in board2 are scalar splines; mixing pcurves and space curves becomes a type error.                                  |
| 16  | Tolerances               | One `Tolerances` record with cm defaults; a test forbids tolerance literals elsewhere in `src`.                                                                                                          | A + B | Project principle 3. Names from B where clearer, A's `knotRel`, `pivotRel` and `weightRatioMax` added.                         |
| 17  | Errors                   | `GeomError` for contract violations; `Result<T>` for data-dependent failures; the per-frame solve never throws and reports dependent and inconsistent rows plus multipliers.                             | A + B | A drag must not throw mid-gesture (A); every failure names its rows and values (B).                                            |
| 18  | Incremental evaluation   | Sample plans: cached spans and separable basis values, plus a CSR map from control point to samples (dirty updates). The per-sample weight matrix stays internal.                                        | A     | Covers Phase 3's incremental mesh update and derivatives with one public mechanism.                                            |
| 19  | Structural constraints   | A DOF map `x = T z + x_fixed` with `fix`, `fixAxes`, `slide`, `offsetFrom`, `mirror` and `copy`. Fix, axis locks, axis-aligned mirrors and copies hold bit-exactly.                                      | A + B | Apex rows, rail-frame axes and symmetry leave the constraint set, so m stays 5–60 and those locks are exact, not approximate.  |
| 20  | General constraints      | Range-space KKT through the Schur complement over an SPD factor, one step of iterative refinement, multipliers returned.                                                                                 | A + B | Both proposals agree; a full indefinite KKT LDLᵀ needs pivoting that destroys the sparsity.                                    |
| 21  | Factorisation            | Envelope (profile) Cholesky with reverse Cuthill–McKee ordering.                                                                                                                                         | A     | Mirror and `offsetFrom` elimination and periodic wrap create couplings no fixed index order keeps narrow; RCM handles all.     |
| 22  | Fairness target          | Edits penalise the **displacement** from the drag-start shape; fits penalise the shape itself. One option (`on`).                                                                                        | B + A | An edit must never flatten existing rocker or concave; a fit is a smoothing problem.                                           |
| 23  | Fairness metric          | Thin plate scaled per knot-span pair by the reference surface's mean `\|Su\|`, `\|Sv\|` on that span pair.                                                                                               | B + A | Affine-invariant (B) and free of parameter-speed bias round a tight tail (A's intent), still exact under Gauss–Legendre.       |
| 24  | Regularisation           | None implicit. `stiffness` is explicit; a singular reduced system is reported.                                                                                                                           | new   | Rejects A's `1e-8·trace` default: a magic constant.                                                                            |
| 25  | Solver oracle            | Dense null-space QR solve (`solveFairReference`), test-only.                                                                                                                                             | A + B | Independent algorithm; too slow for the drag path.                                                                             |
| 26  | CDT                      | Implement in-house on vendored robust predicates; `delaunator` and `@kninnug/constrainautor` as dev-only differential oracles; 5-day timebox, then vendor those two.                                     | A + B | No new runtime dependency, and our inputs break constrainautor's preconditions.                                                |
| 27  | Predicate sign           | Shewchuk's: `orient2d > 0` ⇔ counter-clockwise with y up. `robust-predicates` returns the opposite sign (checked in its source).                                                                         | B     | (u, v) is a y-up frame; one sign convention throughout.                                                                        |
| 28  | Trimmed integration      | One integrator: Green's theorem over the trim loops, exact for polynomial integrands; tensor Gauss–Legendre for natural-boundary faces. A's cut-cell integrator is deferred unless benchmark P22 misses. | B     | One code path; analytic solids and mesh-volume convergence are the independent oracles.                                        |
| 29  | Untrimmed faces          | `TrimmedSurface.outer = null` means the natural boundary. Trim loops only on surfaces clamped in both directions in Phase 1.                                                                             | A     | A periodic direction has no closed natural loop in (u, v); the board's trimmed faces (deck, bottom) are clamped.               |
| 30  | Trim-loop orientation    | Wrong orientation is reversed and reported as a warning issue.                                                                                                                                           | A     | The fix is unambiguous; reported, so never silent.                                                                             |
| 31  | Continuity               | geom measures gap, normal angle and cross-boundary curvature mismatch (B's definitions); classification needs thresholds from the caller.                                                                | B + A | Acceptance limits (0.1° at the apex) are product decisions that belong to board2.                                              |
| 32  | B-rep                    | Index-based records; cheap structural `makeBrep`; expensive geometric `checkBrep` report with per-edge measured gaps; seams derived from use; master representation per coedge.                          | B + A | Cheap to clone and diff; nothing stored that can contradict the geometry.                                                      |
| 33  | STEP numbers             | Shortest round-trip decimals by default (bit-exact self-check), a `precision` option, knot multiplicities computed from the formatted text.                                                              | B + A | What is checked is exactly what was written; reduced precision stays correct.                                                  |
| 34  | STEP validity            | `writeStep` runs `checkBrep` and refuses an invalid B-rep; uncertainty is measured, never assumed.                                                                                                       | B + A | OCCT's reader heals silently, so the writer must be the gate.                                                                  |
| 35  | OCCT pin                 | `occt-wasm` **5.3.5**, exact.                                                                                                                                                                            | B     | Newest release past a 14-day cool-off; the API used here is identical in 5.6.1 (checked in both typings).                      |
| 36  | OCCT protocol            | Path B (our STEP through `importStep`) plus Path A (a test-only native BREP writer through `fromBREP`, unhealed). OCCT's `getVolume` is a 1% sanity check only.                                          | A + B | B measured −0.43% GProp error on a polynomial prism, which rules out A's 1e-9 polynomial volume check.                         |
| 37  | OCCT tests               | `src/**/*.occt.test.ts`, own Vitest config, not in `pnpm test`, a required CI step on the branch.                                                                                                        | B + A | Type-checked with the package; a young upstream cannot block every package's tests.                                            |
| 38  | Cross-package tests      | geom tests never import `@openshaper/kernel` or any other workspace package.                                                                                                                             | B     | geom must stand alone; comparing with the classic engine is board2's deviation report (Phase 2).                               |
| 39  | Test helpers             | A `@openshaper/geom/testing` subpath: analytic solids, seeded PRNG, oracle solvers, unchecked STEP writer, STEP subset reader, native BREP writer.                                                       | B     | board2 reuses the same oracles; none of it ships through the main entry.                                                       |
| 40  | API review               | `index.ts` lists every export by name; `index.test.ts` pins the runtime export list.                                                                                                                     | B     | Every API change shows in a diff.                                                                                              |
| 41  | Benchmarks               | A's frame-budget targets plus B's throughput targets; a miss is reported, not failed, and triggers the listed tier-2 options.                                                                            | A + B | Targets grounded in measured probes; CI noise must not block work.                                                             |

---

## 1. Scope and non-goals

**In scope** (plan §6 Phase 1): knots and bases; B-spline and NURBS curves, clamped and
periodic, rational from the start; derivatives to second order (third for curves); arc
length; curvature; tensor-product surfaces with derivatives, normals, principal
curvatures, iso and boundary curves; knot insertion and refinement, degree elevation,
compatibility; interpolation and constrained least squares; the constrained
fairness solver; curves on surfaces, closest point and projection; trimmed surfaces,
constrained Delaunay tessellation, quadrature for area and volume; continuity
measures; a minimal B-rep; the STEP writer; the CI-only OCCT validator; oracles and
benchmarks.

**Not in Phase 1:** board concepts (tail at x = 0 is board2's rule; geom has no frame
convention); surface/surface and plane/surface intersection (Phase 2 adds
`intersectSurfacePlane` for cross-sections as cuts); knot removal and degree
reduction; offsets and booleans; rotation-minimising frames; T-splines and
hierarchical splines; non-manifold or multi-shell B-reps; collapsed edges and poles in
STEP; trims on periodic surfaces; STEP reading in the product.

---

## 2. Package, layering, tooling

`packages/geom/package.json` follows `packages/kernel`: `"type": "module"`, `exports`
pointing at `src`, `build` and `typecheck` as `tsc --noEmit`, Vitest with colocated
`*.test.ts`, licence `GPL-3.0-or-later`. Additions: `"sideEffects": false` (true by
rule, §4.8). **No `dependencies`**, ever, in Phase 1 (Checkpoint A: no new runtime
dependency).

Scripts now: `build`, `typecheck`, `test`, `test:watch`, `coverage`. Added later:
`bench` (`vitest bench src --run`, with the first benchmark, F2) and `test:occt`
(`vitest run -c vitest.occt.config.ts`, B4).

devDependencies now: `@types/node`, `typescript`, `vitest` (the kernel's). Added in the
step that first needs them, each pinned exactly and test-only:

| Package                   | Version | Licence                                  | Step | Use                                 |
| ------------------------- | ------- | ---------------------------------------- | ---- | ----------------------------------- |
| `delaunator`              | 5.1.0   | ISC                                      | B2   | Differential oracle (unconstrained) |
| `@kninnug/constrainautor` | 4.1.0   | ISC                                      | B2   | Differential oracle (constrained)   |
| `occt-wasm`               | 5.3.5   | wrapper MIT OR Apache-2.0; WASM LGPL-2.1 | B4   | CI-only STEP / BREP validator       |

`@kninnug/constrainautor`'s `types` point at raw `.ts` source that our strict config
would type-check; its test import goes through a local `.d.ts` shim.

**ESLint** (`eslint.config.mjs`, additive):

- `geom` joins `LAYERS` as a pure layer: no other `@openshaper/*` package, no React,
  DOM or three.js, and no `node:*` imports in `src` (tests and benches exempt, as for
  every layer).
- Every existing package lists `geom` as forbidden, and a rule for `apps/*/src`
  forbids it too. No existing package may import geom until a later phase grants it
  explicitly (board2 in Phase 2). pnpm's strict `node_modules` is a second guard: an
  undeclared workspace package does not resolve.
- When the oracle devDependencies land (B2, B4), `geom`'s rule also forbids
  `occt-wasm`, `delaunator`, `@kninnug/constrainautor` and `./testing` in `src`
  ("test-only oracle; never shipped").

**Vitest.** `vitest.config.ts`: `include: ['src/**/*.test.ts']`, `environment: 'node'`,
`testTimeout: 20_000` (same budget and reason as kernel). From B4 it excludes
`src/**/*.occt.test.ts`, which `vitest.occt.config.ts` runs in a single fork (one 21 MB
WASM instance) with `testTimeout: 60_000`.

**CI** (the branch's `ci.yml` only, B4): after `pnpm test`, run
`pnpm --filter @openshaper/geom test:occt`, and upload `packages/geom/.occt-corpus/*.step`
(gitignored) as an artifact for the manual Rhino / Fusion / FreeCAD / SolidWorks import
matrix (`docs/design/step-export.md`). Turbo needs no change: its generic `test`,
`typecheck` and `build` tasks pick the package up.

**Notices.** When the predicates are vendored (B2), `NOTICE.md` gains the
`robust-predicates` attribution (Unlicense; port of Shewchuk's public-domain code).

---

## 3. Module layout

Dependencies inside geom point downward in this list. `book/`, `linalg/` and the
assembly helpers are internal: never re-exported from `index.ts`.

```
packages/geom/
  package.json  tsconfig.json  vitest.config.ts  (vitest.occt.config.ts — B4)
  src/
    index.ts              explicit named re-exports: the public API
    types.ts              shared value types (type-only module)
    tolerance.ts          Tolerances, DEFAULT_TOLERANCES, resolve/scale
    errors.ts             GeomError, issue and Result helpers
    array.ts              Scratch, readonly views, typed-array helpers
    vec.ts                Point2/Point3 maths, affine maps (exported as `vec`)
    quadrature.ts         Gauss–Legendre tables, adaptive Gauss–Kronrod 7–15
    book/                 literal P&T ports on raw arrays (internal)
      basis.ts            A2.1 findSpan, A2.2 basisFuns, A2.3 dersBasisFuns, A2.4 oneBasisFun
      curve.ts            A3.1 / A4.1 point, A3.2 derivatives, A4.2 rational derivatives
      surface.ts          A3.5 / A4.3 point, A3.6 derivatives, A4.4 rational derivatives
      periodic.ts         periodic span windows; unroll to / extract from a clamped window
      refine.ts           A5.1, A5.3, A5.4, A5.5, A5.6, A5.9 (+ row/column form), eq. 5.36
      fit.ts              eqs. 9.4–9.6, 9.8, 9.68–9.69; A9.1, §9.2.2, A9.4, A9.6 structure
      primitives.ts       A7.1 circle, A7.3 open conic, A8.1 revolve
    basis.ts              Basis factories, validation, knot generators, multiplicities, spans
    curve.ts              curve factories, accessors, copy-on-write edits, evaluation
    curve-ops.ts          insert, refine, elevate, split, sub-curve, reverse, reparameterise,
                          toClamped, Bézier decomposition, compatibility, transforms
    curve-measure.ts      tangent, curvature, frame, arc length, inverse arc length, bounds
    surface.ts            surface factories, accessors, edits, evaluation, iso/boundary curves
    surface-ops.ts        per-direction insert, refine, elevate, split, reverse, swap, …
    surface-measure.ts    normals, fundamental forms, principal curvatures, normal curvature
    plan.ts               sample plans: cached basis, full and dirty evaluation
    primitives.ts         exact lines, circles, conics, planes, revolutions, spheres, tori …
    linalg/               internal: dense.ts (Cholesky, pivoted LDLᵀ, Householder QR),
                          banded.ts (banded LU for A9.1), rcm.ts, envelope.ts
    fit/                  param.ts, interpolate.ts, approximate.ts, skin.ts,
                          assemble.ts (internal: collocation rows, Gram matrices)
    solver/               dof.ts (DOF map), fairness.ts (energies), solver.ts
    project.ts            closest point on curve / surface / trimmed surface, batches
    curve-on-surface.ts   pcurve evaluation, chain-rule derivatives, iso pcurves,
                          pcurve fitting and 3D edge fitting (integration milestone)
    trim.ts               trim loops, trimmed surfaces, validation, classification
    integrate.ts          Green's-theorem integration over trimmed domains, area
    mesh/
      predicates.ts       vendored orient2d / incircle (Unlicense), Shewchuk's sign
      cdt.ts              constrained Delaunay triangulation
      refine.ts           Steiner refinement
      tessellate.ts       trimmed surface → mesh; retargeting during a drag
    continuity.ts         gap, normal angle, curvature mismatch; knot and join continuity
    brep/
      brep.ts             makeBrep (structural), orient, transform, face accessors
      check.ts            checkBrep (geometric report)
      mass.ts             volume, area, centroid
      mesh.ts             edge-first watertight tessellation
    step/
      part21.ts           lexical rules (copied from export/src/step.ts, not imported)
      schema.ts           arity table of every emitted entity type
      write.ts            AP214 writer
      read.ts             subset reader for round-trip tests (exported via ./testing)
    testing/              subpath `@openshaper/geom/testing` (test-only helpers)
      index.ts  prng.ts  checksum.ts  solids.ts  reference-solver.ts  occt-brep.ts
```

---

## 4. Conventions

### 4.1 Units

geom has no units. Length-valued tolerance defaults assume **centimetres** (the
kernel's and board2's unit) at board scale (≤ 400 cm). `scaleTolerances(t, k)` converts
them. The STEP writer converts model units to file units (mm by default). Knots and
weights are never scaled.

### 4.2 Points and storage

- Public points are `Point2 {x, y}` and `Point3 {x, y, z}`, structurally identical to
  the kernel's `Vec2` and `Vert3`, so board2 passes kernel points through unchanged.
  Bulk inputs are `ArrayLike<number>` with an explicit stride.
- A control net is one `Float64Array` `cw` of homogeneous points. A curve of
  dimension `d` stores `count · (d + 1)` doubles. A surface stores
  `u.count · v.count · 4` doubles, **u-major**: point `(i, j)` starts at
  `(i · v.count + j) · 4`. This matches the existing `BSplineSurface` (`ctrl[i][j]`)
  and STEP's `control_points_list`, and the inner v loop is contiguous.
- Polynomial geometry still stores `w = 1`. That costs a third more memory and keeps
  one code path; kernels skip the weight arithmetic when `rational === false`.

### 4.3 Bases, knots and domains

**Clamped basis**, degree `p ≥ 1`, `count = n + 1` functions:

- `knots.length === count + p + 1`; the first `p + 1` knots are equal and so are the
  last `p + 1`;
- non-decreasing and finite; interior multiplicity ≤ `p` (C⁰ joins allowed,
  disconnected curves not);
- `domain = [knots[p], knots[count]]` with positive length.

An unclamped, non-periodic knot vector is rejected (`knots-not-clamped`).
`clampUnclamped` converts imports exactly (knot insertion at the domain ends).

**Periodic basis**, degree `p`, `count = n ≥ p + 1` unique control points:

- `knots` holds **one period** `t_0 ≤ … ≤ t_{n−1}` with `t_{n−1} < t_0 + T`;
- the bi-infinite sequence is `t_{i + k·n} = t_i + k·T`;
- multiplicity ≤ `p`, counting runs that wrap round the seam (a full-multiplicity
  interior knot is allowed: it gives a sharp tip on a loop, as Phase 5 notches need);
- `domain = [t_0, t_0 + T)`; basis function `i` uses control point `i mod n`.

**Near-coincident knots.** Two distinct knots closer than `knotRel × domain length`
are rejected at construction (`knots-near-coincident`); `mergeNearKnots` is the
explicit fix and reports what it moved. Knots computed inside geom (refinement,
compatibility merges, fitting) snap to an existing value within that distance.
Inserting a snapped value is exact. Unifying two curves' knots in `makeCompatible` can
move an existing knot by at most `knotRel × domain`; the result reports the largest
geometric change this caused. With near-coincident knots excluded, multiplicity is
exact equality.

**No implicit normalisation.**

- Constructors keep the caller's domain.
- Fitters and primitives produce `[0, 1]`, or `[0, 1)` with period 1.
- Operations keep the input domain: `splitCurve` keeps the sub-ranges, `reverseCurve`
  maps `t ↦ a + b − t` on `[a, b]`, insertion and elevation keep it.
- `reparameterize(x, [a, b])` is an explicit affine map; the k-th derivative scales by
  the factor to the k-th power. `normalizeDomain` maps to `[0, 1]` with the ends
  snapped to exactly 0 and 1.
- STEP writes knots as stored (OCCT keeps knots as written, so parameter-based
  checks line up).

### 4.4 Closed and periodic

- **Periodic** is a basis kind. A periodic curve is C^(p−1) at the seam unless a knot
  of higher multiplicity sits there.
- **Closed** is a query, not a form: `isClosed(c, tol)` is true for a periodic curve
  and for a clamped curve whose end points coincide within `point` (closed C⁰).
- A pcurve on a surface with a periodic direction may run past one period; evaluation
  wraps. Seam coedges use the lines `u = t_0` and `u = t_0 + T`.
- Periodic geometry leaves geom only through exact conversion: `toClamped` (inserts
  the seam to multiplicity `p` and unrolls) for STEP and B-rep edges.
- **Periodic operations** (insert, refine, elevate, reverse): unroll to a clamped
  window covering `[t_0 − T, t_0 + 2T]` (exact, by insertion at the window ends), run
  the clamped book algorithm, and extract the middle period. With `n ≥ p + 1`, every
  basis function of the middle period has support inside the window away from the
  clamped ends, so the extracted net is the periodic result; a test checks that the
  middle period equals its neighbours shifted by `T` within `point`.

### 4.5 Rational representation

- Weights are finite and `> 0`; zero or negative weights are a contract violation.
- `rational` is computed by the factory: `false` iff every weight is exactly 1.
- A max/min weight ratio above `weightRatioMax` is a warning issue where a `Result` is
  returned, never an error.
- Weights are never renormalised implicitly (rescaling all weights keeps the shape but
  changes STEP output and solver conditioning).
- During a solve the weights are fixed, so the geometry is linear in the Euclidean
  control points through the rational basis `R` and the problem stays quadratic.

### 4.6 Evaluation at knots and ends

- Default side at an interior knot is **right** (span `[u_k, u_{k+1})`). Every
  derivative entry point takes `side?: 'left' | 'right'`; the continuity measures use
  both.
- At the end of a clamped domain the last non-empty span is used (P&T A2.1 special
  case), so `C(b) = P_n` exactly. Only the inner side exists at a clamped end
  (`side-unavailable` if the other is asked for); periodic curves always have both.
- Allocating evaluators throw `param-out-of-domain` when a clamped parameter lies
  outside the domain by more than `paramRel × length`; within that slack it is
  clamped. Periodic parameters wrap: `u ↦ t_0 + ((u − t_0) mod T)`, with
  `u = t_0 + T` mapped exactly to `t_0`.
- `*Into` kernels and plans clamp or wrap and never throw (§8).

**Derivative layouts** (flat, for `*Into` outputs):

- curve: `[C, C′, C″, C‴]` up to `nDer`, each `dim` values;
- surface: `[S, Su, Sv, Suu, Suv, Svv]` (P&T's SKL order, flattened), 3 values each.

### 4.7 Orientation and signs

- Surface normal `n = Su × Sv / |Su × Sv|`; degenerate when
  `|Su × Sv| ≤ degenerateRel · |Su| · |Sv|`, or when a partial is at its rounding
  floor, `|Su| ≤ degenerateRel · M / L_u` (likewise v) — the curves' rule, with `M`
  the magnitude of the point's span-pair control points (largest absolute
  homogeneous coordinate over smallest weight). A pole's `Su` is a sum of equal
  points times cancelling basis derivatives: rounding noise, not zero.
- Principal curvatures `k₁ ≥ k₂` are positive where the surface bends **towards**
  `n` (`k = II / I`, `II = S″ · n`): a sphere with outward `n` has `k = −1/r`.
  `H = (k₁ + k₂)/2`, `K = k₁k₂`. They are computed from the shape operator in the
  orthonormal tangent frame `e₁ = Su/|Su|`, `e₂ = n × e₁`, a symmetric
  `[[a, b], [b, c]]`: `√(H² − K) = √(((a − c)/2)² + b²)` has no cancellation (the
  textbook form loses half the digits at an umbilic). Umbilic (directions `null`)
  when `H² − K ≤ umbilicRel · H²` or `√(H² − K) ≤ degenerateRel · M / (L_u L_v |Su| |Sv|)`
  (`II` at rounding level, as on a plane). Principal directions: `d₂ = n × d₁`.
- Primitives orient by the right-hand rule so that `n` points out of a closed
  solid: sphere, torus and cylinder have outward normals.
- Signed curvature of a 2D curve is positive when it turns counter-clockwise.
- Trim loops keep the material on the **left** in (u, v): outer loop counter-clockwise
  (positive signed area), holes clockwise.
- B-rep: `sameSense` says whether the face's outward normal is `+n`; a coedge's
  `sense` says whether it runs along its edge curve's parameter. Orientation is
  measured (signed volume), never assumed.
- `orient2d > 0` ⇔ counter-clockwise in a y-up frame (Shewchuk).

### 4.8 Immutability, validation and state

- **Copy on write.** Every operation returns new values; inputs are never written.
  Unchanged parts are shared by reference: `withControlPoints` copies `cw` (512
  points × 4 × 8 B = 16 KB) and keeps the same `Basis` objects, so 200 undo steps
  of a rail band hold about 3 MB.
- **Freezing.** Factories `Object.freeze` the records. Typed arrays cannot be frozen,
  so they are typed `ReadonlyF64` (no `set`, `fill`, `copyWithin`, `reverse`, `sort`
  or `subarray`). This is a type-level guard, not a security boundary; the
  immutability property test (checksum every input before and after every public
  operation, on random geometry) is the runtime proof.
- **Validation.** Factories (`make*`, `revive*`) validate fully, O(n). Public entry
  points run O(1) consistency checks (array lengths against counts and degree).
  Hot kernels check nothing beyond what their plans already validated.
- **Workers.** Values are plain records plus typed arrays, so they structured-clone
  cheaply and outputs are transferable. A cloned value has lost its freeze and its
  brand's guarantee, so receiving code calls `reviveCurve` / `reviveSurface` (or
  rebuilds from a known value with `withSurfaceControlNet`). `GeomError` does not
  survive cloning: worker code sends `issueOf(e)`.
- **No module state.** No registries, default scratch, or caches at module level. The
  only module-level data are constant tables computed once at module evaluation
  (Gauss–Legendre nodes and weights, n ≤ 64; zero-length typed arrays that a new
  scratch starts its growable buffers with, which nothing can write) and never
  mutated. Kernels whose working memory depends on the input size (the grid's
  bases, a dirty update's stamps) grow buffers **inside the caller's scratch** on
  first use and reuse them, so steady-state frames allocate nothing. Caches keyed by
  geometry (plans, solver factors) are objects the caller owns; consumers that keep
  them per board use bounded `WeakMap`s (`.claude/CLAUDE.md`).
- **Determinism.** Same input, same bits: no randomness (randomised insertion orders
  in the CDT use a fixed-seed generator), no time, no iteration over hash order.

### 4.9 Naming

- `make*` validates and copies; `revive*` validates an untrusted plain value.
- `*Into(…, out, offset, scratch)` writes into caller buffers and allocates nothing.
- Plain names allocate their result and are thin wrappers over the kernels; a test
  checks each wrapper against its kernel bit for bit.
- No default exports. No classes except `GeomError`. Vector helpers live under the
  `vec` namespace export to keep generic names (`add`, `dot`) out of the top level.

---

## 5. Core types (`src/types.ts`)

This module is type-only and is scaffolded with the package. Module-specific records
(projection results, plan outputs, solver reports) live with their modules (§6).

```ts
/** Compile-time mark set only by geom's factories; never present at runtime. */
export declare const geomBrand: unique symbol;
export type BrandKind = 'basis' | 'curve' | 'surface' | 'trim-loop' | 'trimmed-surface' | 'brep';
export interface Branded<K extends BrandKind> {
  readonly [geomBrand]: K;
}

// Read-only typed arrays (type-level guard; see §4.8).
type TypedArrayMutator = 'set' | 'fill' | 'copyWithin' | 'reverse' | 'sort' | 'subarray';
export type ReadonlyTypedArray<A extends Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array> =
  Omit<A, number | TypedArrayMutator> & { readonly [index: number]: number };
export type ReadonlyF64 = ReadonlyTypedArray<Float64Array>;
export type ReadonlyF32 = ReadonlyTypedArray<Float32Array>;
export type ReadonlyI32 = ReadonlyTypedArray<Int32Array>;
export type ReadonlyU32 = ReadonlyTypedArray<Uint32Array>;
export type ReadonlyU8 = ReadonlyTypedArray<Uint8Array>;
/** Output buffers: Float32 for GPU upload, Float64 for analysis. */
export type NumArray = Float32Array | Float64Array;

// Points and small records.
export type Dim = 1 | 2 | 3;
export interface Point2 { readonly x: number; readonly y: number }              // = kernel Vec2
export interface Point3 { readonly x: number; readonly y: number; readonly z: number } // = kernel Vert3
export type PointOf<D extends Dim> = D extends 1 ? number : D extends 2 ? Point2 : Point3;
export interface UV { readonly u: number; readonly v: number }
export interface Box3 { readonly min: Point3; readonly max: Point3 }
export type Interval = readonly [number, number];
export type Side = 'left' | 'right';
export type ParamDir = 'u' | 'v';
export type SurfaceEdge = 'u0' | 'u1' | 'v0' | 'v1';
/** Row-major affine maps: 2×3 and 3×4. */
export type Affine2 = readonly [number, number, number, number, number, number];
export type Affine3 = readonly [number, number, number, number, number, number,
                                number, number, number, number, number, number];

// Bases (§4.3).
export interface ClampedBasis extends Branded<'basis'> {
  readonly kind: 'clamped';
  readonly degree: number;
  readonly count: number;            // basis functions = control points along this direction
  readonly knots: ReadonlyF64;       // count + degree + 1, clamped
  readonly domain: Interval;         // [knots[degree], knots[count]]
}
export interface PeriodicBasis extends Branded<'basis'> {
  readonly kind: 'periodic';
  readonly degree: number;
  readonly count: number;            // unique control points, ≥ degree + 1
  readonly knots: ReadonlyF64;       // one period, length count
  readonly period: number;           // T > 0
  readonly domain: Interval;         // [t0, t0 + T), half-open
}
export type Basis = ClampedBasis | PeriodicBasis;

// Curves and surfaces (§4.2, §4.5).
export interface NurbsCurve<D extends Dim = Dim> extends Branded<'curve'> {
  readonly dim: D;
  readonly basis: Basis;
  readonly cw: ReadonlyF64;          // homogeneous, stride dim + 1, length basis.count·(dim + 1)
  readonly rational: boolean;        // derived: false iff every weight === 1
}
export type ClampedCurve<D extends Dim = Dim> = NurbsCurve<D> & { readonly basis: ClampedBasis };
export type PeriodicCurve<D extends Dim = Dim> = NurbsCurve<D> & { readonly basis: PeriodicBasis };

export interface NurbsSurface extends Branded<'surface'> {
  readonly u: Basis;
  readonly v: Basis;
  readonly cw: ReadonlyF64;          // homogeneous, stride 4, u-major
  readonly rational: boolean;
}
export interface SurfaceDerivs {
  readonly S: Point3; readonly Su: Point3; readonly Sv: Point3;
  readonly Suu: Point3; readonly Suv: Point3; readonly Svv: Point3;
}

// Trimming and curves on surfaces (§4.7).
export interface TrimLoop extends Branded<'trim-loop'> {
  readonly curves: readonly ClampedCurve<2>[];   // head to tail, end(i) === start(i+1) bitwise, closed
  readonly signedArea: number;                    // (u, v) area by Green's theorem; > 0 ⇔ CCW
}
export interface TrimmedSurface extends Branded<'trimmed-surface'> {
  readonly surface: NurbsSurface;
  readonly outer: TrimLoop | null;               // null = natural boundary
  readonly holes: readonly TrimLoop[];
}
export interface CurveOnSurface {
  readonly surface: NurbsSurface;
  readonly pcurve: NurbsCurve<2>;
}

// Minimal B-rep (§13): index-based, so it clones and diffs cheaply.
export interface BrepVertex { readonly point: Point3 }
export interface BrepEdge {
  readonly curve: ClampedCurve<3>;   // the whole curve is the edge
  readonly start: number;            // vertex ids; start === end for a closed edge
  readonly end: number;
}
export interface BrepCoedge {
  readonly edge: number;
  readonly sense: boolean;           // true: runs along the edge curve's parameter
  readonly pcurve: ClampedCurve<2>;  // same parameter domain as the edge curve
  readonly master: 'curve3d' | 'pcurve';  // which geometry defines the edge (STEP master_representation)
}
export interface BrepLoop { readonly coedges: readonly BrepCoedge[] }
export interface BrepFace {
  readonly surface: NurbsSurface;
  readonly sameSense: boolean;
  readonly outer: BrepLoop;
  readonly holes: readonly BrepLoop[];
  readonly label?: string;
}
export interface BrepShell { readonly faces: readonly number[]; readonly closed: boolean }
export interface BrepSolid { readonly outer: number; readonly genus?: number }
export interface BrepSpec {
  readonly vertices: readonly BrepVertex[];
  readonly edges: readonly BrepEdge[];
  readonly faces: readonly BrepFace[];
  readonly shells: readonly BrepShell[];
  readonly solids: readonly BrepSolid[];
}
export interface Brep extends BrepSpec, Branded<'brep'> {}

// Errors and results (§8).
export type GeomErrorCode = /* the union in §8 */;
export interface GeomIssue {
  readonly code: GeomErrorCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly at?: {
    readonly index?: number; readonly t?: number; readonly uv?: UV; readonly point?: Point3;
    readonly vertex?: number; readonly edge?: number; readonly face?: number;
    readonly coedge?: readonly [face: number, loop: number, index: number];
  };
  readonly value?: number;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly GeomIssue[] }  // warnings only
  | { readonly ok: false; readonly issues: readonly GeomIssue[] };                   // ≥ 1 error
export interface QuadratureResult {
  readonly value: number; readonly errorEstimate: number;
  readonly evaluations: number; readonly converged: boolean;
}
```

---

## 6. Public API (Phase 1)

Every function below is exported by name from `index.ts`. `tol?: Partial<Tolerances>`
is merged over `DEFAULT_TOLERANCES`. The step in brackets is when it lands (§18).

### 6.1 Tolerances, errors, arrays, vectors [F1]

```ts
export interface Tolerances {
  /* §7 */
}
export const DEFAULT_TOLERANCES: Tolerances;
export function resolveTolerances(overrides?: Partial<Tolerances>): Tolerances; // validates finite, > 0
export function scaleTolerances(t: Tolerances, lengthFactor: number): Tolerances; // length-valued entries only

export class GeomError extends Error {
  readonly code: GeomErrorCode;
  readonly details: Readonly<Record<string, unknown>>; // indices and values that reproduce it
}
export function isGeomError(e: unknown, code?: GeomErrorCode): e is GeomError;
export function issueOf(e: GeomError): GeomIssue;

export interface Scratch {
  readonly maxDegree: number;
  readonly maxDerivs: number;
} // opaque buffers inside
export function createScratch(capacity: { maxDegree: number; maxDerivs?: number }): Scratch; // maxDerivs ≤ 3

export * as vec from './vec';
// vec: add, sub, scale, dot, cross, norm, distance, lerp,
//      normalize(v, tol?) → V | null, angleBetween(a, b) (atan2(|a×b|, a·b)),
//      applyAffine3(m, p), applyAffine2(m, p), affineDeterminant(m), composeAffine3(a, b)
```

### 6.2 Bases [F1]

```ts
export function clampedBasis(
  degree: number,
  knots: ArrayLike<number>,
  tol?: Partial<Tolerances>,
): ClampedBasis;
export function periodicBasis(
  degree: number,
  knots: ArrayLike<number>,
  period: number,
  tol?: Partial<Tolerances>,
): PeriodicBasis;
export function clampedUniformKnots(degree: number, count: number, domain?: Interval): Float64Array;
export function periodicUniformKnots(count: number, period?: number): Float64Array; // t_i = i·T/n
export function knotsFromBreaks(breaks: ArrayLike<number>, mults: ArrayLike<number>): Float64Array;
export function knotMultiplicities(b: Basis): {
  readonly values: Float64Array;
  readonly mults: Int32Array;
};
export function mergeNearKnots(
  knots: ArrayLike<number>,
  tol?: Partial<Tolerances>,
): { readonly knots: Float64Array; readonly moved: number };
export function breakpoints(b: Basis): Float64Array; // distinct knots in the domain
/** Clamped: P&T span index in [p, count−1]. Periodic: k in [0, count) with t_k ≤ t < t_{k+1}. */
export function findSpan(b: Basis, t: number, side?: Side): number; // A2.1
export function basisFunsInto(
  b: Basis,
  span: number,
  t: number,
  out: Float64Array,
  o: number,
  s: Scratch,
): void; // A2.2
export function basisDersInto(
  b: Basis,
  span: number,
  t: number,
  nDer: number,
  out: Float64Array,
  o: number,
  s: Scratch,
): void; // A2.3, out[k·(p+1)+r]
export function basisFunction(b: Basis, i: number, t: number): number; // A2.4 (oracle)
```

### 6.3 Curves [F1]

```ts
export function makeCurve<D extends Dim>(spec: {
  readonly dim: D;
  readonly basis: Basis;
  readonly points: ArrayLike<number>; // Euclidean, stride dim
  readonly weights?: ArrayLike<number>;
}): NurbsCurve<D>;
export function curveFromHomogeneous<D extends Dim>(spec: {
  readonly dim: D;
  readonly basis: Basis;
  readonly cw: ArrayLike<number>;
}): NurbsCurve<D>;
export function bezierCurve<D extends Dim>(
  dim: D,
  points: ArrayLike<number>,
  weights?: ArrayLike<number>,
): ClampedCurve<D>; // domain [0, 1]
export function clampUnclamped<D extends Dim>(spec: {
  readonly dim: D;
  readonly degree: number;
  readonly knots: ArrayLike<number>;
  readonly points: ArrayLike<number>;
  readonly weights?: ArrayLike<number>;
  readonly tol?: Partial<Tolerances>; // knotRel check of the input knots
}): ClampedCurve<D>; // exact (A5.1 at the domain ends)
export function reviveCurve(x: unknown): NurbsCurve; // clone or JSON → validated
export function curveToJSON(c: NurbsCurve): CurveJSON; // plain arrays
export interface CurveJSON {
  readonly dim: Dim;
  readonly kind: 'clamped' | 'periodic';
  readonly degree: number;
  readonly knots: readonly number[];
  readonly period?: number;
  readonly points: readonly number[];
  readonly weights?: readonly number[];
}

export function controlPoint<D extends Dim>(c: NurbsCurve<D>, i: number): PointOf<D>; // Euclidean
export function controlWeight(c: NurbsCurve, i: number): number;
export function controlPointsInto(c: NurbsCurve, out: Float64Array, o?: number): void; // Euclidean, stride dim
export function weightsInto(c: NurbsCurve, out: Float64Array, o?: number): void;
export function withControlPoints<C extends NurbsCurve>(
  c: C,
  points: ArrayLike<number>,
  indices?: ArrayLike<number>,
): C; // keeps weights and basis
export function withWeights<C extends NurbsCurve>(
  c: C,
  weights: ArrayLike<number>,
  indices?: ArrayLike<number>,
): C;
export function curveDomain(c: NurbsCurve): Interval;
export function isClosed(c: NurbsCurve, tol?: Partial<Tolerances>): boolean;

export function curvePoint<D extends Dim>(c: NurbsCurve<D>, t: number): PointOf<D>; // A3.1 / A4.1
export function curveDerivatives<D extends Dim>(
  c: NurbsCurve<D>,
  t: number,
  order: 1 | 2 | 3,
  side?: Side,
): readonly PointOf<D>[]; // [C, C′, …] A3.2 + A4.2
export function curveEvalInto(
  c: NurbsCurve,
  t: number,
  nDer: 0 | 1 | 2 | 3,
  out: Float64Array,
  o: number,
  s: Scratch,
  side?: Side,
): void;
/** ts ascending ⇒ amortised O(1) span search; output layout as curveEvalInto, consecutive. */
export function curveEvalBatchInto(
  c: NurbsCurve,
  ts: ReadonlyF64,
  nDer: 0 | 1 | 2 | 3,
  out: NumArray,
  s: Scratch,
): void;
// Generic so a clamped or periodic input keeps its type; the basis is shared.
export function transformCurve<C extends NurbsCurve<3>>(c: C, m: Affine3): C;
export function transformCurve2<C extends NurbsCurve<2>>(c: C, m: Affine2): C;
```

### 6.4 Curve measures [F1]

```ts
export function curveTangent<D extends 2 | 3>(
  c: NurbsCurve<D>,
  t: number,
  side?: Side,
): PointOf<D> | null;
export function curveCurvature(c: NurbsCurve<3>, t: number, side?: Side): number; // |C′×C″| / |C′|³
export function curveSignedCurvature(c: NurbsCurve<2>, t: number, side?: Side): number; // CCW positive
export function curveCurvatureBatchInto(
  c: NurbsCurve<2> | NurbsCurve<3>,
  ts: ReadonlyF64,
  out: Float64Array,
  s: Scratch,
): void;
/** null where the tangent is degenerate or |C′ × C″| ≤ sin(angle)·|C′|·|C″| (no normal). */
export function curveFrame(
  c: NurbsCurve<3>,
  t: number,
  tol?: Partial<Tolerances>,
): { readonly t: Point3; readonly n: Point3; readonly b: Point3 } | null;
export function curveLength(
  c: NurbsCurve,
  range?: Interval,
  tol?: Partial<Tolerances>,
): QuadratureResult;
/**
 * Belongs to the one curve object it was built from: lengthAtParam and
 * paramAtLength check `table.curve === c` (size-mismatch otherwise), since every
 * primitive shares the domain [0, 1] and a domain check cannot tell curves apart.
 * A cloned or revived curve needs its own table.
 */
export interface ArcLengthTable {
  readonly curve: NurbsCurve;
  readonly t: ReadonlyF64;
  readonly s: ReadonlyF64;
  readonly total: number;
}
/** Breakpoints of the adaptive GK 7–15 partition (every knot plus its refinements); total = curveLength. */
export function arcLengthTable(c: NurbsCurve, tol?: Partial<Tolerances>): ArcLengthTable;
export function lengthAtParam(c: NurbsCurve, table: ArcLengthTable, t: number): number;
export function paramAtLength(
  c: NurbsCurve,
  table: ArcLengthTable,
  s: number,
  tol?: Partial<Tolerances>,
): number; // Newton, bracketed
export function curveBounds(c: NurbsCurve): Box3; // control-hull bound
```

### 6.5 Curve operations [A1]

Generic signatures keep the input's kind and dimension (`C extends NurbsCurve`).

```ts
export function insertKnot<C extends NurbsCurve>(c: C, t: number, times?: number): C; // A5.1
export function refineKnots<C extends NurbsCurve>(c: C, x: ArrayLike<number>): C; // A5.4
export function elevateDegree<C extends NurbsCurve>(c: C, by: number): C; // A5.9
export function splitCurve<D extends Dim>(
  c: ClampedCurve<D>,
  t: number,
): readonly [ClampedCurve<D>, ClampedCurve<D>];
/** Periodic: t1 < t0 means across the seam. */
export function subCurve<D extends Dim>(c: NurbsCurve<D>, t0: number, t1: number): ClampedCurve<D>;
export function reverseCurve<C extends NurbsCurve>(c: C): C;
export function reparameterize<C extends NurbsCurve>(c: C, domain: Interval): C; // affine
export function normalizeDomain<C extends NurbsCurve>(c: C): C; // [0, 1] or period 1
export function toClamped<D extends Dim>(c: PeriodicCurve<D>, seam?: number): ClampedCurve<D>; // exact
export function decomposeBezier<D extends Dim>(c: ClampedCurve<D>): readonly ClampedCurve<D>[]; // A5.6
/** All clamped or all periodic with equal domains; common degree and knots, shapes unchanged. */
export function makeCompatible<C extends NurbsCurve>(
  cs: readonly C[],
): { readonly curves: readonly C[]; readonly maxKnotShift: number; readonly maxDeviation: number };
```

### 6.6 Surfaces [F2]

```ts
export function makeSurface(spec: {
  readonly u: Basis;
  readonly v: Basis;
  readonly points: ArrayLike<number>; // Euclidean, u-major, stride 3
  readonly weights?: ArrayLike<number>;
}): NurbsSurface;
export function surfaceFromHomogeneous(spec: {
  readonly u: Basis;
  readonly v: Basis;
  readonly cw: ArrayLike<number>;
}): NurbsSurface;
export function reviveSurface(x: unknown): NurbsSurface; // clone or JSON → validated; bases rebuilt
export function surfaceToJSON(s: NurbsSurface): SurfaceJSON;
export interface BasisJSON {
  readonly kind: 'clamped' | 'periodic';
  readonly degree: number;
  readonly knots: readonly number[];
  readonly period?: number;
}
export interface SurfaceJSON {
  readonly u: BasisJSON;
  readonly v: BasisJSON;
  readonly points: readonly number[]; // Euclidean, u-major, stride 3
  readonly weights?: readonly number[]; // present iff rational
}

export function surfaceControlPoint(s: NurbsSurface, i: number, j: number): Point3;
export function surfaceControlWeight(s: NurbsSurface, i: number, j: number): number;
export function withSurfaceControlPoints(
  s: NurbsSurface,
  points: ArrayLike<number>,
  indices?: ArrayLike<number>,
): NurbsSurface; // flat i·v.count + j
export function withSurfaceWeights(
  s: NurbsSurface,
  weights: ArrayLike<number>,
  indices?: ArrayLike<number>,
): NurbsSurface;
export function withSurfaceControlNet(s: NurbsSurface, cw: ArrayLike<number>): NurbsSurface; // whole net (solver output)
export function surfaceDomain(s: NurbsSurface): { readonly u: Interval; readonly v: Interval };

export function surfacePoint(s: NurbsSurface, u: number, v: number): Point3; // A3.5 / A4.3
export interface SurfaceSide {
  readonly u?: Side;
  readonly v?: Side;
}
export type SurfaceDerivs1 = Pick<SurfaceDerivs, 'S' | 'Su' | 'Sv'>;
// Overloads: order 2 → SurfaceDerivs; order 1 → SurfaceDerivs1 (no fields that were not computed).
export function surfaceDerivatives(
  s: NurbsSurface,
  u: number,
  v: number,
  order: 1 | 2,
  side?: SurfaceSide,
): SurfaceDerivs | SurfaceDerivs1; // A3.6 / A4.4
export function surfaceEvalInto(
  s: NurbsSurface,
  u: number,
  v: number,
  nDer: 0 | 1 | 2,
  out: Float64Array,
  o: number,
  sc: Scratch,
  side?: SurfaceSide,
): void;
/**
 * Separable: basis once per u and per v, then combined; output row-major over (us, vs).
 * Bit for bit surfaceEvalInto. The v bases live in the scratch's growable buffer (§4.8).
 */
export function surfaceEvalGridInto(
  s: NurbsSurface,
  us: ReadonlyF64,
  vs: ReadonlyF64,
  nDer: 0 | 1 | 2,
  out: NumArray,
  sc: Scratch,
): void;
// exact: Σ N(u)·Pw with the other basis shared. fixed = 'u' reproduces S(value, v) bit for bit
// (same sums, same order); a polynomial surface gives a polynomial curve (weights exactly 1).
export function isoCurve(s: NurbsSurface, fixed: ParamDir, value: number): NurbsCurve<3>;
export function boundaryCurve(s: NurbsSurface, edge: SurfaceEdge): NurbsCurve<3>; // clamped directions only
export function transformSurface(s: NurbsSurface, m: Affine3): NurbsSurface;
export function surfaceBounds(s: NurbsSurface): Box3;
```

### 6.7 Surface measures [F2]

```ts
export type NormalResult =
  | { readonly kind: 'regular'; readonly n: Point3 }
  | { readonly kind: 'degenerate' };
export interface FundamentalForms {
  readonly E: number;
  readonly F: number;
  readonly G: number;
  readonly L: number;
  readonly M: number;
  readonly N: number;
}
export interface Curvatures {
  readonly k1: number;
  readonly k2: number;
  readonly K: number;
  readonly H: number;
  readonly n: Point3;
  readonly d1: Point3 | null;
  readonly d2: Point3 | null;
} // null at umbilics
export function surfaceNormal(
  s: NurbsSurface,
  u: number,
  v: number,
  tol?: Partial<Tolerances>,
): NormalResult;
/** Collapsed edges (poles): ±(Suv × Sv) on v0/v1, ±(Su × Suv) on u0/u1 (+ on the 0 edge); the normal elsewhere. */
export function limitNormal(
  s: NurbsSurface,
  edge: SurfaceEdge,
  t: number,
  tol?: Partial<Tolerances>,
): Point3 | null;
export function fundamentalForms(
  s: NurbsSurface,
  u: number,
  v: number,
  tol?: Partial<Tolerances>,
): FundamentalForms | null;
export function fundamentalFormsInto(
  s: NurbsSurface,
  u: number,
  v: number,
  out: Float64Array,
  o: number,
  sc: Scratch,
): number; // E,F,G,L,M,N; returns flags
export function principalCurvatures(
  s: NurbsSurface,
  u: number,
  v: number,
  tol?: Partial<Tolerances>,
): Curvatures | null;
export function normalCurvature(
  s: NurbsSurface,
  u: number,
  v: number,
  direction: Point3, // projected onto the tangent plane; null if within `angle` of n
  tol?: Partial<Tolerances>,
): number | null;
```

### 6.8 Surface operations [A1]

```ts
export function insertKnotSurface(
  s: NurbsSurface,
  dir: ParamDir,
  t: number,
  times?: number,
): NurbsSurface; // A5.3
export function refineKnotsSurface(
  s: NurbsSurface,
  dir: ParamDir,
  x: ArrayLike<number>,
): NurbsSurface; // A5.5
export function elevateDegreeSurface(s: NurbsSurface, dir: ParamDir, by: number): NurbsSurface; // A5.9 row-wise
export function splitSurface(
  s: NurbsSurface,
  dir: ParamDir,
  t: number,
): readonly [NurbsSurface, NurbsSurface];
export function reverseSurface(s: NurbsSurface, dir: ParamDir): NurbsSurface;
export function swapUV(s: NurbsSurface): NurbsSurface;
export function reparameterizeSurface(
  s: NurbsSurface,
  dir: ParamDir,
  domain: Interval,
): NurbsSurface;
export function normalizeSurfaceDomain(s: NurbsSurface): NurbsSurface;
export function toClampedSurface(s: NurbsSurface, dir: ParamDir, seam?: number): NurbsSurface;
```

### 6.9 Sample plans: incremental evaluation [F2]

```ts
export interface SurfaceSamplePlan {
  readonly kind: 'surface';
  readonly count: number;
  readonly nDer: 0 | 1 | 2;
  readonly u: Basis;
  readonly v: Basis; // identity is the validity key
  readonly uv: ReadonlyF64; // stride 2, sanitized, in the caller's order
  readonly spanU: ReadonlyI32;
  readonly spanV: ReadonlyI32;
  readonly basisU: ReadonlyF64; // count × (nDer+1) × (p+1)
  readonly basisV: ReadonlyF64; // count × (nDer+1) × (q+1)
  readonly rowOff: ReadonlyI32; // count × (p+1): net offset i·v.count·4 of each row read (wrapped)
  readonly colOff: ReadonlyI32; // count × (q+1): net offset j·4 of each column read
  readonly cpStart: ReadonlyI32;
  readonly cpSamples: ReadonlyI32; // CSR: control point → samples, ascending
  readonly tol: Tolerances; // degenerate / umbilic flags
}
export interface CurveSamplePlan {
  readonly kind: 'curve';
  readonly count: number;
  readonly nDer: 0 | 1 | 2 | 3;
  readonly basis: Basis;
  readonly t: ReadonlyF64;
  readonly span: ReadonlyI32;
  readonly basisT: ReadonlyF64; // count × (nDer+1) × (p+1)
  readonly cpIndex: ReadonlyI32; // count × (p+1), wrapped
  readonly cpStart: ReadonlyI32;
  readonly cpSamples: ReadonlyI32;
  readonly tol: Tolerances;
}
export interface SampleOutputs {
  readonly position?: NumArray; // stride 3 (curves: dim)
  readonly normal?: NumArray; // surfaces, nDer ≥ 1, stride 3; (0,0,0) + DEGENERATE flag when degenerate
  readonly curvature?: NumArray; // nDer = 2. Surfaces stride 2 (k1, k2); curves stride 1 (as curveCurvatureBatchInto)
  readonly derivatives?: Float64Array; // stride 3/9/18 by the plan's nDer (surfaceEvalInto's layout); curves (nDer+1)·dim
  readonly flags?: Uint8Array; // SAMPLE_DEGENERATE = 1, SAMPLE_UMBILIC = 2 (curves: degenerate tangent)
}
export const SAMPLE_DEGENERATE: 1;
export const SAMPLE_UMBILIC: 2;
export function planSurfaceSamples(
  s: NurbsSurface,
  uv: ArrayLike<number>,
  nDer: 0 | 1 | 2,
  tol?: Partial<Tolerances>,
): SurfaceSamplePlan;
export function planCurveSamples(
  c: NurbsCurve,
  ts: ArrayLike<number>,
  nDer: 0 | 1 | 2 | 3,
  tol?: Partial<Tolerances>,
): CurveSamplePlan;
export function planMatches(
  plan: SurfaceSamplePlan | CurveSamplePlan,
  g: NurbsSurface | NurbsCurve,
): boolean;
/** Ascending flat indices; every index when `rational` differs (the evaluation path changes everywhere). */
export function changedControlPoints(
  a: NurbsSurface | NurbsCurve,
  b: NurbsSurface | NurbsCurve,
): Int32Array;
export function evalSurfacePlan(
  plan: SurfaceSamplePlan,
  s: NurbsSurface,
  out: SampleOutputs,
  sc: Scratch,
): void;
/** Recomputes only samples touched by changedCps; returns their count, ids sorted into `touched` (length ≥ count). */
export function evalSurfacePlanDirty(
  plan: SurfaceSamplePlan,
  s: NurbsSurface,
  changedCps: ReadonlyI32,
  out: SampleOutputs,
  touched: Int32Array,
  sc: Scratch,
): number;
export function evalCurvePlan(
  plan: CurveSamplePlan,
  c: NurbsCurve,
  out: SampleOutputs,
  sc: Scratch,
): void;
export function evalCurvePlanDirty(
  plan: CurveSamplePlan,
  c: NurbsCurve,
  changedCps: ReadonlyI32,
  out: SampleOutputs,
  touched: Int32Array,
  sc: Scratch,
): number;
```

A plan stores polynomial basis values, so it stays valid when weights or control
points change and is invalidated only by a new `Basis` (knot insertion, elevation, a
revived copy). Samples keep the caller's order (sample `k` is the caller's vertex
`k`); a tessellation that orders vertices span-major makes the touched ids a few
contiguous runs. Plan outputs equal the direct functions bit for bit (positions and
derivatives `surfaceEvalInto` / `curveEvalInto`, normals `surfaceNormal`, curvatures
`principalCurvatures` / `curveCurvatureBatchInto`): the same kernels run in the same
order. Offsets are `Int32Array` in plans and in scratch alike, so the A3.6 kernel stays
monomorphic (offsets held in doubles measured ~20% slower).

### 6.10 Quadrature [F1]

```ts
export const GL_MAX_ORDER: 64;
export function gaussLegendre(n: number): {
  readonly nodes: ReadonlyF64;
  readonly weights: ReadonlyF64;
}; // on [−1, 1]
export function integrate1d(
  f: (x: number) => number,
  a: number,
  b: number,
  opts?: { readonly breaks?: ArrayLike<number>; readonly tol?: Partial<Tolerances> },
): QuadratureResult; // adaptive GK 7–15
```

### 6.11 Primitives (exact) [F1 curves, F2 surfaces, A1 `ruled`]

```ts
export function line(a: Point3, b: Point3): ClampedCurve<3>;
export function line2(a: Point2, b: Point2): ClampedCurve<2>;
export function polyline<D extends 2 | 3>(
  points: ArrayLike<number>,
  dim: D,
  closed?: boolean,
): ClampedCurve<D>;
export function circleArc(
  center: Point3,
  xAxis: Point3,
  yAxis: Point3,
  r: number,
  a0: number,
  a1: number,
): ClampedCurve<3>; // A7.1
export function circle(center: Point3, xAxis: Point3, yAxis: Point3, r: number): ClampedCurve<3>; // 9-point quadratic
export function circle2(center: Point2, r: number, arc?: Interval): ClampedCurve<2>;
export function periodicCircle(
  center: Point3,
  xAxis: Point3,
  yAxis: Point3,
  r: number,
): PeriodicCurve<3>; // 8 unique points
/** One rational quadratic segment; w1 = rho / (1 − rho); rho = 0.5 is a parabola (D5 rail fullness). */
export function conicArc(p0: Point3, apex: Point3, p2: Point3, rho: number): ClampedCurve<3>; // A7.3 segment
export function planeSurface(
  origin: Point3,
  uAxis: Point3,
  vAxis: Point3,
  domain?: { readonly u: Interval; readonly v: Interval },
): NurbsSurface;
export function bilinearPatch(p00: Point3, p10: Point3, p01: Point3, p11: Point3): NurbsSurface;
export function bezierSurface(
  points: ArrayLike<number>,
  countU: number,
  countV: number,
  weights?: ArrayLike<number>,
): NurbsSurface;
/** A8.1. A full turn gives a periodic u direction; a periodic profile gives a periodic v. */
export function revolve(
  profile: NurbsCurve<3>,
  axisOrigin: Point3,
  axisDir: Point3,
  angle?: number,
): NurbsSurface;
// u turns about +z from +x; v clamped from the south pole (v = 0) to the north pole, exact
// two-quarter semicircle; pole rows collapsed; outward n.
export function sphere(center: Point3, r: number): NurbsSurface;
// R > r; doubly periodic (8-point periodic circles); v starts on the outer equator; outward n.
export function torus(center: Point3, axis: Point3, R: number, r: number): NurbsSurface;
// extrude(periodicCircle, h·axis): periodic u, v from base (0) to top (1); outward n.
export function cylinder(base: Point3, axis: Point3, r: number, h: number): NurbsSurface;
export function extrude(c: NurbsCurve<3>, dir: Point3): NurbsSurface;
export function ruled(a: NurbsCurve<3>, b: NurbsCurve<3>): NurbsSurface; // via makeCompatible [A1]
```

### 6.12 Fitting [A2; `fairness` options from A3]

```ts
export type Parameterization = 'uniform' | 'chord' | 'centripetal' | { readonly exponent: number };
export function parameterize(
  points: ArrayLike<number>,
  dim: Dim,
  method: Parameterization,
  closed?: boolean,
): Float64Array; // eqs. 9.4–9.6
export function averagedKnots(params: ArrayLike<number>, degree: number): Float64Array; // eq. 9.8
export function lsqKnots(params: ArrayLike<number>, degree: number, count: number): Float64Array; // eqs. 9.68–9.69

export function interpolateCurve<D extends Dim>(
  points: ArrayLike<number>,
  dim: D,
  opts?: {
    readonly degree?: number; // default 3
    readonly params?: ArrayLike<number> | Parameterization; // default 'centripetal'
    readonly endDerivatives?: readonly [PointOf<D> | null, PointOf<D> | null];
  },
): ClampedCurve<D>; // A9.1, §9.2.2
export function interpolatePeriodic<D extends Dim>(
  points: ArrayLike<number>,
  dim: D,
  opts?: {
    readonly degree?: number;
    readonly params?: ArrayLike<number> | Parameterization;
  },
): PeriodicCurve<D>; // cyclic system
export function interpolateSurface(
  grid: ArrayLike<number>,
  rows: number,
  cols: number,
  opts?: {
    readonly degreeU?: number;
    readonly degreeV?: number;
    readonly paramU?: Parameterization;
    readonly paramV?: Parameterization;
    readonly periodicU?: boolean;
    readonly periodicV?: boolean;
  },
): NurbsSurface; // A9.4

export type CurveConstraint<D extends Dim = Dim> =
  | { readonly kind: 'point'; readonly t: number; readonly value: PointOf<D> }
  | {
      readonly kind: 'derivative';
      readonly t: number;
      readonly order: 1 | 2;
      readonly value: PointOf<D>;
    }
  | { readonly kind: 'tangentDirection'; readonly t: number; readonly direction: PointOf<D> }; // C′ ∥ d, linear
export type SurfaceConstraint =
  | { readonly kind: 'point'; readonly uv: UV; readonly value: Point3; readonly axes?: number } // bitmask x=1,y=2,z=4
  | {
      readonly kind: 'derivative';
      readonly uv: UV;
      readonly du: 0 | 1 | 2;
      readonly dv: 0 | 1 | 2;
      readonly value: Point3;
      readonly axes?: number;
    };
export interface CurveFit<D extends Dim = Dim> {
  readonly curve: NurbsCurve<D>;
  readonly params: ReadonlyF64;
  readonly maxError: number;
  readonly rmsError: number;
  readonly withinTolerance: boolean;
  readonly multipliers: ReadonlyF64; // one per constraint row
}
export function approximateCurve<D extends Dim>(
  points: ArrayLike<number>,
  dim: D,
  opts: {
    readonly degree?: number;
    readonly periodic?: boolean;
    readonly knots?: ArrayLike<number>; // fixed knots, or …
    readonly count?: number; // … a fixed count (eqs. 9.68–9.69), or …
    readonly tolerance?: number;
    readonly maxCount?: number; // … adaptive insertion until maxError ≤ tolerance (default tol.fit; maxCount default: data count)
    readonly params?: ArrayLike<number> | Parameterization;
    readonly dataWeights?: ArrayLike<number>;
    readonly constraints?: readonly CurveConstraint<D>[];
    readonly fairness?: FairnessWeights; // [A3]
    readonly parameterCorrection?: number; // passes; default 0
    readonly tol?: Partial<Tolerances>;
  },
): Result<CurveFit<D>>; // A9.6, generalised
export interface SurfaceFit {
  readonly surface: NurbsSurface;
  readonly maxError: number;
  readonly rmsError: number;
  readonly withinTolerance: boolean;
}
export function approximateSurface(
  points: ArrayLike<number>,
  layout: { readonly uv: ArrayLike<number> } | { readonly rows: number; readonly cols: number },
  opts: {
    readonly u: Basis;
    readonly v: Basis; // fixed bases (lsqKnots or caller's)
    readonly dataWeights?: ArrayLike<number>;
    readonly constraints?: readonly SurfaceConstraint[];
    readonly fairness?: FairnessWeights; // [A3]
    readonly parameterCorrection?: number;
    readonly tol?: Partial<Tolerances>;
  },
): Result<SurfaceFit>;
/** Sections made compatible, then interpolated across (clamped or periodic). */
export function skinCurves(
  sections: readonly NurbsCurve<3>[],
  opts?: {
    readonly degree?: number;
    readonly params?: ArrayLike<number> | Parameterization;
    readonly periodic?: boolean;
  },
): NurbsSurface;
```

### 6.13 Constrained fair solver [A3] — formulation in §10

```ts
export interface FairnessWeights {
  readonly stretch?: number; // α, membrane ∫|S′|²
  readonly bend: number; // β, thin plate ∫|S″|²
  readonly jerk?: number; // γ, curves only ∫|C‴|²
  readonly metric?: 'parametric' | 'scaled'; // default 'scaled' (§10.2)
  readonly on?: 'displacement' | 'shape'; // default: 'displacement' in FairProblem, 'shape' in fits
}
export type DofRule =
  | { readonly kind: 'fix'; readonly cp: number }
  | { readonly kind: 'fixAxes'; readonly cp: number; readonly axes: number } // bitmask
  | { readonly kind: 'slide'; readonly cp: number; readonly dirs: readonly Point3[] } // cp = ref + Σ s_k d_k
  | {
      readonly kind: 'offsetFrom';
      readonly cp: number;
      readonly master: number;
      readonly dirs: readonly Point3[];
    } // cp − master = ref offset + Σ s_k d_k
  | {
      readonly kind: 'mirror';
      readonly cp: number;
      readonly master: number;
      readonly plane: { readonly normal: Point3; readonly d: number };
    }
  | {
      readonly kind: 'copy';
      readonly cp: number;
      readonly master: number;
      readonly offset?: Point3;
    };
export interface DofMap {
  readonly cpCount: number;
  readonly dofCount: number;
  readonly separable: boolean;
  readonly rowPtr: ReadonlyI32;
  readonly col: ReadonlyI32;
  readonly val: ReadonlyF64; // T, CSR, 3·cpCount rows
  readonly fixed: ReadonlyF64; // x_fixed
}
export function makeDofMap(target: NurbsCurve | NurbsSurface, rules: readonly DofRule[]): DofMap; // throws conflicting-dof-rules
export type LinearConstraint =
  | CurveConstraint
  | SurfaceConstraint
  | {
      readonly kind: 'raw';
      readonly terms: readonly {
        readonly cp: number;
        readonly axis: 0 | 1 | 2;
        readonly coeff: number;
      }[];
      readonly rhs: number;
    };
export interface FairProblem {
  readonly target: NurbsCurve | NurbsSurface; // basis and weights fixed; its control points are x_ref
  readonly dof: DofMap;
  readonly fairness: FairnessWeights;
  readonly stiffness: number | ArrayLike<number>; // μ, global or per control point (the falloff)
  readonly data?: {
    readonly params: ArrayLike<number>;
    readonly points: ArrayLike<number>;
    readonly weights?: ArrayLike<number>;
  }; // soft targets
  readonly constraints: readonly LinearConstraint[]; // hard
}
export interface FairSolver {
  readonly dofCount: number;
  readonly constraintCount: number;
  readonly rank: number;
  readonly separable: boolean;
} // opaque factors inside
export interface SolveReport {
  readonly constraintResidual: number;
  readonly stationarityResidual: number;
  readonly energy: number;
  readonly dependent: ReadonlyI32; // consistent, redundant rows (dropped)
  readonly inconsistent: ReadonlyI32; // rows that could not be met (dropped; residual reported)
  readonly multipliers: ReadonlyF64; // constraint forces, one per row
}
export function prepareFairSolver(p: FairProblem, tol?: Partial<Tolerances>): Result<FairSolver>; // once per drag
/** values: per constraint, stride 3 (raw constraints use the first). Allocates only the report. */
export function solveFairInto(
  s: FairSolver,
  values: ArrayLike<number>,
  outCw: Float64Array,
): SolveReport;
export function solveFair<G extends NurbsCurve | NurbsSurface>(
  s: FairSolver,
  values: ArrayLike<number>,
): { readonly result: G; readonly report: SolveReport };
/** ∂x/∂value for one constraint component: displacement per control point per unit move. */
export function fairInfluenceInto(
  s: FairSolver,
  constraint: number,
  axis: 0 | 1 | 2,
  out: Float64Array,
): void;
export function fairnessEnergy(
  g: NurbsCurve | NurbsSurface,
  w: FairnessWeights,
  reference?: NurbsCurve | NurbsSurface,
): number;
```

### 6.14 Projection [B1]

```ts
export interface CurveProjection<D extends Dim> {
  readonly t: number;
  readonly point: PointOf<D>;
  readonly distance: number;
  readonly converged: boolean;
  readonly iterations: number;
}
export interface SurfaceProjection {
  readonly uv: UV;
  readonly point: Point3;
  readonly distance: number;
  readonly converged: boolean;
  readonly iterations: number;
  readonly onBoundary: false | SurfaceEdge | 'trim';
}
export function closestPointOnCurve<D extends 2 | 3>(
  c: NurbsCurve<D>,
  p: PointOf<D>,
  opts?: { readonly seed?: number; readonly range?: Interval; readonly tol?: Partial<Tolerances> },
): CurveProjection<D>;
export function closestPointOnSurface(
  s: NurbsSurface,
  p: Point3,
  opts?: { readonly seed?: UV; readonly tol?: Partial<Tolerances> },
): SurfaceProjection;
export function closestPointOnTrimmed(
  ts: TrimmedSurface,
  p: Point3,
  opts?: { readonly tol?: Partial<Tolerances> },
): SurfaceProjection;
/** pts stride dim; warmStart seeds each point from the previous result. Returns the count not converged. */
export function projectPointsToCurveInto(
  c: NurbsCurve<2> | NurbsCurve<3>,
  pts: ReadonlyF64,
  outT: Float64Array,
  outDist: Float64Array,
  opts?: { readonly warmStart?: boolean; readonly tol?: Partial<Tolerances> },
): number;
export function projectPointsToSurfaceInto(
  s: NurbsSurface,
  pts: ReadonlyF64,
  outUV: Float64Array,
  outDist: Float64Array,
  opts?: {
    readonly warmStart?: boolean;
    readonly seeds?: ReadonlyF64;
    readonly tol?: Partial<Tolerances>;
  },
): number;
```

### 6.15 Curves on surfaces [B1; the last two at integration]

```ts
export function curveOnSurface(
  surface: NurbsSurface,
  pcurve: NurbsCurve<2>,
  tol?: Partial<Tolerances>,
): CurveOnSurface;
export function curveOnSurfacePoint(cs: CurveOnSurface, t: number): Point3;
export function curveOnSurfaceDerivatives(
  cs: CurveOnSurface,
  t: number,
  order: 1 | 2,
): readonly Point3[]; // chain rule
export function curveOnSurfaceEvalInto(
  cs: CurveOnSurface,
  t: number,
  nDer: 0 | 1 | 2,
  out: Float64Array,
  o: number,
  sc: Scratch,
): void;
export function isoLinePcurve(s: NurbsSurface, fixed: ParamDir, value: number): ClampedCurve<2>; // exact, degree 1
/** Same-parameter pcurve of a 3D curve lying on s (sample, warm-started projection, 2D LSQ, refine). */
export function projectCurveToSurface(
  c: NurbsCurve<3>,
  s: NurbsSurface,
  tol?: Partial<Tolerances>,
): Result<{
  readonly pcurve: ClampedCurve<2>;
  readonly maxDeviation: number;
  readonly withinTolerance: boolean;
}>;
/** 3D edge curve fitted to a pcurve's image, same parameter. */
export function curveOnSurfaceTo3d(
  cs: CurveOnSurface,
  tol?: Partial<Tolerances>,
): Result<{
  readonly curve: ClampedCurve<3>;
  readonly maxError: number;
  readonly withinTolerance: boolean;
}>;
```

### 6.16 Trimmed surfaces and integration [B2]

```ts
export function makeTrimLoop(
  curves: readonly ClampedCurve<2>[],
  opts?: { readonly snap?: boolean; readonly tol?: Partial<Tolerances> },
): Result<TrimLoop>; // snap: make joins bitwise
export function naturalBoundaryLoop(s: NurbsSurface): TrimLoop; // clamped surfaces only
export function makeTrimmedSurface(
  surface: NurbsSurface,
  outer: TrimLoop | null,
  holes?: readonly TrimLoop[],
  tol?: Partial<Tolerances>,
): Result<TrimmedSurface>;
export function checkTrimLoops(ts: TrimmedSurface, tol?: Partial<Tolerances>): readonly GeomIssue[];
export function classifyUV(
  ts: TrimmedSurface,
  uv: UV,
  tol?: Partial<Tolerances>,
): 'inside' | 'outside' | 'boundary';
/** f receives the SKL derivatives (layout §4.6) at (u, v); never retained after the call. */
export function integrateTrimmed(
  ts: TrimmedSurface,
  f: (u: number, v: number, skl: ReadonlyF64) => number,
  opts?: {
    readonly polynomialDegree?: readonly [number, number];
    readonly tol?: Partial<Tolerances>;
  },
): QuadratureResult;
export function surfaceArea(
  ts: TrimmedSurface | NurbsSurface,
  tol?: Partial<Tolerances>,
): QuadratureResult;
```

### 6.17 Triangulation and tessellation [B2]

```ts
export function orient2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number;
export function incircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number; // > 0 ⇔ d inside CCW abc
export interface CdtInput {
  readonly points: ArrayLike<number>;
  readonly segments: ArrayLike<number>;
} // pairs
export interface Triangulation {
  readonly points: ReadonlyF64; // may grow: points created by splitting segments
  readonly triangles: ReadonlyU32; // CCW
  readonly halfedges: ReadonlyI32; // −1 on the hull
  readonly constrained: ReadonlyU8; // per half-edge
}
export function constrainedDelaunay(
  input: CdtInput,
  opts?: {
    readonly duplicates?: 'error' | 'merge';
    readonly removeExterior?: boolean;
    readonly tol?: Partial<Tolerances>;
  },
): Result<Triangulation>;
export function checkTriangulation(
  t: Triangulation,
  segments?: ArrayLike<number>,
): readonly GeomIssue[];

export interface TessellationOptions {
  readonly chordTol: number;
  readonly angleTol: number;
  readonly maxEdge?: number;
  readonly nDer?: 0 | 1 | 2;
}
export const DEFAULT_TESSELLATION: TessellationOptions; // chordTol 0.01 cm, angleTol 0.1 rad (provisional; Phase 3 tunes)
export interface FaceMesh {
  readonly uv: ReadonlyF64;
  readonly triangles: ReadonlyU32;
  readonly boundaryEdge: ReadonlyI32; // per vertex: B-rep edge id, or −1
  readonly plan: SurfaceSamplePlan; // all later evaluation, including drags, goes through it
}
export function tessellateTrimmedSurface(
  ts: TrimmedSurface,
  opts: TessellationOptions,
  boundary?: { readonly uv: ArrayLike<number>; readonly loopStarts: ArrayLike<number> },
): Result<FaceMesh>;
/** Keeps topology while a trim moves; null when a triangle would flip (exact orient2d) ⇒ re-tessellate. */
export function retargetTessellation(mesh: FaceMesh, ts: TrimmedSurface): FaceMesh | null;
```

### 6.18 Continuity [B3] — definitions in §11.4

```ts
export interface EdgeSide {
  readonly surface: NurbsSurface;
  readonly pcurve: NurbsCurve<2>;
  readonly sameSense: boolean;
}
export interface ContinuityProfile {
  readonly t: ReadonlyF64;
  readonly gap: ReadonlyF64;
  readonly normalAngle: ReadonlyF64;
  readonly curvatureMismatch: ReadonlyF64;
  readonly max: {
    readonly gap: number;
    readonly normalAngle: number;
    readonly curvatureMismatch: number;
  };
  readonly argmax: {
    readonly gap: number;
    readonly normalAngle: number;
    readonly curvatureMismatch: number;
  };
}
export function edgeContinuity(
  edge: NurbsCurve<3>,
  a: EdgeSide,
  b: EdgeSide,
  opts?: { readonly samplesPerSpan?: number; readonly refineMax?: boolean },
): ContinuityProfile;
export function brepEdgeContinuity(
  b: Brep,
  edge: number,
  opts?: { readonly samplesPerSpan?: number; readonly refineMax?: boolean },
): ContinuityProfile;
export interface JoinContinuity {
  readonly gap: number;
  readonly tangentAngle: number;
  readonly curvatureMismatch: number;
}
export function curveJoinContinuity(
  a: NurbsCurve<2> | NurbsCurve<3>,
  b: NurbsCurve<2> | NurbsCurve<3>,
): JoinContinuity;
export function knotContinuity(
  c: NurbsCurve<2> | NurbsCurve<3>,
  t: number,
): {
  readonly parametric: 0 | 1 | 2 | 3; // order of matching one-sided derivatives
  readonly geometric: 0 | 1 | 2;
  readonly jumps: {
    readonly d1: number;
    readonly d2: number;
    readonly tangentAngle: number;
    readonly curvature: number;
  };
};
export interface ContinuityThresholds {
  readonly gap: number;
  readonly angle: number;
  readonly curvatureRel: number;
  readonly curvatureAbs: number;
} // required: no defaults in geom
export function classifyContinuity(
  m: {
    readonly gap: number;
    readonly angle: number;
    readonly curvatureMismatch: number;
    readonly curvature: number;
  },
  th: ContinuityThresholds,
): 'none' | 'G0' | 'G1' | 'G2';
```

### 6.19 B-rep [B4]

```ts
export function makeBrep(spec: BrepSpec): Result<Brep>; // structural only: ids, loops, closure, use counts
export interface BrepReport {
  readonly ok: boolean;
  readonly issues: readonly GeomIssue[];
  readonly edgeGaps: ReadonlyF64; // measured per edge (same-parameter deviation)
  readonly maxEdgeGap: number;
  readonly maxVertexGap: number;
  readonly euler: {
    readonly V: number;
    readonly E: number;
    readonly F: number;
    readonly L: number;
    readonly S: number;
    readonly G: number;
    readonly holds: boolean;
  };
  readonly signedVolume: number;
}
export function checkBrep(b: Brep, tol?: Partial<Tolerances>): BrepReport; // geometric, expensive
export function orientBrep(b: Brep, tol?: Partial<Tolerances>): Brep; // outward by signed volume
export function transformBrep(b: Brep, m: Affine3): Brep; // det < 0 flips senses
export function faceTrimmedSurface(b: Brep, face: number): TrimmedSurface;
export function massProperties(
  b: Brep,
  tol?: Partial<Tolerances>,
): {
  readonly volume: QuadratureResult;
  readonly area: QuadratureResult;
  readonly centroid: Point3;
};
export interface BrepMesh {
  readonly faces: readonly FaceMesh[];
  readonly positions: Float64Array;
  readonly normals: Float64Array; // render3d converts to Float32 about the centre
  readonly indices: Uint32Array;
  readonly faceRanges: Uint32Array; // triangle ranges per face
}
export function tessellateBrep(b: Brep, opts: TessellationOptions): Result<BrepMesh>; // edge-first, watertight
```

### 6.20 STEP [B4]

```ts
export interface StepWriteOptions {
  readonly fileUnit?: 'mm' | 'cm' | 'in'; // default 'mm'
  readonly modelUnit?: 'mm' | 'cm'; // default 'cm'
  readonly name?: string;
  readonly timestamp?: string;
  readonly originatingSystem?: string;
  readonly precision?: 'roundTrip' | number; // default 'roundTrip'; a number = significant digits
  readonly pcurves?: 'always' | 'trimmedOnly'; // default 'always'
  readonly splitPeriodicFaces?: boolean; // default false
}
export interface StepStats {
  readonly entities: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly uncertainty: number;
  readonly maxEdgeGap: number;
} // file units
/** Throws brep-invalid (with the report) or step-unsupported. */
export function writeStep(
  b: Brep,
  opts?: StepWriteOptions,
): { readonly text: string; readonly stats: StepStats; readonly report: BrepReport };
```

### 6.21 `@openshaper/geom/testing` [from F1, grows per step]

```ts
export function mulberry32(seed: number): () => number;
// Seeded random geometry for property tests (F1): knots at least `minSpacing × domain` apart.
export function randomClampedBasis(
  rng: () => number,
  degree: number,
  count: number,
  opts?: RandomBasisOptions,
): ClampedBasis;
export function randomPeriodicBasis(
  rng: () => number,
  degree: number,
  count: number,
  opts?: RandomBasisOptions,
): PeriodicBasis;
export function randomCurve(rng: () => number, opts: RandomCurveOptions): NurbsCurve;
export function randomSurface(rng: () => number, opts: RandomSurfaceOptions): NurbsSurface; // F2
export function checksum(value: unknown): string; // typed arrays and records, for immutability tests
export function solveFairReference(
  p: FairProblem,
  values: ArrayLike<number>,
): { cw: Float64Array; report: SolveReport }; // dense null-space QR
export function boxSolid(x: number, y: number, z: number): Brep; // V1: degree-1 faces
export function prismSolid(/* polynomial prism */): Brep;
export function cylinderSolid(r: number, h: number, opts?: { trimmedCaps?: boolean }): Brep; // V2
export function torusSolid(R: number, r: number): Brep; // V3
export function sphericalZoneSolid(r: number, latitude: number): Brep; // V4
export function lensSolid(a: number, b: number, h: number): Brep;
export function plateWithHoleSolid(L: number, t: number, r: number): Brep;
export function ellipticPuckSolid(
  a: number,
  b: number,
  h: number,
  opts?: { bicubicDeck?: boolean },
): Brep; // V5 (integration)
export function sphereSolid(r: number): Brep; // in memory only; poles outside STEP scope
export function writeStepUnchecked(b: Brep, opts?: StepWriteOptions): string; // mutation suite only
export function readStepSubset(text: string): Brep; // reads exactly what writeStep emits; arity-checked
export function toOcctBrepText(b: Brep): string; // OCCT native BREP format (Path A)
```

---

## 7. Tolerance policy

One `Tolerances` record holds every tolerance and iteration cap. `DEFAULT_TOLERANCES`
is frozen; every public function that compares numbers takes `tol?: Partial<Tolerances>`.
Hot kernels take none because they compare nothing. `no-magic-tolerances.test.ts` (F1)
scans `src/**/*.ts` (excluding tests, `tolerance.ts` and vendored files) for literals
matching `/\b\d+(\.\d+)?e-\d+\b/i` and fails on any. Tolerances are never loosened to
make a test pass (golden-data rule 2).

| Name             | Default         | Meaning                                                                                                                                                                                                                                                                                                                               | Why this value                                                                                                                      |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---- | ---- | ---- | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `point`          | 1e-6 cm (10 nm) | Points coincide: vertex merge, loop closure, `isClosed`, vertex on curve end, edge-gap floor.                                                                                                                                                                                                                                         | ~10³ above accumulated rounding at board scale (300 cm × 2.2e-16 × ~10⁴ operations ≈ 7e-10 cm); ~10⁴ below a CNC finishing pass.    |
| `fit`            | 1e-4 cm (1 µm)  | Largest 3D error accepted from any approximation: fits, pcurves, projections, `curveOnSurfaceTo3d`.                                                                                                                                                                                                                                   | Two orders below CNC accuracy (0.1 mm) and 50× below the existing STEP fit target (0.005 cm); reachable with modest control counts. |
| `constraint`     | 1e-9 cm         | Post-solve `‖Cx − d‖∞` after iterative refinement.                                                                                                                                                                                                                                                                                    | Constraints must stay exact; ~10³ × rounding at condition ~10⁶.                                                                     |
| `paramRel`       | 1e-12 × domain  | Parameter equality, clamping slack, Newton parameter-step stop.                                                                                                                                                                                                                                                                       | Relative, so a rescaled domain behaves the same; far below any meaningful parameter difference.                                     |
| `knotRel`        | 1e-10 × domain  | Distinct knots closer than this: rejected at construction, snapped in operations.                                                                                                                                                                                                                                                     | Above accumulated rounding of insertion and merging; below any real knot spacing (3e-8 cm on a 300 cm curve).                       |
| `angle`          | 1e-9 rad        | Parallel and perpendicular tests in exact checks.                                                                                                                                                                                                                                                                                     | `atan2` angles are good to ~1e-16; not a continuity threshold (those are the caller's, §6.18).                                      |
| `cosine`         | 1e-12           | Zero-cosine stop in point inversion (P&T §6.1, ε₂).                                                                                                                                                                                                                                                                                   | Orthogonality to rounding at unit vectors.                                                                                          |
| `degenerateRel`  | 1e-12           | `\|Su × Sv\| ≤ degenerateRel · \|Su\| · \|Sv\|` ⇒ degenerate normal. Curves: `\|C′\| ≤ degenerateRel · M / L` ⇒ degenerate tangent (`M` largest control coordinate, `L` domain length). Surfaces apply the same floor to each partial and to `√(H² − K)` (÷ `L_u L_v \|Su\| \|Sv\|`: umbilic), `M` from the point's span pair (§4.7). | Su × Sv\                                                                                                                            | < degenerateRel · \  | Su\  | · \  | Sv\  | `⇒ degenerate normal. Curves:`\  | C′\  | ≤ degenerateRel · M / L` ⇒ degenerate tangent (`M`largest control coordinate,`L` domain length). | Scale-free; catches poles, collapsed tips and cusps from coincident control points. |
| `umbilicRel`     | 1e-10           | `H² − K ≤ umbilicRel · H²` ⇒ umbilic: principal directions are `null` (also below the `degenerateRel` floor).                                                                                                                                                                                                                         | Directions are noise below this.                                                                                                    |
| `pivotRel`       | 1e-12           | Rank decisions in pivoted Cholesky / LDLᵀ / QR, relative to the largest pivot after scaling.                                                                                                                                                                                                                                          | Dependent constraint rows have pivots at rounding level; genuine ones are O(1) after scaling.                                       |
| `quadRel`        | 1e-10           | Adaptive quadrature relative target.                                                                                                                                                                                                                                                                                                  | 3e-6 cm³ on a 30 L board; cheap because polynomial cases are exact.                                                                 |
| `weightRatioMax` | 1e6             | Max/min weight ratio above which a warning is issued.                                                                                                                                                                                                                                                                                 | Rational evaluation loses about six digits beyond it.                                                                               |
| `newtonMaxIter`  | 32              | Cap for projection, inverse arc length and other Newton loops.                                                                                                                                                                                                                                                                        | Quadratic convergence needs < 8 from the sampled seed; the cap only bounds pathological cases (`converged: false`).                 |
| `quadMaxSplits`  | 4096            | Cap on adaptive subintervals per integral.                                                                                                                                                                                                                                                                                            | 61k evaluations at GK15; reaching it means a singular integrand, reported as `converged: false`.                                    |

Options with domain meaning carry their own named defaults next to their functions:
`DEFAULT_TESSELLATION` (chord 0.01 cm, angle 0.1 rad, provisional until Phase 3
compares with the classic tessellator), the continuity sampling density (§11.4), the
projection seeding (§11.2). Continuity acceptance thresholds have **no** defaults in
geom (decision 31).

Before solves and integrals, geometry is centred (bounding-box centre subtracted) and,
for solves, scaled by the box extent. Relative tolerances then mean the same thing at
any position and size, and conditioning improves.

Every approximating function returns its achieved error (`maxError`, `maxDeviation`,
`edgeGaps`), so B-rep gaps and STEP uncertainty are measured, not assumed.

---

## 8. Error handling

**Throw `GeomError`** for contract violations (the caller passed something invalid or
asked for something impossible). They are checked once at factories and validating
entry points, never inside hot kernels.

**Return `Result<T>`** for data-dependent failures that valid input can produce and
that the UI must show during a drag without exceptions: fits, solver preparation,
trim-loop and trimmed-surface construction, CDT, tessellation, `makeBrep`,
pcurve fitting. `ok: true` may carry warnings.

**Always return a best result** with a flag where an iteration can fall short:
projection (`converged`), quadrature (`converged`), fits (`withinTolerance`), the
per-frame solve (`SolveReport` with `dependent`, `inconsistent`, residuals).
`solveFairInto` never throws.

**Never return NaN.** Valid input yields finite output. A degenerate normal is
`{ kind: 'degenerate' }` in the allocating API and `(0, 0, 0)` with
`SAMPLE_DEGENERATE` in plan outputs. Tests assert finiteness of every output.

Messages name the broken convention and the value, e.g. "outer trim loop must be
counter-clockwise (material on the left); signed area −0.12". `details` and
`GeomIssue.at` carry the indices and values needed to reproduce the failure.

```ts
export type GeomErrorCode =
  // construction
  | 'invalid-degree'
  | 'knot-count'
  | 'knots-decreasing'
  | 'knots-not-clamped'
  | 'knot-multiplicity'
  | 'knots-near-coincident'
  | 'non-finite'
  | 'weight-not-positive'
  | 'weight-ratio'
  | 'too-few-points'
  | 'size-mismatch'
  | 'dimension-mismatch'
  | 'empty-domain'
  | 'scratch-too-small'
  // evaluation
  | 'param-out-of-domain'
  | 'side-unavailable'
  // fitting and solving
  | 'schoenberg-whitney'
  | 'singular-system'
  | 'not-positive-definite'
  | 'conflicting-dof-rules'
  | 'dependent-constraints'
  | 'inconsistent-constraints'
  | 'constraint-residual'
  | 'not-converged'
  // trimming, triangulation, tessellation
  | 'trim-not-closed'
  | 'trim-self-intersects'
  | 'trim-orientation'
  | 'trim-outside-domain'
  | 'trim-loops-intersect'
  | 'trim-hole-outside'
  | 'trim-on-periodic'
  | 'cdt-duplicate-point'
  | 'cdt-segments-intersect'
  | 'cdt-failure'
  | 'tessellation-failure'
  // B-rep and STEP
  | 'brep-reference'
  | 'brep-invalid'
  | 'step-unsupported'
  // anything else not supported in Phase 1
  | 'unsupported';
```

---

## 9. Performance strategy and hot paths

**Budget.** A 16.7 ms frame leaves about 4 ms for geometry after React and the GPU
upload, and phones run 4–5× slower (the throttle in `browser-perf.mjs`). So per-frame
geometry work is ≤ 1 ms in desktop Node, and one-off work on pointer-down is ≤ 10 ms
(the coupled solver path may take more and then runs in the worker, cached across
drags while its structure is unchanged).

**Hot paths** (each has a benchmark in §17):

1. **Drag frame.** `solveFairInto` → `withSurfaceControlNet` → `changedControlPoints`
   → `evalSurfacePlanDirty` → partial GPU upload. Allocates only the new `cw` (16 KB)
   and the small report.
2. **Shading and analysis evaluation.** `evalSurfacePlan` over all mesh vertices.
3. **2D views.** `curveEvalBatchInto` / `curveCurvatureBatchInto` over sorted params.
4. **Projection batches.** `projectPointsTo*Into` with warm starts (converter, pcurves).

**Kernel rules.**

- Basis functions follow A2.2 / A2.3 into fixed regions of one scratch `Float64Array`
  (`ndu`, `left`, `right`, `a`); no per-call arrays (the existing `bspline-surface.ts`
  allocates five per call).
- Span search is binary for single queries and a linear walk for sorted batches and
  grids (amortised O(1)).
- Tensor grids are separable: basis per u and per v once, then
  O(Nu·Nv·(p+1)(q+1)) multiply-adds.
- Rational evaluation accumulates homogeneous SKL (6 combinations × 4 components) and
  applies the quotient rule once per sample.
- V8 hygiene: monomorphic functions, integer offsets, no `subarray` or closures in hot
  loops, `Math.sqrt` not `Math.hypot`, no `Math.pow` or array methods in loops, no
  out-of-bounds reads (they return `undefined` and deoptimise), outputs at most
  bimorphic (`Float32Array | Float64Array`). Loops are written for
  `noUncheckedIndexedAccess` (`a[i]!`), which costs nothing at runtime.

**Sample plans** (A, measured in its prototype, Node 22, 5,000 random samples on a
64 × 8 rational bicubic net: plan build 1.64 ms, full position + normal + k₁/k₂
evaluation 1.33 ms).

- Per sample: spans and separable u/v basis values up to `nDer`; per control point: a
  CSR list of the samples it influences.
- A dirty update takes the union of the changed control points' sample lists
  (deduplicated with a generation-stamped `Uint32Array`, no clearing), recomputes
  those samples and returns their sorted ids. One rail-band control point touches
  about 4/57 × 4/5 ≈ 6% of the samples.
- Tessellation orders vertices span-major, so touched ids form a few contiguous runs:
  that suits `BufferAttribute.addUpdateRange`.
- Memory: about 1.3 MB for 5,000 bicubic samples at `nDer = 2`. `nDer = 1` is the
  shading default; `nDer = 2` is built when a curvature display is selected (the
  plan's on-demand rule, §0.7).

**Workers.** geom never touches `Worker`. Values clone cheaply and buffers transfer.
Recommended Phase 3 split: prepare the solver on pointer-down, per-frame solves on the
main thread or in the worker that owns the plans; per frame post `{ cw, changedCps }`
(transferred). Solver objects are drag-session state, never stored in the store.

**Allocation check.** A bench runs 10k simulated drag frames under
`node --expose-gc` and counts V8 GCs with `PerformanceObserver('gc')`; the target is no
GC beyond the `cw` copies.

**Tier-2 options**, only if P7, P8 or P14 miss: a cubic-specialised unrolled basis;
delta updates (`ΔS = Σ N ΔPw`, positions and derivatives are linear in Pw) with a full
recompute on settle so output stays deterministic; Float32 basis storage in display
plans.

---

## 10. Constrained least squares with fairness

### 10.1 Problem

Unknowns: Euclidean control coordinates `x ∈ ℝ^{3n}` (`n` control points; dimension
`d ≤ 3` for curves). Basis and weights are fixed, so `S(u, v) = Σ R_ij(u, v) P_ij` is
linear in `x`.

```
minimise   ½ Σ_k ω_k |S(ξ_k) − q_k|²                       data / soft targets (A9.6 when alone)
         + ½ yᵀ F y                                        fairness, F = α G₁ + β G₂ (+ γ G₃ for curves)
         + ½ (x − x_ref)ᵀ D (x − x_ref)                    stiffness, D = diag(μ_i)  (the falloff)
subject to x = T z + x_fixed                               structural rules (DOF map), exact by construction
           C x = d                                         general linear constraints, exact
```

- `y = x − x_ref` when fairness is `on: 'displacement'` (edits: the drag-start shape
  `x_ref` is never flattened, only the change is kept fair); `y = x` when
  `on: 'shape'` (fits: smoothing).
- `G₁ = ∫∫ (R_u R_uᵀ + R_v R_vᵀ)` (membrane); `G₂ = ∫∫ (R_uu R_uuᵀ + 2 R_uv R_uvᵀ +
R_vv R_vvᵀ)` (thin plate); for curves `∫ R′R′ᵀ`, `∫ R″R″ᵀ`, `∫ R‴R‴ᵀ`. Each acts per
  coordinate (`⊗ I₃`).
- Equivalent quadratic form: `½ xᵀ H x − gᵀ x` with `H = AᵀWA + F + D` and
  `g = AᵀWq + D x_ref (+ F x_ref when on displacement)`. `x_ref` is fixed for a
  drag, so `g` is fixed and only `d` changes per frame.
- **No implicit regularisation.** `F` has the affine fields as its null space. `D`
  (stiffness > 0), the data term or the constraints must remove it; otherwise
  `prepareFairSolver` returns `not-positive-definite`. For a pure fit the stiffness is
  normally 0 and the data term does it.

### 10.2 Assembly

- Gram matrices are assembled per knot-span pair with Gauss–Legendre. Polynomial
  bases: `p + 1` points per direction, which is **exact**: each tensor factor is a
  product of two basis functions or their derivatives, of degree at most `2p` (the
  undifferentiated factor, e.g. `∫ N_j N_l dv` in the `S_uu` term), and `n` GL points
  integrate degree `2n − 1` exactly. Fixed-weight rational bases are not polynomial:
  `p + 3` points, with a test that `p + 4` changes nothing beyond `quadRel`.
- `metric: 'scaled'` (default) weights span pair `(a, b)` by the reference surface's
  mean speeds `λ_u`, `λ_v` on that span pair:
  `∫∫ (λ_u⁻⁴|S_uu|² + 2 λ_u⁻² λ_v⁻² |S_uv|² + λ_v⁻⁴ |S_vv|²) λ_u λ_v du dv`.
  Piecewise constant, so still exact under GL; invariant to affine
  reparameterisation; removes the bias a non-arc-length parameter would give round a
  tight tail. `'parametric'` drops the λ factors.
- Coordinates are centred and scaled first (§7).

### 10.3 Two constraint classes

| Class          | Examples (Phase 2/3 consumers)                                                                                                                                                                                       | Technique                                                        | Why                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural     | Fixed boundary rows; the apex row; rows either side of the apex move only vertically relative to it (`offsetFrom`, dir ẑ); rail-frame handle axes (`slide`); symmetry (`mirror`); periodic or copied points (`copy`) | **Null space by an explicit sparse DOF map** `x = T z + x_fixed` | Exact forever, no drift, no multipliers; shrinks the system; `T` holds 0/±1 or 3×3 blocks so `TᵀHT` stays sparse; symmetric mode solves only the master half. |
| General linear | Drag handles `S(u₀, v₀) = h`; tangent-direction rows; rocker or deck-line samples that are not rows; apex height                                                                                                     | **Range-space KKT** through the Schur complement                 | m ≪ n (5–60 once structural locks are in the map); the factor stays SPD and sparse; `S` is a small dense matrix.                                              |

Bit-exactness: `fix`, `fixAxes`, `copy` and `mirror` across a coordinate plane hold
with `===`; `slide`, `offsetFrom` and general mirrors hold to rounding of `T z`.
Conflicting rules (one control point coordinate claimed twice) throw
`conflicting-dof-rules`.

### 10.4 Factorisation and solve

With `K = Tᵀ H T`, `g′ = Tᵀ(g − H x_fixed)`, `C′ = C T`, `d′ = d − C x_fixed`:

1. **Structure (knots, degree, DOF pattern or constraint pattern changes).** Assemble
   Gram matrices; reverse Cuthill–McKee ordering of `K`'s graph; symbolic envelope.
   RCM handles periodic wrap (it zig-zags the cyclic index) and the couplings that
   mirror and `offsetFrom` elimination create; on a plain clamped grid it reduces to
   the band.
2. **Pointer-down (weights, falloff or handle set change).** Numeric envelope
   Cholesky `K = LLᵀ`; `Y = K⁻¹ C′ᵀ` (m solves, exploiting each column's leading
   zeros); `S = C′ Y`; pivoted Cholesky of `S` — pivots below `pivotRel × max pivot`
   mark dependent rows; `z₀ = K⁻¹ g′`.
3. **Each pointer move (only `d` changes).** `λ = S⁻¹ (C′ z₀ − d′)`, `z = z₀ − Y λ`,
   scatter `x = T z + x_fixed`, one step of iterative refinement on the full KKT
   residual so `‖Cx − d‖∞ ≤ constraint`. Cost O(m² + n·m).
4. **Dependent rows.** A dependent row whose residual after the solve is within
   `constraint` is consistent and reported in `dependent`; otherwise it is reported in
   `inconsistent` with its residual. The independent rows hold exactly either way.
5. **Separable path.** If every DOF rule is axis-diagonal and every constraint row
   involves one coordinate, x, y and z are solved as three systems of size n that
   share the symbolic analysis (and the numeric factor when their locks agree). About
   25× cheaper to factor than the coupled 3n system (B's measurement). Otherwise one
   interleaved 3n system.
6. **Influence (§3.5 display).** Column k of `T Y S⁻¹` is the displacement of every
   control point per unit move of constraint value k; `fairInfluenceInto` returns it,
   and pushing it through a sample plan gives the per-vertex influence map.

**Measured** (proposal probes, Node 22, single thread, naive loops): dense Cholesky
34 ms at n = 512 and 958 ms at n = 1536; banded Cholesky 0.32 ms at n = 512 (b = 27)
and 9.9 ms at n = 1536 (b = 81); with m = 100 the Schur step adds 7.2 ms at n = 500,
and the coupled n = 1500, m = 150 case takes 155 ms naive (55 ms factor + 100 ms
Schur), which is why the Schur step must use the columns' leading zeros.

**Expected sizes.**

| Problem                                           | Control points | Scalar unknowns       | m     |
| ------------------------------------------------- | -------------- | --------------------- | ----- |
| Rail band drag, symmetric                         | 512            | ≈ 3 × 230 after locks | 5–30  |
| Rail band, rail-frame handles (coupled)           | 512            | ≤ 1,536               | 5–30  |
| Deck or bottom height field                       | ≈ 640          | 640 (z only)          | 20–60 |
| Converter LSQ (Phase 2): rail band to ~8k samples | 512            | 3 × 512               | ≈ 10  |
| Apex loop or rail-law curves                      | 60–120         | 3n or n               | ≤ 10  |

**Fitting is the same machinery**: `approximateCurve` / `approximateSurface` set
`H = AᵀWA (+ F on shape)`, constraints as `C` rows, no DOF map. Normal equations
square the condition number; B-spline collocation is well conditioned under
Schoenberg–Whitney (checked, `schoenberg-whitney` issue otherwise), and the dense
Householder-QR path cross-checks small problems in tests. Tangent-direction
constraints are linear: `C′(t) × d = 0` gives two independent rows (one in 2D).

---

## 11. Algorithms that needed a decision

### 11.1 Periodic evaluation

1. Wrap the parameter into the domain (§4.6).
2. Find the span `k` in the one-period knot list.
3. Build the local knot window `t_{k−p+1} … t_{k+p}` from the bi-infinite sequence
   into scratch (O(p)).
4. Gather control points `(k − p … k) mod n`.
5. Run A2.2 / A2.3 and A3.1 / A4.1 unchanged on the window.

`book/periodic.ts` is the only place that knows periodicity. Plans store the gathered
control indices, so per-frame evaluation has no modular arithmetic.

### 11.2 Projection (closest point)

- **Seeds:** each non-empty span sampled at `2p + 1` parameters (a `(2p + 1)²` grid per
  surface span pair); the three best start Newton. The derivative of the squared
  distance has at most `2p − 1` roots per polynomial span, so this is dense enough in
  practice; brute-force tests (§16) are the check.
- **Newton:** P&T §6.1 for curves, the 2 × 2 system for surfaces; stop on
  `distance ≤ point`, cosine `≤ cosine`, or a parameter step `≤ paramRel`; damped
  (Levenberg–Marquardt) when a step increases the distance; clamp on clamped
  directions and wrap on periodic ones. An iterate leaving the domain switches to 1D
  Newton on the boundary iso-curve; the better of the two wins.
- **Trimmed:** if the unconstrained minimum classifies outside, project onto each trim
  loop's image as a curve on the surface (`onBoundary: 'trim'`).
- **Batches:** warm start from the previous point's result, falling back to seeding
  when Newton fails.
- Always returns the best point found, with `converged` and `iterations`.

### 11.3 Integration over trimmed domains

Green's theorem in the parameter domain, boundary positively oriented (outer CCW,
holes CW):

```
∫∫_D f(u, v) du dv = ∮_∂D F(u, v) dv,    F(u, v) = ∫_{u_lo}^{u} f(s, v) ds
```

- **Inner integral:** Gauss–Legendre split at the surface's u-knots.
- **Outer integral:** along each trim curve, split at the curve's own knots and at
  every `t` where `v(t)` crosses a surface v-knot (found on the Bézier pieces from
  `decomposeBezier` by sign-isolated bisection).
- **Exactness:** for polynomial `S` of bidegree `(p_u, p_v)` and polynomial pcurves of
  degree `q`, the volume integrand `(S − c)·(S_u × S_v)` has bidegree
  `(3p_u − 1, 3p_v − 1)`, and fixed GL orders chosen from these degrees make the
  result exact to rounding (cubic: 5 points per direction).
- **Otherwise** (rational geometry, the area integrand `|S_u × S_v|`): Gauss–Kronrod
  7–15 with adaptive bisection on both levels until `quadRel`.
- **Natural-boundary faces** use the tensor-product GL rule per span pair (exact under
  the same conditions, cheaper).
- **Volume:** `V = ⅓ Σ_f σ_f ∫∫_{D_f} (S − c)·(S_u × S_v) du dv`, `σ_f = ±1` from
  `sameSense`, `c` = bounding-box centre to minimise cancellation; a translation test
  pins that. The centroid uses the same machinery.
- A's cut-cell integrator (tensor GL on interior cells, Gauss–Green on cut cells) is
  the documented fallback if P22 misses.

### 11.4 Continuity measures

For an edge with 3D curve `C(t)` and sides `(S_A, p_A)`, `(S_B, p_B)`:

- **Gap** = max of `|S_A(p_A(t)) − S_B(p_B(t))|`, `|C(t) − S_A(p_A(t))|`,
  `|C(t) − S_B(p_B(t))|`.
- **Normal angle** between the two faces' outward normals (`sameSense` applied),
  via `atan2(|a × b|, a · b)`.
- **Curvature mismatch** = `|κ_A(b) − κ_B(b)|` where `b = n_A × t̂` is the
  cross-boundary direction and `κ(b) = II(b, b) / I(b, b)`. For a G1 join the tangent
  planes coincide, so G2 holds iff the normal curvatures agree across the edge (they
  already agree along it); the sign of `b` is irrelevant.
- **Sampling:** `samplesPerSpan` Gauss points (default `degree + 1` of the highest
  degree involved) on each span of the union of the edge's and both pcurves' knots,
  plus golden-section refinement round the worst sample (`refineMax`, default true).
  The full arrays are returned for the Phase 3 join readout.

### 11.5 Tessellation

1. **Edges first.** Each B-rep edge is sampled once, adaptively, by chord and angle on
   its 3D curve and on both faces through their pcurves. Every face uses the same
   vertex indices with positions from the **edge curve**, so the mesh is bitwise
   watertight even where surfaces meet only within the edge gap.
2. **Interior seeds** on a grid aligned to knot spans, refined per span by a flatness
   bound on the control net; seeds closer than half the local spacing to the boundary
   are dropped (exact classification), which avoids slivers and collinear-with-segment
   cases.
3. **CDT in metric-scaled (u, v)** (affine map by mean `|Su|`, `|Sv|`), so a 300 cm ×
   60 cm deck gives near-Delaunay triangles in 3D, not just in (u, v); exterior and
   holes removed.
4. **Refinement:** insert at the worst triangle where the chord error (centroid and
   edge midpoints, measured by projection) or normal deviation exceeds the tolerance;
   a split of a constrained edge is placed **on the trim curve** at the mid parameter.
5. **Plan:** a `SurfaceSamplePlan` over the final uv, ordered span-major.
6. **Retarget during a drag:** boundary samples keep their trim parameters, triangles
   are checked with exact `orient2d`, and only a flip forces a re-tessellation.

---

## 12. Constrained Delaunay triangulation: implement

**Decision: implement `mesh/cdt.ts` in-house on vendored exact predicates.** Licences
and versions below were checked in the package tarballs (2026-10-10).

| Package                   | Licence     | Version | Verdict                                                                                                                                                                        |
| ------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `robust-predicates`       | Unlicense   | 3.0.3   | **Vendored** (`orient2d`, `incircle` only) with attribution in `NOTICE.md`. Its `orient2d` computes `(ay − cy)(bx − cx) − (ax − cx)(by − cy)`: negative for a y-up CCW triple. |
| `delaunator`              | ISC         | 5.1.0   | **Dev-only differential oracle** (unconstrained). Silently skips near-duplicates.                                                                                              |
| `@kninnug/constrainautor` | ISC         | 4.1.0   | **Dev-only differential oracle** (constrained). Throws on a point on a constraint, crossing constraints and duplicates; no exterior or hole removal.                           |
| `earcut`                  | ISC         | —       | Rejected: ear clipping, not Delaunay, no interior points.                                                                                                                      |
| `cdt2d`, `poly2tri`       | MIT, BSD-3  | —       | Rejected: unmaintained; fragile on collinear input.                                                                                                                            |
| `libtess`                 | SGI-B-2.0   | —       | Rejected: not Delaunay; unusual licence.                                                                                                                                       |
| `triangle-wasm`           | MIT wrapper | —       | Rejected: wraps Shewchuk's _Triangle_, whose licence forbids commercial redistribution — not GPL-compatible.                                                                   |

**Why implement:** Phase 1 is dependency-free and Checkpoint A forbids new runtime
dependencies (vendored public-domain predicates satisfy both); our inputs routinely
break constrainautor's preconditions (grid points land exactly on iso-parametric
trims and the domain rectangle), so a preprocessing layer is needed anyway;
refinement needs incremental Steiner insertion that keeps constrained edges; and the
invariants are cheap and exhaustive to check, so correctness rests on checkable
properties.

**Algorithm (about 700–900 lines):**

- Data layout as Delaunator: `triangles: Uint32Array`, `halfedges: Int32Array`, a
  constrained flag per half-edge.
- Insertion in BRIO / Hilbert order with a fixed seed (deterministic), visibility-walk
  point location, Lawson flips; **ghost triangles** (an infinite vertex) instead of a
  super-triangle, so predicates only see input coordinates.
- Segments by Sloan's flip-based recovery, then a re-Delaunay pass over the new
  unconstrained edges. A point exactly on a segment (`orient2d = 0` and between the
  ends) splits the segment instead of failing.
- Inside/outside by flood fill across unconstrained edges from the ghost triangles,
  cross-checked against the winding number per region; a mismatch reveals an
  inconsistently oriented loop (`trim-orientation`).
- Steiner points by constrained Lawson insertion (never flipping constrained edges).

**Predicates.** Copied from `robust-predicates` 3.0.3 into `mesh/predicates.ts`,
wrapped so `> 0` means CCW with y up. Tested on fixed triples and against an exact
BigInt oracle (each double is an exact dyadic rational) on random, 1-ulp-perturbed,
cocircular-grid and large-offset (1e6 + ε) inputs.

**Fallback (timebox: 5 working days from the start of `cdt.ts`).** If the invariant and
differential suites are not green, vendor `delaunator` and `constrainautor` (ISC,
notices kept) under `src/mesh/vendor/` behind the same `constrainedDelaunay`
signature, keeping our own preprocessing (segment splits at points, duplicate
merging) and classification.

---

## 13. Minimal B-rep

**Scope:** manifold solids with one closed outer shell; faces with an outer loop and
holes; closed edges (start = end); seam edges (used twice by one face). **Out of
scope:** collapsed edges and poles, voids, open shells, non-manifold topology.

`makeBrep` (cheap, structural): ids in range, non-empty loops, edge endpoint
consistency, loop closure in vertex order (respecting `sense`), every edge used
exactly twice (a seam twice by one face).

`checkBrep` (expensive, geometric) adds:

1. pcurve end points join bitwise (across the period for seams) and map to their
   vertices within `point`;
2. same-parameter deviation `|C(t) − S(p(t))|` at Gauss points per span plus
   refinement round the maximum, per coedge; the per-edge maximum is `edgeGaps[e]`;
3. pcurves inside their surface's domain; trim loops valid per face (§6.16);
4. manifold and orientable: each edge's two uses run in opposite effective directions;
5. Euler–Poincaré `V − E + F − (L − F) = 2(S − G)`, with `G` checked against the
   declared genus or reported as derived (must be a non-negative integer);
6. outward orientation: `signedVolume > 0` (for a connected, coherently oriented
   closed shell the sign decides the global orientation).

Checks 4 and 6 catch every orientation error that OCCT's STEP reader heals (§15). A
defect-injection catalogue mutates valid B-reps (flip a face sense, flip a coedge,
reverse a loop, drop a face, move a vertex, corrupt a weight) and asserts each is
detected.

---

## 14. STEP writer scope (AP214)

Header, product chain, units and contexts as in `export/src/step.ts` (copied into
`step/part21.ts`, since geom may not import `export`; Phase 4 should make `export`
import them from geom).

**Entities.**

- Units: mm and cm as `SI_UNIT`, inches as `CONVERSION_BASED_UNIT`; plane and solid
  angle units; `UNCERTAINTY_MEASURE_WITH_UNIT`; the 3D
  `GEOMETRIC_REPRESENTATION_CONTEXT` complex.
- 2D parameter context: `(GEOMETRIC_REPRESENTATION_CONTEXT(2) PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''))`.
- Geometry: `CARTESIAN_POINT` (2D, 3D), `DIRECTION`, `AXIS2_PLACEMENT_3D`, `PLANE`,
  `B_SPLINE_CURVE_WITH_KNOTS`, `B_SPLINE_SURFACE_WITH_KNOTS`; **rational curves and
  surfaces as complex entity instances** with partial entities in alphabetical order,
  Euclidean control points and separate weights:
  `(BOUNDED_CURVE() B_SPLINE_CURVE(…) B_SPLINE_CURVE_WITH_KNOTS(…) CURVE() GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_CURVE((w…)) REPRESENTATION_ITEM(''))`
  and the surface analogue ending `… RATIONAL_B_SPLINE_SURFACE(((w…),…)) REPRESENTATION_ITEM('') SURFACE())`;
  `PCURVE` with `DEFINITIONAL_REPRESENTATION`; `SURFACE_CURVE`; `SEAM_CURVE`.
- Topology: `VERTEX_POINT`, `EDGE_CURVE` (geometry a `SURFACE_CURVE` or `SEAM_CURVE`
  with both pcurves), `ORIENTED_EDGE`, `EDGE_LOOP`, `FACE_OUTER_BOUND`, `FACE_BOUND`,
  `ADVANCED_FACE`, `CLOSED_SHELL`, `MANIFOLD_SOLID_BREP`,
  `ADVANCED_BREP_SHAPE_REPRESENTATION`, `SHAPE_DEFINITION_REPRESENTATION`.
- These templates (rational surfaces and curves, `SURFACE_CURVE`/`SEAM_CURVE` with
  `PCURVE`s, a face trimmed by a rational pcurve loop) were accepted by OCCT 8.0.1 at
  1e-7 mm in proposal B's probe.

**Policies.**

- Periodic curves and surfaces are written clamped through the exact `toClamped` at a
  seam, closed by a `SEAM_CURVE` edge with exact degree-1 pcurves; `closed_curve`,
  `u_closed`, `v_closed` state the geometric truth. `splitPeriodicFaces: true` emits
  two faces per periodic surface instead, for importers that dislike seams.
- `master_representation` is `.CURVE_3D.` where the 3D curve defines the edge (iso
  and boundary rows) and `.PCURVE_S1.` / `.PCURVE_S2.` where a parameter-space trim
  does.
- **Uncertainty is measured:** `2 × max(maxEdgeGap, maxVertexGap)` from `checkBrep`,
  floored at 1e-7 mm, in file units. OCCT then has no gap to heal, and the validator
  can tell real tolerance growth from declared uncertainty.
- **Refusal:** `writeStep` runs `checkBrep` and throws `brep-invalid` (carrying the
  report); `step-unsupported` for collapsed edges or open shells.
  `writeStepUnchecked` exists only in `testing` for the mutation suite.
- **Numbers:** shortest round-trip decimals by default (Part 21's `.` rule applied),
  so `readStepSubset(writeStep(b))` equals `b` bitwise; `precision: n` writes `n`
  significant digits (9 reproduces the existing writer's size), in which case knot
  multiplicities are computed from the formatted text so knots that print alike
  merge.
- Coincident points deduplicated by emitted text; shared vertices emitted once;
  output byte-identical for the same input and timestamp.
- `step/schema.ts` records every emitted entity's attribute count and kinds;
  `readStepSubset` enforces it (OCCT only warns on malformed entities).
- **Not in Phase 1:** colours and names (`STYLED_ITEM`), assemblies, AP242/PMI,
  `BREP_WITH_VOIDS`, collapsed edges, STEP reading in the product.

---

## 15. CI-only OCCT validator (`occt-wasm`)

### 15.1 What it exposes (verified)

Checked in this session by reading the `occt-wasm` 5.3.5 and 5.6.1 typings
(`dist/index.d.ts`, `dist/types.d.ts`), the JS wrapper (`dist/index.js`) and the C++
facade source (`facade/generated/kernel.cpp`) unpacked by the proposals' probes. The
methods below exist with the same signatures in both versions.

| Need            | API                                                                                                                                                                          | Implementation                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Start           | `OcctKernel.init(options?): Promise<OcctKernel>`                                                                                                                             | Loads the WASM.                                                                                                                              |
| STEP import     | `importStep(data: string \| ArrayBuffer): ShapeHandle`                                                                                                                       | `STEPControl_Reader::ReadFile` → `TransferRoots` → `OneShape`; default shape processing, no option to disable it; throws if nothing is read. |
| Validity        | `isValid(shape): boolean`                                                                                                                                                    | `BRepCheck_Analyzer(shape).IsValid()`, default (geometric controls on); boolean only.                                                        |
| Unhealed load   | `fromBREP(data: string): ShapeHandle`, `toBREP(shape): string`                                                                                                               | `BRepTools::Read` / `Write` (native format, no healing); `toBREP` text includes vertex and edge tolerances.                                  |
| Volume, area    | `getVolume(shape)`, `getSurfaceArea(shape)`                                                                                                                                  | `BRepGProp::VolumeProperties` / `SurfaceProperties` **without** an epsilon (fixed default order).                                            |
| Structure       | `getShapeType`, `subShapeCount(shape, 'vertex'\|'edge'\|'wire'\|'face'\|'shell'\|'solid')`, `getSubShapes`, `edgeToFaceMap`, `sharedEdges`, `shapeOrientation`, `queryBatch` | —                                                                                                                                            |
| Geometry probes | `pointOnSurface(face, u, v)`, `uvBounds(face)`, `surfaceType(face)`, `getNurbsCurveData(edge)` → `{ degree, rational, periodic, knots, multiplicities, poles, weights }`     | —                                                                                                                                            |
| Fine mesh       | `tessellate(shape, { linearDeflection, angularDeflection, … })`                                                                                                              | `BRepMesh`.                                                                                                                                  |
| Memory          | `checkpoint()`, `releaseSince(mark)`                                                                                                                                         | Handles are freed explicitly; one checkpoint per test file.                                                                                  |
| **Do not use**  | `surfaceCurvature(face, u, v)`                                                                                                                                               | C++ returns `[mean, gaussian, max, min]`; the JS wrapper decodes index 0–3 as `{ min, max, gaussian, mean }`. Mislabelled.                   |

Package facts (verified): repository `github.com/andymai/occt-wasm` (the plan's §9
link to `lto-dev/occt-wasm` was wrong and is corrected); wrapper licence
`MIT OR Apache-2.0`; compiled WASM LGPL-2.1-only (README) — dev-only and never
distributed, so no obligations to users arise; one runtime dependency (`comlink`);
about 22 MB unpacked (21 MB WASM); needs Node 22 (WASM tail calls, SIMD,
exceptions), which `.node-version` (22.23.3) provides.

### 15.2 What the probes measured (proposals A and B, 2026-10-10; not re-run here)

1. **The STEP reader heals silently.** A box missing one face imports as a valid
   5-face shell; a flipped `ADVANCED_FACE` sense, a flipped `ORIENTED_EDGE` and both
   hull faces inverted all import as a valid solid with unchanged volume; a cap plane
   moved 5 mm imports "valid", visible only as vertex/edge tolerance grown to 4.97 mm.
2. **The native BREP path does not heal:** a face flipped in a shell or an edge
   flipped in a wire gives `isValid = false` and a wrong volume (4000 instead of 6000).
3. **`getVolume` is coarse on B-spline solids:** −0.43% on a polynomial prism, +0.79%
   (B) and +0.30% (A) on rational cylinders; OCCT's fine mesh volume is within 5–8e-5.
4. **Dropped weights** are visible only as tolerance growth (0.59 mm).
5. **Baseline:** today's exporter's golden boards import as one valid solid at
   tolerance 1e-7 mm; OCCT's volume is 0.24–0.33% above the classic `getVolume`
   (a Phase 2 deviation-report lead, unverified cause).

### 15.3 Protocol

Each corpus solid is built in memory (`testing/solids.ts`), must pass `checkBrep`, and
then runs through two paths.

**Path B — our STEP file** (`writeStep` → `importStep`):

| #   | Check            | Pass condition                                                                                                                       | Catches                                         |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| B1  | Type             | `getShapeType` is `solid` (or a compound with exactly one solid)                                                                     | Wrong product structure                         |
| B2  | Validity         | `isValid`                                                                                                                            | Gross errors                                    |
| B3  | Counts           | solids 1, shells 1, faces / edges / vertices equal `StepStats`                                                                       | Healed or dropped topology                      |
| B4  | Tolerance growth | Max vertex and edge tolerance parsed from `toBREP` ≤ 2 × declared uncertainty, floored at 1e-6 mm                                    | Healed gaps, wrong weights                      |
| B5  | Encoding         | `getNurbsCurveData(edge)`: degree, rational flag, knots, multiplicities, weights equal ours                                          | Knot / weight encoding                          |
| B6  | Encoding         | `pointOnSurface` at sampled (u, v) equals our `surfacePoint` within 1e-6 mm                                                          | Surface encoding, parameterisation              |
| B7  | Same integrator  | `getVolume(Path B) = getVolume(Path A)` to 1e-9 relative                                                                             | Encoding fidelity, independent of GProp's error |
| B8  | Accuracy         | Our exact volume vs OCCT's mesh volume within its chord bound (≤ 5e-4 relative at 0.01 mm deflection); vs `getVolume` within 1% only | Gross geometry errors                           |

If a future OCCT reparameterises a B-spline face, B6 falls back to closest-point
distance.

**Path A — unhealed model validity** (test-only `toOcctBrepText` → `fromBREP`):
assert `isValid`; record `getVolume` (for B7) and the mesh volume. This is the only
OCCT check that sees orientation errors, and it tests `checkBrep` independently.
Path A lands after Path B is green (about two days for the BREP text writer).

**Mutation suite.** The STEP mutations of §15.2 are written with `writeStepUnchecked`.
The test pins OCCT's current verdict (orientation mutations pass B2; gap and weight
mutations fail B4) so an upstream change is noticed, and asserts that
`readStepSubset` + `checkBrep` rejects every one. Native BREP mutations must fail
Path A.

**Corpus** (each written in mm and in cm):

| Id  | Solid                                                                                                                                  | Exercises                                                   | Exact volume             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| V1  | Box from degree-1 B-spline faces                                                                                                       | Tooling smoke test; B4's first deliverable                  | `abc`                    |
| V2  | Cylinder: rational periodic band with a `SEAM_CURVE`, two trimmed planar caps with rational circle pcurves; with and without pcurves   | Rational, seam, trims                                       | `πr²h`                   |
| V3  | Torus: one doubly periodic face, two seams, one vertex                                                                                 | Double periodicity                                          | `2π²Rr²`                 |
| V4  | Spherical zone (±60°) and two trimmed planar caps                                                                                      | Rational, seam, trims, no poles                             | zone formula             |
| —   | Polynomial prism; lens (two trimmed polynomial faces, rational pcurves); plate with a hole (`FACE_BOUND`); mirrored and rotated copies | Exact polynomial volumes, holes, `det < 0` transforms       | closed forms             |
| V5  | Elliptic puck: rational elliptic band, planar bottom, **trimmed bicubic deck with a fitted pcurve** (integration)                      | The board's three-patch topology; honest uncertainty        | `πab·h` (planar variant) |
| V6  | Full sphere with poles                                                                                                                 | Stretch: documents OCCT's handling of degenerate pole edges | `4/3 πr³`                |

**Harness.** `src/**/*.occt.test.ts`, run by `vitest.occt.config.ts` (single fork,
`testTimeout: 60_000`); one kernel per file, freed with `releaseSince(checkpoint())`;
init ≈ 0.13–0.2 s, small solids import in 0.01–0.2 s. STEP files go to
`packages/geom/.occt-corpus/` and CI uploads them.

### 15.4 Fallback

1. Stay on the verified 5.3.5 pin; bump deliberately after re-running this protocol.
2. **pythonocc-core** (conda-forge, native OCCT, LGPL) in a separate CI job running the
   same protocol in Python, with per-sub-shape `BRepCheck_Analyzer` statuses,
   `ShapeAnalysis_ShapeTolerance`, and `BRepGProp` with an epsilon (adaptive).
3. Local diagnosis with headless FreeCAD: `Part.read(f).check(True)`.
4. Always on regardless: `checkBrep`, `readStepSubset`, the arity table and the
   bitwise round trip.
5. Never vendor the WASM into git. Worth upstreaming: exposing GProp's epsilon.

---

## 16. Oracle catalogue

Every public function has an oracle better than "it ran". `ε` = `Number.EPSILON`
(2.2e-16); "scale" = the bounding-box diagonal of the control net; "rel" = relative.
Each tolerance states why it is that size; each test file includes at least one
check verified to fail when the code is deliberately broken. Randomised tests use the
seeded `mulberry32` and print the failing seed. Cross-cutting tests: public-API list
(`index.test.ts`), no tolerance literals, immutability (checksum of every input before
and after every public operation), finiteness of every output, `*Into` kernels equal
their wrappers bit for bit.

| Module                | Oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tolerance and why                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- |
| `basis`               | P&T Ex. 2.3 (`U = {0,0,0,1,2,3,4,4,5,5,5}`, p = 2, u = 5/2 → 1/8, 6/8, 1/8) and Ex. 2.4 derivatives; Bézier knots give Bernstein polynomials in closed form; A2.4 vs A2.2                                                                                                                                                                                                                                                                                                                                                                                                     | `4(p+1)ε` absolute: A2.2 sums p + 1 terms of O(1) relative error. Book examples exact in binary fractions: bitwise.                                                                                                                                     |
| `basis` (properties)  | Partition of unity, non-negativity, derivative sums 0; `findSpan` vs linear scan incl. `u = b` and every multiplicity, both sides                                                                                                                                                                                                                                                                                                                                                                                                                                             | `4(p+1)ε`; spans exact.                                                                                                                                                                                                                                 |
| `book/curve`, `curve` | Bézier vs closed-form Bernstein sum and its exact derivatives; rational circle (A7.1, 9-point and periodic 8-point): `\|C(t) − c\| = r`; ellipse as affine image; affine invariance                                                                                                                                                                                                                                                                                                                                                                                           | Radius `64 ε r`: ~10 flops and one division per coordinate; a wrong weight errs ≥ 1e-3 r. Bernstein `64 ε · scale · p!` for derivatives.                                                                                                                |
| `curve` (derivatives) | Central differences with Richardson extrapolation inside spans; one-sided derivatives at C⁰ knots equal the split halves' end derivatives; multi-span rational: A7.1 arcs of 1–4 segments against the half-angle closed form to C‴, both sides of every knot                                                                                                                                                                                                                                                                                                                  | 1e-8 rel for C′, C″ and C‴ (truncation ~h⁴ ≈ 1e-12, cancellation ~ε/h² ≈ 2e-10 at h = 2⁻¹⁰ of the span), relative to the local `max(\|C⁽ᵏ⁾(t)\|, \|C⁽ᵏ⁻¹⁾(t)\|/span)`; one-sided: `1e-13 · scale`; closed form: `64 ε · M · ρ^(k+1) · p!/(p−k)! / h^k`. |
| `curve-measure`       | Circle curvature `1/r`, length `2πr`; parabola curvature `2/(1+4x²)^{3/2}`, length `x√(1+4x²)/2 + asinh(2x)/4`; ellipse curvature; `paramAtLength(lengthAtParam(t)) = t`                                                                                                                                                                                                                                                                                                                                                                                                      | Curvature `1e-12` rel (two derivative evaluations, one division); length `10 · quadRel` rel (GK estimate is not a bound: 10× margin); inverse `paramRel`.                                                                                               |
| `curve-ops`           | Shape invariance under insert, refine, elevate, split, reverse∘reverse, reparameterise, `toClamped`, Bézier decomposition, at 1,000 params and every knot; counts `m = n + p + 1`; P&T Ex. 5.1 (insertion) fixtures; eq. 5.36 Bézier elevation closed form; `makeCompatible` keeps shapes; periodic middle-period consistency                                                                                                                                                                                                                                                 | `1e-13 · scale`: each op is convex combinations (~ε per step) chained ≤ 100 times; book fixtures bitwise where exact in binary.                                                                                                                         |
| `surface`             | Rational sphere (A8.1): radius `r`; torus: points on the torus; cylinder; plane; `z = xy` bilinear; cone from a revolved line; Bézier patches vs the closed-form Bernstein double sum with the quotient rule written out (to second order); linear precision (Greville nets reproduce `(u, v, uv)` on random knots); vs A2.4 summed over the net; partials vs Richardson differences; one-sided partials at a C⁰ knot line vs the Bézier halves; invariance under A5.1 per row/column; iso-curve equals the surface at the fixed parameter; boundary curve equals the net row | `64 ε r` for radii; Bézier `64 ε · M · ρ^(k+l+1) · (2p)^k (2q)^l`; iso (`u` fixed) bitwise, (`v` fixed) and boundary `1e-14 · scale` (same arithmetic re-associated); FD `1e-8` of the local scale; insertion `1e-13 · scale`.                          |
| `surface-measure`     | Sphere `k₁ = k₂ = −1/r`, `K = 1/r²`; torus `k = −1/r` and `−cos v/(R + r cos v)`, `K = cos v/(r(R + r cos v))`, directions along meridian and parallel; cylinder `(0, −1/r)`, zero direction along the axis; plane 0; `z = xy`: every form coefficient, `K = −1/(1+x²+y²)²`; paraboloid, saddle and elliptic paraboloid (graph formulas); Weingarten `L = −Su·n_u` … vs differences of the normal; Euler's theorem; `limitNormal` at sphere poles = ±axis                                                                                                                     | `1e-12` rel: second derivatives of rational patches lose ~3 digits to the quotient rule. Normals `1e-13`; directions `1e-10` (eigenvector error ~ rounding/gap); FD `1e-8` of the local scale, step resolving `κ·                                       | Su  | `.  |
| `plan`                | `evalSurfacePlan` = `surfaceEvalInto` bitwise; dirty update after random edits = full re-evaluation bitwise; touched set = brute-force support; `planMatches` false after insertion                                                                                                                                                                                                                                                                                                                                                                                           | Exact: same arithmetic in the same order.                                                                                                                                                                                                               |
| `quadrature`          | GL nodes vs Abramowitz–Stegun tables; exact on monomials to degree `2n − 1`; adaptive vs closed forms (∫ rational, ∫ √, ∫ with a kink at a break)                                                                                                                                                                                                                                                                                                                                                                                                                             | Nodes `4ε`; monomials `4nε` rel; adaptive `10 · quadRel` rel.                                                                                                                                                                                           |
| `primitives`          | Exactness above; `conicArc` ρ = 0.5 is a parabola; ρ vs eccentricity; `revolve` of a line is a cone with the right half-angle                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `64 ε · scale`.                                                                                                                                                                                                                                         |
| `fit`                 | Interpolation passes through the data; **polynomial reproduction** (data from a degree-≤ p polynomial gives that polynomial); end derivatives exact; periodic interpolation C^(p−1) at the seam; LSQ optimality (normal-equation residual) and agreement with dense QR; constraints exact; **convergence** of error ∝ h^(p+1) fitting sin and circle data                                                                                                                                                                                                                     | Data `1e-12 · scale` (collocation condition ~10–100); reproduction `1e-10 · scale` (normal equations square it); constraints `constraint`; convergence slope within ±0.3 of p + 1.                                                                      |
| `solver`              | **Holladay:** knots at the data sites, `bend` only on shape ⇒ the natural cubic spline (reference path); planar data ⇒ plane with zero energy; DOF rules bitwise (`===`) where §10.3 says so; `offsetFrom` neighbours keep the apex normal within `angle`; target = current ⇒ x unchanged; range-space vs `solveFairReference`; KKT stationarity; rigid-motion equivariance; mirror-symmetric input ⇒ symmetric output; separable and coupled paths agree; dependent and inconsistent rows reported with the right indices                                                    | Range-space vs reference `1e-9` rel (Schur path error ~cond·ε ≈ 2e-10 at cond 10⁶ after scaling); residual `constraint`; bitwise where stated.                                                                                                          |
| `project`             | Points built as `S(u*, v*) + d·n` with `\|d\| < 1/κ_max` on sphere, cylinder, torus project to `(u*, v*)` at distance `\|d\|`; circle: radial foot; random points vs dense sampling + Newton brute force; `converged` honest                                                                                                                                                                                                                                                                                                                                                  | Parameter `1e-12` rel of the domain; distance `point`; brute force agreement `1e-9 · scale`.                                                                                                                                                            |
| `curve-on-surface`    | `v = const` on a cylinder is an exact circle; chain-rule derivatives vs finite differences; `isoLinePcurve` exact; fitted pcurve and 3D edge: reported `maxDeviation` / `maxError` honest against 4× denser sampling                                                                                                                                                                                                                                                                                                                                                          | Exact cases `64 ε · scale`; FD `1e-8` rel; honesty: dense max ≤ reported × 1.01 and reported ≤ `fit` when `withinTolerance`.                                                                                                                            |
| `trim`                | Trimmed disc area `πr²`; square with circular hole `a² − πr²`; rejects CW outer (re-oriented with warning), self-intersection, open loops, holes outside; `classifyUV` vs winding number                                                                                                                                                                                                                                                                                                                                                                                      | Areas `10 · quadRel` rel (rational pcurves) or `1e-13` rel (polynomial: exact rule); classification exact (exact predicates).                                                                                                                           |
| `predicates`          | Exact BigInt determinant sign on random, 1-ulp-perturbed, cocircular and large-offset inputs; fixed CCW triples give > 0                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Exact sign.                                                                                                                                                                                                                                             |
| `cdt`                 | Every constraint present; every triangle strictly CCW; local Delaunay on unconstrained edges (exact incircle); symmetric half-edges; Euler `T = 2V − B − 2 + 2H`; area sum = shoelace; differential vs `delaunator` (general position: same triangle sets) and `constrainautor` (unique CDT: same edge sets) on 10⁴ seeded cases; adversarial: points on segments, collinear chains, 1-ulp near-duplicates, cocircular grids, slivers                                                                                                                                         | Exact; area `1e-12` rel (summation).                                                                                                                                                                                                                    |
| `tessellate`          | Chord error ≤ `chordTol` at centroids and edge midpoints (by projection); shared edge vertices bitwise identical across faces; Euler characteristic 2 (lens, cylinder) and 0 (torus); mesh volume converges at O(h²)                                                                                                                                                                                                                                                                                                                                                          | Chord as stated; watertight exact; convergence ratio 3.5–4.5 per halving.                                                                                                                                                                               |
| `integrate`, `mass`   | Polynomial prism (exact rational volume), lens `πabh`, sphere `4/3 πr³`, torus `2π²Rr²`, cylinder with trimmed caps `πr²h`, plate with hole `(4L² − πr²)t`, spherical cap area `2πrh`; polynomial volume unchanged from n to n + 5 GL points; translation by 100 cm leaves volume unchanged; flipped orientation negates it                                                                                                                                                                                                                                                   | Polynomial `1e-12` rel (exact rule, ~10³ summed terms); rational `10 · quadRel` rel; translation `1e-12` rel.                                                                                                                                           |
| `continuity`          | Two planes hinged at θ: angle θ; plane tangent to a cylinder: G1 with mismatch exactly `1/r`; a patch split by knot insertion: zeros; a deliberate gap δ reads δ; lens rail dihedral `cos φ = (4h²/a² − 1)/(4h²/a² + 1)`; `knotContinuity` on designed C⁰/C¹/C²/G1 joins (G1 with speed ratio ≠ 1 is G1, not C1)                                                                                                                                                                                                                                                              | Angles `1e-12` rad; gaps `point`; mismatch `1e-12` rel.                                                                                                                                                                                                 |
| `brep`                | Euler on the corpus; defect-injection catalogue (§13) all detected; `edgeGaps` equal independently sampled deviations                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Exact; gaps `1e-12 · scale`.                                                                                                                                                                                                                            |
| `step`                | `readStepSubset(writeStep(b))` bitwise equals `b`; byte-identical output for the same timestamp; Part 21 lexical rules (reals contain `.`; strings escaped); no dangling or unused ids; complex sub-entity order; arity table; **OCCT protocol (§15) on the corpus**                                                                                                                                                                                                                                                                                                          | Bitwise; OCCT checks as in §15.3.                                                                                                                                                                                                                       |

---

## 17. Benchmark targets

`packages/geom/src/*.bench.ts`, run by `pnpm --filter @openshaper/geom bench` (not part
of `pnpm test`), printing their own table as `packages/store/src/perf.bench.ts` does.
Numbers, with machine details, go into the Phase 1 report and the branch's
`QUALITY_REPORT.md`. A missed target is reported, not failed; once numbers exist CI
may fail a regression of more than 2×.

| #   | Benchmark                                                       | Size                                                | Target (desktop Node 22)               | Grounding                          |
| --- | --------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- | ---------------------------------- |
| P1  | `curvePoint`, cubic polynomial                                  | 50 control points                                   | ≥ 10 M/s                               | B                                  |
| P2  | `curvePoint`, rational circle                                   | —                                                   | ≥ 5 M/s                                | B                                  |
| P3  | `curveEvalBatchInto`, 2nd derivatives, rational cubic           | 10k params                                          | ≤ 1.5 ms                               | A (0.5 ms) vs B (3 M/s): between   |
| P4  | `surfacePoint`, bicubic                                         | 40 × 20                                             | ≥ 2 M/s                                | B                                  |
| P5  | Point + normal + principal curvatures                           | bicubic 40 × 20                                     | ≥ 0.5 M/s                              | B                                  |
| P6  | `planSurfaceSamples`, `nDer = 2`                                | 5k samples, 64 × 8 net                              | ≤ 2 ms                                 | measured 1.64 ms                   |
| P7  | `evalSurfacePlan`: position, normal, k₁/k₂, rational            | 5k                                                  | ≤ 2 ms                                 | measured 1.33 ms                   |
| P8  | `evalSurfacePlanDirty`, one control point                       | 5k (≈ 6% touched)                                   | ≤ 0.15 ms                              | —                                  |
| P9  | `surfaceEvalGridInto` with normals                              | 64 × 64                                             | ≤ 1.5 ms                               | —                                  |
| P10 | Refine a bicubic with 40 u-knots; elevate a curve 3 → 5         | 40 × 20; 100 points                                 | ≤ 2 ms; ≤ 1 ms                         | B                                  |
| P11 | `interpolateCurve`; `interpolateSurface`                        | 200 points; 60 × 30                                 | ≤ 2 ms; ≤ 20 ms                        | B                                  |
| P12 | Thin-plate Gram assembly                                        | 64 × 8 bicubic                                      | ≤ 2 ms                                 | —                                  |
| P13 | `prepareFairSolver`: separable; coupled; coupled, many rows     | 512 cps m = 20; 1,536 DOF m = 20; 1,500 DOF m = 150 | ≤ 3 ms; ≤ 15 ms; ≤ 100 ms              | factor measured 0.32 / 9.9 / 55 ms |
| P14 | `solveFairInto` per move                                        | m = 20; m = 150                                     | ≤ 0.1 ms; ≤ 2 ms                       | O(n·m)                             |
| P15 | `approximateCurve` with constraints and fairness                | 2k points → 80 cps                                  | ≤ 3 ms                                 | —                                  |
| P16 | `approximateSurface` with fairness, 2 correction passes         | 8k points → 64 × 8                                  | ≤ 30 ms                                | —                                  |
| P17 | `projectPointsToSurfaceInto` warm; `closestPointOnSurface` cold | 1k points; bicubic 40 × 20                          | ≤ 2 ms; ≤ 20 µs mean                   | —                                  |
| P18 | `projectCurveToSurface`                                         | 60-span curve, `fit`                                | ≤ 30 ms                                | —                                  |
| P19 | `constrainedDelaunay`                                           | 5k + 400 segments; 20k + 1k                         | ≤ 5 ms; ≤ 40 ms                        | —                                  |
| P20 | `tessellateTrimmedSurface`                                      | ≈ 3k triangles; board-size at 0.005 cm              | ≤ 15 ms; ≤ 100 ms                      | —                                  |
| P21 | `retargetTessellation`, no flip                                 | ≈ 3k triangles                                      | ≤ 0.5 ms                               | —                                  |
| P22 | `massProperties`                                                | 3 trimmed faces, `quadRel`                          | ≤ 50 ms                                | A 20 / B 100                       |
| P23 | `writeStep`                                                     | board-size 3-face B-rep                             | ≤ 100 ms, file size at both precisions | existing writer ≈ 0.5 s incl. fit  |
| P24 | Allocation                                                      | 10k simulated drag frames                           | no GC beyond `cw` copies               | —                                  |

**First measurements (F2, `src/eval.bench.ts`).** On the session's 4-vCPU cloud
container (Node 22.22; a plain loop runs ~1.4 ns per multiply-add and a small typed
array costs ~1.5 µs to allocate, several times a desktop) every P1–P9 target was
missed, under `vitest bench`: P1 0.31 M/s, P2 0.31 M/s, P3 9.1 ms, P4 0.27 M/s, P5
0.18 M/s, P6 8.5 ms, P7 6.5 ms, P8 0.36 ms (5.5% touched), P9 1.8 ms. The same code
run as a plain Node script: P3 5.1–6.9 ms, P7 4.4 ms, P6 4.7–5.3 ms. P1/P2/P4/P5 call
allocating wrappers, which create a scratch per call: on this machine that allocation
dominates. Re-measure on the reference desktop before acting on tier-2 options (§9).

---

## 18. Build order

Phase 1 can run alongside Phase 0: geom is a new package with no source coupling to
any existing one, and it touches shared files only additively (`eslint.config.mjs`,
`pnpm-lock.yaml`, `NOTICE.md`, the branch's `ci.yml`). Each step lands as its own
commit(s) with its oracles, and leaves `pnpm lint`, `pnpm typecheck` and `pnpm test`
green.

**Step 0 — scaffold (this commit).** Package skeleton, `types.ts`, `index.ts`, public
API test, ESLint layer, lockfile entry, this document.

**Foundation** (both tracks wait for it):

- **F1 Curves.** `tolerance.ts`, `errors.ts`, `array.ts`, `vec.ts`, `quadrature.ts`;
  `book/basis.ts`, `book/curve.ts`, `book/periodic.ts`; `basis.ts`; `curve.ts`;
  `curve-measure.ts` (curvature, arc length); curve primitives (line, polyline,
  circle and arc, periodic circle, conic); the `testing` subpath (`mulberry32`,
  `checksum`, random bases and curves); no-magic-tolerance and immutability tests.
  `book/refine.ts` starts here with A5.1 only, which `clampUnclamped` (§6.3) needs;
  A1 adds the rest.
- **F2 Surfaces.** `book/surface.ts`; `surface.ts` (incl. exact iso and boundary
  curves); `surface-measure.ts`; `plan.ts` (sample plans and dirty evaluation);
  surface primitives (plane, bilinear, Bézier patch, revolve, sphere, torus,
  cylinder, extrude); the `bench` script and P1–P9 (`src/eval.bench.ts`);
  `randomSurface` in `testing`.

**Track A — fitting and solving:**

- **A1 Knot operations.** `book/refine.ts`; `curve-ops.ts`, `surface-ops.ts`
  (insertion, refinement, elevation, split, sub-curve, reverse, reparameterise,
  `toClamped`, Bézier decomposition, periodic unroll/extract); `makeCompatible`;
  `ruled`; P10.
- **A2 Fitting.** `linalg/dense.ts`, `linalg/banded.ts`; `book/fit.ts`; `fit/`
  (parameterisation, knot placement, A9.1 with end derivatives, periodic
  interpolation, A9.4, constrained LSQ for curves and surfaces with adaptive knots
  and parameter correction, `skinCurves`); P11.
- **A3 Solver and fairness.** `linalg/rcm.ts`, `linalg/envelope.ts`; Gram and
  fairness matrices; DOF map; `prepareFairSolver` / `solveFairInto` /
  `fairInfluenceInto`; `solveFairReference` in `testing`; the `fairness` option of the
  A2 fitters; P12–P16, P24.

**Track B — geometry on surfaces and export:**

- **B1 Projection and curves on surfaces.** `project.ts` (curve, surface, batches with
  warm start); `curve-on-surface.ts` evaluation and chain-rule derivatives;
  `isoLinePcurve`; P17. Pcurve **fitting** is not here (see integration).
- **B2 Trimmed surfaces, CDT and quadrature.** `mesh/predicates.ts` (vendored,
  `NOTICE.md`), `mesh/cdt.ts`, `mesh/refine.ts` (5-day timebox, §12); `trim.ts`;
  `mesh/tessellate.ts` (incl. retarget); `integrate.ts` (Green's theorem, area);
  devDependencies `delaunator` and `@kninnug/constrainautor`; P19–P21.
- **B3 Continuity.** `continuity.ts`.
- **B4 B-rep, STEP and the OCCT validator.** `brep/` (make, check, orient, transform,
  mass, watertight mesh); `step/` (writer, schema, subset reader in `testing`);
  analytic solids V1–V4 and the extra corpus in `testing/solids.ts`; devDependency
  `occt-wasm@5.3.5`, `vitest.occt.config.ts`, `test:occt`, the branch's `ci.yml` step;
  Path B, then Path A (`toOcctBrepText`), then the mutation suite; P22, P23. Its first
  deliverable is V1 (box) end to end, to de-risk the tooling early.

**Cross-track dependencies.**

- B2 needs A1's `decomposeBezier` (trim curves split where they cross surface knot
  lines). A1 is the first Track A step, so it is ready before B2 if both tracks start
  together; otherwise B2 starts with polynomial pcurves split by sampling + bisection
  and switches when A1 lands.
- B4 needs A1's `toClamped` (periodic seams in STEP and B-rep edges) and `subCurve`.
- **Fitting 3D edge curves from pcurves needs Track A and lands at integration:**
  `curveOnSurfaceTo3d` (3D edge from a pcurve's image) and `projectCurveToSurface`
  (same-parameter pcurve from a 3D curve) both need A2's LSQ fitting on top of B1's
  projection. Until then Track B builds only solids with exact edges and pcurves
  (iso-lines, rational circles), which V1–V4 are.

**Integration** (after both tracks): `projectCurveToSurface`, `curveOnSurfaceTo3d`;
V5 (elliptic puck with a fitted bicubic deck pcurve, honest uncertainty flowing into
STEP); skinned and fitted surfaces through the B-rep, STEP and OCCT; P18; the full
benchmark table recorded; the Phase 1 report (numbers, measured OCCT caveats, no
divergences expected since geom has no classic counterpart).

---

## 19. Exit criteria, consumers, risks

**Exit** (plan §6): every §16 oracle green at its stated tolerance; V1–V5 accepted by
the §15 protocol (V6 documented); §17 numbers recorded; `git diff` against `main`
shows no change under `packages/{kernel,io,units,store,render2d,render3d,export,ui}` and
`apps/`, and their tests and snapshots are unchanged.

**What the API is shaped for:**

| Phase | Needs                                                             | API                                                                                        |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2     | Rail band: periodic u, clamped v, apex row at full v-multiplicity | `makeSurface`, `knotsFromBreaks`, `offsetFrom` keeps the G1 apex                           |
| 2     | Conic rail profiles (D5)                                          | `conicArc`, rational throughout                                                            |
| 2     | Profiles blended along the rail                                   | `makeCompatible`, `skinCurves` (periodic)                                                  |
| 2     | Deck and bottom trimmed by rail rows                              | `projectCurveToSurface`, `makeTrimmedSurface`                                              |
| 2     | Specs; converter                                                  | `massProperties`; `approximateSurface` with fairness and correction                        |
| 3     | Incremental editing and analysis                                  | plans, `principalCurvatures`, `edgeContinuity`, `fairInfluenceInto`, per-point `stiffness` |
| 4     | Exports                                                           | `writeStep`, `tessellateBrep`, arc length and sampling for DXF/PDF                         |
| 5     | Concave tails                                                     | periodic loops with full-multiplicity knots; multi-lobe trim loops                         |
| 6     | Asymmetric boards                                                 | the DOF map without mirror rules                                                           |

**Risks.**

1. Trimmed joins are exact only to the pcurve fit (≈ 1 µm) unless board2 builds deck
   and bottom to contain the rail curve exactly; geom makes the gap explicit
   (`edgeGaps`, STEP uncertainty, continuity profile), and the mesh stays watertight
   (§11.5).
2. OCCT heals silently and its default volume is coarse: the protocol is built round
   both (§15).
3. `occt-wasm` is young with one maintainer: exact pin, protocol re-run before any
   bump, pythonocc fallback.
4. Parametric fairness bias: the scaled metric (§10.2).
5. CDT robustness: exact predicates, fuzzing, differential oracles, vendoring fallback.
6. Periodic seams in third-party importers: `splitPeriodicFaces` and the manual
   matrix.
7. Sphere poles in STEP: out of scope (V6 stretch).

---

## 20. References

- L. Piegl, W. Tiller, _The NURBS Book_, 2nd ed., Springer 1997 (chapters 2–9, 12).
- N. Patrikalakis, T. Maekawa, _Shape Interrogation for Computer Aided Design and
  Manufacturing_, Springer 2002, §2.3.
- W. Welch, A. Witkin, _Variational surface modeling_, SIGGRAPH '92.
- J. Nocedal, S. Wright, _Numerical Optimization_, 2nd ed., ch. 16.
- G. Golub, C. Van Loan, _Matrix Computations_, 4th ed., §4.3, §5.2.
- A. George, J. Liu, _Computer Solution of Large Sparse Positive Definite Systems_,
  1981 (RCM, envelope Cholesky).
- D. Gunderman, K. Weiss, J. Evans, "High-accuracy mesh-free quadrature for trimmed
  parametric surfaces and volumes", _Computer-Aided Design_ 141 (2021).
- R. Piessens et al., _QUADPACK_, 1983 (Gauss–Kronrod tables).
- J. R. Shewchuk, "Adaptive precision floating-point arithmetic and fast robust
  geometric predicates", _DCG_ 18 (1997).
- S. W. Sloan, "A fast algorithm for generating constrained Delaunay
  triangulations", _Computers & Structures_ 47(3) (1993).
- M. de Berg et al., _Computational Geometry_, 3rd ed., ch. 9.
- ISO 10303-21, -42, -214; CAx-IF Recommended Practices; OCCT "BRep Format".
- `occt-wasm` (`github.com/andymai/occt-wasm`), `robust-predicates`, `delaunator`,
  `@kninnug/constrainautor`.
