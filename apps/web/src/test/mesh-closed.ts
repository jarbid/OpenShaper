// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: whether a triangle mesh is a closed, consistently wound solid.
 *
 * The engine's mesh gives each panel and strip its own vertices along a seam, so two vertices in exactly
 * the same place count as one here; an edge is open unless it is used once in each direction.
 */

/** The number of open edges of the indexed triangle list (0 for a closed solid). */
export function openEdges(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  const vertices = positions.length / 3;
  const place = new Map<string, number>();
  const canon = new Uint32Array(vertices);
  for (let i = 0; i < vertices; i++) {
    const key = `${positions[3 * i]},${positions[3 * i + 1]},${positions[3 * i + 2]}`;
    const first = place.get(key);
    if (first === undefined) {
      place.set(key, i);
      canon[i] = i;
    } else {
      canon[i] = first;
    }
  }
  const uses = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = canon[indices[t]!]!;
    const b = canon[indices[t + 1]!]!;
    const c = canon[indices[t + 2]!]!;
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = from * vertices + to;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [key, n] of uses) {
    const from = Math.floor(key / vertices);
    const to = key - from * vertices;
    if (n !== 1 || uses.get(to * vertices + from) !== 1) open++;
  }
  return open;
}

/** The volume (cubic units) a closed triangle list encloses: signed tetrahedra about the origin. */
export function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t]!;
    const b = 3 * indices[t + 1]!;
    const c = 3 * indices[t + 2]!;
    volume +=
      (positions[a]! *
        (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
        positions[a + 1]! *
          (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
        positions[a + 2]! *
          (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)) /
      6;
  }
  return volume;
}
