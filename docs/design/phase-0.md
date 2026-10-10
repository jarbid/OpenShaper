# Phase 0 — improvements to the current app

Status: **approved** (2026-10-10), in progress.

Phase 0 is the part of the geometry plan that applies to the app as it is today.
Every item stands on its own and is worth shipping whether or not the geometry
overhaul is ever adopted. The overhaul itself — a new NURBS geometry core and
board model — is planned and built on the `experiment/nurbs-overhaul` branch
(`docs/design/geometry-overhaul.md` there) and is not merged into `main` unless it
is adopted after testing.

## Inputs

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

## Where the current architecture stands

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

## The items

Each item is its own commit and must pass the full CI gate (`pnpm lint`, `typecheck`, `test`,
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

Chords (decided): **hold R + arrows** rotates, **hold T + arrows** changes
length; Shift multiplies either step by 10. Hold-key modes avoid both platform
traps: Ctrl+←/→ is taken by macOS (desktop switching), and Alt+←/→ is
Back/Forward in browsers on Windows and Linux. The modes are listed in
`shortcuts.ts`, and so on `/docs/shortcuts`.

### 0.4 Tension ("fullness") drag — done

Shipped in #75 as **Tunni controls** (View ▸ Tunni controls): drag the line
between a segment's handles, or its diamond, to change both at once.

### 0.5 Slices never change the outline, rocker or deck (Jörg's first request)

Decided as a rule, not a setting. The outline and the side profile (rocker
and deck) define the blank, the way a shaper hot-wires the side profile and then
cuts the outline. Slices refine that blank and always sit inside it.

- A slice's two centre points are locked: they always sit on the bottom and the
  deck.
- The slice's widest knot (the apex) moves only vertically, so the slice keeps the
  outline's width.
- No control point of a slice can be dragged wider than its apex.
- `propagateCrossSectionToCurves` no longer runs on slice edits. The two-way link
  (`docs/superpowers/specs/2026-06-04-two-way-thickness-rocker-link-design.md`) is
  superseded.
- Outline, rocker and deck are edited only in their own views.

This changes editing behaviour on purpose, so the store characterization snapshot
may change; any change is justified in the commit, never accepted with
`vitest -u` alone.

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
  measured against (on the experiment branch).

### 0.8 Deviation map against the ghost board

When a ghost (reference) board is loaded, a 3D mode colours the hull by signed
distance to the ghost, measured in each station plane to the ghost's section at the
same x. Both boards share the tail-at-x=0 rule, so this needs no alignment step.
Diverging palette, legend in display units, adjustable ± band; beyond the ghost's
length is shown as "no data". A pure kernel function plus a render attribute.
Serves Jörg's point that board development is evolutionary and changes must be
measurable.
