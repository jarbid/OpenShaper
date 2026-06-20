# Junction constraints (control-point masks, slaves & tangent locks)

Authoritative legacy source:
`../boardcad-le/src/board/BezierBoard.java` — `setLocks()` (lines **1582–1639**) and
`checkAndFixContinousy()` (lines **1641–1675**), with the per-knot lock primitives in
`../boardcad-le/src/cadcore/BezierKnot.java`.

This spec captures the constraints the legacy applies to a board's control points so an
edit can never open a gap at a shared junction, never pull a tip off the centreline, and
never let a tangent fold back on itself. It is paired with pinning tests in
`packages/store/src/edits.test.ts` (describe block **"junction-constraint spec (legacy
parity pinning)"**) that record which of these the current web `enforceJunctions`
reproduces and which are still gaps.

> The legacy applies these via three mechanisms on each `BezierKnot`: **masks**
> (`setMask(x, y)`), **slaves** (`setSlave`), and **tangent locks**
> (`setTangentToPrevLocks` / `setTangentToNextLocks`). They are independent and all
> active simultaneously; an edit is filtered through whichever apply to the dragged point.

---

## Coordinate convention (IMPORTANT)

By repo convention and the actual geometry: **the TAIL is at `x = 0` and the NOSE at
`x = length`** (the board runs tail→nose with increasing x). The outline `knots[0]` is the
**tail** endpoint and `knots[last]` is the **nose** endpoint.

> **Discrepancy to fix:** `packages/kernel/src/board.ts` carries a stale comment (lines
> ~47 and ~55) that says "dummy zero-sections at nose (pos 0) and tail (pos length)" and
> "index 0 = nose dummy, last = tail dummy". That labelling is **inverted** — trust the
> geometry: `x = 0` is the tail, `x = length` is the nose. The legacy `setLocks()` code
> does not name nose/tail; it only uses `index 0` (smallest x = tail) and `index last`
> (largest x = nose), so the masks/slaves/locks below are stated by index and are correct
> regardless of the naming bug. The current web `enforceJunctions` likewise has comments
> calling `knots[0]` the "nose"; that naming is part of the same stale convention and is
> noted as a doc-only divergence (see "Divergences" below).

## Mask semantics (`BezierKnot.setMask`, `setControlPointLocation`)

`BezierKnot.java:89–104` — when a control point is dragged to `(x, y)`:

```
x_diff = (x - end.x) * mXMask
y_diff = (y - end.y) * mYMask
end, tangentToPrev, tangentToNext all += (x_diff, y_diff)
```

So a mask component is a **multiplier on the drag delta** for that axis:

- mask `= 1.0` → axis is **free** (full delta applied).
- mask `= 0` → axis is **locked** (delta zeroed; the point cannot move on that axis).

`setMask(x, y)` takes `(xMask, yMask)` in that order.

## Tangent-lock semantics (`BezierKnot.handleLocks`)

`BezierKnot.java:288–319`. A tangent handle being moved to `point` is clamped against the
**endpoint** `end = getPoints()[0]`:

| Lock          | Value    | Effect when set on a tangent                                                        |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| `LOCK_X_MORE` | `0x0001` | `if end.x > point.x: point.x = end.x` (handle x cannot go **below** the endpoint x) |
| `LOCK_X_LESS` | `0x0010` | `if end.x < point.x: point.x = end.x` (handle x cannot go **above** the endpoint x) |
| `LOCK_Y_MORE` | `0x0100` | `if end.y > point.y: point.y = end.y` (handle y cannot go **below** the endpoint y) |
| `LOCK_Y_LESS` | `0x1000` | `if end.y < point.y: point.y = end.y` (handle y cannot go **above** the endpoint y) |

`setTangentToPrevLocks` / `setTangentToNextLocks` **replace** the lock word;
`addTangentToPrevLocks` / `addTangentToNextLocks` **OR** new bits in.

## Slave semantics (`BezierKnot.setSlave`, `updateSlave`)

`BezierKnot.java:106–112, 278–286`. When knot A has knot B as its slave, moving A:

1. snaps B's **endpoint** to A's endpoint exactly (`B.end = A.end`), and
2. translates B's two tangents by A's drag delta (`B.tangentToPrev/Next += (x_diff, y_diff)`).

The endpoints are thereby kept **coincident**; the handles move rigidly with the master.
`setSlave` itself immediately calls `updateSlave` with the current endpoint difference, so
attaching a slave snaps it onto the master at attach time too (`BezierKnot.java:278–286`).

---

## Constraints applied by `setLocks()`

`setLocks()` runs only when the outline has ≥ 2 control points (`BezierBoard.java:1584`).
`ajustCrossSectionThickNess` below is
`BoardCADSettings.getInstance().getAdjustCrossectionThickness()` (`:1599`).

### JC-1 — Outline endpoints fully locked (masks)

**Given** a board outline spline,
**when** `setLocks()` runs,
**then** both endpoints get `setMask(0, 0)`:

- `BezierBoard.java:1588` — `outline.controlPoint(0).setMask(0, 0)` (tail endpoint).
- `BezierBoard.java:1589` — `outline.controlPoint(last).setMask(0, 0)` (nose endpoint).

Both axes locked → **outline tip endpoints cannot be dragged at all**.

### JC-2 — Deck endpoints x-locked, y-free (masks)

**Given** the deck spline,
**when** `setLocks()` runs,
**then** both endpoints get `setMask(0, 1.0)`:

- `BezierBoard.java:1591` — `deck.controlPoint(0).setMask(0, 1.0f)`.
- `BezierBoard.java:1592` — `deck.controlPoint(last).setMask(0, 1.0f)`.

x locked (tips stay at their longitudinal station), y free (tip height editable).

### JC-3 — Bottom endpoints x-locked, y-free (masks)

**Given** the bottom (rocker) spline,
**when** `setLocks()` runs,
**then**:

- `BezierBoard.java:1594` — `bottom.controlPoint(0).setMask(0, 0)` then
- `BezierBoard.java:1596` — `bottom.controlPoint(0).setMask(0, 1.0f)` — the second call
  **overwrites** the first, so `controlPoint(0)` ends at `(0, 1.0)` (the `:1594` line is
  dead — a legacy quirk worth preserving knowledge of, not behaviour).
- `BezierBoard.java:1597` — `bottom.controlPoint(last).setMask(0, 1.0f)`.

Net: bottom endpoints are `(0, 1.0)` — x locked, y free, same as the deck.

### JC-4 — Cross-section endpoint masks depend on `adjustCrossectionThickness`

**Given** every cross-section (including the dummies),
**when** `setLocks()` runs,
**then** the section's first and last control points get
`setMask(0, ajustCrossSectionThickNess ? 1 : 0)`:

- `BezierBoard.java:1602` — `controlPoint(0).setMask(0, adjust ? 1 : 0)`.
- `BezierBoard.java:1603` — `controlPoint(last).setMask(0, adjust ? 1 : 0)`.

x is **always locked** (`= 0`) → section centre endpoints stay on the stringer
(`x = 0`). y is locked when `adjustCrossectionThickness` is **off** (sections keep their
height) and free when it is **on** (dragging the section's centre changes thickness).

### JC-5 — Deck↔bottom endpoints are mutually enslaved (shared tail & nose tips)

**Given** deck and bottom splines,
**when** `setLocks()` runs,
**then** their corresponding endpoints become each other's slave:

- `BezierBoard.java:1607` — `deck.cp(0).setSlave(bottom.cp(0))`.
- `BezierBoard.java:1608` — `deck.cp(last).setSlave(bottom.cp(last))`.
- `BezierBoard.java:1610` — `bottom.cp(0).setSlave(deck.cp(0))`.
- `BezierBoard.java:1611` — `bottom.cp(last).setSlave(deck.cp(last))`.

So the deck and bottom **share the same tail tip** (both at `x = 0`) and the **same nose
tip** (both at `x = length`): moving one endpoint moves the other to the identical point.
This is the closed-profile guarantee at the two ends of the board.

### JC-6 — Monotonic tangent-flow locks on outline / deck / bottom

**Given** outline, deck, and bottom,
**when** `setLocks()` runs,
**then** **every** control point on each of the three curves gets:

- `setTangentToPrevLocks(LOCK_X_LESS)` and
- `setTangentToNextLocks(LOCK_X_MORE)`.

Lines: outline `:1616–1617`, deck `:1624–1625`, bottom `:1630–1631`.

Effect (per the `handleLocks` table): the **toPrev** handle x can never exceed its
endpoint x (`LOCK_X_LESS`), and the **toNext** handle x can never fall below its endpoint
x (`LOCK_X_MORE`). The handles therefore always point "back" (−x) and "forward" (+x)
respectively, so the curve is **monotonic in x** (single-valued: one y per station) and
tangents cannot fold the curve back on itself.

### JC-7 — Outline first/last get an extra `LOCK_Y_MORE` tangent lock

**Given** the outline,
**when** `setLocks()` runs (after JC-6 has set the X locks),
**then**:

- `BezierBoard.java:1619` — `outline.cp(0).addTangentToNextLocks(LOCK_Y_MORE)`.
- `BezierBoard.java:1620` — `outline.cp(last).addTangentToPrevLocks(LOCK_Y_MORE)`.

`addTangent*` **OR**s the bit in, so cp(0).toNext = `LOCK_X_MORE | LOCK_Y_MORE` and
cp(last).toPrev = `LOCK_X_LESS | LOCK_Y_MORE`. `LOCK_Y_MORE` clamps the handle's y so it
cannot drop below the endpoint y — the outline tips sit on the centreline (`y = 0`), so
the first segment leaving the tail tip and the last segment arriving at the nose tip can
only depart **outward** (toward +y, positive half-width). This keeps the planshape from
inverting at the tips.

### JC-8 — Cross-section first/last get `LOCK_X_MORE` tangent locks

**Given** every cross-section,
**when** `setLocks()` runs,
**then**:

- `BezierBoard.java:1636` — `cs.cp(0).setTangentToNextLocks(LOCK_X_MORE)`.
- `BezierBoard.java:1637` — `cs.cp(last).setTangentToPrevLocks(LOCK_X_MORE)`.

The section's centre endpoints are at `x = 0` (stringer). `LOCK_X_MORE` keeps the
adjoining handle's x ≥ the endpoint x (≥ 0), so the rail curve leaves the centreline
toward +x and never crosses to the mirrored half. (Cross-section interior points get **no**
tangent locks.)

### JC-9 — Dummy nose & tail cross-sections

`crossSections` is sorted by position; **index 0 and the last index are zero-width dummy
sections** at the tail (`x = 0`) and nose (`x = length`) tips. The legacy treats the
dummies specially in interpolation: when sampling at or beyond a dummy it substitutes the
**first/last real** cross-section (`BezierBoard.java:803, 823, 1102`). `setLocks()` does
**not** exclude the dummies — JC-4 and JC-8 apply to them too — but because they have zero
width their endpoints already sit on the stringer.

> **Naming caveat:** the kernel's `board.ts` comment labels index 0 the "nose dummy" and
> the last the "tail dummy". Per the geometry convention above this is inverted: **index 0
> = tail dummy (x = 0), last = nose dummy (x = length)**.

---

## Constraints applied by `checkAndFixContinousy()`

`BezierBoard.java:1641–1675`. Walks every control point of outline, bottom, deck, and each
cross-section spline and reconciles its `continuous` flag with its actual tangent angles:

**Given** a control point with tangent-to-prev angle `pta` and tangent-to-next angle
`nta`,
**when** `checkAndFixContinousy(fixShouldBeCont, fixShouldNotBeCont)` runs,
**then** it is considered continuous iff

```
cont = abs( abs(PI - pta) - nta ) < 0.02      // BezierBoard.java:1663
```

`0.02` rad ≈ **one degree** of tolerance (legacy magic number). Then:

- if `cont && fixShouldBeCont` → `setContinous(true)` (`:1665–1668`).
- if `!cont && fixShouldNotBeCont` → `setContinous(false)` (`:1670–1673`).

This is an angle-based reconciliation, not a positional junction lock; the web port's
continuity is handled per-knot in `moveKnotTangent` / `setKnotContinuous` and is **out of
scope** for `enforceJunctions`. Recorded here for completeness; no web pinning test.

---

## What the current web `enforceJunctions` does (and does not) reproduce

`packages/store/src/edits.ts` → `enforceJunctions(b, changed?)`, applied by
`board-store.ts` after every edit and on load. It re-snaps positions only (it has no
mask/lock/slave machinery — the web kernel splines are immutable and locks are not modeled
yet). `JUNCTION_EPS = 1e-7`.

| Legacy constraint                                        | Web `enforceJunctions`                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JC-5** deck↔bottom shared tail+nose tips               | **Reproduced** — `joinTips` copies the `changed` curve's first+last endpoints onto the other (deck wins by default; bottom wins when `changed.kind === 'bottom'`). Positional only — `moveKnotEnd` translates the joined curve's tangents by the same delta, like the legacy slave.                |
| **JC-4 x-lock** section centre endpoints at `x = 0`      | **Reproduced** — every section's first+last endpoint is snapped to `x = 0` (y preserved).                                                                                                                                                                                                          |
| outline tail/nose endpoint stays on centreline (`y = 0`) | **Partially** — only the **`knots[last]`** outline endpoint (the **nose**, `x = length`) is snapped to `y = 0`; the **tail** (`knots[0]`, `x = 0`) is deliberately left free so wide/fish/square tails keep their tail-block width (see Divergences).                                              |
| **JC-1** outline endpoints fully locked (mask 0,0)       | **Partially** — the **station x** of both tips is re-snapped (tail → `x = 0`; the nose's x is the length reference) and the nose's **y** → `0`. The tail's **y** is left free by design (tail width). The legacy "fully un-draggable" mask (incl. tail y) is **not** modeled.                      |
| **JC-2 / JC-3** deck/bottom endpoint x-lock              | **Reproduced** — `lockEndpointsX` re-snaps deck & bottom tail endpoints to `x = 0` and nose endpoints to `x = length` (`getLength`, outline-derived); y preserved. A drag can no longer pull a deck/bottom tip off the board ends.                                                                 |
| **JC-4 y-lock** when `adjustCrossectionThickness` off    | **Not reproduced** — section endpoint y is never constrained; thickness-adjust mode is not modeled in junctions.                                                                                                                                                                                   |
| **JC-6** monotonic tangent-flow X locks                  | **Reproduced** — `clampMonotonicX` clamps each segment-driving handle so `toPrev.x ≤ end.x` and `toNext.x ≥ end.x` on outline / deck / bottom; the curve stays single-valued in x. Unused dangling handles (first `toPrev`, last `toNext`) are left alone, so it is a no-op on well-formed boards. |
| **JC-7** outline tip `LOCK_Y_MORE`                       | **Reproduced** — `clampHandleFloor` raises the outline tail `toNext.y` and nose `toPrev.y` to ≥ the tip y, so the tip segments depart the centreline outward and the planshape can't invert at the tips.                                                                                           |
| **JC-8** section endpoint `LOCK_X_MORE`                  | **Reproduced** — `clampHandleFloor` raises each section centre tip's inward handle to `x ≥ 0`, so the rail leaves the stringer toward +x and never crosses to the mirrored half. (Interior section points are unconstrained, per legacy.)                                                          |
| **JC-9** dummy nose/tail special-casing                  | N/A to `enforceJunctions`; dummies are handled in the kernel interpolation, not here.                                                                                                                                                                                                              |

## Divergences

These are documented gaps, **not** failing tests. The pinning tests assert what IS.
The behavioural gaps below are catalogued in `docs/specs/divergences.md` under
**"Known candidates (not yet diverged)"** (they are unimplemented behaviors, not
superseded golden values, so they carry no ledger table row yet — they get one once a
junction-lock layer is built and verified).

1. **Tangent locks not modeled (JC-6/JC-7/JC-8).** The web kernel is immutable and edits
   return whole new splines; there is no per-handle clamp on drag. Consequence: a tangent
   handle can be dragged to fold the curve back on itself, which the legacy prevented.
   Candidate for a future `enforceJunctions`/edit-time clamp.

2. **Endpoint masks not modeled (JC-1/JC-2/JC-3).** Tips are re-snapped positionally by
   `enforceJunctions` (only the axes listed in the table) rather than being un-draggable.
   The net closed-junction guarantee (JC-5 shared tips, sections on stringer) holds; the
   "can't move at all" mask is a stricter UX guard that is not yet ported.

3. **Only the nose (`knots[last]`) of the outline is pinned to `y = 0`.**
   `enforceJunctions` snaps the outline **nose** endpoint (`knots[last]`, `x = length`) to
   the centreline and leaves the **tail** (`knots[0]`, `x = 0`) free. The nose is the
   pointed tip whose half-width is 0; the tail may carry legitimate width (wide / fish /
   square tails). This is the **corrected** behavior: a prior inverted-naming bug pinned
   `knots[0]` (the tail) to `y = 0` while a comment mislabelled it the "nose", which forced
   tail width to zero. Fixed in `fix/junction-outline-tip-pin`; the choice (pin nose only)
   is recorded as a divergence-ledger row in `docs/specs/divergences.md` — it deliberately
   differs from legacy JC-1, which locks **both** outline tips (via mask, not just `y`).
   The full both-tip lock is deferred to the Stage B mask layer.

## Golden inputs / outputs to capture (future)

When a golden-data exporter runs the legacy kernel, capture for a representative `.brd`
(tail at x=0, nose at x=length):

- the outline/deck/bottom endpoint masks (expect `(0,0)`, `(0,1)`, `(0,1)` respectively);
- the deck/bottom endpoint coincidence after a tip drag (slave coupling): drag
  `deck.cp(0)` by `(dx, dy)` and record that `bottom.cp(0).end` equals the new
  `deck.cp(0).end`, and that each tangent translated by `(dx, dy)`;
- a tangent-fold attempt on the outline: try to drag `cp(i).toNext` to an x **below**
  `cp(i).end.x` and record that it clamps to `end.x` (JC-6);
- an outline tip tangent dragged below the centreline and record `LOCK_Y_MORE` clamping it
  to `y = end.y` (JC-7);
- `adjustCrossectionThickness` on vs off: section endpoint y-mask `1` vs `0` and the
  resulting drag behavior (JC-4).

These pin the legacy numbers the web port should match once locks/masks are modeled.
