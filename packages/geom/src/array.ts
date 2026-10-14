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
  /** Surfaces: v-direction basis values and derivatives, stride p + 1: (D + 1)(P + 1). */
  readonly oNv: number;
  /** Surfaces: periodic v knot window: 2P. */
  readonly oWinV: number;
  /** Surfaces: A3.6 `temp[s]`, homogeneous, stride 4: 4(P + 1). */
  readonly oTmp: number;
  /** Surfaces: homogeneous `SKLw` (A3.6 / A4.4), 6 slots of stride 4 (`[S, Su, Sv, Suu, Suv, Svv]`). */
  readonly oSw: number;
  /** Surfaces: Euclidean `SKL` (A4.4), 6 slots of stride 3. */
  readonly oS: number;
  /** Surface measures at one point (`MEASURE_*` offsets in surface-measure.ts): 16. */
  readonly oM: number;
  /**
   * Surfaces: control-net offsets of one span pair: the u rows at `[0, P]`
   * (`i · v.count · 4`) and the v columns at `[P + 1, 2P + 1]` (`j · 4`).
   * `Int32Array`, as in sample plans, so the A3.6 kernel stays monomorphic
   * (integer offsets in doubles measured ~20% slower); a view on the same
   * buffer as `f`.
   */
  readonly iw: Int32Array;
  /**
   * Work memory whose size depends on the input (grid bases, dirty-update
   * stamps). It grows on first use and is then reused, so a kernel allocates
   * only when a caller's input outgrows every earlier one: steady-state
   * frames allocate nothing. Owned by this scratch, never shared.
   */
  readonly grow: GrowBuffers;
}

/** The growable part of a scratch (see {@link ScratchImpl.grow}). */
export interface GrowBuffers {
  f: Float64Array;
  i: Int32Array;
  stamp: Uint32Array;
  /** Generation of the last dirty update; `stamp[s] === gen` marks sample `s` as seen. */
  gen: number;
}

/**
 * The initial growable buffers: zero-length, so nothing can ever be written to
 * them (constant module data, decision 14); a scratch replaces them with its
 * own arrays on first use. Sharing them keeps creating a scratch to one
 * buffer (the allocating wrappers create one per call).
 */
const EMPTY_F64 = new Float64Array(0);
const EMPTY_I32 = new Int32Array(0);
const EMPTY_U32 = new Uint32Array(0);

/** Surfaces evaluate to second order: `[S, Su, Sv, Suu, Suv, Svv]`. */
export const SURFACE_SLOTS = 6;

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
  const oNv = take((D + 1) * (P + 1));
  const oWinV = take(2 * P);
  const oTmp = take(4 * (P + 1));
  const oSw = take(4 * SURFACE_SLOTS);
  const oS = take(3 * SURFACE_SLOTS);
  const oM = take(16);
  const ni = 2 * (P + 1);
  const buf = new ArrayBuffer(8 * o + 4 * ni);
  return Object.freeze({
    maxDegree: P,
    maxDerivs: D,
    f: new Float64Array(buf, 0, o),
    oLeft,
    oRight,
    oNdu,
    oA,
    oN,
    oWin,
    oPw,
    oH,
    oC,
    oNv,
    oWinV,
    oTmp,
    oSw,
    oS,
    oM,
    iw: new Int32Array(buf, 8 * o, ni),
    grow: { f: EMPTY_F64, i: EMPTY_I32, stamp: EMPTY_U32, gen: 0 },
  });
}

/** `s.grow.f` with room for at least `n` doubles (contents not kept when it grows). */
export function growF64(s: ScratchImpl, n: number): Float64Array {
  if (s.grow.f.length < n) s.grow.f = new Float64Array(n);
  return s.grow.f;
}

/** `s.grow.i` with room for at least `n` integers (contents not kept when it grows). */
export function growI32(s: ScratchImpl, n: number): Int32Array {
  if (s.grow.i.length < n) s.grow.i = new Int32Array(n);
  return s.grow.i;
}

/**
 * Starts a deduplication pass over `n` ids and returns a fresh generation;
 * `s.grow.stamp[id] === gen` then means "seen in this pass". Nothing is cleared
 * between passes (a wrap of the 32-bit counter clears once).
 */
export function nextStamp(s: ScratchImpl, n: number): number {
  const g = s.grow;
  if (g.stamp.length < n) {
    g.stamp = new Uint32Array(n);
    g.gen = 0;
  }
  g.gen = (g.gen + 1) >>> 0;
  if (g.gen === 0) {
    g.stamp.fill(0);
    g.gen = 1;
  }
  return g.gen;
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
