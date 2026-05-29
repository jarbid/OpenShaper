# Golden reference data

Authoritative fixtures for pinning the TypeScript port (`packages/kernel`,
`packages/io`) to the legacy BoardCAD-LE behavior.

## Files

- `shortboard.brd`, `funboard.brd`, `longboard.brd` — the three reference boards, extracted
  verbatim from the legacy `boardcad/DefaultBrds.java` (the boards the app creates for
  File ▸ New). Native `.brd` text format. **These are the canonical parser test inputs.**
- `golden.json` — **computed** specs (length, widths, thicknesses, rocker, volume, area,
  center of mass, and sampled per-station values) produced by running the legacy kernel
  via `tools/golden-exporter`. Units: cm, cm², cm³. Regenerate with:

  ```sh
  cd tools/golden-exporter
  ../../../boardcad-le/gradlew -p . run \
    --args="../../docs/specs/golden ../../docs/specs/golden/golden.json"
  ```

## Important: stored vs computed values

The `pNN` fields in the `.brd` files include stored convenience values:

| Field | Meaning | Note |
|---|---|---|
| `p01` | length | **ignored on load** — legacy recomputes from the outline spline |
| `p02` | length over curve | stored |
| `p03` | thickness | stored convenience copy |
| `p04` | max width | stored convenience copy |
| `p32` | outline spline control points | authoritative geometry |
| `p33` | deck (rocker) spline | authoritative geometry |
| `p34` | bottom spline | authoritative geometry |
| `p35` | cross-sections (`p36` = longitudinal position) | authoritative geometry |

Because length/width/thickness are recomputed from the splines, **assert the kernel port
against `golden.json` (computed), not against the stored `pNN` fields.** The stored values
are close but not bit-identical to the computed ones.

## Reference board sizes (sanity)

Internal unit is **centimeters**.

| Board | `p01` length | ≈ imperial |
|---|---|---|
| shortboard | 187.96 cm | 6'2" |
| funboard | 228.60 cm | 7'6" |
| longboard | 274.32 cm | 9'0" |

## Known quirk: shortboard missing trailing paren

`shortboard.brd` is extracted verbatim from `DefaultBrds.java`, which is **missing the final
closing `)` for the `p35` cross-section group** (funboard/longboard have it). The legacy
`BrdReader.loadFile` returns `-1` for it (error: "strLine is null") **yet still fully
populates the board** — it parses all geometry before hitting EOF. The values in
`golden.json` for shortboard are therefore valid. The TypeScript `.brd` parser in
`packages/io` should match this tolerance: accept a truncated trailing group, load what's
present, and surface a non-fatal warning rather than discarding the board.

## Tolerances

The kernel uses adaptive refinement instead of the legacy fixed `VOLUME_X_SPLITS=10 /
VOLUME_Y_SPLITS=30`, so volume/area will differ slightly and **legitimately** from the
legacy figure. Suggested tolerances for `kernel`/`io` tests:

- lengths/widths/thicknesses/rocker: within 0.05 cm (geometry must match closely)
- volume/area: within 1.0% (adaptive vs fixed-split integration)
- control-point coordinates on parse: exact (round-trip fidelity)

Document any deviation beyond these and the reason.
