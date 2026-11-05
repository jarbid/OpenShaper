# Fin designer — standalone Futures fin design for CNC and print

Status: **all steps done (0–17, with 4a and insertion clearance); user-testing round 1 (R1–R7) done; round 2 (S1–S3, T1) done; foil slices (T2–T7) done.** Open follow-ups: P46 / P47 in `PROPOSALS.md` (board STEP loop winding, board STL units); section drags take ~5 ms per move (up to ~60 ms when clamped); STEP export runs on the main thread (~1 s), as the board's does. The `/fin` page edits the outline, foil section and taper, with a 3D preview, autosave, `.fin.json` Open / Save and STEP / STL export; documented at `/docs/fin-designer`. Tab spec and fixture: `docs/specs/fins/futures-tabs.*`.
Kernel: `packages/kernel/src/fin-design/` (tab outline, `FinDesign` model, defaults,
rules, readouts, blade sections, blade surface, placement, NACA presets, meshes); export: `fin-step.ts`; io: `fin-json.ts`; export: `fin-stl.ts`; store: `fin-store.ts`, `fin-edits.ts`; render2d: `FinCurveEditor.tsx`, `fin-curve-view.ts`; web: `apps/web/src/fin/`, route `/fin` (offline, like `/app`). This is the agreed scope and build order. Update the status line as steps land.

## Goal

A standalone fin designer at `/fin`. A shaper starts from a default fin, edits its
outline, foil section and thickness taper by dragging points, and exports a solid for
CNC milling (**STEP, the priority**) or 3D printing (STL). The fin is its own document,
independent of any board. It does not touch the board's `FinSpec`/`FinConfig`.

Out of scope: DXF, importing STEP/STL, FCS or other box systems, a single fused solid
(see [STEP topology](#step-topology)).

## Requirements

### Futures tabs

The tab is the part that sits in the Futures box. Bases are industry standard and **not
editable**. The user picks one of:

| Tab               | Length | Depth | Thickness | Notches | Cant  | Sides |
| ----------------- | ------ | ----- | --------- | ------- | ----- | ----- |
| Side / quad front | 113    | 17.7  | 6.35      | side    | 0–20° | L / R |
| Quad rear         | 113    | 12.7  | 6.35      | centre  | 0–20° | L / R |
| Centre            | 113    | 12.7  | 6.35      | centre  | 0°    | —     |

All dimensions in mm.

- Futures is a US standard, so the source dimensions are in inches. The app always shows
  and writes mm.
- Quad rears use the centre tab geometry but take cant and a side: they sit further
  back where the tail is thinner, hence the shallower tab.

The notch geometry comes from the user's AutoCAD drawings of the **box slot**: 113.5
long, with the side drawing marked 17.7 deep. The tab is slightly smaller than the slot.
Each feature keeps its drawn size and is placed from its own end of the 113 mm tab.

**Rear, trailing end (both tab families):**

- Ø4.4 U-slot open to the end, centre 6.4 below the tab top, 3.3 in from the end.
- Bottom-rear corner R1.0.

**Front, leading end:** a V-notch the grub screw seats in.

| Front notch        | Included angle | Apex below top | Front-face angle | Setback at top | Setback at bottom |
| ------------------ | -------------- | -------------- | ---------------- | -------------- | ----------------- |
| Centre / quad rear | 100°           | 4.5            | 101°             | 2.0            | 0.7               |
| Side / quad front  | 90°            | 5.5            | 101°             | 3.8            | 2.1               |

These readings are transcribed from screenshots. Step 0 pins them in a fixture that the
user signs off before anything depends on it.

### Blade

- **Outline:** dragged freely, with these rules:
  - The root chord is not tied to the tab, and the fin may extend behind the tab
    without limit.
  - The leading-edge root may overhang the tab's **top-front corner by at most 2.5 mm**.
    The grub screw sits at the front of the box.
  - The leading and trailing edges must each keep rising from root to tip, so every
    horizontal slice cuts the outline exactly twice. A drag that breaks this is clamped.
  - **Raised rear** (long-based fins, e.g. keels and twins). Behind the tab, the blade's
    underside may rise from the base to a raised low point before the trailing edge
    climbs to the tip, so the fin can be rocked onto the box's rear pin without its
    tail hitting the board. The outline chain then runs down the trailing edge to the
    low point and forward along the underside to the base. Height still falls all
    the way from the tip, so the rules above already allow it, and the editor must
    let control points form it: add points on the trailing edge, move them behind
    and above the base, and end the chain anywhere on the base.
    `raised-rear.test.ts` and `fin-step.test.ts` build one end to end.
- **Section (horizontal foil):**
  - One shape, scaled to the local chord.
  - Modelled as **two independent curves**, inside and outside, each measured from the
    chord line. One model covers every foil below, and more can be added without
    changing the file format.
  - **Centre fins: always symmetric**, like a boat keel. The inside curve mirrors the
    outside, so one curve is edited. Symmetric NACA sections (NACA 00xx) are allowed.
  - **Side fins default to a flat inside face** with an editable outside curve. Both
    curves can be edited, so cambered or concave-inside foils are possible.
  - **NACA presets** (`naca.ts`): NACA 4-digit (camber, camber position, thickness)
    generates both curves, which stay editable afterwards. The convex face is the
    outside face; 00XX is symmetric. Closed trailing edge (the blade's minimum thickness
    blunts it), and thickness applied square to the chord rather than the camber
    line, so a cambered face never curls back past its leading edge: within 0.16%
    chord of the textbook shape for a 2412, 0.35% for a 4412. Other series can be
    added as further presets on the same two-curve model.
  - Section thickness always comes from the taper, and the whole section scales with
    it, so a preset keeps its camber-to-thickness ratio (a 2412 stays 2 : 12) at any
    thickness. (The first draft of this plan said camber stays a fraction of chord;
    uniform scaling is what the owner specified: the foil's thickest point scales to
    the taper.)
  - The foil may be thicker than the tab (e.g. 7.0) and overlap the box slot.
- **Taper (thickness from base to tip):** the thickness at the thickest point of the
  section, as a function of height.
  - Usually straight, then curving near the tip; that curve is how flex is controlled.
  - Example: if the taper says 8 mm at 15 mm below the tip, the section there is
    scaled to 8 mm thick.
- **Minimum thickness 0.5 mm** at the leading edge, trailing edge and tip while
  designing, close to a hand-finished edge. Exports have their own minimum, 1 mm by
  default (0.5–3 mm): some 3D printing materials can't hold a thinner wall. (Raised to
  1 mm in the design in October 2026, then moved to the export, as it got in the way of
  seeing the finished fin.) Sections are closed shapes (rounded leading edge, blunt trailing edge), never
  knife edges.
- **Cant:** the lean of the blade relative to the tab, 0–20°, typed by the user. Futures
  builds cant into the fin (FCS builds it into the box).
- **Left / right:** side and quad-rear fins mirror; the inside curve always faces
  inboard.
- **Placement on the tab** (added after the step 5 review; `fin-placement.ts`):
  - **Defaults are rear-aligned:** the trailing-edge root on the tab's rear end, the
    usual convention.
  - **Across the tab:** a flat inside face is flush with the tab, and a symmetric foil
    is centred. A curved inside face (most NACA foils) has its chord line flush, so
    the curve overhangs the tab inboard.
  - **Nudge arrows:** forward / back moves the fin along the tab, with a hard stop at
    the 2.5 mm front overhang and, going back, at the insertion-clearance limit below. Left / right slides the blade
    across the tab, so a strongly curved inside face can be brought back over it,
    within the range that keeps the tab under the foil (its centre plane between the
    root section's faces at their thickest point).

### Insertion clearance (agreed working model; `fin-clearance.ts`)

A Futures fin is fitted rear first: its rear slot hooks the pin at the back of the box,
then the fin rocks down about the pin until the tab seats. While tilted, anything
behind the tab swings toward the board.

Model: pivot at the rear slot's centre (3.3 mm from the tab's rear end, 6.4 mm below
the tab top). The fin must tilt until the tab's bottom-front corner clears the board:
about **9.4° for the side tab, 6.7° for the centre tab**. A point x mm behind the tab's
rear end must then sit at least `(6.4 + (3.3 + x)·sin θ) / cos θ − 6.4` above the
base: for a side fin, 0.6 mm at the rear end, 2.0 mm at 8 mm back and 3.6 mm at 18 mm back; for a centre or quad-rear tab, 0.4, 1.4 and 2.5 mm.

Agreed with the owner as a working model (defaults are not critical; what matters is
that the raised rear can be edited). Built as the `rear-clearance` rule, which reports
how much to raise the rear, and the backward nudge stops at the last clear position.
A rear-aligned fin with a flat base therefore cannot move back at all. The outline
pane should draw the line dashed behind the tab (steps 10 and 12).

### Readouts

All shown in mm and degrees:

- **Area:** the outline above the tab top; the tab is excluded.
- **Depth.**
- **Sweep:** the angle from the leading-edge root to the tip. Read-only; editing the
  outline changes it.
- **Root chord.**
- **Front overhang,** with a warning past the limit.

### Files

- Save and open `.fin.json` (versioned), plus IndexedDB autosave.
- Export STEP (AP214, mm) and STL (binary, mm).

## Design decisions

- **Placement:** inside the existing packages, not a new package.

  | Package  | New code                                 |
  | -------- | ---------------------------------------- |
  | kernel   | `packages/kernel/src/fin-design/` (pure) |
  | export   | fin STEP and STL writers                 |
  | io       | `.fin.json`                              |
  | store    | `createFinStore`                         |
  | render2d | `FinCurveEditor`                         |
  | apps/web | the `/fin` route                         |

  The route shares the SPA's offline support and desktop build. Splitting it out gains
  nothing under GPL-3.0-or-later.

- **Units:** the kernel stays in cm like the rest of the kernel. Conversion to mm happens
  at the UI, file and export edges. The STEP writer already takes a `unit` option.
- **Cant as a lean of horizontal sections:** each horizontal slice is shifted sideways
  as height increases. Thickness is corrected by 1/cos(cant), so the taper value is the
  true thickness. This keeps the blade root exactly on the tab-top plane. A true rotation
  would tilt the root and need it trimmed against that plane, which cannot be exact in
  STEP.
- **Own curve editor:** `FinCurveEditor` is new, built on `render2d`'s viewport, hit
  testing and drawing. It does not generalise `SplineEditor`, which is about 1.7k lines
  tied to `BoardState` through about 10 actions. Fin curves also need their own rules
  (fixed endpoints, rising edges, overhang limit). The board editor stays untouched.
- **Default fins:** fitted from `docs/specs/fins/side.foil` and `center.foil`, the same
  FinFoil reference outlines behind `fin-templates.generated.ts`.
- **Oracles:** BoardCAD-LE has no fin designer, so the golden-data rule is met with:
  - the tab fixture (step 0);
  - analytic cases (rectangle/triangle area, known sweep, thickness at a station);
  - topology checks (closed shells, every edge shared by exactly two faces).

### STEP topology

As built in step 5 (`packages/kernel/src/fin-design/blade-surface.ts`,
`packages/export/src/fin-step.ts`):

```
blade  3 faces: one bicubic B-spline surface wrapped around the blade, closed in u
       on a seam (outside face, trailing-edge cap, inside face, leading-edge cap),
       plus flat root and tip caps
tab    14 faces: two flat sides, then one face per profile segment: PLANE for a line,
       CYLINDRICAL_SURFACE for the slot end and the R1.0 corner
```

- **One wrapped surface, not two skins.** The minimum thickness makes the edges blunt,
  so each section is a closed loop with four corners. One surface with C0 knots at
  the corners (`uBreaks`) shares its edges with itself and the caps exactly, the way
  the board's two patches share the stringer. Corners in the outline or taper crease
  along the height the same way (`vBreaks`, added to `interpolateSurface` for this;
  the board's output is byte-identical).
- **Tip:** sections stop 0.1 mm under the tip and a flat sliver closes the blade. A
  surface pinched to a point is legal but often fails to import.
- **Accuracy:** fitted to 0.05 mm and refined until met. What remains is in the last
  0.2 mm under the tip, at the edge corners (about 0.08 mm on the defaults). CI holds
  the whole blade to the board STEP's 0.15 mm and all but the top 0.5% to 0.05 mm.
- **Touching, not overlapping (changed from the plan).** The plan sank the blade 1 mm
  into the tab. But the root foil is wider than the 6.35 mm tab (8 mm by default) and
  often longer, so a sunk blade leaves a 1 mm lip below the base outside the tab, and
  the fin would not seat. The blade and tab are two solids that **touch on the
  tab-top plane** (z = 0); CAD Combine / Join merges them. A single fused solid is
  still a possible later step.
- **Tab position across the fin:** from `tabCentreY` (flush with a flat inside face,
  centred under a symmetric foil, plus the user's sideways nudge). First built centred
  under the thickest point; changed after review, since a flat inside face is
  conventionally flush with the tab.
- **Orientation** is measured from the geometry, as for the board. Tests read the file
  back and check every edge is used once in each direction per solid, every flat face
  winds counter-clockwise about its outward normal, and every face points out.

The Part 21 encoding moved to `packages/export/src/step-writer.ts`, shared with the
board exporter, whose output was diffed byte-for-byte before and after (12 files:
test board and the three golden boards, in mm, cm and in).

Building this exposed a board STEP bug: the hull loops run clockwise, so hull and caps
use their shared edges in the same direction. Recorded as P46 in `PROPOSALS.md`.

#### Verification

OpenCascade (via `occt-import-js` 0.0.23, run outside the repo) reads each sample as
two closed solids with positive volume; blade volumes agree with the kernel's
integrated section areas to 0.1–0.2% (tessellation reads slightly low), and the tab
volume equals profile area × 6.35 mm exactly.

| date       | app                       | fins                                                  | result                                                                                                     |
| ---------- | ------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-10-15 | OpenCascade (wasm 0.0.23) | side R 7°, side L 20°, quad rear R, centre (defaults) | 2 solids each, closed, volumes match                                                                       |
| 2026-10-15 | Fusion 360                | same                                                  | Imports; Combine / Join gives one body. Review asked for rear alignment and sideways placement (now built) |

Manual pass for Fusion (and any other CAD/CAM): imports without repair; two bodies;
Combine / Join gives one body; depth, root chord and thickness match the designer;
a 3-axis toolpath generates on each side of the blade.

### Related finding (separate fix)

The board STL (`packages/export/src/stl.ts`) writes kernel cm with no unit conversion,
so slicers that assume mm import boards 10× too small. The fin STL writes mm. The board
STL needs its own change, which is user-visible: P47 in `PROPOSALS.md`.

## Build order

Each step is independently testable and committable. The STEP prototype (5) comes
before the UI so the biggest unknown is answered first.

| #   | Step                                                                                                                                                                                                                   | Size | Model                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- |
| 0   | Spec and fixture: `docs/specs/fins/futures-tabs.md` + JSON fixture of the three tabs. The user signs off.                                                                                                              | S    | Opus                 |
| 1   | Kernel: exact tab outline (lines + arcs) per tab type; tests against the fixture.                                                                                                                                      | S    | Sonnet               |
| 2   | Kernel: `FinDesign` model (LE/TE curves, section, taper, cant, side, tab), default fins, rule checks (overhang ≤ 2.5, rising edges, taper ≥ 0.5).                                                                      | M    | Opus                 |
| 3   | Kernel: readouts (area excluding the tab, depth, sweep, root chord, overhang). Analytic tests.                                                                                                                         | S    | Haiku                |
| 4   | Kernel: `bladeSection(design, h)`: closed foil from chord × section × taper, cant lean + cos correction, L/R mirroring, 0.5 mm minimum. Tests: thickest point = taper value; L/R mirror exactly; measured lean = cant. | M    | Opus                 |
| 4a  | Kernel: NACA 4-digit section generator → inside/outside curves, trailing edge blunted to 0.5 mm. Tests against published NACA ordinates (e.g. 0012, 2412); 00xx comes out exactly symmetric.                           | S    | Sonnet               |
| 5   | **⚠ Riskiest.** STEP of the default fin: blade skins + caps, tab faces, two solids. Part 21 writer extracted with board output byte-identical. Structural tests, plus manual import into Fusion/FreeCAD recorded here. | L    | Opus                 |
| 7   | Kernel: preview/STL mesh, two closed shells. Every edge shared by exactly two triangles.                                                                                                                               | M    | Sonnet               |
| 8   | io: `.fin.json` v1 read/write, round-trip test.                                                                                                                                                                        | S    | Sonnet               |
| 9   | Store: `createFinStore` with undo; pure `fin-edits.ts` enforcing the rules (clamped drags); nudge actions over `nudgeFore` / `nudgeLateral`.                                                                           | M    | Sonnet + Opus review |
| 10  | render2d: `FinCurveEditor` (drag points/handles, rule callbacks).                                                                                                                                                      | M    | Sonnet               |
| 11  | Web: `/fin` route, tab picker, L/R, cant 0–20°, mm readouts, overhang warning, fore/aft and sideways nudge arrows (with keyboard shortcuts in `shortcuts.ts`).                                                         | M    | Sonnet               |
| 12  | Web: outline pane (over the true tab), section pane (both curves; symmetric lock for centre; NACA preset picker), taper pane.                                                                                          | M    | Sonnet               |
| 13  | Web: 3D preview (the `Fins3D.tsx` pattern, `frameloop="demand"`).                                                                                                                                                      | S    | Sonnet               |
| 14  | Web: IndexedDB autosave + save/open `.fin.json`.                                                                                                                                                                       | S    | Sonnet               |
| 15  | Web: STEP/STL export buttons; docs page, `docs/registry.ts`, precache entries.                                                                                                                                         | S    | Haiku                |
| 16  | Export: STL in mm from the step 7 mesh.                                                                                                                                                                                | S    | Haiku                |
| 17  | e2e: load the default fin, drag a point, area and sweep change, STEP downloads.                                                                                                                                        | S    | Haiku                |

Step 6, the single fused solid, is deliberately absent; see above.

### Risks

- **Step 5:** a closed solid that real CAD packages accept. Structural tests catch
  malformed files but not every importer quirk. Manual import into Fusion and FreeCAD is
  the acceptance check, as for the board STEP.
- **Tab transcription (0–1):** the dimensions come from screenshots of box-slot drawings,
  so the user's sign-off on the fixture is the gate.
- **Rising-edge rule (2, 10):** clamping drags must feel natural. If it fights the user,
  revisit slicing along the span line instead of horizontally.

## User testing, round 1

Feedback from the owner's first session on the deployed `/fin`, and the agreed fixes.

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Size | Model                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- |
| R1  | **Done.** **NACA picker bug.** It was an `<input list>`, and the browser filters a datalist by the current text, so after one Apply only that code was offered. Replace with a preset dropdown plus a free 4-digit field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | S    | Sonnet               |
| R2  | **Done.** **Left/right named bottom-up**, the fin makers' convention (the board seen from below, nose up). The geometry is unchanged; the names swap. No saved files need keeping, so `.fin.json` `hand` simply flips meaning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | S    | Sonnet               |
| R3  | **Done.** **⚠ Riskiest. Swappable panes.** Large pane left (profile at first), three small panes right (foil, thickness, 3D); an icon on a small pane swaps it with the large one. The large pane's toolbar holds its view's controls: profile — depth, point tools; foil — symmetric / flat / NACA, point tools; thickness — root thickness, point tools; 3D — side, cant, nudge. Readouts and rule warnings stay visible. Nudge arrows sit directly under the 3D view when it is small. Phones stack the views, large first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | L    | Sonnet + Opus review |
| R4  | **Done.** **Point tools** on every curve: add (midway along the selected span), delete, smooth, corner. NACA presets drop from 17 to 6 points per face (`NACA_SEGMENTS` 5): worst error 0.011% of chord (0.012 mm on a 110 mm chord), measured; 4 points would be 0.065%, 3 points 0.38%.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | M    | Sonnet               |
| R3a | **Done.** **Raised-rear underside.** Horizontal sections below a raised rear ended on its underside, so the underside was the sections' 0.5 mm trailing edges: a thin flap. Now the underside is found (`findRaisedRear`: the outline's end, walking back from the trailing-edge root, while it runs backward and rises at under 45°), and below its corner each section's foil runs over the full chord, to the trailing edge carried down from the corner along its tangent, and is cut off at the underside (`foilCut`). The cut ends form the underside, with the foil's thickness: 4.7 mm at the tab's rear end on the owner's test fin, thinning to 0.5 mm at the corner. Sections stay horizontal, so the surface, mesh and STEP topology are unchanged; the underside gets rows of its own (`raisedRearHeights`) and its own deviation slices. Fins without a raised rear are unchanged. Owner's fin: fit deviation 0.038 mm overall (as before), 0.0096 mm on the underside; OpenCascade reads two closed solids. | L    | Opus                 |
| R5  | **Dropped.** A Fit button: the owner found the existing pan and zoom cover it (right-click pan dropped earlier for the same reason).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —    | —                    |
| R6  | **Done.** **Thickness pane upright:** root at the bottom, tip at the top, to the fin's real height so it lines up with the profile. Needs a view transform in `FinCurveEditor` beyond `yScale`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M    | Sonnet, Opus checks  |
| R7  | **Done.** Docs page, e2e, full CI gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | S    | Sonnet               |

Also found in testing (fixed alongside R1–R3): the 0.5 mm minimum was a plain max(t, 0.5 mm),
which left a visible crease where the foil ran down to it, along the trailing edge and at the
tip. The padding now blends in over a 0.5 mm thickness band (`padThickness` in `blade.ts`, a C2
polynomial smooth max that is exactly 0.5 mm at zero foil thickness). Each section is scaled
through its inverse (`unpadThickness`), so after padding the thickest point is exactly the
taper's thickness, and near the tip the foil shrinks smoothly into a uniform 0.5 mm slab instead
of switching to a plain max. The foil is untouched where it is 1 mm or thicker. The blade fit
also closes its seam exactly now (the shared surface solver reproduces the loop's ends only to
~1e-15 cm).

## User testing, round 2

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Size | Model |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----- |
| S1  | **Convex to the edges.** The 0.5 mm minimum was padding where the foil was thin, which left the last few percent of the chord parallel-sided (a flat). Now the foil is scaled to the taper less the minimum and the minimum is added all the way along (symmetric: half each face; otherwise the outside), so faces stay convex to edges that end at 0.5 mm. The thickest point is still exactly the taper. Replaces `padThickness` / `unpadThickness`. NACA proportions now hold above the minimum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | S    | Opus  |
| S2  | **No creases from sharp outline bends.** Stretching the foil edge to edge on horizontal slices ties every point to both edges, so a sharp bend (the owner's hooked tip: the trailing edge turns from vertical to nearly level 97 mm up) shifted whole slices at once and creased the blade right across. The foil is now laid over smoothed copies of the edges (`foilEdges`: a Gaussian-weighted local line fit over 5% of the chord, exact for straight edges, pushed outward so it never lies inside the blade), and over the last 30% of the chord at each edge it is drawn back to the real edge (`FIN_EDGE_PIN`, a C2 blend), so edges end at exactly 0.5 mm. A first version cut the foil off at the real edge instead; in Fusion that bulged the trailing edge wherever it bent (up to 1.6 mm), so cutting now applies only on a raised rear's underside (`findRaisedRear`, restored from round 1 for that alone, fading out 3 mm above the corner), which keeps 2.5–2.6 mm at the tab's rear end. On the hooked tip the face's worst bend across the turn fell from 19 /cm to 3 /cm up to 30 mm behind the tab; in the last 5–15 mm before the edge it follows the edge's own sharp turn. Rows, mesh rings and deviation slices are spaced by how far the edges travel (`bladeRowHeights`), not height. STEP fit: defaults 0.022–0.028 mm, the owner's raised-rear fin 0.022 mm (was 0.038), the hooked tip 0.078 mm, all in the top 1% of the height; OpenCascade reads every file as two closed solids. | L    | Opus  |
| S3  | **A raised rear behind a steep root.** The owner's twin fin's root handle points nearly straight up, so its outline leaves the trailing-edge root steeply for about 1.5 mm before turning back along the underside. `findRaisedRear` gave up on a steep start, so the 15 mm underside was the sections' 0.5 mm trailing edge: a thin flap with a crease along it and a spike at the corner. It now allows a steep lead-in of up to 3 mm of rise (`REAR_LEAD`) before the underside; longer than that it is still a trailing edge rising from the root, so the default fins are unchanged. The twin's underside now keeps the foil's thickness (2.2 mm near the root, thinning to the corner); up upright lines through the corner region the worst change in thickness slope fell from 0.31–0.40 /mm to 0.03 /mm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | S    | Opus  |
| S4  | **No ridge above a raised rear's corner.** Owner's keel: a ridge across the blade at the rear corner. Two causes. (1) The keel's underside curls up into a sharp point, turning steeper than 45° 2.1 mm short of it, so the corner was found short of the point and the point's kink lay in the trailing edge above; a sharp point within `REAR_LEAD` of rise past the turn, still running back, is now the corner. (2) The hand-over above the corner, from the foil running on to the underside's cut to being drawn in to the trailing edge, reaches a third of the chord forward but took only 3 mm of height; `FIN_REAR_FADE` is now 10 mm (6 mm halved the ridge, 15 mm and more gained nothing). The trailing edge is a little thicker just above the corner (keel 0.84 mm 3 mm up, the minimum again 10 mm up). Sharpest bend in thickness going up just in front of the corner: keel 6.39 → 0.60 /cm, twin 2.43 → 0.62 /cm. STEP fits unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | S    | Opus  |
| S5  | **Corners in an edge stay at the edge.** Owner's test fin (`docs/specs/fins/corner_creases.fin.json`, four sharp corners in the trailing edge): a crease across the blade at each corner's height. Over the last 30% of the chord (`FIN_EDGE_PIN`) the foil was drawn to the real edge, whose position on the foil kinks at a corner, so the kink was carried a third of the way across. Now in two steps: across that stretch toward where the edge sits _smoothed up the blade_ (`FoilEdges.smoothFrom/smoothTo`, Gaussian like the edges), then over the last 3% (`FIN_EDGE_LAND`) exactly onto the real edge, so edges still end at exactly the minimum and a raised rear's cut is kept. Slope jump through each corner's height, 5 and 10 mm ahead of it: 1.0–2.7 → 0.13–0.37 mm/cm; unchanged 30 mm ahead (already 0.05–0.09). Costs about 5 ms per edit (edge smoothing 20 → 25 ms on the keel). The test fin's STEP fit is 0.022 mm (was 0.006): the foil now turns more sharply in the last 3%. Repeating the push that keeps the smoothed edges outside the real ones (instead of clamping at the last step) was tried: it doubled the edge cost for no visible change, so it was left out.                                                                                                                                                                                                                                                                                                              | M    | Opus  |
| S6  | **No flat or bulge at the top edge.** Owner's keel in CAD: a flat in the top edge with a bulge beside it, and specks along it in the 3D view. Two causes. (1) The sections stopped 0.1 mm under the tip and a flat cap closed the blade there, but under a rounded top the chord closes slowly: that cap was 8.1 mm long on the keel, 5.6 mm on the twin. They now stop where the chord is at most `FIN_TIP_CAP` (1 mm), or 0.1 mm under the tip if that is shorter (`bladeTop`), in the STEP and the mesh. (2) Where the wide step of S5 carries the foil past the real edge, the 3% land draws it back, and drawing back more than about half its width ran the foil backward: folded over and clamped at the minimum, a bulge then a flat. Under a rounded top the edge runs nearly level and sits well inside its smoothed place, so it folded there: 0.07 mm deep on the keel and twin, and up to 0.05 mm at the test fin's corners. A land drawing back now widens to 15/8 of what it draws back (the ramp's steepest slope), so the foil never runs backward; no fold on any starting fin or the test fin, and S5's corner figures are unchanged. The faint ring-by-ring shading that remains along a level top under close zoom is the preview mesh, not the shape.                                                                                                                                                                                                                                        | S    | Opus  |
| S7  | **A raised rear behind a tall steep start.** Owner's A4C (`docs/specs/fins/a4c_raised_rear.fin.json`): the bottom of the trailing edge pinched. The outline rises almost straight up off the trailing-edge root for 6.9 mm before running back 30 mm along the underside, but only a 3 mm steep lead-in (`REAR_LEAD`) was allowed, so no raised rear was found: the underside was trailing edge, drawn to the minimum (0.5 mm) behind 5.6 mm of foil. A taller lead-in now counts if the underside then runs back further than the lead-in rose. That keeps the side and quad-rear fins out (steep for 65 and 52 mm, then a shallow sweep of 23 and 18 mm into the tip, which never forms a corner anyway); every starting fin's detection is unchanged. The A4C's trailing edge now keeps the foil's thickness at the base (5.6 mm) and thins up the underside to its corner, 16 mm up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | S    | Opus  |
| S3  | **No crease line at outline corners.** The STEP fit creased the whole blade (a C0 knot all the way round) at the height of every corner point in the outline, which Fusion draws as a line across the blade. With the foil laid over smoothed edges only the edge itself has the corner, so outline corners no longer crease the surface (taper corners still do: they kink the thickness across the section). The fit turns each edge corner between rows packed around every outline point's height and above the root (±0.05–4 mm), and its v-parameters follow the edges' travel (`SurfaceFitOptions.vParams`, new and unused by the board, whose output is unchanged) instead of averaging over every point of the section, which let the many points that barely move outvote a trailing edge running nearly level. Dense check (200 slices × 157 points): defaults ≤ 0.019 mm, the owner's fins ≤ 0.038 mm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | M    | Opus  |

## The foil sweep (owner proposal, 2026-10)

Horizontal sections meet any edge that runs near level at a glancing angle: S2–S5 and the
hatchet's hook fix (#45) were all patches for that. The blade is now foiled the way a foiler
works it (`swept-loft.ts`): a Coons patch over four sides — the base (the root, plus a raised
rear's underside), the leading edge, a tip line across the tip and the trailing edge —
relaxed (over-relaxed Gauss–Seidel, stopped at the last pass with no folded cell) so a
corner in a side fades within a few sections. The root foil is laid along each section by
length, its thickest point on the thickness path (three points, base, halfway and tip line,
quadratic between), as thick there as the taper at that point's height; past the tip line
the tip is lofted to the minimum at the tip edge (below); the grid's cap rows, which blend from the tip line out to the tip edge itself, only find where a point is. A slice acts within `FIN_SLICE_REACH` (15% of the depth) of its height. Each sweep row lays the base and tip foils on its thickness path separately, each as a fraction of its own thickest, and blends the two (`rowFaces`, `SweptBlade.ends`/`foilW`); it used to blend the foils first and lay the blend by where it was thickest, which jumped between rows where the blend had two humps nearly as high (owner testing: a base foil thickest at 32% and a tip foil at 49%, a 1.1 mm step across 3 mm of a cut 152 mm up; `docs/specs/fins/swept_back_two_foils.fin.json`). Fins whose tip foil is the base foil are unchanged. On a heavily swept-back fin the thickness curve is read along the sweep (`rowThickness`, `SweptBlade.sweepEta`: the thickness path's length out to each row, then on across the tip to its edge), as far as the path rises little over its length (`thicknessAlongSweep`: rise over length 0.72 and up by height exactly as before, the default and owners' fins at 0.75–0.79; 0.55 and below along the sweep; the owner's swept-back fin 0.58, read 97% along). Read by height, its arm, reaching back to the tip over little height, kept its full thickness to the tip line and fell to the minimum in the last 20 mm (owner testing, with a slice that pinched against it). Steering the thickness path through slices' thickest points was tried first: it halved the tip's bulge at the slice's height and left the pinch, as the conflict was the arm's thickness, not where it was thickest. The arm now comes out thicker where the curve, read along the sweep, says so (7.6 mm at 177 mm up, was 6.5); a slice shaped against the old arm still pinches against the new one near the tip line and is best made again. A raised rear's corner must be in the lowest quarter of the fin (`FIN_RAISED_REAR_MAX`; the owners' are 3–13% up): a trailing edge that leaves the root steeply, bulges forward, then sweeps back gently to a hooked tip read as an underside up to 80% of the depth, and the base ran up it, a section standing almost upright from the base (owner testing). The owner suggested a "base overhang" point as a manual alternative, preferring detection; kept as detection. The top counts as tip (owner's rule 3): the default tip line's leading-edge end is no further round than where the leading edge, walked up over its top half, first runs within `FIN_TIP_TURN` (20°) of level (`leadingTurn`, `tipTurnFraction`). A moved tip line goes where it is put: holding a dragged end there too, the end seemed frozen to the owner. Left on the leading edge, a long, flat top swept steep sections from it down to the hook, and every cut near the top was thickest toward its trailing edge (owner testing; 74% of the chord 94 mm up on the owner's fin, 38% now). A 30° turn put it 88 mm up there and thinned the top too much. The cost: by a sharp trailing-edge corner the sections now run near level, and its crease reaches about 5 mm in from the edge instead of 2.5 mm (the corner test fin's 45 mm corner). Past the tip line the tip foil carries on out to the tip edge (`sweepFaces`, the owner's tip rules): each point takes the tip foil where it falls square to the tip line, rounded down by a quarter cosine of how far it is from the tip line toward the edge (`tipReach`, tabled along the line). So it is thickest at the tip foil's high point, rounds off to the edge round the middle, is the tip foil's front and back halves toward the line's ends, and leaves the tip line level, meeting the sweep with no crease. Lofted instead on spokes from the high point (fc288c5), the tip met a long, steep tip line at an angle along most of it: owner testing saw a square end to every cut crossing it. A slope cap on the thickness near the edge was tried before that and left a divot. Thickness (`sectionThickness`) is the thickness curve's at the height of the section's thickest point, thinning with the curve above that height and never thicker below it, eased over about a millimetre so the thickness path doesn't crease; the tip takes the same with the tip foil's high point as its peak. Owner testing went through both simpler rules. At the thickest point's height alone, slanting sections carried that thickness up to their high end: a step at the top of the tip, and a fuller (convex) curve fattening the tip. At each point's own height, the steeply slanting sections near the tip came out much thicker at their low end, a thick band along a hooked tip's trailing edge. An asymmetric foil's leading- and trailing-edge points move across the chord (owner's request, to blend twists; every foil, the root's too, by the owner's choice): both faces' ends move together (`withFinCurve`, `withEdgesOf`), so the edge stays closed; a symmetric foil's stay on the chord line (`edgesFree`, the owner's choice over making it asymmetric), and making a foil symmetric or flat inside puts them back (`setInsideFace`). The rule is now that the faces meet at x 0 and 1 (`checkFoil`). The offset is part of the foil's shape, so it scales with the thickness like the rest of it, and fades to the chord line round the tip edge with the tip's rounding. The loft's edges off the base used to be the minimum on the chord line whatever the foil (`sweptFacesAt`); they now read the foils' own edge (`sweepFaces`, along 0 or 1), identical for edges on the line. Without that, a root foil's moved edge reached 3% of the chord from the edge and stopped (0.6 mm moved there, the edge not at all). New slices copy the edge (`fitShape` passes the faces' meeting point to `fitFace`). A horizontal slice (owner's rules) starts as the fin's own section at its height (`bladeFoilAt`, fitted with as few points as follow it to 2% of its thickness, square to the face: `FIT_TOLERANCE`; owner testing found seven points where one between the edges drew the same curve. At 1%, and measured as height, the fit added points for misses no one could see: at a steep nose, and at a thick trailing edge's drop, whose slope it copied, so the last stretch bent. It now fits the trailing edge's slope: three points on the default fin, as its foil, and four on the owner's two-foil swept fin, was 9. Adding one now moves the fin by up to 0.1–0.2 mm, mostly at the very nose, was 0.05), and is applied as its difference to the fin without slices there (`SliceRef`, `slicesAt`), both as fractions of their thickest, scaled with the thickness curve: so adding one changes nothing, and reshaping it changes only what was reshaped. Moving a slice repositions it, as the analysis cut moves (`sliceFoilMovedTo`): the fin's section at its new height, plus what the slice was reshaped by at its old one (as fractions of the thickest, up to the tip line; under 3%, square to the face, counts as not reshaped: `RESHAPED`, measured as height the A4C's untouched slices read as reshaped). A drag carries the slice as the drag found it at every step, so fitting errors don't build up. Kept as it was when dragged, a slice added halfway up and taken to the tip carried the section from halfway up (owner testing). Laid along the chord as a foil of its own, an unedited slice near the tip turned the tip's foil round (owner: "applied upside down"), and laid with the sweep's thickest point, still reshaped the fin. Where its chord crosses the tip line, the part past it is the tip's (`sliceFreeSpan`): the slices fade out over 5% of the depth toward the tip line (`SLICE_TIP_FADE`, by distance; squeezed into the chord short of a nearly level tip line, a slice changed sharply within a millimetre of height there), the foil view shades it. Its points there are not locked (owner testing: with the tip line moved forward, most of a slice's points sat in the locked part and wouldn't move); they move but change nothing. Each slice crossing the tip line gets a point at the crossing in its own foil and in the tip foil (`withCrossingPoints`, on adding a slice and at the end of any drag; shape-preserving splits), and each foil view shows the other there as a reference dot (`sliceTipCrossing`): green in the slice for the tip, aqua in the tip foil for the slice, so the owner matches them by hand. The green dot used to be dragged to scale the whole tip foil (`tipScale`). Nothing in the editor set it after that, but the loft still eased the thickness to it at the tip line: on the owner's hatchet (0.61) the upper blade was up to 1.8 mm thinner than its thickness curve (3.7 mm at 106 mm up where the curve says 5.3), out of sight. It is gone, the owner's choice: the thickness curve alone sets the thickness, and files drop it when read. A crossing point is now taken out when its crossing moves on (`withCrossingPoints` with the design before the drag), where taking it out changes nothing: each tip line or slice drag left one more, three or four a few percent apart in the owner's tip foil. A point dragged since stays. The foil view draws any foil true to scale (`foilTrueScale`, now in the store): kept within four times either way, it drew a tip foil stored at a twentieth of its thickness flat (only a foil's shape counts, so one can be stored at any thickness). That thinness came from the view itself: its stretch, the true thickness over the stored one, was read afresh at every step of a drag, so dragging a point down thinned the stored foil, the stretch grew, and every other point and handle moved under the pointer; drag after drag the owner's tip foil went from 0.5% of its chord to 0.00001% (a stretch of 737,000), and the view's frame, given in the foil's units and stretched with it, zoomed far out. The stretch is now held through a drag, the frame is on screen (`SECTION_FRAME` over the stretch), and a foil stored more than four times off its true thickness is stored at it on loading and after each drag (`withFoilsNearTrueScale`; the blade unchanged, 2e-9 mm on the owner's hatchet). A fin may set its own minimum thickness (`FinDesign.minThickness`, owner request, after a printed fin's edges): the thickness view's Min thickness box, 0.5 to 3 mm (`FIN_MIN_THICKNESS_LIMITS`; never under 0.5, enough edge for CAD to read the surface as closed), 0.5 when absent; `.fin.json` writes it in mm. `prepareBlade` takes the larger of it and an export's minimum, so everything that builds the blade follows; the taper rule, the dashed line and its label read `finMinThickness`. Setting it (`setMinThickness`) moves a taper tip that sat on the old minimum to the new one, handles and all, and lifts anything left under it. The editor's design-level helpers share one prepared blade per design (`designBlade`), where each built its sweep afresh. Toward an edge thicker than the minimum (a raised rear's underside) a slice lays its own foil instead of its difference, over the last 10% of the chord: carried from its height, the difference ran into that edge as a cliff (the A4C's slice sits just over its corner). The cost: the A4C, whose curve falls steeply to the minimum over its last few millimetres, takes several seconds to fit as a smooth surface for STEP. `bladeSection` reads this
thickness field along the horizontal chord, so the mesh, STEP fit, analysis and panel fit
are unchanged. Horizontal slice foils blend in around their height (`sliceWeight`: from the
base to the first slice, held between slices, back to the sweep over their reach above;
eased out by the tip line instead, a slice just under it handed back within 2 mm, a kink); a slice's
cant and toe ease over the whole span from the anchor below, with no transition zone. The
edge smoothing (`foilEdges` smoothing, `FIN_EDGE_PIN`, `FIN_EDGE_LAND`, the land
widening, `FIN_REAR_FADE`) is gone. Files are version 3, with optional `tipLine`,
`thicknessPath` (and `tipScale`, since dropped). Volumes stay within 2% of the horizontal loft on every fixture; a
horizontal cut near a raked tip is thicker toward the trailing edge than before, as the
sweep's sections there lean.
| T1 | **Raised-rear twist.** Owner saw a distortion where a raised rear's underside turns up into the trailing edge. Measured on finely sampled sections, the true shape there bends no more than elsewhere (≈3.5 /cm); the visible fault was the fit: its worst error, 0.07 mm, sat on the narrow trailing-edge strip just below the corner. The denser rows of S3 bring it to ≤ 0.038 mm. The thick-to-thin switch stays above the corner (3 mm, `REAR_FADE`): moving it below made a real kink (56 /cm), and longer fades thicken the edge above the corner more (0.71 mm at 3 mm, 1.05 mm at 10 mm). | S | Opus |

## Foil slices

Asked for in round 2 testing, as manual control where the automatic shape needs help.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Done |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| T2  | Model: `FinDesign.slices` (height as a fraction of the depth, and a foil), lowest first, at least `FIN_SLICE_MIN_GAP` (2%) apart and from the root and tip; rules check every slice's foil and name it. `.fin.json` version 2 adds `slices`; a fin without any is still written as version 1, so it opens in the designer before slices.                                                                                                                      | ✓    |
| T3  | Blade: `foilAt(design, eta)` blends the foils either side with `smoother` (6t⁵ − 15t⁴ + 10t³), easing flat into each slice, so the shape changes smoothly through it (no line at a slice); above the top slice it stays as that slice. Each height scales its own blended foil to the taper, its thickest point found per height; the 0.5 mm share between faces blends too (½ symmetric, all outside otherwise). STEP, STL and the preview need nothing new. | ✓    |
| T4  | Profile: **Add slice** (halfway up the biggest gap); slices drawn as level guides, dragged to move (one undo step per drag), picked to select their foil (`FinCurveEditor` `guides`).                                                                                                                                                                                                                                                                         | ✓    |
| T5  | Foil view: tabs (Root, then each slice by height), **Remove slice**; NACA, inside face and point tools act on the selected foil (`activeFoil` in the store; `getFoil` / `withFoil`).                                                                                                                                                                                                                                                                          | ✓    |
| T6  | Thickness view: the same guides, at the fraction of the depth, draggable.                                                                                                                                                                                                                                                                                                                                                                                     | ✓    |
| T7  | Docs (Foil slices section), e2e (add, shape, export, save as v2, reopen), full gate.                                                                                                                                                                                                                                                                                                                                                                          | ✓    |

## FCS single tab base

Asked for by the owner for small canard fins, which plug into an FCS 1 style single plug.

- `FinDesign.base`: `futures-side` (Futures 3/4"), `futures-centre` (Futures 1/2"), `fcs-single`. Each position defaults to its Futures tab (`defaultFinBase`); `.fin.json` writes `base` (version 2) only when it differs.
- FCS single tab (`fin-tab.ts`): a plain block, 20.5 mm long × 13.5 mm deep × 6.35 mm thick, held by a grub screw in the side of the plug (no notch or slot). It drops straight in, so the Futures front-overhang limit, the rear-pin clearance rule and line, and the clearance stop on nudges don't apply. Instead the tab must sit wholly under the blade's root (`tab-cover`). The plug carries the cant (0°, 5° or 9°), so the fin has none (`cant` rule; the field is greyed out). A flat inside face sits flush with the tab, as on Futures.
- `placeOnBase`: moving onto FCS centres the root over the tab and zeroes the cant; moving onto Futures rear-aligns the fin.
- STEP/STL/preview take the tab from `finTabOutline(base)`; OpenCascade reads the FCS block as an exact 20.5 × 13.5 × 6.35 mm solid (1757.4 mm³).
- Canard starting fin (`defaultCanard`, New fin → Canard, left / right): the owner's canard (69.3 mm base, 80.6 mm deep, 8 mm root, flat inside), on the FCS tab, centred, no cant. `FinStart` (a position or `canard`) is what New fin takes.

## Front overhang 4 mm

The owner measured production fins whose leading-edge root overhangs the tab's front by more
than 2.5 mm: the base foil clears the box's grub screw. `FIN_MAX_FRONT_OVERHANG` is now 4 mm
(it was 2.5 mm in the requirements above). Futures tabs only; the FCS tab has no front limit.

## Weight-saving holes in Futures tabs

Four round-ended slots through both Futures tabs (spec: `docs/specs/fins/futures-tabs.md`,
"Weight-saving holes"; `FUTURES_TAB_HOLES`), always cut. Tab outlines gain `holes` (closed,
clockwise loops of lines and arcs). The mesh triangulates the tab's sides with
`triangulateWithHoles` (each hole bridged to an existing point, so faces still meet edge to
edge) and walls the holes; STEP gives each side face inner bounds (`face(..., holes)` in the
shared writer, unchanged output without holes: a board STEP diffs byte-identical) and each
hole a plane or cylinder face per segment. OpenCascade: each tab loses 2900 mm³ (expected
4 × (8·8 + π·4²) × 6.35 = 2902.5 mm³), 30 faces.

## R & L pairs

An **R & L** checkbox beside Save and Export (fins with a side only; remembered per device as
`bs.fin.pair`). Ticked, Save, ⌘S, Export STEP and Export STL each write the fin and its mirror
for the other side (`finsToWrite`: the same design with the other hand, which the kernel builds
as an exact mirror), two files spaced by `MULTI_DOWNLOAD_GAP_MS` so browsers keep both.

## Toe correction

For a box set at the wrong angle to the stringer. `FinDesign.toe` (deg, ±`FIN_MAX_TOE` = 5,

- is more toe in: the leading edge toward the stringer, hand-relative so R & L pairs match).
  Each section is turned about the upright axis through the centre of the root's thickest point
  (`toeTurn`: x along the root chord at the foil's thickest fraction, y midway between its faces),
  so slices stay horizontal and the root stays on the tab top. The 3D view's toolbar has toe
  in/out (0.25° a click), a typed field, and **From above** (looking down the blade, an orange line
  along the tab's axis). `.fin.json` writes `toe` (version 2) when it isn't 0. Rules on the root
  (front overhang, clearance) still read the outline before the turn: at 5° the leading-edge root
  moves a few tenths of a millimetre.

## Bent and twisted upper blade (slice cant and toe)

`FinSlice.twist` (`FinTwist`: cant −20…20° (may be negative), toe ±5°, transition: a fraction
of the depth). `twistAt(design, eta)` walks the slices: below a slice's transition zone the blade
keeps what it had, through the zone it eases to the slice's values (`smoother`, C2), above it
holds them. Lean becomes height-dependent: the lateral slide is the integral of tan(cant) up the
blade (`slideAt`, Simpson per step on the edge-sample grid), the horizontal widening is
1/cos(local cant); a slice's own toe (its toe less the fin's) turns each section about that
section's centre of area (the faces' midpoint weighted by thickness along the chord), before
the fin's toe turns everything about the root's. It used to turn about the thickest sampled
station: the station jumped from one to the next up the blade, and the turn stepped the section
sideways, grooves every few millimetres up the owner's hatchet (1.5° less toe at its slice,
0.068 mm steps between cuts 0.2 mm apart, in the STEP too;
`docs/specs/fins/hatchet_slice_toe.fin.json`). Found between stations it still stepped 0.05 mm:
on that flat-topped foil the thickest point runs across a seventh of the chord in 3 mm of
height, back and forth. About the centre: 0.001-0.006 mm, as with no toe. Adding a point no
longer lands on one the curve has (`insertKnotAt`: a split at a span's end, or on an empty
span): the + button then copied the empty span again at every press, thirty points stacked on
one in the owner's tip foil. Loading a design makes stacked points one (`withoutStackedPoints`). Fins without
any twist take the old code path unchanged. The 3D toolbar gets a **Slice** selector (shared
with the foil tabs): with a slice selected the position arrows (and arrow keys) are off, and cant,
toe and **Transition below slice** (mm; 10 mm to start, never below the slice beneath) set its
change; **No change here** removes it. `.fin.json` writes `twist` per slice. STEP: a side fin
with 12° cant and −1° toe above 60% over a 15% zone fits within 0.0089 mm (dense check) and
OpenCascade reads two closed solids.

Not ours: the console's `THREE.Clock` deprecation comes from `@react-three/fiber` (harmless,
goes with a fiber update); `share-modal.js` is not in the repository, most likely a browser
extension.

## UI and copy review, round 1 (owner review, 2026-11)

A review against Robin Williams' The Non-Designer's Design Book (proximity, alignment,
repetition, contrast, type) and a copy inventory; the owner approved every recommendation and
a glossary. This round is the clear-cut set; the layout changes (header and its Export menu,
phone header, the 3D controls and small 3D pane, the status bar's warnings, one meaning per
colour, selected toggles vs primary buttons) are mocked up first.

- **Glossary** (owner): the fin system selector is **Tab** (was Base); **Base** is where the
  blade meets the tab, replacing "root" everywhere users see it (Base thickness, Base length,
  Base / Tip, Base foil / Tip foil); **Profile**, **Foil**, **Thickness** (not outline, Foil
  section, taper); **Slice** ("Add slice", "Twist at", "Slice at 50 mm"); **Rake** (the
  readout was "Sweep"); **Export minimum thickness** vs the fin's **Min thickness**; **Export
  core**; "problem" in the app. Code names and the `.fin.json` format keep the old words.
- Canvas text is drawn in Instrument Sans at 12 px (`FIN_CANVAS_FONT`); the editor redraws once
  the font has loaded. Labels are full-strength slate (`FIN_CANVAS_LABEL`, 6.5:1; they were at
  70%, 3.8:1).
- The section analysis sliders have a quiet track and an orange thumb (`.fin-range`): the
  filled track read as a progress bar. Both readouts sit in one strip at the bottom, shortened
  ("70.0 mm back · 83.2 mm high · 5.9 mm thick"): in a short pane the right-hand column ran up
  over the toolbar.
- The large pane's title is set apart from its controls; the Outside / Inside split moved into
  the foil toolbar beside Asymmetric, Min thickness into the thickness toolbar beside Base
  thickness. Ranges left the labels for tooltips (Cant, Toe, Cant at slice, with a true minus).
- New fin is a menu; disabled point tools lose their border; the consent banner's Accept and
  Reject have the same weight; File settings' Units row matches the other rows.
- Front overhang reads "none (11.3 mm clear)" rather than a negative overhang. Long tooltips
  were cut to a line, file-opening errors say what was damaged in plain words, and rule
  messages use the glossary.

## UI and copy review, round 2 (the mock-ups, owner review 2026-11)

The owner approved the layout mock-ups with two changes: the tagline moves to the bottom and
reads "A fork of OpenShaper"; and a slice is a **control section** ("Station" was unfamiliar
to a shaper of twenty years; "twist" undersold it, as it sets foil, cant and toe). Phones
are unlikely, tablets likely: touch sizes stay (`pointer-coarse` in the Button), the phone
header was not built.

- Header in three groups set apart by rules: File (New fin, Open…, Save), Edit (Undo,
  Redo), and at the right one primary **Export** menu (STEP for CNC, STL for 3D printing,
  Core to laminate over…, and the left-and-right option, which changes Save too), settings
  and Help. `Menu` takes `triggerClassName` and `panelClassName` for this.
- The 3D tools in titled groups (`ToolGroup`, laid across the toolbar or stacked under the
  small pane by `ToolsLayout`): Placement (Tab, side, Cant, Position), Toe (field, then its
  turn buttons), View (View from above, Panel fit). With a control section selected,
  **Shape at** picks it and its own Cant and Toe replace Placement, which is hidden rather
  than greyed; **Reset cant and toe** takes its change away. The small pane holding the 3D
  view gets a double-height row (`data-3d-slot`), so the model has room beside its tools.
- The status bar: description, measurements, then at the right one chip for warnings and
  problems ("2 to fix"), opening the list with Fit to panel for a panel the fin doesn't fit;
  a hidden live region still reads problems out. "A fork of OpenShaper" sits at its end.
- One meaning per colour, with a key in the help: cyan the profile, the outside face and
  what is selected; violet the inside face; pink control sections (were violet); green the
  base and tip foils; amber thickness; orange limits and warnings only (the analysis planes,
  the tab axis and a panel the fin fits went slate; the slider thumb cyan); red problems.
- Toggles that are on use the Button's new `selected` variant (tinted, outlined), keeping
  solid primary for the one action to press.
