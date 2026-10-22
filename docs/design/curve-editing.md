# Curve editing — handle-angle locks, and where curve editing goes next

Records the research behind the handle-angle lock (first proposed in
[#65](https://github.com/jarbid/OpenShaper/pull/65) by @CmdLnInt) and the design it
settled on, so the follow-ups listed at the end can be built against something concrete.

---

## 1. The problem

Shaping a curve is mostly two separate decisions per control point: which way the
curve leaves the point (the handle's **direction**) and how far it carries before
turning (the handle's **length** — how full the curve is). A free handle couples them:
any drag that changes the length also nudges the angle, so refining fullness keeps
undoing a direction that was already right. Shapers asked for a way to fix the angle
and work on the length alone.

## 2. What other tools do

- **Shape3d X** (the professional reference) puts the constraint on the point as a
  _tangent type_: continuous, angular (corner), vertical, horizontal, **continuous with
  fixed angle**, plus passive points. Its manual prescribes where each belongs —
  horizontal at the outline's wide point and the rocker's low point, angular at a
  slice's rail point, vertical at the slice apex. It also has "Smart Functions" (set
  the width / thickness / rocker at a station), multi-curve editing, a curvature
  display, and warnings for loops and superimposed points. Its learning curve is the
  common complaint.
- **AkuShaper** wins on approachability: set dimensions and nudge nose and tail rocker
  with the arrow keys without redrawing the board.
- **Font editors** separate direction from length with **Tunni lines** (FontLab): a line
  joining the two inner handles of a segment; dragging it lengthens or shortens both
  handles together, changing the segment's tension without turning anything.
- **Class-A CAD** (Rhino, Alias) judges fairness with the curvature comb: an unbroken
  comb across a point means curvature continuity (G2). Matching handle directions
  alone (G1) can still leave a visible flat spot.
- **Spiro / Hobby splines** (Raph Levien's thesis) place on-curve points only and solve
  the curve for continuous curvature: fair by construction, but non-local, and not
  exact cubic Béziers.

The common workflow in every surfboard tool is the same: template → main dimensions →
outline → rocker → deck and thickness → slices → check in 3D → export.

## 3. Decisions

1. **Bézier stays the stored geometry.** `.brd` files, the golden fixtures, every
   exporter and STEP export rely on cubic Bézier points with handles. New editing
   behaviour is a different way of _producing_ handles, never a different model, so a
   board moves between tools and file formats with nothing lost.
2. **A constraint lives on the point it constrains.** #65 first kept locks in a store
   list keyed by point index. Indices change under insert, delete and undo, so the
   list pointed at the wrong point after undoing an insert, forgot itself after a
   delete, and was invisible to every edit except a direct drag. Stored on the knot
   (`Knot.lock`, `packages/kernel/src/knot.ts`), the lock travels with undo, insert,
   delete, copy and save for free.
3. **A lock stores directions, not a flag.** A handle dragged onto its point has no
   direction left to read back; a stored unit vector survives that, and also makes
   horizontal and vertical locks the same thing as any other lock.
4. **One place enforces it.** Every edit that rewrites a knot goes through
   `replaceKnot` in `packages/store/src/edits.ts`, which runs `constrainToLock`:
   each locked handle is projected onto its direction (length = its reach along the
   direction, never negative). Drags, nudges, typed values and the junction
   constraints all respect the lock without code of their own. A few tools state
   their intent instead of being projected: Fair sets its lengths along the locked
   directions, Extend grows a collapsed handle along its lock, and Align turns the lock
   with the handles — which is how a handle is locked horizontal or vertical. The
   keyboard turn (hold R + arrows, `rotateKnotTangent`) leaves a locked handle where it
   is, and on a smooth point a lock on either handle holds both; the keyboard length
   step (hold T + arrows) works along the lock like the Length field.
5. **Projection, not distance.** The length is the cursor's reach _along_ the locked
   direction. A sideways drag leaves the length alone, and dragging back past the point
   collapses the handle instead of flipping it.
6. **The format change is additive.** `.board.json` writes `l` only on locked knots,
   so a board without locks serializes byte-for-byte as before, and the version stays
   2: an older build ignores `l` and opens the board unlocked. `.brd` has no such
   concept and drops it.
7. **Scaling transforms the lock.** A non-uniform scale (Resize, and the cross-section
   thickness/width adjust that runs on every commit) turns handles, so `scaleKnot`
   scales the lock's directions the same way, keeping lock and handle parallel.

## 4. What shipped

- Kernel: `Knot.lock` / `KnotLock`, `withHandles`, lock-aware `scaleKnot`.
- Store: `constrainToLock`, `setKnotLock`, `canLockKnot`, `setKnotTangentLength`, and
  lock-aware fair / extend / align / insert / delete; actions `setLocked` and
  `setTangentLength`, each one undo step.
- IO: the optional `l` field in `.board.json` (and so in share links and session
  restore).
- UI: the padlock in the pane header and the sidebar Control point section, Lock /
  Unlock in the right-click menu on a point or a handle, the `L` shortcut, a bar across
  each locked handle's line, and a Length field for a locked handle.
- Docs: `/docs/editing#locks`.

Later, keyboard turn and length (Phase 0 item 0.3, `docs/design/phase-0.md`): hold R +
arrows turns the selected handle, or both handles of a selected point, 1° a press
(`rotateKnotTangent`, store action `rotateTangent`); hold T + arrows changes their length
by one nudge step (`stepKnotTangentLength`, `stepTangentLength`); Shift makes any step
10×. Each press is one undo step. The rules that are easy to get wrong:

- **Direction on screen.** ← and ↑ turn counter-clockwise, → and ↓ clockwise, as seen.
  That is a positive angle in the spline's own x/y in every pane, with no per-view case:
  `worldToScreen` draws every spline y-up, a nose-up phone pane turns its canvas element
  a quarter turn (a rotation, never a reflection), and the mirrored halves (the outline
  below the stringer, a section's left side) are drawn copies with no control points, so
  a selected handle is always on the half drawn the right way round. Pinned in
  `packages/render2d/src/viewport.test.ts`; a pane that ever draws a spline mirrored
  must flip the sign for that pane.
- **Locks.** A locked handle never turns, and on a smooth point a lock on either handle
  holds both. Length still changes, along the lock.
- **Junctions.** A turn the junction pass would clamp (an outline or rocker handle past
  vertical, a tip handle across the centreline) is refused whole, so a turn always keeps
  the handle's length.
- **Length never loses a direction.** A step collapses a handle only when it can grow
  back the way it pointed (its lock, or opposite a smooth point's other handle);
  otherwise the handle stops at its last step above zero. A selected first or last
  point acts only on the handle its segment uses, never on the open spline's unused one.
- **Hold keys** (`apps/web/src/use-nudge-mode.ts`) are ignored in text fields and with
  Ctrl/Cmd/Alt, and end on their keyup (matched by `key` or by the `code` recorded at
  keydown, since Option changes the character), window blur, the tab being hidden, and
  Cmd's keyup (macOS drops the keyup of a key released under Cmd; so a Cmd chord such
  as undo ends the mode even with R still down). An arrow's auto-repeats carry on only
  in the mode its first press used, so letting go of R or T mid-repeat stops the turn
  rather than starting moves. The arrows do nothing while a `[data-modal]` dialog is open.

## 5. Next

Each builds on the stored lock.

1. **Tension ("fullness") drag.** Drag the curve between two points: both inner handles
   lengthen or shorten along their current directions — Tunni lines without new
   on-screen controls. Optionally show the Tunni line and its percentage on request,
   hidden by default: extra handles everywhere were the main objection to them.
2. **Auto points.** Handles solved so curvature is continuous through the point
   (a tridiagonal solve on runs of auto points; exact cubic Béziers out). Locked and
   corner points bound each run, so a change stays local.
3. **Simple mode.** Dimension-driven editing — width at a station, nose and tail width
   at 12", rocker, fullness — on the same Bézier data, following the template-first
   workflow above. Switching modes changes the controls, never the board.
4. **Shape3d tangent types on import.** Map `.s3d` "fixed angle", horizontal and
   vertical tangents to locks; `s3d-reader.ts` reads only the corner/smooth flag today.
5. **Hide control points** while a key is held, to judge a curve without its handles.
