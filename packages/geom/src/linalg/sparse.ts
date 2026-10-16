// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compressed sparse row matrices (internal; design §3 `linalg/`): the Gram and
 * fairness matrices of the solver, the DOF map `T` and the reduced system
 * `K = Tᵀ H T` before its envelope factorisation.
 *
 * Built from coordinate triplets ({@link coo}): duplicates are summed,
 * columns sorted within each row. Symmetric matrices are stored with both
 * triangles, so a product and a row scan need no special case.
 */

/** An `rows × cols` matrix in CSR form; `col` is sorted within each row. */
export interface Csr {
  readonly rows: number;
  readonly cols: number;
  readonly rowPtr: Int32Array;
  readonly col: Int32Array;
  readonly val: Float64Array;
}

/** Collects `(i, j, v)` triplets; grows geometrically. A plain record (geom has one class: `GeomError`). */
export interface Coo {
  readonly rows: number;
  readonly cols: number;
  n: number;
  ii: Int32Array;
  jj: Int32Array;
  vv: Float64Array;
}

/** An empty triplet list for an `rows × cols` matrix. */
export function coo(rows: number, cols: number, capacity = 16): Coo {
  const c = Math.max(capacity, 1);
  return {
    rows,
    cols,
    n: 0,
    ii: new Int32Array(c),
    jj: new Int32Array(c),
    vv: new Float64Array(c),
  };
}

/** Appends `A(i, j) += v`. */
export function cooAdd(b: Coo, i: number, j: number, v: number): void {
  if (b.n === b.ii.length) {
    const c = b.ii.length * 2;
    const ii = new Int32Array(c);
    const jj = new Int32Array(c);
    const vv = new Float64Array(c);
    ii.set(b.ii);
    jj.set(b.jj);
    vv.set(b.vv);
    b.ii = ii;
    b.jj = jj;
    b.vv = vv;
  }
  b.ii[b.n] = i;
  b.jj[b.n] = j;
  b.vv[b.n] = v;
  b.n++;
}

/**
 * The CSR matrix, duplicates summed (in insertion order, so the result is
 * deterministic). Explicit zeros are kept: the pattern is structural.
 */
export function cooToCsr(b: Coo): Csr {
  const { rows, cols, n, ii, jj, vv } = b;
  const count = new Int32Array(rows + 1);
  for (let e = 0; e < n; e++) count[ii[e]! + 1]!++;
  for (let i = 0; i < rows; i++) count[i + 1] = count[i + 1]! + count[i]!;
  const pos = count.slice(0, rows);
  const cj = new Int32Array(n);
  const cv = new Float64Array(n);
  for (let e = 0; e < n; e++) {
    const p = pos[ii[e]!]!++;
    cj[p] = jj[e]!;
    cv[p] = vv[e]!;
  }
  // Per row: sum duplicates with a dense marker (stable: first occurrence keeps its slot).
  const mark = new Int32Array(cols).fill(-1);
  const rowPtr = new Int32Array(rows + 1);
  const outJ = new Int32Array(n);
  const outV = new Float64Array(n);
  let nnz = 0;
  for (let i = 0; i < rows; i++) {
    const start = nnz;
    for (let p = count[i]!; p < count[i + 1]!; p++) {
      const j = cj[p]!;
      const at = mark[j]!;
      if (at >= start) outV[at] = outV[at]! + cv[p]!;
      else {
        mark[j] = nnz;
        outJ[nnz] = j;
        outV[nnz] = cv[p]!;
        nnz++;
      }
    }
    sortRow(outJ, outV, start, nnz);
    rowPtr[i + 1] = nnz;
  }
  return { rows, cols, rowPtr, col: outJ.slice(0, nnz), val: outV.slice(0, nnz) };
}

/** Insertion sort of `j[a..b)` with `v` alongside (rows are short). */
function sortRow(j: Int32Array, v: Float64Array, a: number, b: number): void {
  for (let p = a + 1; p < b; p++) {
    const kj = j[p]!;
    const kv = v[p]!;
    let q = p - 1;
    while (q >= a && j[q]! > kj) {
      j[q + 1] = j[q]!;
      v[q + 1] = v[q]!;
      q--;
    }
    j[q + 1] = kj;
    v[q + 1] = kv;
  }
}

/** `out[i] = (A x)_i`. */
export function csrMul(A: Csr, x: ArrayLike<number>, out: Float64Array): void {
  const { rows, rowPtr, col, val } = A;
  for (let i = 0; i < rows; i++) {
    let s = 0;
    for (let p = rowPtr[i]!; p < rowPtr[i + 1]!; p++) s += val[p]! * x[col[p]!]!;
    out[i] = s;
  }
}

/**
 * `out[i·stride + c] = Σ_j A_ij x[j·stride + c]` for `c < stride`: a scalar
 * matrix acting on each coordinate of interleaved points (`A ⊗ I`).
 */
export function csrMulStrided(
  A: Csr,
  x: ArrayLike<number>,
  out: Float64Array,
  stride: number,
): void {
  const { rows, rowPtr, col, val } = A;
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < stride; c++) {
      let s = 0;
      for (let p = rowPtr[i]!; p < rowPtr[i + 1]!; p++) s += val[p]! * x[col[p]! * stride + c]!;
      out[i * stride + c] = s;
    }
  }
}

/** The transpose of `A`. */
export function csrTranspose(A: Csr): Csr {
  const b = coo(A.cols, A.rows, A.val.length);
  for (let i = 0; i < A.rows; i++) {
    for (let p = A.rowPtr[i]!; p < A.rowPtr[i + 1]!; p++) cooAdd(b, A.col[p]!, i, A.val[p]!);
  }
  return cooToCsr(b);
}

/** The dense row-major copy of `A` (tests and the reference solver). */
export function csrToDense(A: Csr): Float64Array {
  const out = new Float64Array(A.rows * A.cols);
  for (let i = 0; i < A.rows; i++) {
    for (let p = A.rowPtr[i]!; p < A.rowPtr[i + 1]!; p++) {
      out[i * A.cols + A.col[p]!] = out[i * A.cols + A.col[p]!]! + A.val[p]!;
    }
  }
  return out;
}
