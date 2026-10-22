// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `checkBrep`'s volume test against a non-finite measurement (review of S7:
 * `orientBrep`, which refused a non-finite volume, is no longer called by
 * board2, and `checkBrep` tested only `< 0` and `=== 0`, so a NaN passed).
 * The measured volume is replaced by `vi.mock` (no valid solid integrates to
 * NaN through the finite-integrand guard; an overflowing sum or a future
 * integrator change could). Oracle: a solid is accepted only on a finite,
 * positive volume.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boxSolid } from '../testing';
import { checkBrep } from './check';

const measured = vi.hoisted(() => ({ value: 0 }));

vi.mock('./mass', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./mass')>();
  return {
    ...mod,
    signedVolume: () =>
      Object.freeze({ value: measured.value, errorEstimate: 0, evaluations: 0, converged: true }),
  };
});

describe('checkBrep: the measured volume must be finite and positive', () => {
  beforeEach(() => {
    measured.value = 30;
  });

  it('a finite positive volume is accepted (the mock is in place)', () => {
    const r = checkBrep(boxSolid(2, 3, 5));
    expect(r.ok).toBe(true);
    expect(r.signedVolume).toBe(30);
  });

  for (const v of [NaN, Infinity, -Infinity, 0, -1]) {
    it(`volume ${v} is refused`, () => {
      measured.value = v;
      const r = checkBrep(boxSolid(2, 3, 5));
      expect(r.ok).toBe(false);
      expect(r.issues.map((i) => i.code)).toEqual(['brep-invalid']);
    });
  }
});
