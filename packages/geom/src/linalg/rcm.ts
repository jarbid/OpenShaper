// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reverse Cuthill–McKee ordering (internal; design §3 `linalg/rcm.ts`,
 * decision 21): a symmetric permutation that keeps the envelope of a sparse
 * symmetric matrix small, so its envelope Cholesky factor
 * (`linalg/envelope.ts`) stays cheap.
 *
 * George & Liu, _Computer Solution of Large Sparse Positive Definite Systems_
 * (1981), §4.3: per connected component, a pseudo-peripheral start node
 * (their FNROOT: repeated level structures from a minimum-degree node of the
 * last level until the eccentricity stops growing), then a breadth-first
 * numbering that visits each node's unnumbered neighbours in increasing degree
 * (RCM proper), and finally the whole order reversed. Ties break on the lower
 * index, so the ordering is deterministic.
 *
 * On a plain clamped tensor grid it reproduces the band; it zig-zags round a
 * periodic wrap and keeps the couplings that mirror and `offsetFrom`
 * elimination create local (design §10.4 step 1). Disconnected components
 * (the three axes of a separable problem) are numbered one after the other, so
 * their factors never mix.
 */
import type { Csr } from './sparse';

/** Level structure from `root` inside the unnumbered nodes; returns its depth and the last level. */
function levels(
  g: Csr,
  root: number,
  blocked: Uint8Array,
  level: Int32Array,
  queue: Int32Array,
): { depth: number; lastStart: number; end: number } {
  level.fill(-1);
  let head = 0;
  let tail = 0;
  queue[tail++] = root;
  level[root] = 0;
  let lastStart = 0;
  let depth = 0;
  while (head < tail) {
    const v = queue[head++]!;
    const lv = level[v]!;
    if (lv > depth) {
      depth = lv;
      lastStart = head - 1;
    }
    for (let p = g.rowPtr[v]!; p < g.rowPtr[v + 1]!; p++) {
      const w = g.col[p]!;
      if (w === v || blocked[w] || level[w]! >= 0) continue;
      level[w] = lv + 1;
      queue[tail++] = w;
    }
  }
  return { depth, lastStart, end: tail };
}

/**
 * The reverse Cuthill–McKee permutation of the symmetric pattern `g` (both
 * triangles stored; values ignored): `perm[new] = old`.
 */
export function rcmOrder(g: Csr): Int32Array {
  const n = g.rows;
  const degree = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let p = g.rowPtr[i]!; p < g.rowPtr[i + 1]!; p++) if (g.col[p] !== i) d++;
    degree[i] = d;
  }
  const numbered = new Uint8Array(n);
  const order = new Int32Array(n);
  const level = new Int32Array(n);
  const queue = new Int32Array(n);
  const nbr: number[] = [];
  let next = 0;
  for (let seed = 0; seed < n; seed++) {
    if (numbered[seed]) continue;
    // Minimum-degree node of this component, then FNROOT.
    let ls = levels(g, seed, numbered, level, queue);
    let root = seed;
    for (let k = 0; k < ls.end; k++) {
      const v = queue[k]!;
      if (degree[v]! < degree[root]! || (degree[v] === degree[root] && v < root)) root = v;
    }
    ls = levels(g, root, numbered, level, queue);
    for (;;) {
      let cand = queue[ls.lastStart]!;
      for (let k = ls.lastStart + 1; k < ls.end; k++) {
        const v = queue[k]!;
        if (degree[v]! < degree[cand]! || (degree[v] === degree[cand] && v < cand)) cand = v;
      }
      const lc = levels(g, cand, numbered, level, queue);
      if (lc.depth <= ls.depth) break; // only `root` is used below
      root = cand;
      ls = lc;
    }
    // Cuthill–McKee from root.
    let head = next;
    order[next++] = root;
    numbered[root] = 1;
    while (head < next) {
      const v = order[head++]!;
      nbr.length = 0;
      for (let p = g.rowPtr[v]!; p < g.rowPtr[v + 1]!; p++) {
        const w = g.col[p]!;
        if (!numbered[w]) {
          numbered[w] = 1;
          nbr.push(w);
        }
      }
      nbr.sort((a, b) => degree[a]! - degree[b]! || a - b);
      for (const w of nbr) order[next++] = w;
    }
  }
  order.reverse();
  return order;
}

/** `inv[perm[k]] = k`. */
export function invertPerm(perm: Int32Array): Int32Array {
  const inv = new Int32Array(perm.length);
  for (let k = 0; k < perm.length; k++) inv[perm[k]!] = k;
  return inv;
}
