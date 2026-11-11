# Rails along the board: the design workflow

Status: **proposal**. It describes how the trim-and-blend construction
(`docs/design/trim-blend-test.md`) would be edited, not what the app does today. A working
sketch of everything below exists as a single page outside the repo; it is described at the
end.

Frame as everywhere: cm, **tail at x = 0**, nose toward +x.

## What a designer edits

Five things, each independent of the others:

|                 | What it is                                           | Edited as                                     |
| --------------- | ---------------------------------------------------- | --------------------------------------------- |
| **Outline**     | The plan curve, with a radius on every corner        | Curve in the plan view; a radius per corner   |
| **Foil**        | Rocker and thickness along the stringer              | Curves in the profile view, as now            |
| **Panels**      | Deck crown; bottom contours (vee, concave, channels) | Laws along the board; bottom features, as now |
| **Rails**       | How the panels turn into each other at the outline   | **Rail keys along the outline** — this note   |
| **Fins, plugs** | Unchanged                                            | Unchanged                                     |

Sections stop being something the designer draws. A section is what you get when you slice
the board; it is a view, and an import path for classic files.

## A rail, as the designer sees it

A rail is seven numbers. Each one is a thing a shaper already has a word for.

| Number      | Meaning                                                  | Range in the sketch    |
| ----------- | -------------------------------------------------------- | ---------------------- |
| Band width  | How far in from the outline the deck starts to turn      | 10 to 55 mm            |
| Hardness    | How square the shoulder of the rail is                   | soft 0.35 to hard 0.93 |
| Tuck        | How far in from the outline the bottom starts to turn    | 2.5 to 45 mm           |
| Tuck shape  | Round tuck, or a flat bevel                              | 0.08 (bevel) to 0.93   |
| Bottom edge | The angle the rail leaves the bottom at. Zero is no edge | 0 to 45 degrees        |
| Apex height | Where the widest point sits between bottom and deck      | 8% to 60%              |
| Fullness    | How much of the stringer thickness reaches the rail      | 25% to 80%             |

Fullness belongs to the foil rather than the rail, but it is what makes a rail boxy or
pinched, so it travels with the others.

The common rails are settings of these numbers, and are kept as a named library:

| Rail              | What sets it apart                                                               |
| ----------------- | -------------------------------------------------------------------------------- |
| Soft, 50/50       | Wide band and tuck, apex at half height, no edge                                 |
| 60/40, 80/20      | The same, with the apex lower                                                    |
| Hard              | Tuck at its minimum, apex nearly on the bottom: the bottom runs flat to a corner |
| Tucked under edge | A bottom edge of 15 to 20 degrees, with a round tuck above it                    |
| Chine             | A bottom edge of about 30 degrees, with a flat tuck above it                     |
| Boxy, pinched     | High or low fullness                                                             |

A deck-side edge (a bevelled or chined deck) is the same mechanism on the other blend. The
generator carries it; it has no control yet.

## Rail keys and zones

**A rail key is a place on the outline that holds a rail.** Between two keys every number
moves smoothly from one rail to the other. That is the whole mechanism: there is no separate
"blend" object, and nothing switches from one kind of surface to another.

Three consequences make it usable.

- **A zone is two keys holding the same rail.** Between them the rail does not change.
  "Hard in the tail third, tucked under edge in the middle, 50/50 in the nose" is three zones,
  which is six keys.
- **A blend is the gap between two zones.** Its position is where the gap sits and its length
  is how wide the gap is. Dragging either end of the gap moves where one rail starts handing
  over to the next, or where it finishes.
- **An edge fades rather than stops.** Going from a hard or tucked rail to a soft one, the
  edge angle runs down to zero while the tuck opens up. The crease shallows and vanishes. No
  face appears or disappears, so the solid cannot break at a blend.

Keys live on the outline, measured by distance along it, not on stations. So the rail carries
on round a pin, down a notch wall and through the crotch, and the notch can hold its own rail.
A symmetric board shares its keys between the two sides; an asymmetric one unlocks them.

## Editing in 2D

**Rail map** — new. The outline laid out straight, tail to nose, as a strip of coloured zones
with the blends between them drawn as gradients. Drag a zone's end to move a blend. Tap a
zone to choose it, then pick a rail from the library or move its numbers. An advanced mode
shows one lane per number, with the keys as points on a curve, for anyone who wants to shape
how a single number travels.

**Section view** — the existing pane, with handles that mean something:

| Handle                 | Drag                           | Changes              |
| ---------------------- | ------------------------------ | -------------------- |
| Apex                   | up and down the outline wall   | Apex height          |
| Deck band edge         | in and out along the deck      | Band width           |
| Tuck edge              | in and out along the bottom    | Tuck                 |
| Shoulder of each blend | toward or away from the corner | Hardness, tuck shape |
| Bottom edge            | rotate                         | Bottom edge angle    |

Moving a handle at a station edits the key under it, or makes a key there if there is none.
The designer edits the rail where they are looking; the model stores it as a key.

**Plan view.** The deck band edge and the tuck line are drawn on the plan, the way a shaper
pencils rail bands on a blank. Both can be dragged. Keys show as ticks on the outline.

## Editing in 3D

- **Tap the board** to choose the zone under the tap and move the slice there.
- **Zone colours on the rail**, so where a blend starts and ends is visible on the board
  itself and not only in the map.
- **Drag a blend along the rail.** The ends of each zone are handles on the 3D rail.
- **A section gizmo** at the chosen key: the handles of the section view, standing in the
  plane of the slice, draggable in place.

2D and 3D are two views of the same keys. Nothing is edited in one that cannot be reached in
the other.

## Why it stays valid whatever the designer does

The rules below are enforced by the generator, not left to the designer.

- A band or tuck is never wider than 0.72 of the local half-width of the outline. Bands from
  opposite edges cannot cross, and tips become all rail by themselves.
- An edge's shoulder is kept below the apex. Asking for a steeper edge than fits just stops.
- The tuck has a minimum, so a hard edge is a very small blend, never a missing one.
- The faces are the same whatever the keys say: two trimmed panels and the rail strips.

In the sketch, 96 combinations were built and checked for a closed mesh: every rail type in
every zone on three tails, the blends dragged to both ends of the board and squeezed to 2% of
its length, and the harshest neighbours (hard into chine into pinched). All 96 closed. A
rebuild takes 33 ms at the median and 83 ms at worst, in unoptimised JavaScript on one thread.

## How it would land in the app

| Phase         | What                                                                                                               | Gate                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1. Kernel     | Panels as height fields over the outline; rail strips swept along it; corner radii; an evaluator and a mesh        | Closed mesh on every golden and test board; volume against today's engine |
| 2. Document   | Rail keys and corner radii in the board document, beside the outline, rocker and deck chains that stay as they are | Round-trips; undo                                                         |
| 3. Conversion | A classic or current board becomes rail keys and panels                                                            | The 0.5 mm tolerance of `docs/design/trim-blend-test.md`, per station     |
| 4. 2D editing | Rail map; section handles; band lines in the plan                                                                  | Editing one key leaves the others alone                                   |
| 5. 3D editing | Tap to choose; zone colours; draggable blends; section gizmo                                                       | Same keys as 2D, by test                                                  |
| 6. Exports    | STEP with two trimmed faces and the strips; STL, DXF and PDF from slices                                           | OCCT reads one valid solid                                                |

Phase 1 is the large one. The others each build on a kernel that already closes.

## Not decided

- **Panels for a new design.** A converted board's panels are fitted surfaces. A board started
  from nothing needs a deck crown and a bottom contour the designer can drive, and this note
  does not say what those laws are.
- **Curvature across a band edge.** The blends meet the panels tangent. Whether that reads as
  a line under a zebra on a real board, and whether it matters, is unmeasured.
- **How many keys a converted board gets.** The conversion study fits a rail at every station
  it looks at. Reducing that to a handful of keys the designer can read is the next step and
  has not been done.
- **The deck-side edge** needs a control and a place in the library.

## The sketch

A single page, published privately, that builds a whole board this way in the browser and
checks it for a closed mesh on every change. It has three tails (fish, winged swallow,
asymmetric), the three rail zones with draggable blends, the nine library rails, tap-to-choose
on the 3D board, a slice drawn to true scale, and clay, zebra and patch-layout views. Its
generator is about 450 lines of plain JavaScript and is **not in this repository**; porting it
is phase 1.
