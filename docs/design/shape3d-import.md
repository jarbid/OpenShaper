# Shape3D import (`.s3dx` / `.s3d`)

How `packages/io/src/s3d-reader.ts` reads a Shape3D board, what went wrong with eight real
pro boards, and what is still left out. Checked against the figures Shape3D stores in each file
(`Length`, `Width`, `Thickness`, `Volume`).

## What the format holds

An `.s3dx` is XML: `<Shape3d_design><Board>`. Inside `<Board>`:

| Element                                                                | Holds                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `<Otl>`                                                                | The outline (plan view). Identical to `curveDefTop2`, the "Apex" curve.                                 |
| `<StrBot>`, `<StrDeck>`                                                | The stringer bottom and the **absolute** deck. `StrBot` equals `curveDefSide0`.                         |
| `curveDefTop1`                                                         | The **rail / tuck line**: a narrower curve, not the outline.                                            |
| `curveDefTop2/3`, `curveDefSide1-4`                                    | Bundles of curves. The first `Bezier3d` is the main curve; the others are guides (Apex, "Deck 1", ...). |
| `<Number_of_slices>`, `<Couples_N>`                                    | The board's own cross-sections.                                                                         |
| `<Calque3D>`                                                           | A 3D layer (a channel, a notch, a leash patch) with its own curves and its own `Couples_N`.             |
| `<Nb_Boxes>`, `<Box_N><Box>`                                           | Fin boxes and plugs.                                                                                    |
| `Length`, `Width`, `Thickness`, `Volume` (dl: divide by 10 for litres) | Shape3D's own figures, the oracle.                                                                      |

Tail at x = 0, nose at +x, as in the rest of OpenShaper. A `Bezier3d` has three polygons
(control points, two tangent polygons); index 0 is a symmetry point.

## The faults

1. **Outline from the wrong element.** The reader took `curveDefTop2`, falling back to
   `curveDefTop1`. Every file has `<Otl>`, equal to `curveDefTop2`. The reader had no `Otl` and,
   on a file without `curveDefTop2`, silently drew the rail line (the 4.3 L midlength came out
   47.27 cm wide against Shape3D's 50.165). Now `Otl`, then `curveDefTop2`, then `curveDefTop1`
   with a warning. The element matcher was also loosened: `<Otl>` matched `<OtlExt>`; a tag name
   now ends at whitespace or `>`.
2. **Layer slices in the board.** `getChildElement` takes the first match anywhere, so the first
   `Couples_N` could be a `<Calque3D>` layer's. Go fish imported the "canaleta fish" layer's 2-point
   slice at 113.9 cm, the long classico a layer slice at 256.7 cm. Layers are now removed from
   `<Board>` before anything is read.
3. **Deck.** In 9.1.1.0 files (`gremilin56`, `hyptocrypto`) the first curve of `curveDefSide4` is the
   **thickness above the bottom**, with its own handles and a longer x range. The same element
   carries further curves, and the last, "Stringer Top", is the absolute deck; the top-level
   `<StrDeck>` always holds that absolute deck, in every writer version. The old reader guessed
   (a deck below its bottom means thickness) and re-fitted bottom + thickness, which got the
   handles wrong. It now reads `<StrDeck>` and needs no conversion. The geometric guess stays as
   the fallback for files without `StrDeck` (the synthetic fixtures, `.s3d`). The thickness guide
   curves are not "off" by themselves: they are a different representation of the same deck.
4. **Fins.** See below.
5. **Converter refusals** (`packages/board2/src/classic/convert.ts`), see below.

## Fins

`<Box>` records are the **hardware**, not a fin:

| Shape3D                                             | Ours                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `Even` = 1                                          | two fins, `side` -1 and +1                                                                                                                  |
| `Central` = 1, or the box straddles the stringer (` | y                                                                                                                                           | `<`Width` / 2) | `side` 0                                                                       |
| `PointCenter.x` - `Length` / 2                      | `trailingFromTail` (`Ref. point` is the tail end of the box)                                                                                |
| `Length`                                            | `base`                                                                                                                                      |
| rail half-width at `PointCenter.x` - `              | PointCenter.y                                                                                                                               | `              | `insetFromRail` (clamped to 0, with a note when the box sits outside the rail) |
| `AngleOz` (rad) x 180 / pi                          | `toe`, positive toe-in toward the nose (checked: on `hyptocrypto` the side box's centre is 0.48 cm nearer the stringer than its tail end)   |
| `Style` 5 / 6                                       | `system` futures / fcs-ii; any other style keeps the FCS II default                                                                         |
| count and roles                                     | `setup`: 1 = single, 2 = twin, pair + centre = thruster (2+1 if the centre box is over 20 cm), two pairs = quad, two pairs + centre = 5-fin |

Blade depth, profile, foil and cant come from the setup's defaults: Shape3D stores no blade.
A box over 20 cm long is drawn as a 22 cm noserider.

Not fins, reported as a `dropped` warning, not imported: `Leash`, `Plug`, `Leash_plug` (style 4,
a diameter, face 0 = deck). **To model them later** we would need a hardware record on the board
(kind, face, centre, diameter, depth), separate from `FinSpec`, plus a place for it in the
exports and the 3D view. The same record would carry the **box hardware** of the fins (`Height`
= pocket depth, `Diameter`, `C1C2` = centre distance of a two-plug system, `CutCNC`), which our
model also does not hold: `SYSTEM_BOX` only knows four fixed systems. `FixedTail` / `FixedRail`
(what the position is anchored to), `PtConvergence` (where the fin lines meet; it does not
reproduce `AngleOz`) and `Color` are not read.

On the eight boards: Trusther 5 (centre + pair, 1 leash plug skipped), diamond twin (pair, leash
skipped), Go fish (pair, plug skipped), gremilin (centre + 2 pairs, leash skipped), hyptocrypto
(centre + 2 pairs, plug skipped), long classico (one Futures 10 3/4" single, leash plug skipped).
The MLC and the Master Trusther have no boxes. The diamond twin's boxes sit 12 cm outside its rail
in the file (stale after a plan edit); they are placed on the rail and a note says so. Resolved
fin centres reproduce `PointCenter` to 0.01 cm.

## Converter (NURBS) refusals

Fixes 1-3 cleared nothing by themselves; the refusals were real converter limits.

- `DIAMOND_TWIN`, "a handle would have to move 1.1 cm": the nose knot ends 0.68 cm wide with a
  handle at y = -1.1, while the curve itself stays above the stringer (its minimum is 0.6 cm). The
  section model needs every control point at y >= 0, and the converter lifted the handle by
  1.1 cm. It now **splits** the segment (de Casteljau, exact) so each piece has a polygon above
  the stringer. A curve that really goes below the stringer is still lifted and, if that is large,
  still refused.
- `gremilin56`, "slice at x = 0.2 has no width": Shape3D keeps a slice at the very tip (x = 0), a
  vertical line where the outline closes. It carries a thickness and no shape. The converter now
  leaves a no-width **first or last** slice out, with a `convert-adjusted` warning; a no-width slice
  anywhere else is still refused.
- `Go_fish`, "centre knots are off the stringer": the leaked layer slice (fault 2). Gone once
  layers are dropped. The notch layer is **not** turned into a swallow tail here.

All eight boards convert and build. A board that cannot be a surface is still refused with the
slice or line and the distance in the message.

## Accuracy against Shape3D's own figures

Length, width and thickness from the kernel's `getLength`, `getMaxWidth`, `getThickness`; volume from
`getVolume(board, { sectionSplits: 100 })` (the default `VOLUME_X_SPLITS` = 10 reads 0.1-0.3% low).

| Board              | Length          | Width          | Thickness    | Volume (L, ours / Shape3D) | Volume error |
| ------------------ | --------------- | -------------- | ------------ | -------------------------- | ------------ |
| MLC 5'10"          | 177.80 / 177.80 | 50.17 / 50.165 | 6.51 / 6.514 | 31.71 / 31.74              | -0.09%       |
| Trusther 5 fin     | 172.72 / 172.72 | 50.80 / 50.80  | 6.62 / 6.676 | 33.50 / 33.50              | 0.00%        |
| Master Trusther 3  | 182.88 / 182.88 | 55.88 / 55.88  | 6.98 / 6.985 | 39.28 / 39.69              | -1.03%       |
| Diamond twin       | 210.82 / 210.82 | 54.00 / 54.00  | 6.98 / 7.001 | 41.61 / 44.26              | -5.99%       |
| Go fish            | 175.26 / 175.26 | 53.34 / 53.34  | 7.43 / 7.049 | 41.28 / 38.50              | +7.21%       |
| gremilin 5'6"      | 165.85 / 165.85 | 50.16 / 50.165 | 6.19 / 6.203 | 29.70 / 29.75              | -0.16%       |
| hyptocrypto        | 176.23 / 176.23 | 52.70 / 52.705 | 6.84 / 6.843 | 35.10 / 35.02              | +0.21%       |
| long classico 9'6" | 288.33 / 288.33 | 59.69 / 59.69  | 7.61 / 7.638 | 80.36 / 78.69              | +2.11%       |

Length, width and thickness are within 1% on all eight, except the Go fish thickness. Volume is
within 1% on four boards (MLC, Trusther 5, gremilin, hyptocrypto) and 1.03% on a fifth. Three are
**not**, and the reasons are not import bugs:

- **Go fish**: Shape3D's thickness (7.049) and volume include the 'canaleta fish' bottom-channel 3D
  layer (1.32 cm deep, tail to 113.9 cm). The bare board is 7.43 cm thick at the stringer, exactly
  the stored deck minus bottom. Matching needs 3D layers.
- **Diamond twin** (-6.0%) and **long classico** (+2.1%): not explained. Both have only five slices,
  94 to 140 cm apart, and the diamond twin's gap is almost all in the nose half (-11% there, against
  -2% in the tail half); the Trusther 5 has four and matches, so the gap alone is not the cause. The
  files also carry rail and apex guide curves that pass through the slices (the diamond twin's `Apex`
  and `Rail` curves hit the slice points), and Shape3D most likely follows them between slices where
  OpenShaper blends the slices by the outline. That is a guess, not tested: using the guides would
  be a new loft, not an import fix, so these two stay open. Their tests pin today's error
  (7% and 2.5%) so it cannot get worse unnoticed.

The plan area (`SurfaceProj`) matches to within 0.6% on every board (0.2% or better on six).

## Still not imported

3D layers (`Calque3D`: channels, notches, patches; they change Shape3D's thickness and volume),
fin and plug box hardware (above), graphics and decoration (`DecoDeck`, `Deco_origin`),
pinlines, stringers (`Stringer_N`), the rail / apex guide curves, and the second and later
curves of `curveDefSide*` / `curveDefTop*`.

## Tests

`packages/io/src/s3dx-import-fidelity.test.ts` (synthetic element choice and fins; the eight real
boards against their stored figures, skipped when `Sample board imports/` is absent) and
`packages/board2/src/classic/convert.test.ts` / `convert.shape3d.test.ts`. The sample boards are
third-party designs and are never committed (`.gitignore`).
