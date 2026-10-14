// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Caller-owned scratch memory and typed-array helpers (design §4.8, §9).
 *
 * geom keeps no module state (decision 14): every `*Into` kernel takes a
 * {@link Scratch} the caller created, so kernels allocate nothing and are
 * reentrant. A scratch is one `Float64Array` carved into fixed regions; the
 * P&T ports in `book/` receive the array and a region offset, so the same code
 * runs on scratch, on a control net or on a knot window without copies.
 */
import { fail } from './errors';
import type { ReadonlyF64 } from './types';

/** Working memory for the evaluation kernels. Opaque: its buffers are internal. */
export interface Scratch {
  /** Largest degree it can evaluate. */
  readonly maxDegree: number;
  /** Highest derivative order it can evaluate (≤ 3). */
  readonly maxDerivs: number;
}

/** Highest derivative order any kernel evaluates (curves: C‴). */
export const MAX_DERIVS = 3;

/**
 * The internal layout of a {@link Scratch}: one array `f` and region offsets.
 * `P` = maxDegree, `D` = maxDerivs; sizes in doubles.
 */
export interface ScratchImpl extends Scratch {
  readonly f: Float64Array;
  /** A2.2 / A2.3 `left[1..p]`: P + 1. */
  readonly oLeft: number;
  /** A2.2 / A2.3 `right[1..p]`: P + 1. */
  readonly oRight: number;
  /** A2.3 `ndu[j][r]`, row stride p + 1: (P + 1)². */
  readonly oNdu: number;
  /** A2.3 `a[s][j]`, two rows of stride p + 1: 2(P + 1). */
  readonly oA: number;
  /** Basis values and derivatives `ders[k][j]`, stride p + 1: (D + 1)(P + 1). */
  readonly oN: number;
  /** Periodic knot window `t_{k−p+1} … t_{k+p}`: 2P. */
  readonly oWin: number;
  /** Gathered homogeneous control points (periodic wrap): 4(P + 1). */
  readonly oPw: number;
  /** Homogeneous derivatives `Aders`, `wders` (A4.2), stride 4: 4(D + 1). */
  readonly oH: number;
  /** Euclidean derivatives `CK` (A4.2), stride 4: 4(D + 1). */
  readonly oC: number;
}

/**
 * Allocates scratch for kernels up to degree `maxDegree` and derivative order
 * `maxDerivs` (default 3, the most any kernel asks for; the extra memory is a
 * few dozen doubles). Reuse one per worker or per loop: kernels never keep it.
 */
export function createScratch(capacity: { maxDegree: number; maxDerivs?: number }): Scratch {
  const P = capacity.maxDegree;
  const D = capacity.maxDerivs ?? MAX_DERIVS;
  if (!Number.isInteger(P) || P < 1) {
    fail('invalid-degree', `scratch maxDegree must be an integer ≥ 1; got ${P}`, { value: P });
  }
  if (!Number.isInteger(D) || D < 0 || D > MAX_DERIVS) {
    fail('unsupported', `scratch maxDerivs must be an integer in [0, ${MAX_DERIVS}]; got ${D}`, {
      value: D,
    });
  }
  return makeScratch(P, D);
}

/** {@link createScratch} without validation, for the allocating wrappers. */
export function makeScratch(P: number, D: number): ScratchImpl {
  let o = 0;
  const take = (n: number): number => {
    const at = o;
    o += n;
    return at;
  };
  const oLeft = take(P + 1);
  const oRight = take(P + 1);
  const oNdu = take((P + 1) * (P + 1));
  const oA = take(2 * (P + 1));
  const oN = take((D + 1) * (P + 1));
  const oWin = take(2 * P);
  const oPw = take(4 * (P + 1));
  const oH = take(4 * (D + 1));
  const oC = take(4 * (D + 1));
  return Object.freeze({
    maxDegree: P,
    maxDerivs: D,
    f: new Float64Array(o),
    oLeft,
    oRight,
    oNdu,
    oA,
    oN,
    oWin,
    oPw,
    oH,
    oC,
  });
}

/**
 * The internal view of a caller's scratch, after the O(1) capacity check every
 * public kernel runs (a contract violation, so it throws).
 */
export function scratchFor(s: Scratch, degree: number, nDer: number): ScratchImpl {
  const impl = s as ScratchImpl;
  if (!(impl.f instanceof Float64Array)) {
    fail('scratch-too-small', 'scratch was not created by createScratch');
  }
  if (impl.maxDegree < degree || impl.maxDerivs < nDer) {
    fail(
      'scratch-too-small',
      `scratch holds degree ≤ ${impl.maxDegree}, derivatives ≤ ${impl.maxDerivs}; ` +
        `needs degree ${degree}, derivatives ${nDer}`,
      { degree, nDer, maxDegree: impl.maxDegree, maxDerivs: impl.maxDerivs },
    );
  }
  return impl;
}

/** Copies `ArrayLike` numbers into a new `Float64Array`. */
export function toF64(a: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]!;
  return out;
}

/** A plain number array copy of a typed array (for JSON). */
export function toNumbers(a: ReadonlyF64 | ArrayLike<number>): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]!;
  return out;
}

/** Checks an output buffer is long enough for `need` values from `o` (O(1)). */
export function checkOut(out: ArrayLike<number>, o: number, need: number, what: string): void {
  if (!Number.isInteger(o) || o < 0 || out.length < o + need) {
    fail(
      'size-mismatch',
      `${what}: output needs ${need} values from offset ${o}; length ${out.length}`,
      {
        offset: o,
        need,
        length: out.length,
      },
    );
  }
}
