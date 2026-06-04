# Two-way thickness ↔ rocker link — design

## Problem

Cross-sections are currently slaved one-way to the rocker/deck/outline. Every edit runs
through `commit()` → `adjustCrossSectionsToThicknessAndWidth` (`packages/store/src/board-store.ts`),
which rescales each interior cross-section so its **center thickness** (`deck-center −
bottom-center`) matches `getThicknessAtPos(x)` and its **width** (`2·maxX`) matches
`getWidthAtPos(x)` at the station. So editing a section's centerline thickness or width
"snaps back" — the rocker/deck/outline own those scalars.

Goal: make the link **bidirectional** — editing a section's centerline/width drives the
rocker/deck/outline at that station — while keeping shapes **clean by default** with light
guardrails, and **never blocking** sharp steps, wings, or zigzag edges.

## Scope (agreed)

- **Centerline + width only** drive back to the curves:
  - bottom-center point (section knot index 0) → **bottom** rocker at `x`
  - deck-center point (section last knot) → **deck** curve at `x`
  - section **maxX** (widest rail point) → **outline** (half-width) at `x`
- All other foil/rail/apex points stay **local** to the section (no propagation).
- Deck vs bottom is split by _which_ centerline endpoint moved (drag deck-center up → deck
  rises, bottom untouched), not by redistributing the thickness change.

## Design

### Hook point

Add a reverse pass that runs in `commit()` **before** `adjustCrossSectionsToThicknessAndWidth`,
and only when the just-edited target is a `crossSection`. It propagates the edited section's
changed centerline/width onto the curves; then the existing adjust pass re-syncs the _other_
sections. The edited station no longer snaps back because the curve now agrees with it.

### Propagation rule (delta-based, exact)

Given the edited section at position `x`, compare against the pre-edit board:

- Δ in the section's bottom-center y → `setValueAt(bottom, x, bottom(x) + Δ)`
- Δ in the section's deck-center y → `setValueAt(deck, x, deck(x) + Δ)`
- Δ in the section's half-width (`maxX`) → `setValueAt(outline, x, outline(x) + Δ)`

Only quantities that actually changed (beyond an epsilon) propagate, so a foil-only edit
propagates nothing.

### Curve-update mechanism: `setValueAt(spline, x, targetY)` (kernel, pure)

A Bézier knot's endpoint lies _on_ the curve, so:

1. If a knot's `end.x` is within `X_TOL` of `x` → retarget: set that knot's `end.y = targetY`
   (and shift its tangents by the same Δy so local shape is preserved).
2. Otherwise insert a knot at `x` (shape-preserving split at the parameter where the curve's
   x equals `x`) and set its `end.y = targetY`.

Inserted knots default to **smooth/continuous** tangents (clean curve). Sharp features are
opt-in: toggling the resulting curve knot to a **corner** (existing control) yields a hard
step/wing/zigzag. Nothing blocks that.

### Guardrails (clean by default, not restrictive)

- New knots are smooth by default → ordinary edits keep the rocker faired.
- Repeated edits at the same station **retarget** the existing knot (the `X_TOL` merge)
  rather than stacking near-coincident knots.
- Sharp features remain fully available via the corner toggle.

### Undo

Propagation happens inside the same `commit`, so a section drag and its rocker/outline
change form a single undo step (drag grouping via `beginEdit`/`endEdit` already does this).

## Files

- `packages/kernel/src/board.ts` (or a small new module): `setValueAt(spline, x, targetY)`
  pure helper; reuse existing `valueAt`, segment/`t`-at-x lookup, and the de Casteljau split
  used by `addControlPoint`.
- `packages/store/src/edits.ts`: `propagateCrossSectionToCurves(prev, next, target)` that
  diffs the edited section vs `prev` and applies `setValueAt` to bottom/deck/outline.
- `packages/store/src/board-store.ts`: in `commit()`, when the edit target is a cross-section,
  run the propagation pass before `adjustCrossSectionsToThicknessAndWidth`. (The committer
  already knows the edited target via `editSpline`.)

## Testing

- `setValueAt`: hits `valueAt(result, x) === targetY` exactly, both retarget and insert paths;
  shape away from `x` preserved within tolerance; monotonic-x splines stay valid.
- Propagation (store): dragging deck-center raises `getDeckAtPos(x)` by Δ with bottom
  unchanged; bottom-center drives `getRockerAtPos(x)`; widest point drives `getWidthAtPos(x)`;
  a foil-only edit leaves all three unchanged.
- Round-trip stability: edit rocker → section follows → edit the section's thickness back →
  rocker returns near the original (no runaway drift); the adjust pass converges.
- Undo reverts the section **and** the curves together in one step.

## Out of scope

- Redistributing a thickness change between deck and bottom (we move only the dragged side).
- Unifying section stations with curve control points (the "shared CP" model) — heavier
  refactor, not needed for this behavior.
