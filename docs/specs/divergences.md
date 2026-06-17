# Intentional divergences from BoardCAD-LE

The ledger required by CLAUDE.md principle 2 (golden-data rule, ported phase).
Every place where OpenShaper _deliberately_ differs from legacy behavior gets an
entry here: what changed, why, the magnitude, and the replacement oracle that
proves the new behavior is right. Accidental drift is still a bug — if a golden
test fails and there's no entry here, the code is wrong, not the fixture.

Adding an entry requires:

1. **A better oracle** — analytic cases, convergence tests, or a published
   reference that the new behavior is verified against (legacy stops being the
   ground truth for that value).
2. **Regenerated or re-banded fixtures** — the golden test changes in the same
   commit, with the new tolerance derivation documented.
3. **A row below.**

| Date       | Subsystem                                | What differs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Magnitude vs legacy                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                               | Oracle                                                                                                                                                                                                                                     | Commit                            |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 2026-06-11 | `getVolume` / `getCenterOfMass` (kernel) | Longitudinal integral defaults to `adaptiveSimpson` (relTol `1e-5`) instead of the legacy fixed `VOLUME_Y_SPLITS=30` / `MASS_Y_SPLITS=10` Simpson. Inner cross-section trapezoid unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Volume: ≤ 0.016% vs legacy fixed-split (control-point boards), ≤ 1.3e-4 rel (sLinear longboard). CoM: ≤ 0.072 cm. All well inside the 1% / 0.5 cm golden bands. (The `1e-5` relTol was chosen because `1e-4` still leaves the funboard ~0.18% short of converged; `1e-5` lands within ~1e-4 of the 1e-9 reference.) | Legacy hard-coded 30/10 panels (CLAUDE.md principle 3). Adaptive refines only where the area-vs-x curve needs it, so it is at least as accurate everywhere for ~13–260 integrand calls/board.     | Convergence: adaptive default agrees with a 4×-finer fixed Simpson to < 0.5% (`board.integration.test.ts`) and to < 1e-3 over the sLinear area curve (`board.slinear.test.ts`). Legacy splits still reproducible via `IntegrationOptions`. | feat/adaptive-integration-default |
| 2026-06-11 | `getArea` (kernel)                       | Planshape-area integral defaults to `adaptiveSimpson` (relTol `1e-5`) instead of the legacy fixed `AREA_SPLITS=10` Simpson.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ≤ 0.75% larger than legacy (longboard; shortboard 0.42%, funboard 0.52%) — AREA_SPLITS was the least-converged legacy resolution.                                                                                                                                                                                   | Same as above; `AREA_SPLITS=10` left the longboard's width integral ~0.63–0.75% short of converged.                                                                                               | Adaptive default equals a 1e-9 adaptive integral of the width to < 0.01% (`board.integration.test.ts`); still inside the 1% golden area band. `getArea(b, 10)` reproduces the legacy value bit-for-bit.                                    | feat/adaptive-integration-default |
| 2026-06-14 | `fins` (kernel)                          | Replaces the legacy `BezierBoard.mFins` flat `double[9]` + free-text `mFinType` with a parametric, system-aware `FinConfig` (named setup + fin system + per-fin specs) resolved to geometry on demand by `resolveFins`. Placement is parametric to the board (inset-from-rail follows the outline; base rides the bottom rocker), and FCS II / FCS x2 / Futures / glass-on box footprints are modelled (legacy modelled none). Blade silhouettes (single / noserider / keel / thruster) are traced from FinFoil reference outlines (`docs/specs/fins/*.foil` → `fin-templates.generated.ts`); legacy drew fins as three plain lines. | Total — the legacy default was all-zeros (no usable placement) and stored absolute coords that did not track shape edits. No legacy numeric value is reproduced.                                                                                                                                                    | Legacy fin data was unusable (zeros), absolute (broke on scale/edit), and modelled no fin systems — the rebuild requires editable, system-accurate, shape-coupled fins in 2D/3D and every export. | Analytic: placement, inset/surface coupling, toe geometry, tail-end detection pinned in `fins.test.ts`; `SYSTEM_BOX` pinned to manufacturer hardware dimensions. No legacy oracle (model superseded, not approximated).                    | (this branch)                     |

The sLinear golden **volume** band was relaxed 1e-4 → 1e-2 in the same commit
(`board.slinear.test.ts`), with a convergence-oracle test; the per-station
**area** band stays 1e-4 because the inner cross-section trapezoid
(`SLINEAR_AREA_SPLITS`) is deliberately left legacy-pinned.

## `.brd` writer (`packages/io/src/brd-writer.ts`)

`writeBrd` (the export-to-legacy path, paired with the existing `parseBrd` reader) is
**lossy relative to legacy `board.writers.BrdWriter`**: it emits the geometry fields
(p32 outline, p33 bottom, p34 deck, p35/p36 cross-sections) plus the identity/dimension
scalars our model actually carries (p1–p4 length/lengthOverCurve/thickness/centerWidth,
p7 version, p45 designer, p48 surfer, p49 comments, p51 finType, p54 model). It does **not**
write the legacy CAM/machine scalar fields (cuts, cutter diam, pivots, speeds, margins,
struts, blank/board positions — p11–p31, p43–p47, etc.) or the per-curve guide-point (`gps`)
blocks, because the kernel board model does not represent them.

This is intentional and safe to round-trip: `parseBrd` already treats every one of those
fields as optional (the geometry is rebuilt purely from p32–p36), so `parseBrd(writeBrd(b))`
reproduces the board geometry exactly (pinned in `brd-writer.test.ts`). No numeric golden
value is superseded, so there is no table row above — re-importing a written `.brd` into
BoardCAD-LE simply yields a board with default CAM settings.

## Known candidates (not yet diverged)

- **Junction constraints — unimplemented legacy locks/masks** (see
  `docs/specs/junction-constraints.md`, JC-1…JC-8). The web `enforceJunctions`
  re-snaps positions only; it does not model the legacy per-knot masks, tangent
  locks, or slaves. The gaps, pinned by the "junction-constraint spec (legacy
  parity pinning)" tests in `packages/store/src/edits.test.ts`:
  - **Outline endpoint centreline pin is asymmetric** (behavioural). Legacy JC-1
    fully locks **both** outline tips with `setMask(0,0)`; the port only snaps
    `outline.knots[0]` (the tail, `x = 0`) to `y = 0` and leaves `knots[last]`
    (the nose, `x = length`) free. Under the correct tail-at-x=0 geometry the
    pinned end is the **tail**, not the nose — and the in-code comment that calls
    `knots[0]` the "nose" is the same inverted naming as the stale `board.ts`
    comment (lines ~47/55). Whether the intended pinned end is the nose is a
    deferred design question; if so this is an inverted-by-naming bug.
  - **Endpoint masks not modeled (JC-1/JC-2/JC-3)** — tips are re-snapped
    positionally rather than being un-draggable; no deck/bottom endpoint x-lock.
  - **Tangent-flow locks not modeled (JC-6/JC-7/JC-8)** — no per-handle clamp, so
    a drag can fold a tangent past its endpoint x (or below the tip y).
  - **`adjustCrossectionThickness` y-mask (JC-4 y) not modeled** — section
    endpoint y is never constrained; the thickness-adjust mode is absent.

  These are unimplemented behaviors, not superseded golden values, so they have
  no table row (no better oracle / regenerated fixture exists yet). Promote to a
  table row only once a junction-lock layer is built and verified.

(The former adaptive-integration candidates were actioned — see the table rows
above.)
