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
