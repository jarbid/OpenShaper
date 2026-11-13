# The rails editor: a plan

Status: **plan, agreed with the project owner on 2026-11-13**. It says what the editor on
`experiment/nurbs-overhaul` becomes now that a board is built by trim and blend
(`trim-blend-plan.md`, `trim-blend-engine.md`), and in what order it is built.

## What was asked for

A clean and logical editor built on the new way of designing a board: a clear way to add and
edit rails and to manage how they blend along the board; control over every edge without a
complicated workflow; easy enough for a beginner and deep enough for a master; and the patches
view, which shows at a glance how the surfaces of a board meet.

## Decisions

Taken by the project owner, by question and answer, on 2026-11-13.

|     | Decision                                 | What it means                                                                                                                                                                |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Rebuild around the board**             | A new layout organised by what a shaper designs. The app's look, menus, files and exports stay                                                                               |
| 2   | **3D and 2D side by side**               | The 3D board is always in view. Tapping a patch on it chooses that thing; the matching 2D drawing opens beside it. Everything can be done in either                          |
| 3   | **Rails are zones with blends**          | Tail hard, blend, middle tucked, blend, nose 50/50. Add or remove a zone, pick its rail, drag where each blend starts and ends                                               |
| 4   | **One interface, detail on demand**      | No Simple and Pro modes. Every panel shows a name and a few dials; More opens every number                                                                                   |
| 5   | **A rail is a name and three dials**     | Apex, Tuck, Edge, with a live slice. Band, shoulder, tuck shape, fullness and the deck-side edge are under More. Both sides, or one                                          |
| 6   | **A blend is its two ends**              | How each number travels through a blend is under More                                                                                                                        |
| 7   | **Built-in rails plus my rails**         | A rail a shaper dials in can be saved under a name. It is kept on their machine and travels inside any board file that uses it                                               |
| 8   | **Deck and bottom: shapes first**        | Named shapes with a dial or two; Edit curve opens the curve itself, and a drawn curve stays the shaper's                                                                     |
| 9   | **Tail picker and handles**              | Pick a tail by name, then drag the outline's points and a radius handle on each corner                                                                                       |
| 10  | **Patches is the working look**          | Shown while a design step is open. Every analysis view the app has stays, and so do the realistic materials and lighting                                                     |
| 11  | **Desktop first, tablet too**            | Mouse and keyboard first; laid out to work by touch on a tablet. A phone opens and views a board                                                                             |
| 12  | **A new board is a type and a size**     | Choose a kind of board, type its length, width and thickness, start from a whole board                                                                                       |
| 13  | **A plan, then slices**                  | No separate mock-up. Each slice is usable when it lands                                                                                                                      |
| 14  | **Deliver it efficiently, keep quality** | Left to the build: the new editor replaces the current one, and the order follows what each slice depends on, so nothing is built twice and there is one editor to keep fast |

## Principles

1. **The board is the interface.** It is always on screen, and what is tapped is what is
   edited.
2. **One thing is chosen at a time.** The drawing and the panel follow the choice; nothing
   else on screen needs reading.
3. **A shaper's words.** Outline, rocker, foil, deck, bottom, rail, apex, tuck, edge, tail,
   concave, vee. No surface-modelling words in the interface.
4. **Detail on demand.** A name and at most three dials on the face of a panel. More opens
   the rest, in the same panel, and stays open if left open.
5. **Every dial has a number and a handle.** A value can be typed in the app's units, nudged
   with the keys, or dragged where it shows on the board.
6. **Nothing breaks the board.** The engine keeps a closed board whatever the controls say, so
   a control stops where it has to and never raises an error.
7. **2D and 3D are two views of one board.** Nothing can be edited in one that cannot be
   reached from the other.
8. **It stays fast.** Dragging a control moves the 3D board within 50 ms, and the 2D drawing
   at once.

## The screen

```
+--------------------------------------------------------------------------------+
| File  Edit  View  Export  Help          6'0 Twin  *           mm v   Share     |
+----------+------------------------------------------------+--------------------+
| DESIGN   |  Look: [Patches v]   Show v          [cube]    | RAILS > Tail zone  |
|          |                                                |                    |
| Outline  |                                                | Rail [Tucked edge v]|
| Rocker   |              the board, in 3D                  | (o) Both ( ) L ( ) R|
| Deck     |                                                |                    |
| Bottom   |                                                | Apex  50/50 --o- 80/20
| Rails  * |                                                | Tuck  none -o-- deep|
| Tail     +------------------------------------------------+ Edge  none ---o hard|
| Fins     |  tail [=hard=|~~|===tucked===|~~~|==50/50==] nose                    |
|----------|                                                |  [ live slice ]    |
| Specs    |        slice at the chosen place, true scale   |                    |
| Build    |                                                | More v             |
| Compare  |                                                | Save as my rail    |
+----------+------------------------------------------------+--------------------+
```

| Area                    | What it holds                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design list** (left)  | The steps of a board, in the order a shaper works: Outline, Rocker and foil, Deck, Bottom, Rails, Tail, Fins. Under them, what is not shaping: Specs, Build, Compare |
| **The board** (centre)  | The 3D board, always. Its look, what it shows, and the view cube                                                                                                     |
| **The drawing** (below) | The 2D drawing for the chosen step: plan, profile, slice or rail map. The split drags; either half can fill the centre                                               |
| **The panel** (right)   | The thing that is chosen: its name, its dials, More                                                                                                                  |

A step is chosen from the list or by tapping the board. Choosing a step does not move the
camera.

On a tablet the design list is a strip of icons, the panel is a sheet that slides up from the
bottom, and the board and the drawing share the centre one above the other. A phone shows
the board, its looks and its specs.

## Tapping the board

| A tap on                        | Chooses                    | Opens                                            |
| ------------------------------- | -------------------------- | ------------------------------------------------ |
| The deck                        | The deck at that station   | Deck, with the slice there                       |
| The bottom                      | The bottom at that station | Bottom, with the slice there                     |
| A rail zone                     | That zone                  | Rails: the rail map and the slice at the tap     |
| A blend between two zones       | That blend                 | Rails: the rail map, the blend's two ends lit    |
| A corner                        | That corner                | Tail (or Outline at the nose): its radius handle |
| The tail end, or a notch's wall | The tail                   | Tail                                             |
| A fin                           | That fin                   | Fins                                             |

A second tap on the same patch moves the slice to the tap without changing the choice.

## The steps

| Step                | The drawing                                                                                         | The panel's face                                                                                            | Under More                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Outline**         | The plan. Points and handles as now; the deck band and tuck lines pencilled in, as on a blank       | Length, width, wide point; the chosen point                                                                 | Symmetric or asymmetric; widths at 12 inches; the nose's radius; guides       |
| **Rocker and foil** | The profile: bottom line and deck line                                                              | Nose and tail rocker; thickness and where it is                                                             | The chosen point; thickness at 12 inches; the least thickness, at the tips    |
| **Deck**            | The slice at the chosen station; a strip of the stations along the board to add, move or remove one | Deck shape: Flat, Domed. One dial: crown                                                                    | Edit curve; this station or all                                               |
| **Bottom**          | The slice at the chosen station; the bottom seen from below with its contours                       | Bottom contours along the board: concave, double concave, vee, channels, each with its depth and its extent | Edit curve at a station; a contour's law along the board                      |
| **Rails**           | The rail map; the slice at the chosen place, true scale                                             | The rail's name; both sides or one; Apex, Tuck, Edge; the live slice                                        | Band, shoulder, tuck shape, fullness, deck-side edge; how each number travels |
| **Tail**            | The plan, zoomed on the tail, with a round handle on each corner                                    | Tail: squash, round, pin, diamond, swallow, fish, wings. Tail width; notch depth                            | Each corner's radius                                                          |
| **Fins**            | The bottom plan with the fins                                                                       | As now                                                                                                      | As now                                                                        |

## Rails

**The rail map** is the rail laid out straight, tail to nose: a strip of coloured zones with
the blends between them drawn as gradients. The same colours are on the 3D board.

| To                        | Do                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Choose a zone or a blend  | Tap it, on the map or on the board                                                   |
| Move where a blend starts | Drag that end, on the map or along the rail on the board                             |
| Add a zone                | Tap + on the map where it should go: the zone under it splits, a blend between       |
| Remove a zone             | Delete it: its neighbours' blend takes its place                                     |
| Give a zone a rail        | Pick a name in the panel, or move a dial                                             |
| Make one side differ      | Choose L or R in the panel: that zone unlocks its sides. Both locks them again       |
| Reuse a rail              | Save as my rail; it is then in the list on every board. Copy and paste between zones |

**The rail panel.** Apex runs from 50/50 to 80/20: where the widest point sits between
bottom and deck. Tuck runs from none to deep: how far under the board the rail starts to
turn. Edge runs from none to hard: the angle the rail leaves the bottom at. The live slice
in the panel is the rail at the chosen place to true scale, and its handles are the same
three dials plus the deck band, each draggable.

**More** opens, in the same panel: band width, shoulder (how square the rail's shoulder is),
tuck shape (round to a flat bevel), fullness, the deck-side edge; and under each number a
lane showing how it travels along the board, with a point at each zone end that can be moved
by itself. That is the whole of the master's control: a zone is two points holding one rail,
a blend is the gap between two zones, and a lane lets one number leave the others.

**A converted board** arrives with a rail at each of its own stations. Each shows as a zone
of no length: a tick in its colour with a blend either side. Dragging its ends apart makes
it a zone. Each is named for the library rail it is closest to. Tidy rails, in the map's
menu, joins neighbours that are the same rail within a tolerance.

**My rails.** A rail saved under a name is kept in the browser and written into any board
that uses it, so a board opened elsewhere brings its rails with it.

## Looks

One control on the board, Look, in three groups. Nothing the app has today is dropped.

| Group         | Looks                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| **Shaping**   | Patches: deck, bottom, each rail zone in its colour, each blend a gradient between its neighbours, each corner |
| **Surface**   | Clay, Zebra, Mean curvature, Gaussian curvature, Rail radius, Normal change, Slope, Deviation from the ghost   |
| **Realistic** | Glassed gloss, Raw foam, Matte, under Studio, Shaping bay or Neutral light                                     |

Patches is what the board wears while a design step is open, and the chosen patch is lit. A
look picked by hand stays until the step changes. With Specs, Build or Compare open the
board returns to the last surface or realistic look. Show holds what is drawn over any look:
stringer, stations, apex line, band lines, zone ends, wireframe, normals.

## A new board

File, New: a gallery of board types, each a whole board with its rails and tail laid out.
Choosing one asks for length, width and thickness and opens it at that size. The first set
is the five boards the branch already has: shortboard, funboard, longboard, swallow, fish.

## Files

A board in the old format, or a `.brd`, `.s3d`, `.s3dx` or `.srf` file, is converted when it
is opened (`trim-blend-engine.md`, "Converting"), and saved in the new format from then on.
The first time, a line says what changed: tips and corners are rounded, and the rail is now
a rail at each station.

## What is kept, changed and removed

| Part                                                                                          | Today                                                                      | Becomes                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Menus, file handling, share links, autosave, units, settings                                  | `App.tsx` menus, `file-io.ts`, `session-store.ts`, `share-url.ts`          | Kept. The Board menu and the view items change                                                           |
| The 2D curve editor                                                                           | `packages/render2d` `SplineEditor`, `hit.ts`, `draw.ts`, `viewport.ts`     | Kept. It gains two targets, a station's deck curve and its bottom curve, and a round handle for a corner |
| The 3D view, its looks, materials, lighting, analysis                                         | `packages/render3d`, `nurbs-layer.tsx`, `view3d-settings.ts`               | Kept, behind the one Look control. It gains patch colours and picking                                    |
| Fins, specs, construction, ghost and compare, bottom contours                                 | `FinPanel`, the specs panels, `ConstructionPanel`, `BottomFeaturesSection` | Kept, moved into the new layout                                                                          |
| The view tabs: Quad, Outline, Rocker, Cross-section, 3D, Split                                | `view-toolkit.tsx` `View`, `shortcuts.ts` `VIEW_KEYS`                      | Replaced by the design list. The keys choose steps                                                       |
| The sidebar's tabs                                                                            | `sidebar-sections.ts`, `Sidebar.tsx`                                       | The mechanism is kept; its sections become the panel of the chosen thing                                 |
| The cross-section drawing of a whole section                                                  | `CrossSectionControls.tsx`, the closed-section rules in the section store  | Replaced by the slice, with a deck curve, a bottom curve and rail handles                                |
| The shell                                                                                     | One component of 2,500 lines, `AppShell`                                   | Split: layout, design list, board, drawing, panel, each memoised with stable props                       |
| The Classic and NURBS switches, the rails switch, the test-board menu, Deviation from classic | Engine controls in the 3D toolbar and Settings                             | Removed: there is one engine                                                                             |

## How it is built

Five things decide the code, each chosen so that there is one of everything.

1. **One document.** `model: 'rails'` joins the board document; a sections document is
   converted on the way in. The engine then builds what is stored, with no conversion on an
   edit.
2. **One store.** A rails store beside the section store in `packages/store`, with the same
   history. A rail edit is a pure function on the document (set a zone's rail, move a blend's
   end, split or delete a zone, set a corner's radius, set a station's curve), committed as
   one undo step. Curves keep going through the existing curve editor: the outline, rocker
   and deck line as today, a station's two curves through two new targets. The rules for a
   closed section go; a half curve has two: it starts on the stringer and ends on the wall,
   and it stays a function of the distance from the stringer.
3. **The shell is split as it is rebuilt.** `EditorShell` lays out; `DesignList`,
   `BoardStage`, `DrawingArea` and `Panel` each subscribe to what they need. The step
   replaces `View` in the persisted state, the sidebar's relevance table and the shortcuts.
4. **A patch is known from the kernel to the shader.** The engine's mesh already knows which
   part each vertex belongs to. It carries that, and each rail vertex's place along the rail,
   to the 3D view as two vertex attributes. The zone colours are then drawn by the shader
   from a small table of zone ends, so dragging a blend recolours the board without a new
   mesh; and a tap is a ray to a triangle to a patch.
5. **A budget, measured each slice.** A drag moves the 3D board within 50 ms at draft
   quality and settles within 100 ms; the 2D drawing follows the pointer. A rail edit
   rebuilds the rail strips and reuses the loop and the panels. `browser-perf.mjs` and
   `who-renders.mjs` are run before and after each slice and the numbers recorded.

Each slice also updates the documentation registry, the shortcuts table and the Playwright
suites, and re-pins the canvas and WebGL hashes with the reason, since the pictures change
on purpose.

## The slices

In the order each depends on the one before. Each leaves the branch working and is usable
when it lands.

|     | Slice                             | What a shaper gets                                                                                                                                                                                                    | Gate                                                                                                                   |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0   | Engine speed (in progress)        | The new engine keeps up with a drag                                                                                                                                                                                   | The budget above on the sample boards                                                                                  |
| 1   | **STEP for a rails board**        | Nothing visible. It has to exist before the old engine stops being the one that exports                                                                                                                               | OCCT reads one valid closed solid for every sample board                                                               |
| 2   | **Rails boards are the document** | Every board opens in the new format and is built by the new engine alone. In today's layout: outline and rocker as now; the cross-section tab shows a station's deck and bottom curves, editable, and its rail, drawn | Round trip and undo; every export; old files convert; the engine switches are gone                                     |
| 3   | **The new layout and the looks**  | The design list, the board always in view, the drawing, the panel. Look with Patches and everything the app has. Tap a patch to choose. Today's tools in their new places                                             | Every step reachable by list, key and tap; tablet layout; no step slower than before                                   |
| 4   | **Rail zones**                    | The rail map; zones and blends, dragged on the map and on the board; the rail panel with its three dials, live slice and More; my rails; Tidy rails                                                                   | Any zone edit keeps a closed board; one side or both; a board's rails survive a save, a share link and another machine |
| 5   | **Deck and bottom shapes**        | Named deck shapes with a crown dial; bottom contours in the Bottom step; Edit curve; the station strip                                                                                                                | A shape applied and then edited as a curve stays the shaper's                                                          |
| 6   | **Tail and corners**              | The tail picker; a radius handle on every corner, in the plan and on the board                                                                                                                                        | Every tail in the picker gives a closed board at every size in the gallery                                             |
| 7   | **A new board**                   | The gallery of types, then a size                                                                                                                                                                                     | Each type opens at the smallest and largest size it allows                                                             |
| 8   | **The old engine goes**           | Nothing visible                                                                                                                                                                                                       | Nothing imports the chord frame, the notch zone, the caps or the section editor                                        |

Slices 1 and 2 touch different code and are built side by side. Slice 3 comes before the
rails so that the rail map and panel are built once, in their final place.

## Not decided

- **Rails on a notch's wall.** Rail keys are placed by distance along the board, so a notch's
  wall takes the rail of the outer rail beside it. A notch with its own rail needs keys
  placed along the outline, and a place for the wall on the rail map.
- **A section gizmo on the 3D board**: the slice's handles standing in the plane of the slice,
  draggable in place. Useful, and not needed for anything above.
- **Deck shapes beyond flat and domed** (a step deck, a concave deck). The curve does them;
  whether they earn a name is for use to show.
- **The step's name.** "Rocker and foil" here; "Foil" alone in the first sketch.
