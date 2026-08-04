# 3D guide overlays: stringer and cross-section locations

Date: 2026-08-04

## Problem

The 3D view shows a finished hull with no reference marks. You cannot see where
your cross-sections sit, and you cannot read the stringer profile — the two
things a shaper navigates by. Today the only spatial cue is a translucent cyan
plane through the _active_ cross-section, which answers "where am I editing" but
not "where is everything".

## Solution

Two independent toggles in `ThreeDControls`:

- **Stringer** — an amber line tracing the centreline plane's silhouette: the
  deck centreline nose→tail plus the bottom/rocker centreline back.
- **Sections** — a red ring around the hull at every real cross-section, with the
  active one drawn in brand cyan and thicker.

The existing "Section" plane toggle is removed. The cyan active ring inherits its
job, so cyan keeps meaning "where you're editing" consistently with the 2D panes
instead of introducing a second visual language.

## Approach

**`tessellate.ts` is not touched.** Not a rename, not an extracted helper,
nothing. It is the mesh hot path, it was the site of the crease bug fixed in
PR #24, and an overlay is not worth any risk to it.

That is possible because the loft surface is _continuous_.
`getInterpolatedCrossSection(board, x)` and `getRockerAtPos(board, x)` — both
already public — define the surface at every station, and the mesh is merely a
faceted sample of it. A ring computed at any `x` therefore lies on that surface
without sharing a line of code with the tessellator.

What the guides must share is not code but the **arc-length sampling
convention**: `pointByCurveLengthAt(spline, tt * total, total)`, also already
public, and the exact fix from PR #24. Segment-index sampling lands on different
physical points where neighbouring stations differ in knot count. That convention
is one function call, not a dependency.

The no-drift guarantee is kept by a _test_ rather than by shared code: read a
station's `x` straight out of a tessellated mesh, compute a guide ring at that
`x`, assert the two agree to a micron. That pins the relationship without
coupling the code, and fails loudly if either side's convention ever moves.

Rejected alternatives:

- **Export the tessellator's private `buildRing`.** Guarantees agreement by
  construction, but requires renaming a function and rewriting the station loop
  inside `tessellateBoard`. Modifying mesh generation to enable an overlay is a
  bad trade at any risk level.
- **Bake guide indices into `BoardMesh`.** Perfectly aligned and nearly free, but
  couples guide visibility to the tessellation worker and mesh cache — toggling a
  checkbox would retessellate, and `BoardMesh` would stop meaning "the surface".

## Components

### `packages/kernel/src/guides.ts` (new)

Pure, self-contained, built entirely on existing public kernel functions.

```ts
export interface GuidePoint {
  x: number;
  y: number;
  z: number;
}

crossSectionRing(board: BezierBoard, x: number, steps: number): GuidePoint[] | null
stringerLoop(board: BezierBoard, steps: number, ringSteps: number): GuidePoint[] | null
```

`crossSectionRing` walks the profile spline by fractional arc length up the +Y
rail, then mirrors back down the −Y rail, skipping the two shared centreline
points. Returns `null` for a missing or degenerate section.

`stringerLoop` samples stations along the length, takes each ring's deck
centreline point (`ring[half - 1]`) one way and its bottom centreline point
(`ring[0]`) back, and returns one closed polyline tracing the stringer plane's
silhouette. Stations are inset a hair from the tips, where the interpolated
section is null.

Stations whose centreline has been cut away by a tail notch (swallow / fish) are
skipped — there is no foam at y = 0 there for a line to lie on.

### Station selection

Section rings are drawn at `board.crossSections.slice(1, -1)` — real stations
only. Index 0 and the last index are nose/tail dummies; they are degenerate and
would render as dots. This is the same slice `App.tsx` already uses to build
`sectionMarkers`, so the 3D rings and the 2D pane markers always show the same
set.

### `packages/render3d/src/guide-lines.ts` (new)

Pure `board → polylines` builder: applies the station slice, closes each ring
into a drawable polyline, and marks which ring is active. Kept separate from the
component so add/remove-station behaviour is testable without rendering WebGL.

### `packages/render3d/src/Guides3D.tsx` (new)

Thin R3F wrapper, structured like `Fins3D`. Ring resolution comes from
`tessellationSteps(board, targetFaceSize).ringSteps`, so guides match the density
of the mesh they sit on.

Drawn with drei's `<Line>` (Line2/LineMaterial), which supports screen-space
pixel widths; raw `THREE.Line` is clamped to 1px on most drivers.

Z-fighting is handled with `polygonOffset` / `polygonOffsetFactor={-4}` /
`polygonOffsetUnits={-4}` — a depth-buffer bias, so the lines stay geometrically
exact rather than being displaced along a normal.

Colours:

| Guide          | Colour    | Width  |
| -------------- | --------- | ------ |
| Stringer       | `#F59E0B` | 2 px   |
| Section        | `#EF4444` | 1.5 px |
| Active section | `#22D3EE` | 2.5 px |

### Alignment

`meshToGeometry` calls `geometry.center()`, translating the mesh by its own
bounding-box centre. `Fins3D` compensates with a private `boardCenter(mesh)`
helper and a wrapping `<group position={offset}>`.

That helper is lifted into `geometry.ts` and imported by both `Fins3D` and
`Guides3D`, giving one definition of the board-space→scene-space transform.

This is why the removed `SectionPlane` could get away with approximating the
offset as `x - length/2` while a guide line cannot: a plane large enough to
overhang the board hides a centring error, a line lying on the surface does not.

### `apps/web`

- `View3DSettings`: `showSection: boolean` → `showStringer` + `showSections`.
- `ThreeDControls`: the single "Section" button becomes "Stringer" and
  "Sections". Both stay outside the `!compact` branch so the quad-view mini-pane
  gets them too.
- `Board3DViewProps`: drop `sectionX`; add `showStringer`, `showSections`,
  `activeSectionX`.
- `Board3DView`: delete `SectionPlane`, render `<Guides3D>`.
- `App.tsx`: `activeSectionX` is derived from `clampedCs` unconditionally (the
  toggle governs rendering, not derivation).

## Adding and removing cross-sections

The overlay must stay correct as stations are added and deleted, which is the
most likely source of a stale or crashing guide.

- **Recompute is automatic.** The kernel is immutable and swaps the `board`
  reference on every edit, so a `useMemo` keyed on `board` rebuilds the rings
  when a station is added or deleted — the mechanism `BoardMesh` and `Fins3D`
  already rely on.
- **Deleting the active station.** `csIndex` is raw state and is left pointing
  past the end, but `clampedCs` is re-derived each render as
  `min(max(csIndex, 1), max(1, sectionCount - 2))`. The cyan highlight therefore
  lands on a station that exists. No extra wiring is needed; this behaviour is
  pinned by a test rather than trusted.
- **Boards with no real stations.** `crossSections.length <= 2` makes
  `slice(1, -1)` empty: render no rings and no highlight. Notably this must not
  produce a `<Line>` with zero points, which drei mishandles.
- **Degenerate stations.** `crossSectionRing` returns `null`; those are filtered
  out, so one bad station cannot blank the whole overlay.
- **React keys are the station position**, not the array index, so inserting a
  station mid-list does not remount every ring after it.

## Persistence

`ViewState` gains an optional `view3d?: View3DSettings`, persisted in the existing
`bs.viewState` localStorage blob alongside `views2d` and `camera3d`. This fixes
reset-on-reload for all eight 3D settings, not only the two new ones.

`VIEW_STATE_VERSION` is **not** bumped. A bump discards every existing user's
saved 2D framing and camera pose, and buys nothing: the file's stated policy is
already "individually invalid fields are dropped rather than rejecting the whole
blob", which makes an added optional field backwards-compatible by construction.
Old blobs simply carry no `view3d` and receive defaults.

A `sanitizeView3D` helper validates each field against its allowed values,
falling back to the default per field rather than rejecting the object — the same
per-field policy `sanitizeView2D` and `sanitizeCamera` follow.

## Performance

Guides are roughly 5 rings × ~48 points, plus ~120 × 2 stringer points, memoised
on `(board, ringSteps)`. That is a rounding error next to tessellation, so it
stays on the main thread: no worker, no change to the "UI never blocks"
principle.

## Testing

**Kernel (`guides.test.ts`)**

- A guide ring lands on the mesh: tessellate a golden board, read ring 0's
  station `x` out of `mesh.positions`, and assert `crossSectionRing(board, x, n)`
  matches that ring's vertices to within a micron. This is the no-drift pin.
- `crossSectionRing` returns `null` rather than throwing for a degenerate board.
- `stringerLoop` returns points with `y ≈ 0` throughout, and `z` bounded by the
  rocker and rocker + max thickness.
- `stringerLoop` visits both surfaces rather than tracing one of them twice.
- `stringerLoop` returns `null` on a zero-length board.

**render3d (`guide-lines.test.ts`)**

- Rings appear only at real cross-sections; nose/tail dummies are skipped.
- Adding a station adds a ring; deleting one removes a ring.
- Ring keys are stable across an insert.
- The ring at `activeX` is marked active; no match yields no active ring.
- A board with no real cross-sections yields no rings.

**apps/web**

- `ThreeDControls` renders both toggles, in compact and full variants, and each
  patches only its own field.
- `clampSectionIndex` keeps the selection on a real station across add and
  delete.
- `view-state` round-trips `view3d`, falls back per field on garbage, and still
  restores a version-1 blob that predates the field.

## Documentation

Prose in the 3D-view section of `/docs/editing`, covering both toggles and what
the colours mean.

No `registry.ts` entry: `FeatureKind` has no case for view toggles, and the
coverage test's stale-entry assertion fails on ids it cannot enumerate from
source. Adding one would break the build.

## Known limitations

- A ring drawn at a station inside a swallow/fish tail notch traces through the
  cut-away area, because `crossSectionRing` is not cutout-aware (only
  `stringerLoop` skips notched stations). Real stations that far aft are unusual,
  and making rings cutout-aware means reproducing `tessellateCutout`'s clipping —
  far more change than this feature warrants.
- The stringer loop stops a fraction of a millimetre short of each tip, where the
  interpolated section goes null. Invisible at any usable zoom.

## Out of scope

- Clicking a ring to select that cross-section. Plausible follow-up; not needed to
  read the shape, and it would pull pointer-picking into the guide layer.
- Guides in the 2D panes. The 2D editors already draw station markers.
- Guides in exported STL/PDF output. These are viewport reference marks.
