# Geometry overhaul — and what the current app gets first

Status: **proposal** (2026-10-10). Nothing here is approved or scheduled yet.

This combines three planning rounds into one document: the geometry-library
assessment, the concave-tail / asymmetric architecture, and the constrained
control-point editing research. It splits the work in two:

| Track                    | Where it lives                      | What it is                                                                                                                                                         |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Phase 0**              | `main`, one PR per item             | Fixes and upgrades to the app **as it is today**. Each item stands on its own and is worth shipping whether or not the overhaul is ever adopted.                   |
| **Phases 1–6**           | a long-lived experiment branch (§5) | The architecture overhaul: a new NURBS geometry core and board model, built beside the current one. **Never merged into `main` until the adoption decision (§7).** |
| **Phase 7** (if adopted) | `main`                              | Migration: the new engine replaces the old one.                                                                                                                    |

## 1. Inputs

- **Jörg Schobert** (MSc maths, six years on parametric windsurf-board surfaces;
  works with a shaper on Shape3D). B-splines over cubic Béziers; smooth flow
  slice to slice, which interpolation between slices does not give; nose and tail
  slices are where quality is lost. Asked for an **apex curve** with slice points
  **locked to it** (a locked point moves only vertically, so a slice can never
  change the outline), a **rail point** separating bottom from deck (exports and
  CNC depend on it), **keyboard control** of points with modifiers that restrict a
  move to handle rotation or handle length, and ideas from **font tools** (Tunni
  lines). Also: an architecture overhaul.
- **Ben Fowler** (shaper, came from BoardCAD): batwing tails render wrong in 3D
  though the PDF is right; wants to **scale a finished design**; asked about 3D
  export for CNC.
- **UI review**: tools are hard to find, and there is no good way to explain them
  without cluttering the editor with fine text. A tooltip layer that can be turned
  on and off was suggested.
- **Product goal** (Jared): a professional surfboard design tool built on exact CAD
  geometry. Outline, rocker and cross-sections connected where they meet; rail
  apex and tuck lines parting the deck from the bottom; concave tails with real
  edge control; asymmetric boards; constrained 3D editing with visible blending.

## 2. What the current architecture can and cannot do

Measured against the code, not assumed:

- **STEP already exists.** `packages/kernel/src/bspline-surface.ts`,
  `board-surface.ts` and `packages/export/src/step.ts` write a closed solid
  bounded by true B-spline surfaces in pure TypeScript, about 50× smaller than the
  STL and confirmed as one solid in Rhino 8 (`docs/design/step-export.md`). The
  overhaul therefore does not need a CAD kernel to reach STEP.
- **Station creases.** `loftSection` blends adjacent stations linearly in x, so
  the hull has a tangent break at every cross-section; the STEP fit keeps those
  breaks on purpose so that STEP matches STL. This is Jörg's "flow from slice to
  slice" complaint, and no sampling change can remove it.
- **Slices drive the curves.** `propagateCrossSectionToCurves`
  (`packages/store/src/edits.ts`, called from `board-store.ts`) pushes a slice's
  width and centre changes onto the outline, rocker and deck. Deliberate
  (`docs/superpowers/specs/2026-06-04-two-way-thickness-rocker-link-design.md`),
  and the opposite of what Jörg asks for.
- **No explicit apex or tuck line.** The outline is effectively the projected
  apex; there is no stored parting line.
- **Tips.** `MIN_DIM` floors width and thickness at 0.5 cm, so pointed ends carry
  a small false flat.
- **One notch only.** `outline-cutout.ts` models exactly one tail notch and says
  so; a batwing produces a wrong mesh (Ben's report). Every exporter builds one
  half and mirrors it, so asymmetric boards are out of reach without restructuring.
- **Analysis.** The 3D view's zebra / curvature / slope modes run on mesh normals
  averaged from faces; "curvature" is `fwidth(N)` in screen space, so it changes
  with zoom and triangle size and cannot distinguish a smooth join from a
  curvature break.

## 3. Decisions behind the overhaul

### 3.1 Geometry library: extend our own core

| Option                       | Verdict                                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencascade.js (official)    | Last stable release v1.1.1 in 2020; full build ~9 MB brotli. Dormant.                                                                                                                                                                                                                        |
| occt-wasm                    | Current (OCCT 8.0.1), ~4.5 MB brotli, TypeScript API, worker-friendly; WASM is LGPL-2.1. Young. **Used as a CI-only validator** (§6, Phase 1), never shipped.                                                                                                                                |
| brepjs                       | Apache-2.0 layer over occt-wasm; still in development. Same trade-off as OCCT.                                                                                                                                                                                                               |
| verb-nurbs                   | Haxe-generated, stale. Rejected.                                                                                                                                                                                                                                                             |
| openNURBS / rhino3dm         | Not a modelling kernel. Possible later for `.3dm` export.                                                                                                                                                                                                                                    |
| **Own pure-TypeScript core** | **Chosen.** Keeps the kernel pure and immutable (undo keeps working), adds nothing to the offline precache, and the hard part — how a board is controlled — is product logic no library supplies. We already own interpolation, evaluation, boundary extraction and a validated STEP writer. |

OCCT stays out of the editing loop because its objects need manual freeing (at odds
with immutable boards and a 200-step undo history), it would add 4–9 MB to an
offline app, and every drag would cross the WASM boundary.

### 3.2 Board topology: a rail loop with trimmed deck and bottom

Slices at fixed x cannot control a notch, where the rail runs across the board,
and mirroring halves cannot make an asymmetric board. The overhaul's model:

1. **The rail is a closed loop.** The **apex curve** is one closed 3D curve all
   the way round the board, into and out of every notch. The **tuck line** is a
   second closed loop inset from it. **Rail profiles are defined at stations along
   the rail, perpendicular to it**, and blend along it. This also helps standard
   boards: the nose and tail tips are where x-slices fail.
2. **Deck and bottom are surfaces over the plan view, trimmed by the rail**:
   smooth B-spline height fields spanning the full width. Outline = the apex
   curve's plan projection; rocker = the bottom along the stringer; thickness =
   deck − bottom; cross-sections = planar cuts with points locked to the curves.
   Vee and concaves are bottom features, not slice shapes.
3. **Always full width; symmetry is a constraint.** Symmetric (default) mirrors
   every edit; asymmetric removes the link. No separate code path.

Three patches per board — **deck** (stringer to the deck edge of the rail),
**rail band** (around the loop: deck edge → apex → tuck), **bottom** (tuck to
stringer) — sharing their boundary curves, so the solid is watertight by
construction. Considered and rejected: untrimmed multi-patch Class-A layouts (a new
hand-built patch layout per tail type) and SubD / T-splines as the master geometry
(§3.4).

### 3.3 Editing model

- **Master curves are control-point rows.** The apex is a row of the rail band
  with full knot multiplicity, so the surface passes exactly through that row's
  curve: rail edits move other rows and can never shift the outline. The rows
  either side of the apex may only move vertically relative to it, which keeps
  the tangent vertical and the apex the widest point. Rocker and deck line are
  rows where possible; elsewhere (e.g. under a smooth concave crossing the
  stringer) they are exact linear constraints held by the solver.
- **The solver.** Constrained least squares with a fairness energy (Welch &
  Witkin, _Variational surface modeling_, SIGGRAPH '92): drag a handle, the
  constraints stay exact, the rest of the surface stays fair. A small linear
  system, real-time in TypeScript.
- **3D rail handles.** One handle per rail station, each axis locked to the rail's
  local frame: slide along the rail; in/out and up/down for the upper and lower
  rail rows; tuck edge slides along the tuck line with a 0–1 **edge hardness**
  (SubD's crease sharpness as a shaper control). The apex itself is edited only
  through the outline and apex-height curves.
- **Four kinds of weight**, each with its own control:

  | Weight                | Controls                                                          | Set by                                                                                         |
  | --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
  | Falloff               | How far one edit spreads along the board, nose-ward and tail-ward | Distances fore and aft (cm) and a falloff shape while dragging                                 |
  | Ease between stations | How one rail station fades into the next                          | Bézier handles on keys in a **rail-law graph editor** (apex height %, fullness, edge hardness) |
  | Blend bulge           | How the deck rolls into the rail and the rail into the bottom     | One value per join, varying along the board                                                    |
  | NURBS rational weight | Rail profile fullness via a conic's rho                           | The fullness lanes, if rational rails are adopted (D5)                                         |

- **Layers.** Laws generate the rail band; direct control-point edits are stored
  as offsets in the rail's local frame and survive later law changes. Bottom
  concaves and channels are feature layers (precedent: Shape3D X's "3D layers").

### 3.4 Techniques assessed and not adopted as geometry

- **SubD (Catmull–Clark).** Push-pull feel and free topology, but control points
  do not lie on the surface (exact mm dimensions become indirect) and star points
  are only G1 — Rhino's own `ToNURBS` documentation notes that forcing G2 there adds
  bulges or dents. Boards would get star points at the nose, tail tips and notches.
  Adopted instead: its interaction ideas (cage-style handles, crease sharpness,
  soft falloff).
- **T-splines.** Local refinement inside NURBS; the core patent (US 7,274,364) is
  listed as expired in 2024. Heavy to implement and the same dimension-control
  problem. Kept as a fallback if local detail is ever needed.
- **Hierarchical B-splines (THB, LR).** Local detail for deep concaves or
  channels; complex. Later, only if bottom features need it.
- **Cage / lattice deformation.** Moves everything inside the cage, outline
  included. At most a "bend the whole board" tool.

### 3.5 Analysis displays

Exact per-vertex normals, principal curvatures and surface coordinates computed
from the NURBS surfaces in the tessellation worker, passed to the shader:

| Display                                     | Shows                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Zebra (exact normals, adjustable stripes)   | Unbroken stripes = smooth joins; kinks = tangent breaks               |
| Rail radius map (min curvature radius, mm)  | Where the rail is tightest, in shaper units                           |
| Gaussian / mean curvature                   | Domes vs saddles; concave and vee show as a sign change               |
| Draft angle relative to vertical            | The apex at 0° (CNC parting line) and undercuts under tucked rails    |
| Level lines                                 | Concave depth in equal height steps (matches Shape3D)                 |
| **Influence gradient** (live)               | How far each part of the surface moves while you hover or drag        |
| **Station dominance**                       | Which rail-law key controls each region, colours mixing as keys blend |
| Normals along a curve                       | Needles along the apex, tuck or a station — not the whole surface     |
| Join continuity readout                     | Gap, tangent angle and curvature mismatch along each join             |
| Deviation from the ghost board (signed, mm) | What changed between versions, and by how much                        |

B-spline control points have local support, so each vertex's dependence on the
control points is computed once and a drag only updates the vertices it touches —
the incremental-update rule from `.claude/CLAUDE.md`.

## 4. Phase 0 — the current app (PRs to `main`)

Each item is one PR through the full CI gate (`pnpm lint`, `typecheck`, `test`,
`build`, both Playwright suites). User-visible features get their `/docs` entry
(`apps/web/src/docs/registry.ts` fails the build otherwise); new chords go in
`apps/web/src/shortcuts.ts`. Characterization snapshots stay unchanged unless the
item says otherwise. Order is a suggestion; items are independent.

**Explicitly out of Phase 0:** bat-tail detection, a "square tail" export and a
1:1 tail template. Batwing and other multi-notch tails are solved properly in
Phase 5 of the overhaul and nowhere else.

### 0.1 Make Resize findable

Ben asked for a way to scale a finished design; it exists. **Resize** is a
collapsed section in the Shape tab marked relevant to no view
(`apps/web/src/sidebar-sections.ts`, `relevantTo: []`).

- Add **Board ▸ Resize…** to the menubar (and so the command palette, which is
  derived from the menus): it opens the Shape tab with Resize expanded and the
  first field focused.
- A `/docs` section on resizing.
- Done when a test finds the menu item and the palette finds it by "resize" and,
  once 0.2 lands, by "scale".

### 0.2 Help layer and discoverability

- **"Show tips" setting** (Settings, persisted with `readStored`/`writeStored`,
  default on). Labels on icon buttons always show, as today, for accessibility;
  the setting governs the longer description only.
- **`Tooltip` gains an optional `description`**. It stays non-interactive and
  `aria-hidden`, as designed, so it carries no links. "Learn more" lives in a `?`
  link on sidebar section headers and in the palette, each pointing at a `/docs`
  route.
- **One help-text table** (e.g. `apps/web/src/help-text.ts`) keyed by control or
  command id: description, docs route, optional keywords, optional `addedOn` date.
  A test fails if an entry names a route missing from `DOCS_ROUTES`.
- **Command palette:** `MenuItem` gains optional `description` and `keywords`;
  the palette matches label + keywords, shows the description and groups by
  menu. Seed synonyms: scale/resize, litres/volume, slice/cross-section,
  tuck/rail, template/starter.
- **Find-it test:** every menu action has a help entry, enforced like
  `coverage.test.ts`.
- **"New" badge** for entries whose `addedOn` is within 60 days. No analytics.
- No new UI library: the existing `Tooltip` already positions, delays and handles
  touch and focus.

### 0.3 Keyboard nudging with modifiers (Jörg)

Arrow-key nudging exists (`ControlPointInspector.tsx`) but returns early on any
modifier. Add:

- **Shift** — 10× the step.
- **Rotate** — turns the selected handle, or both handles of a selected point,
  by an angle step, keeping its length. Disabled on a locked handle (the lock
  fixes its angle).
- **Length** — lengthens or shortens the handle, keeping its angle.

The chords are open (decision D1). Constraints: Ctrl+←/→ is taken by macOS
(desktop switching) and cannot be overridden; Alt+←/→ is Back/Forward in browsers
on Windows and Linux, so `preventDefault` must be verified in Chrome, Firefox and
Safari before shipping. Default proposal: **Alt/Option+←/→ rotate, Alt/Option+↑/↓
length**, falling back to hold-a-key modes (hold R + arrows to rotate, hold T +
arrows for length) if the browser check fails. All chords go in `shortcuts.ts`,
and so on `/docs/shortcuts`.

### 0.4 Tension ("fullness") drag

`docs/design/curve-editing.md` §5, item 1: drag the curve between two points and
both inner handles lengthen or shorten along their current directions — Tunni
lines without new handles on screen, the line and its percentage shown on request.
A pure edit in `packages/store/src/edits.ts`, lock-aware, one undo step. This is a
cubic-Bézier tool, so it belongs to the current app; the overhaul's equivalent is
the fullness law.

### 0.5 Locked slices (Shape3D style, Jörg's first request)

New setting under **Editing behaviour**: "Slice edits change outline and rocker".

- **On** (today's behaviour): unchanged, including `propagateCrossSectionToCurves`.
- **Off**: a slice's centre points are locked to the rocker and deck; the widest
  knot (the apex) moves only vertically; an edit that would make the slice wider
  than the outline at that station is clamped. Outline, rocker and deck are edited
  only in their own views.

The default is open (D2). With the default on, the characterization snapshots do
not change; new tests pin the locked behaviour.

### 0.6 Apex line guide

The rail apex — each station's widest point — as a 3D guide toggle next to
Stringer and Sections (`packages/kernel/src/guides.ts`, `render3d/Guides3D.tsx`),
as an apex-height overlay in the rocker view (as Shape3D shows it), and as an
`APEX` layer in the profile DXF. It is where a CNC flips the blank. Computed from
`loftRing`, per lobe inside a notch (`crossSectionLoops`); `tessellate.ts` is not
touched.

### 0.7 Exact curvature shading

- Add second derivatives to `bspline-surface.ts`.
- In the tessellation worker, on demand when the mode is selected, compute
  principal curvatures on the existing STEP fit (`fitBoardSurface`, 0.5–0.9 s per
  board) and render that surface's own tessellation (within 0.15 mm of the loft).
- Modes: mean, Gaussian, and minimum radius in display units. While dragging,
  show the last result dimmed and recompute when the edit settles.
- The screen-space mode is renamed honestly ("Normal change (approx.)") and stays
  as the fallback for concave tails, which the fit does not support.
- Expected and intended: **bands at every station position.** Those are the
  current loft's real tangent breaks. This becomes the baseline the overhaul is
  measured against (§7).

### 0.8 Deviation map against the ghost board

When a ghost (reference) board is loaded, a 3D mode colours the hull by signed
distance to the ghost, measured in each station plane to the ghost's section at the
same x. Both boards share the tail-at-x=0 rule, so this needs no alignment step.
Diverging palette, legend in display units, adjustable ± band; beyond the ghost's
length is shown as "no data". A pure kernel function plus a render attribute.
Serves Jörg's point that board development is evolutionary and changes must be
measurable.

## 5. The experiment branch

- **Name:** `experiment/nurbs-overhaul` (D4). Created from `main` when Phase 1
  starts.
- **Never merged into `main`** before the adoption decision. Kept current by
  merging `main` into it (merge commits, never a rebase or force-push), at least
  after every Phase 0 PR lands.
- **Isolation.** New code lives in new packages — `packages/geom` (pure NURBS
  core) and `packages/board2` (the v2 board model) — with the same purity rules
  and ESLint layering as `kernel`. Existing packages change only additively, and
  the app wiring sits behind a flag, so merges from `main` stay clean and the
  classic engine's golden fixtures and characterization snapshots stay unchanged.
- **In the app:** the classic engine stays the default. The branch adds
  "Engine: NURBS (experimental)" (Settings, or `?engine=nurbs`). Boards convert on
  open. In experimental mode, saving writes `.board.json` v2, clearly marked, and
  never silently overwrites a classic file.
- **CI:** the branch's own `ci.yml` adds the branch to `on.push.branches`; that
  edit exists only on the branch. Full gate on every push.
- **Testing in a browser:** a Cloudflare preview build of the branch.
  Non-production branch builds are a dashboard setting this repo cannot see, so
  enabling them is a manual step. Check that preview hosts do not send analytics
  into the production project.
- **Each phase ends with a short report:** numbers, screenshots, and what diverges
  from the classic engine and why.

## 6. Phases 1–6 (experiment branch)

### Phase 1 — the NURBS core (`@openshaper/geom`)

The beginning of the overhaul. Pure, dependency-free, no board concepts yet.

- Knot vectors and spans; B-spline and NURBS curves (open, closed / periodic,
  rational weights from the start); derivatives to second order; arc length;
  curvature.
- Tensor-product surfaces: evaluation with derivatives to second order, normals,
  principal curvatures, isoparametric and boundary curves.
- Knot insertion and refinement, degree elevation, making curves compatible (a
  common knot vector).
- Fitting: interpolation and least-squares approximation with point and tangent
  constraints.
- Constrained least-squares solver with a thin-plate fairness energy; benchmarked
  at ~500 control points.
- Curves on surfaces; closest point and projection.
- Trimmed surfaces: trim loops in parameter space; tessellation by constrained
  Delaunay triangulation (implement, or adopt a vetted MIT/BSD library — decided
  in this phase); Gauss–Legendre quadrature over trimmed domains for area and
  volume (divergence theorem).
- Continuity measures along shared edges: gap, normal angle, curvature mismatch.
- A minimal B-rep and STEP writer for trimmed and rational faces, to de-risk
  export early.
- **CI-only validation:** `occt-wasm` as a dev dependency reads our STEP output
  and runs OCCT's validity check. Its API for this is confirmed first, with a
  fallback if it is not exposed. It never ships to users.
- **Oracles:** analytic cases (exact rational circle, sphere and torus; known
  curvatures; trimmed disc area; sphere and torus volumes; constructed G1/G2
  joins), convergence tests, recorded benchmarks.

**Exit:** all tests green at stated tolerances; the validator accepts the
analytic solids; benchmark numbers recorded; zero diff in every existing
package's tests and snapshots.

### Phase 2 — board model v2 (`@openshaper/board2`)

- Full-width board with the symmetry constraint.
- Closed apex loop and tuck loop; rail band with apex and tuck as control-point
  rows (vertical-tangent constraint at the apex); trimmed deck and bottom; rocker
  and deck line as rows or exact solver constraints.
- Rail laws: keys with ease handles for apex height %, upper and lower fullness,
  and edge hardness.
- Offset layer (rail-local frame) and bottom feature layers.
- **Standard tails only.**
- Converter from the classic `BezierBoard`, so every existing board and sample
  file opens.
- Specs (length, width, thickness, volume, area, centre of mass) from the
  surfaces.

**Exit:** the three golden boards and every sample file convert; a deviation
report against the classic engine (surface distance, spec deltas) with each
difference explained; a volume convergence test.

### Phase 3 — editors and analysis (behind the flag)

- Plan view as a closed outline with mirroring; rocker and deck views; sections
  as planar cuts with locked points.
- Rail-law graph editor.
- 3D rail handles locked to the rail frame, with keyboard nudging on the same
  chords as 0.3.
- Soft falloff with distances fore and aft and a falloff shape.
- Incremental mesh updates from per-vertex basis weights.
- The analysis displays of §3.5; Phase 0's exact curvature and deviation work is
  reused after merging `main`.
- Every edit a pure function through the store's `commit`, so undo works.

→ **Checkpoint A** (§7).

### Phase 4 — files and exports

- `.board.json` v2, share link v2, session restore.
- Import `.brd`, `.s3d`, `.s3dx` and `.srf` through the converter.
- `.brd` export lossy with a warning, refused for asymmetric and notched boards
  (D6).
- STEP with trimmed (and, if adopted, rational) faces; STL, DXF, PDF (the full
  outline when asymmetric), rail bands, fins.
- The manual STEP import matrix from `docs/design/step-export.md`.

### Phase 5 — concave tails

- **Tail: Standard / Notched** in Board info, with a number of tips (2 = swallow
  or fish, 3+ = batwing).
- A Tail panel: tip positions and spread, notch depth and shape, tip finish
  (sharp or radiused), and a notch rail profile set independently of the outside
  rail.
- Converting Standard → Notched is one undoable command.
- Starter templates: fish, swallow, batwing.
- Acceptance case: Ben's batwing. Ask him for the board file.

### Phase 6 — asymmetric boards

- **Symmetry: Symmetric / Asymmetric** in Board info. Asymmetric asks for stance
  (regular or goofy) and labels the rails toe and heel instead of port and
  starboard.
- Per-side outline and rail editing.
- PDF templates print the full outline, since half-and-flip fails.
- Fins already support asymmetric placement (`FinConfig.symmetrical`).
- Starter template: asymmetric.

→ **Checkpoint B** (§7): the adoption decision.

## 7. Checkpoints and test protocol

**Checkpoint A** (after Phase 3) decides whether to continue to tails and
asymmetry. **Checkpoint B** (after Phase 6) decides adoption.

**Boards:** the three golden boards (shortboard, funboard, longboard), a board
with the `80-20-hard` rail, a fish or swallow, Ben's batwing (B only) and an
asymmetric test board (B only).

| Area        | Pass condition                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accuracy    | Converted boards within 1 mm of the classic spec panel in length, width and thickness; surface deviation mapped, with differences only where the classic engine has station creases or tip floors, each one explained. |
| Surface     | Exact curvature and zebra show no bands at station positions (compare Phase 0.7's baseline); the apex join is G1 (normal deviation ≤ 0.1°); the tuck join is as designed.                                              |
| Control     | Editing rails never changes the outline or rocker (automated test plus manual check); numeric entry is exact; keyboard nudging works in 2D and 3D.                                                                     |
| Export      | STEP opens as one solid in Rhino 8, Fusion 360 and FreeCAD (and SolidWorks if available), a 3 mm offset succeeds, volume within 1% of the spec panel; STL is watertight; a CAM toolpath generates.                     |
| Performance | Drag cost and render counts no worse than the classic engine on `apps/web/tools/perf/browser-perf.mjs` (desktop and throttled phone); no new runtime dependency; bundle size delta recorded.                           |
| Usability   | Jared plus one or two shapers (Jörg's shaper friend, Ben) complete set tasks: shape a rail in the tail, set edge hardness, make a swallow from a template, compare against a ghost.                                    |

**If adopted (Phase 7, on `main`):** the new engine replaces the classic one.
Golden fixtures are regenerated against the new oracles, with
`docs/specs/divergences.md` entries; characterization snapshot changes are
justified one by one; help text and `/docs` are written for the new tools;
saved boards, session restore and share links migrate; `docs/ROADMAP.md` is
updated.

**If not adopted:** the branch is tagged and archived. Phase 0 stands on its own.
Reusable pieces (for example the `geom` core) can be ported deliberately.
Batwing tails and asymmetric boards stay unsupported in the classic engine; the
fallback would be the multi-band loft deferred in `outline-cutout.ts`.

## 8. Open decisions

| #   | Decision                                                                       | Proposed default                                                        | Needed by |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------- |
| D1  | Chords for handle rotate / length                                              | Alt/Option+←/→ rotate, Alt/Option+↑/↓ length; hold-key fallback         | 0.3       |
| D2  | Default for "Slice edits change outline and rocker"                            | On (today's behaviour); revisit after shaper feedback                   | 0.5       |
| D3  | Where this document is committed                                               | Phase 0 section on `main`; the full document on the experiment branch   | now       |
| D4  | Experiment branch name; Cloudflare preview builds                              | `experiment/nurbs-overhaul`; previews enabled in the dashboard by Jared | Phase 1   |
| D5  | Rational (conic) rail profiles                                                 | Core supports rational from Phase 1; rail use decided in Phase 2        | Phase 2   |
| D6  | `.brd` as export-only and lossy                                                | Yes                                                                     | Phase 4   |
| D7  | Master copy: curve network plus layers, or free surface control points         | Curve network plus layers                                               | Phase 2   |
| D8  | Two control levels: rail laws plus direct offsets                              | Yes                                                                     | Phase 2   |
| D9  | Falloff units                                                                  | cm, separate distances fore and aft                                     | Phase 3   |
| D10 | First analysis displays                                                        | Influence gradient, rail radius map, deviation from ghost               | Phase 3   |
| D11 | Per-tip rocker and kick on concave tails; per-side bottom on asymmetric boards | Open                                                                    | Phase 5–6 |
| D12 | Default tip finish                                                             | Small radius, value set with shapers                                    | Phase 5   |

## 9. References

- `docs/design/step-export.md`, `docs/design/curve-editing.md`,
  `docs/design/sidebar.md`, `docs/specs/junction-constraints.md`.
- W. Welch, A. Witkin, _Variational surface modeling_, SIGGRAPH '92 —
  <https://www.ri.cmu.edu/publications/variational-surface-modeling>.
- Rhino `ToNURBS` (SubD to NURBS continuity) —
  <https://docs.mcneel.com/rhino/8/help/en-us/commands/tonurbs.htm>.
- Rhino `SoftEditSrf` (falloff distances, `FixEdges`) —
  <https://docs.mcneel.com/rhino/5/help/en-us/commands/softeditsrf.htm>.
- T-spline patent status — <https://patents.google.com/patent/US7274364>.
- Shape3D X features (multi-curve editing, curve locks, 3D layers, asymmetric
  designs) — <https://shape3d.com/Products/DesignPro.aspx>,
  <https://shape3d.com/Products/FromV8toVX.aspx>.
- occt-wasm — <https://github.com/lto-dev/occt-wasm>; opencascade.js releases —
  <https://github.com/donalffons/opencascade.js/releases>.
