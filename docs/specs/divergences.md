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

| Date | Subsystem | What differs | Magnitude vs legacy | Why | Oracle | Commit |
| ---- | --------- | ------------ | ------------------- | --- | ------ | ------ |
| —    | —         | none yet     | —                   | —   | —      | —      |

## Known candidates (not yet diverged)

- **`AREA_SPLITS = 10` (planshape area)** — the least-converged legacy
  resolution: refinement moves the longboard's area by ~0.63% (volume/CoM stay
  < 0.5%). See `packages/kernel/src/board.integration.test.ts`. Becoming the
  default would need the golden area fixtures re-derived from a converged
  integral (`adaptiveSimpson` exists in `math.ts`).
- **Adaptive integration as the `getVolume` default** — blocked by the sLinear
  golden volume band (1e-4 relative, a port-verification artifact). Superseding
  it means re-banding `board.slinear.test.ts` volume to ~1e-2 with a convergence
  oracle, per the process above.
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
