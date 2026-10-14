// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Seeded pseudo-random numbers for randomised tests (design §16: tests use the
 * seeded generator and print the failing seed). Test-only.
 */

/**
 * mulberry32 (Tommy Ettinger, public domain): a 32-bit state generator returning
 * numbers in `[0, 1)`. Deterministic for a seed; good enough for test inputs,
 * not for cryptography.
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
