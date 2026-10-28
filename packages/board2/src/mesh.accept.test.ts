// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M1 step 2 acceptance of the grid mesh (docs/design/m1-model.md §6), on the three golden
 * boards (converted), the four sample files that need a zero-thickness end or a V bottom
 * (step 4) and the swallow, fish and asymmetric test boards:
 *
 * 1. triangle centres and edge midpoints (diagonals included) are within the 0.05 cm tolerance of
 *    the surface, and the mesh is closed: every edge is shared by two triangles, oriented
 *    oppositely;
 * 2. the volume is within 1 % of that of a very fine reference mesh (tolerance 0.005 cm).
 */
import { describe, expect, it } from 'vitest';
import { convertClassic } from './classic';
import { meshBoard } from './mesh';
import { buildBoard } from './surface';
import type { BuiltBoard } from './surface';
import { GOLDENS, SAMPLES } from './test-support/classic-samples';
import { meshDeviation, topology, weldMap } from './test-support/mesh-checks';
import { asymmetricBoard, fishBoard, swallowBoard } from './testing';
import type { BoardDoc } from './types';

function build(doc: BoardDoc): BuiltBoard {
  const r = buildBoard(doc, { check: false });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

const cases: readonly [string, () => BuiltBoard][] = [
  ...GOLDENS.map((g): [string, () => BuiltBoard] => [
    g.name.replace(/^.*\//, ''),
    () => {
      const c = convertClassic(g.load());
      if (!c.ok) throw new Error(c.issues.map((i) => i.message).join('; '));
      return build(c.value.doc);
    },
  ]),
  ...SAMPLES.filter((g) =>
    /clean-6x22|fallback-outline|rocker-absolute-deck|rocker-thickness-deck/.test(g.name),
  ).map((g): [string, () => BuiltBoard] => [
    g.name.replace(/^.*\//, ''),
    () => {
      const c = convertClassic(g.load());
      if (!c.ok) throw new Error(c.issues.map((i) => i.message).join('; '));
      return build(c.value.doc);
    },
  ]),
  ['swallow', () => build(swallowBoard())],
  ['fish', () => build(fishBoard())],
  ['asymmetric', () => build(asymmetricBoard())],
];

const TOLERANCE = 0.05;

describe.each(cases)('%s', (_name, make) => {
  const board = make();
  const mesh = meshBoard(board);

  it('is closed: every edge is shared by exactly two triangles, oppositely oriented', () => {
    const t = topology(mesh.indices, mesh.vertexCount, weldMap(mesh));
    expect(t.badEdges).toBe(0);
    expect(t.unused).toBe(0);
    expect(t.vertices - t.edges + t.triangles).toBe(2);
  });

  it('keeps triangle centres and edge midpoints within 0.5 mm of the surface', () => {
    const stride = Math.max(1, Math.ceil(mesh.triangleCount / 5000));
    const d = meshDeviation(board, mesh, stride);
    expect(d.checked).toBeGreaterThan(1000);
    expect(d.centre).toBeLessThanOrEqual(TOLERANCE);
    expect(d.edgeMid).toBeLessThanOrEqual(TOLERANCE);
  }, 60_000);

  it('has a volume within 1 % of a very fine reference mesh', () => {
    const reference = meshBoard(board, { tolerance: 0.005 });
    expect(reference.vertexCount).toBeGreaterThan(5 * mesh.vertexCount);
    expect(topology(reference.indices, reference.vertexCount, weldMap(reference)).badEdges).toBe(0);
    expect(Math.abs(mesh.volume - reference.volume) / reference.volume).toBeLessThan(0.01);
    // and so is the plan area
    expect(Math.abs(mesh.planArea - reference.planArea) / reference.planArea).toBeLessThan(0.01);
  }, 60_000);
});
