# The rails editor: a plan

> **Status (2026-11-25): decisions made under the old BoardCAD-pinning rules are open.**
> The project no longer treats BoardCAD-LE or the classic loft as the geometry reference
> (see `.claude/CLAUDE.md`). Decisions in this note that rest on classic-editor
> compatibility, matching the classic surface, `geom` being frozen, tolerance stacking or
> clamping are open for the geometry reassessment, and are not settled. The note is kept
> as background and design history.

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
when it lands. Status is as of 2026-11-20.

|     | Slice                             | What a shaper gets                                                                                                                                                                                                    | Gate                                                                                                                   | Status                                                                                                                                                                                                                                 |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Engine speed                      | The new engine keeps up with a drag                                                                                                                                                                                   | The budget above on the sample boards                                                                                  | Mostly done. Volume no longer depends on the grid, unchanged parts are reused, the panels have no long triangles. Draft meshing is over 20 ms on three boards, and the section probe costs 8 to 15 ms a request outside the timed part |
| 1   | **STEP for a rails board**        | Nothing visible. It has to exist before the old engine stops being the one that exports                                                                                                                               | OCCT reads one valid closed solid for every sample board                                                               | Built. 12 of 14 sample boards fit; the made boards are valid in OCCT. The funboard converges (7,900 controls, 1.5 s) and a board no net can follow fails in seconds, saying where                                                      |
| 2   | **Rails boards are the document** | Every board opens in the new format and is built by the new engine alone. In today's layout: outline and rocker as now; the cross-section tab shows a station's deck and bottom curves, editable, and its rail, drawn | Round trip and undo; every export; old files convert; the engine switches are gone                                     | Built behind the two experimental switches, with the old layout. The switches are still there and the classic engine is still the default. A review found defects in how a rails board arrives, is autosaved and is restored (below)   |
| 3   | **The new layout and the looks**  | The design list, the board always in view, the drawing, the panel. Look with Patches and everything the app has. Tap a patch to choose. Today's tools in their new places                                             | Every step reachable by list, key and tap; tablet layout; no step slower than before                                   | The workspace, the Patches look as its working look (seams, a darker tuck, a key) and a tap that chooses a step are in, behind the two switches, with the one Look control and a Show menu. Next: the plan's step-driven looks         |
| 4   | **Rail zones**                    | The rail map; zones and blends, dragged on the map and on the board; the rail panel with its three dials, live slice and More; my rails; Tidy rails                                                                   | Any zone edit keeps a closed board; one side or both; a board's rails survive a save, a share link and another machine | Built behind the two experimental switches: the rail map, the slice and the rail panel, on the zone edits built beside the workspace                                                                                                   |
| 5   | **Deck and bottom shapes**        | Named deck shapes with a crown dial; bottom contours in the Bottom step; Edit curve; the station strip                                                                                                                | A shape applied and then edited as a curve stays the shaper's                                                          | Built behind the two experimental switches: the Deck step (Flat and Domed with a crown, the station strip, Edit curve) and the Bottom step (contours with a depth and a run, the bottom seen from below, Edit curve)                   |
| 6   | **Tail and corners**              | The tail picker; a radius handle on every corner, in the plan and on the board                                                                                                                                        | Every tail in the picker gives a closed board at every size in the gallery                                             | The Tail step is built behind the two experimental switches: six shapes, a tail width and a radius handle on every corner. Wings, and a handle on the board in 3D, are not built                                                       |
| 7   | **A new board**                   | The gallery of types, then a size                                                                                                                                                                                     | Each type opens at the smallest and largest size it allows                                                             | Built behind the two experimental switches: File, New board… asks for a kind of board and then its size. The five named boards stay in the File menu until the old layout goes                                                         |
| 8   | **The old engine goes**           | Nothing visible                                                                                                                                                                                                       | Nothing imports the chord frame, the notch zone, the caps or the section editor                                        | Not started. The switches go and the rails engine becomes the default here                                                                                                                                                             |

Slices 1 and 2 touched different code and were built side by side. Slice 3 comes before the
rails so that the rail map and panel are built once, in their final place.

## How the order changed

- **The workspace is built beside the old layout, not in place of it.** It is a new
  component, shown instead of the main area only while a rails board is the document and the
  screen is not a phone. `AppShell`, `View` and the old views stay until the old path is
  deleted, because the classic engine is still the default and `View` is held by the
  shortcuts, the phone tier, the docs coverage test, the end-to-end specs and the pixel
  scripts. Decision 14's "replaces" therefore takes effect with slice 8, and `AppShell` is
  decomposed then. To see the workspace: Settings, turn on the NURBS engine and the rails
  engine.
- **Slice 3 is built in three parts**: (a) the workspace, over today's editors and sidebar;
  (b) the one Look control; (c) a tap on the board chooses a step. All three are in; what
  is left of slice 3 is the plan's step-driven looks (below).
- **The pure side of rail zones is built beside (a)**, since it needs no layout.

## Decisions taken while building

- **A zone is two or more consecutive rail keys that hold the same rail; a blend is the gap
  between two zones.** A zone of no length is one key. The engine already holds a rail flat
  between equal keys and eases into and out of the neighbours (a monotone cubic with zero
  slope at a flat run's ends), so zones need no change to the file or the engine. A converted
  board arrives as zones of no length with a blend between each.
- **Left and right rails do not depend on the outline's symmetry.** The minus side's rail
  keys are read whenever they are present, on a mirror board too; choosing L or R in the rail
  panel creates them from the other side, and Both sides removes them. The engine tied them
  to a fully asymmetric board in three places (`native.ts`, `probe.ts`, `step.ts`).
- **The workspace's 3D view opens in three quarters, from behind the tail.** Seen from the
  side, as the tabbed layout opens it, the deck is edge-on in the workspace's short, wide
  pane. The workspace passes `defaultView: 'threeQuarter'` to the 3D view, and the board is
  fitted by its silhouette in both directions (`orthographicZoomForBox`): a fit by length
  across the width says nothing of the height, and the oblique board is the tall one. The
  tabbed layout keeps its side view and its fit by length, pixel for pixel, until it goes.
- **The Patches look is drawn from the engine's own strips.** The seams (the band edge on the
  deck, the apex, the tuck's edge, and a cut across the rail where a stretch of the outline
  ends) come from the trim mesh's strip rows in `board2`, never from the triangles, and
  reach the view as line segments; the mesh itself is byte for byte what it was. The tuck
  takes 0.8 of its blend's colour in the shader. The colours, and the key under the 3D view,
  come from one palette module, and every pair of them is tested under normal vision and
  three colour-vision deficiencies.
- **A board is held to the scale of a board, and the count limits are the reader's and the
  builder's.** A board that builds must be one the reader takes back, or the app could hold a
  board it can save and never open. The rail ranges are defined once, in the engine's
  code-free `defaults` (the store imports them): the range the engine builds to
  (`RAIL_LIMITS`), and the wider range a board may hold (`RAIL_DOMAIN`), since a board
  converted from sections can hold a tuck or an apex of 0 and builds. A station curve's rule
  is the sections model's, not a stricter one that refuses real imports.
- **A test budget belongs to the package.** Tests that build and mesh boards run 3 to 10
  times slower on a CI runner, and vitest fails a synchronous test that overruns its timeout.
  Web has 30 s, the store 20 s, the engine package 60 s and the others 20 s. Before a push,
  run what CI runs (`pnpm exec turbo run test --concurrency=2`), not only the package
  touched.
- **A rail's name is not stored.** It is the built-in or saved rail whose numbers it equals,
  and Custom when it matches none. My rails are kept in the browser and in the document's
  `meta.extra`, so they travel with the board.
- **Per-number lanes, and the travel of a blend, are not in the first rail map.** They need
  keys with their own places along the board for each number, which is a change to the file.
- **What a tap can tell apart.** The engine marks an outline piece that runs across the
  board (a squash tail's straight edge, a notch wall) as a tail edge, as the loop always
  allowed and the outline never used; a corner is identified as the corner knot nearest the
  tap; the tail and the nose are told apart by position. A round tail is rail.
- **A new board is a template made at a size by Resize's own scaling.** `sizeRailsBoard` loads the
  template's rails board into a private rails store and scales it by the factors the Resize section
  computes, so a board from the gallery is one Resize could have made: the tail stays at x = 0, corner
  radii stay in cm, and a rail's band and tuck follow the width. The ranges of the five kinds are shaping
  norms, not the engine's limit: each template scaled to 0.5 to 1.7 times its drawn length, width and
  thickness, each alone and all three together (240 boards), builds with no issue and a closed mesh, and
  its volume is the drawn volume times the three factors to 0.1%. A gate test builds each kind at its
  least and greatest corner. A kind's drawn size and plan outline are generated from its template
  (`tools/make-nurbs-templates.ts`, committed as `board-type-shapes.ts` and held to the templates by a
  test), so the dialog loads no template to draw its cards.
- **A deck shape is read from the curve and never stored, and a dome is a parabola.** Flat and
  Domed are what a station's deck curve is to 0.1 mm; anything else is Custom, so a shape applied and
  then edited as a curve reads Custom and nothing the shaper drew is replaced unless they choose a
  shape. The crown is the gap under a straightedge laid across the deck from one band edge to the
  other, measured at the stringer. Curves are stored as fractions of the half width and of the
  thickness, so a moved station or an edited thickness stretches a stored curve per axis: a circle does
  not survive that and a parabola does, so a Domed deck stays Domed through every edit that is not the
  deck's own. A crown runs from 0.05 cm to the deepest dome that keeps the wall 1 mm above the
  bottom's end with a slope under 60 degrees, and is held there, never refused. Applied to all
  stations (the default) every station falls the same share of its own thickness at the wall, half of
  it for a new Domed (the median of the 47 stations of the nine boards measured), and the station
  that was asked has the crown typed.
- **The Deck step's drawing is the section from the engine's fine polyline.** The slice behind the
  curve reads the same 400-point answer as the Rails slice, so a rail's bend is not a polygon.
- **A contour is a bottom feature in a shaper's words, with a depth and a run.** The four kinds of
  the section store's features (Single concave, Double concave, Vee, Channels) each have one Depth
  (how far the bottom is raised into the board, or the rails raised for a vee) and a run, From and
  To, measured from the tail; a kind's own number is on the face and the rest is under More. A run is
  edited by moving both end keys together with the keys between them keeping their share of it, and
  the depth and the channels are then held to the new run once, from where a drag began. The depth is
  also held to half the wall's thickness over the run, which keeps a contour from crossing the deck
  (before the bound a vee at its greatest depth over 2 cm at a notch bottom left a negative
  thickness on the fish and the swallow). The Bottom step's drawing is the section at the station
  with a magnified strip of the relief, and the bottom seen from below with each run as a band; its
  panel replaces the old Bottom features section in the workspace.
- **A tail shape is read from the outline and never stored.** Squash, Round, Pin, Diamond, Swallow
  and Fish are the tail's own knots equal to what applying the shape writes, to 0.1 mm; anything else
  is Custom. A shape rewrites only the knots before the first at or past 8% of the length (after the
  tip for a notched tail) and leaves the rail, the nose, the length and every other curve. The
  width is the width across the corners (tip to tip on a swallow or a fish; where the tail zone ends
  for a round or a pin), with a range per shape taken from plan sheets of three boards; the engine
  builds a closed board at every width from about 4% of the board's width, and every shape builds
  closed at the least and greatest size of each gallery kind. A corner's radius is held between the
  engine's least arc and what the board can fit.

## Open items

From the engine and the mesh:

- The stitch between a panel's grid and its band edge is one to two and a half cells wide
  where the panel rolls fastest: at view quality the distance off the panel is 0.14 to
  0.22 mm at the 99th percentile and up to 0.74 mm at worst. A cell rule that keeps cells
  half a cell from the band edge would narrow it; it adds vertices and closedness depends on
  the rule, so it needs its own measurement (a probe that dropped the margin entirely opened
  20 to 650 edges a board).
- Channel walls are narrower than the grid: the channel board is 1.3 mm off at the 99th
  percentile and 3 mm at worst. Cells of about 0.08 cm over the walls only would bring it to
  0.1 mm; the midpoint gap already computed cannot find a wall that falls between two nodes,
  so the walls' places must come from the relief's own definition.
- The bottom panel's slope within 3 mm of a squash tail's edge is wrong (the loft reads
  `u = y / w(x)` through a 0.1 cm table where `w` is steep): it shades as a bright line along
  the tail edge. Near-hard edges with a band of 0.7 mm or less turn their normal 40° in 0.03 mm
  between the first two strip rows (88 strip triangles on the fish).
- The Diamond Twin's panel has a feature narrower than any grid (5.8 mm off at every grid).

A rails board is bounded (the checks in `checkBoard`, the reader's counts and the mesh's
budget): no number that is not finite, nothing beyond 1,000 cm of the origin, a length of
1,000 cm and a half width of 150 cm at most, an outline that does not cross the stringer,
stations in order and unique, 250 stations, 400 knots a chain, 5,000 rail keys a side and 64
features at most, and the panel grid never finer than the board's box over 250,000 cells.
Each is measured at its limit, and the made boards and templates mesh byte for byte as before.
Still open:

- A tight zigzag of an outline, inside every limit, builds in about 4.5 s. The loop's local
  feature size compares every sample with every other; binning the samples in cells of twice
  the feature cap (120 cm) keeps the same candidates and should give identical results, which
  a before and after dump must prove. The corner search tests every pair of samples within a
  corner's reach and is the next cost.
- The station gap is defined in three places (the engine's parameters and two store modules);
  it could live in the code-free `defaults` with the rail ranges.
- Feature depth keys have no count limit, and a station curve's heights and the features are
  checked only to be finite.

From STEP:

- The fit refines a cell the way the kernel's own samples say, and a cell the band edge cuts
  to a sliver (at a pointed tip, a millimetre inside the outline) had no sample to judge by in
  one direction: it was split only the other way and never converged, which is why the
  funboard ran for 780 s. A direction with no sample to judge by is now split too. The fit
  stops, with where, when a panel's or the strips' miss stops falling (6 passes without a gain
  of 5%), and a panel solve is held to 4e9 multiply-adds (about 2.5 s), because a net that
  grows across the board costs far more than its control count says; the budget is 20,000
  controls (the largest board that fits needs 12,300). Next to a real step the direction rule
  can still split the wrong way and the work cap is what ends it. The Diamond Twin sample has
  not been run with this fit; the app's STEP export does not yet word a stall (`stepFitMessage`
  is typechecked, not exercised).
- Files are 1 to 5 times the old exporter's size and take 0.8 to 4 s on standard boards; the
  faces are not rational and the band edges are refined to a quarter of a micron. Options: a
  rational or degree-elevated band edge, patches instead of one net per panel, or a looser
  tolerance by decision.
- OCCT's volume property is 10.8% over ours on the channel board (its own fine mesh agrees
  within 0.24%); that board's sanity bound is 12%, the others' 5%.
- The asymmetric nose and tail are one transition face where the kernel's laws jump between
  the sides; the deck is smooth across the stringer to the fit, with no tangency constraint;
  only OCCT has read the files.

From the store and the app:

- A station added between two others (`insertStation`, which the strip and the old layout's
  Add both use) gives the new station the neighbours' curves blended after the one with fewer
  knots has been split at the other's knot places, so the blend never copies a curve. It moves the
  surface by 0.9 mm at most on the boards as shipped and 1.3 mm where every deck is Flat (the
  blend it replaced: 4.1 and 6.4). An exact insert would take the new curves from the surface's
  own definition and not from samples of it, which `.claude/CLAUDE.md` principle 2 forbids without
  the owner's decision, so it is open.
- Rail keys behind a new notch bottom are kept. An asymmetric board's station of no width
  skips its curve edits when they are written back.
- The engine info popover still describes the sections engine's blending for a rails board;
  feeding the engine's sections to the store through the 3D layer has no test of its own.

From the new-board gallery:

- A new board replaces the open one without asking, as choosing a template does. A prompt needs a
  notion of unsaved edits that the stores do not have.
- New board… has no shortcut (it needs a row in `shortcuts.ts`, a registry entry and docs), and two sizes
  of one kind share one entry in the recent list, since the name is the kind's.
- Offline, the dialog and the templates are precached but the engine's worker is not, so a fresh offline
  page cannot make a board: the same limit as a template opened from the File menu.
- On a phone the size step is below five stacked cards; the phone layout is slice 8's.
- The menubar's menu drops the focus when an item is chosen, so the gallery puts it back on the menu's
  button itself (`menu-trigger.ts`); the fix for every dialog is `PROPOSALS.md` P47.

From the Deck step:

- Every shipped deck is an arc with a steeper roll at the rail, not a parabola, so every starter and
  every converted board reads Custom at every station and the Deck step opens on the editor. Choosing
  Domed keeps each station's crown at the band edge and replaces the drawn curve (undo brings it back).
  Reading a looser dome as Domed would show a crown dial sooner and let a nudge of it replace a
  hand-drawn curve: a product call.
- A board that arrives opens on the station nearest its middle, as a shared board does, where the shell
  used to keep the tail's first, a tip that holds about 1 cm of rail. One place chooses it
  (`arrival-station.ts`): the first time the rails store is the document for a load, whichever way the
  board arrived, and when a shared board is presented. The tabbed layout with a classic board is as it was.
- On a tablet the sheet opens at its peek, so the shape and the crown are one drag away, and an open
  editor has about 85 px of height. The crown could go in the slice card's header.
- A crown is one number for both sides. The store takes a side; the panel says when the sides differ
  and has no control for one.
- The crown ranges and the default are measured on the nine shipped and made boards, not on the
  gallery's boards at the ends of their ranges.

From the Bottom step:

- The panel and the plan draw a contour from two closed forms (the bump and the vee profile) that
  restate the engine's, because the store may not import engine code; a test holds them to the
  engine's relief within 5e-4 cm. Principle 2 of `.claude/CLAUDE.md` asks for one surface definition:
  the alternative is to expose the engine's forms from the code-free `defaults` module, an engine
  change that is the owner's to decide.
- Rocker, deck and outline edits made after a contour exists do not hold its depth again, and the
  shared `refitFeatures` holds channels only; holding the depth there also changes the old layout.
  A contour out of the tail is capped by the shared stringer rule at 1.7 to 5.4 mm on the boards
  measured; a rule weighted by the contour's shape would give more, and changes the shared `depthRange`.
- At a station outside the chosen contour's run the relief strip is empty and its handle off; a line
  and the marked ticks say where the run is, and the station is not moved for the shaper.
- On a tablet the drawing pane is about 250 px high and the panel sits in the sheet at its peek.

From the Tail step:

- The starter Shortboard and Longboard read Custom, not Squash and Round: the Shortboard has no corner
  knot at the tail (its one corner knot is the nose's) and the Longboard's second knot is smooth, while
  the gallery card says "Round tail". Either accept that or make the canonical shapes equal the
  starters. The Funboard reads Round.
- Wings are not built: a wing's step lies about 18% of the length from the tail, past the rail knot, which
  a shape never rewrites; it needs the tail's own knots to reach past it, a family of three numbers and
  a closedness matrix like the six shapes'. A handle on the board in 3D is not built either: it needs the
  corner projected to the screen, a ray-plane drag that does not fight the orbit controls, and WebGL tests.
- On a tablet under touch the drawing pane is about 186 px high and the panel in the sheet shows three of
  the six shapes at its peek with the dials below the fold; the width handle of a wide squash, round or
  swallow leaves the pane. A compact peek (shapes and width on one row), a refit when a handle gesture
  ends, or a taller pane under touch would fix it.
- The old Board shape section still duplicates the tail choice in the Shape tab until the old sidebar goes.

From the Patches look:

- Against the page it was modelled on, the app's canvas is dark, so the light deck sits on
  navy; the seams are one device pixel, which is faint on a dark canvas; and a tail edge or
  a corner switches at a strip boundary instead of fading across it. Raycasting is linear
  over about 90,000 triangles and untimed; touch is untested; a tail edge has not appeared
  on a real mesh.

From the workspace:

- The 3D controls are one Look button (Shaping, Surface, Realistic) and Show (guides,
  wireframe, normals, mesh quality), with one line of status over the board; the engine chips
  are not drawn in the workspace. Still open:
  - Patches is not yet worn while a design step is open, with the board returning to the last
    surface or realistic look on Specs, Build or Compare (the plan's rule). Today the first
    entry claims Patches once and a later choice is never overridden. Building the rule needs
    a memory of the last non-Patches look (a surface look is lost when Patches replaces the
    analysis), a pure rule applied when the step changes, and an `onLook` from the shell to
    the workspace; it replaces `claimPatchesDefault`.
  - Wireframe and Normals draw on the realistic looks only (the renderer applies its mode to
    no other), so under Patches and the surface looks they are listed disabled, with the
    reason. Band lines and zone ends over any look are not offered: only the Patches look
    draws the seams, from the engine's strips; offering them needs a seam component of its
    own, two settings with their saved form, and the `Show` rows.
  - A guide turned off is not repainted until something else repaints: `Guides3D` is mounted
    conditionally and removing it asks for no frame under on-demand rendering. The tabbed
    layout's Stringer button has it too.
  - The details popover still speaks of "NURBS" and "Rails (experimental)".
- Neither layout meets the 50 ms input-to-frame budget for the 3D board on the machine it was
  measured on (software rendering, shared cores): 30 ms in the workspace against 27 in
  Split. Re-measure on a machine with a GPU before flipping the default.

From how a rails board arrives, is autosaved and is restored (an independent review, with
the failing cases kept as skipped tests):

- With the rails engine switched off after rails edits, the autosave holds the sections
  document made from the board as it was opened, so closing the tab loses the edits; Save and
  Export write that stale document without saying so.
- A rails board that arrives with the switches off (a file, a share link, a restored session)
  turns both on and saves that setting at once, so a shared link changes the next day's
  behaviour. It should be for the session only.
- A share link of a rails board shows two notices in the one toast slot; the second replaces
  the rails one.
- A rails text of a newer version, or one that is JSON but the wrong shape, is dropped when
  the engines are on, and the next autosave overwrites it with a conversion of the classic
  board: data loss, with no notice. The held text must stay held, and the person must be told.

The first two of these come from the engine switches and go with them in slice 8. The held
text that is dropped, and the share link's second toast, do not: they are conditions of
making the rails engine the default, and of any session saved by a newer version being
opened by an older one. Both are fixed:

- A rails text that will not read stays held. Neither engine converts the classic board over
  it (`held-text.ts`, read by `use-section-engine.ts` and `rails-engine.ts`), so the autosave
  keeps writing it back, and a notice of its own (`HeldRailsNotice.tsx`) says it could not be
  read, that it is kept unchanged, and how to go on. The hold belongs to the classic board
  that was restored: any other board opened or started ends it, with the notice; Save writes
  the classic board shown and leaves the held text. There is no action that discards it. The
  held prompt, which offers the NURBS engine with the engine off, still appears for an
  unreadable rails text and its words are about a NURBS board only.
- A share link of a rails board raises one notice: the shared-board line first (what happened
  to the board) with the engines line after it (`arrival-notice.ts`).

From the tests:

- Many tests build and mesh a board; on CI they take 5 to 60 s, and the rails worker
  comparisons take 200 s together. Budgets are per package (see above). The comparisons
  should be trimmed.

## Not decided

- **Rails on a notch's wall.** Rail keys are placed by distance along the board, so a notch's
  wall takes the rail of the outer rail beside it. A notch with its own rail needs keys
  placed along the outline, and a place for the wall on the rail map.
- **A section gizmo on the 3D board**: the slice's handles standing in the plane of the slice,
  draggable in place. Useful, and not needed for anything above.
- **Deck shapes beyond flat and domed** (a step deck, a concave deck). The curve does them;
  whether they earn a name is for use to show.
- **The step's name.** "Rocker and foil" here; "Foil" alone in the first sketch.
