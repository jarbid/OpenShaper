# NURBS engine: refined plan

Status: **current plan** for `experiment/nurbs-overhaul`, agreed 2026-10-28. It replaces
§6–7 of `geometry-overhaul.md` (Phases 2–6 and the checkpoint protocol) and the rail-law
model in `board2.md`. Those documents stay as history.

## Goal

Fast-track a NURBS editor that supports concave tails and asymmetric boards. Editing and
viewing stay as fast and light as the classic mesh editor; the board's master data and its
exports are NURBS.

## Decisions

1. **NURBS is the direction.** It stays on this branch, behind the "Engine: NURBS
   (experimental)" setting, until the editor is usable. `main` is untouched; Phase 0 stays off
   `main` while it is tested.
2. **Keep and freeze `geom`.** Bug fixes only; new geometry only when the editor needs it.
3. **Curve-driven model.** The shaper edits curves; surfaces are always rebuilt from them. The
   saved board (`.board.json` v2) holds:
   - the outline (half-outline, or left and right halves when asymmetric);
   - the rocker and deck stringer lines;
   - stations, each with a normalised cross-section;
   - bottom features (vee, single and double concave, channels, from `board2`);
   - symmetry and tail settings, and room for later 3D tweaks.
4. **Curves are B-splines equivalent to Bézier chains**, so the classic handles, inspector,
   locks, Tunni points, R/T nudging and undo carry over.
5. **Normalised cross-sections.** A section is stored relative to the board's half-width and
   thickness at its station, so a slice can never change the outline, rocker or deck.
   - Sections blend smoothly along the board (no station creases).
   - Stations can be added and removed.
   - Phase 0 rules hold: centre points fixed, apex moves only vertically, nothing wider than
     the apex.
   - Near a swallow or fish notch, sections run across the rail rather than straight across
     the board.
   - Asymmetric boards have a left and a right half-section per station; the stringer lines
     and features across the stringer are shared. Switching back to symmetric asks which side
     to keep.
6. **One tolerance: 0.5 mm.** Applies to conversion, live mesh against the true surfaces and
   any fitting the export needs. Volume and area come from the live mesh (about 1%); there is
   no exact-integration pass.
7. **Live view is a fast grid mesh** evaluated straight from the surfaces, like the classic
   renderer. Heavy work (trimming, B-rep checks) runs only at export.
8. **Classic files convert almost directly** (copy outline, rocker, deck and slices into
   normalised sections). New boards start from NURBS starter templates.
9. **Same app shell.** The engine setting chooses which board model the existing panes,
   sidebar and 3D view edit.
10. **Retire** the rail-law model (band builder, height grids, offset layer), the S6/S7
    surface-fitting converter, and the remaining Phase 2 checking steps (S5, S8, S9). Git
    history keeps them.

## Milestones

I stop at each boundary with a rough cost; inside a milestone the work runs without asking.

| Milestone      | Contents                                                                                                                                                                     | User test                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **M1 Model**   | Section-based model, symmetric and asymmetric, swallow and fish tails; direct converter; fast live mesh in the existing viewer.                                              | Classic files and the new tail types in 3D; speed. |
| **M2 Editor**  | Classic panes editing NURBS boards: outline, rocker, deck, section editor, bottom features, symmetry toggle, undo, nudging, templates, save v2, share link, session restore. | Shaping real boards.                               |
| **M3 Exports** | STEP (one OCCT check), DXF and PDF from NURBS curves, STL from the mesh.                                                                                                     | Open in Rhino, Fusion, FreeCAD and CAM software.   |
| **M4 Extras**  | Batwing tails, 3D rail handles and soft falloff, quick rail dials.                                                                                                           | Advanced shaping.                                  |

## Process

- Sonnet implements; one Opus review per milestone; a few tests where the maths is subtle; no
  mutation checks; OCCT only at M3.
- Each milestone starts with a half-page design note (below or in its own short file).
- The user tests in the branch preview after each milestone.

## M1 design note

Written at the start of M1 in `docs/design/m1-model.md`.
