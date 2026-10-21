// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The native BREP text writer of Path A, without OCCT: its structure, gate,
 * tolerance and orientation encoding. That OCCT reads it as the solid we built
 * (valid, same volume as Path B, every flip refused) is `step.occt.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { flipBrep } from '../brep/brep';
import { GeomError, writeStep } from '../index';
import { DEFAULT_TOLERANCES } from '../tolerance';
import type { Brep } from '../index';
import { boxSolid, cylinderSolid, ellipticPuckSolid, plateWithHoleSolid } from './index';
import { toOcctBrepText, toOcctBrepTextUnchecked } from './occt-brep';

/** The counts a header announces, by section name. */
function sections(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(
    /^(Locations|Curve2ds|Curves|Surfaces|TShapes|Triangulations|Polygon3D|PolygonOnTriangulations) (\d+)$/gm,
  )) {
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** Records of one type (`Ve`, `Ed`, `Wi`, `Fa`, `Sh`, `So`) with their sub-shape lines. */
function records(text: string, type: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (l !== type) return;
    let j = i + 1;
    while (!lines[j]!.endsWith('*')) j++;
    out.push(lines[j]!);
  });
  return out;
}

const loops = (b: Brep): number => b.faces.reduce((n, f) => n + 1 + f.holes.length, 0);
const uses = (b: Brep): number =>
  b.faces.reduce((n, f) => n + [f.outer, ...f.holes].reduce((m, l) => m + l.coedges.length, 0), 0);

describe('toOcctBrepText', () => {
  const solids: readonly (readonly [string, Brep])[] = [
    ['box', boxSolid(2, 3, 5)],
    ['cylinder (seam, reversed cap)', cylinderSolid(1.5, 4)],
    ['plate with a hole', plateWithHoleSolid(6, 5, 2, 1)],
    ['fitted puck', ellipticPuckSolid(3, 2, 1, { bicubicDeck: true })],
  ];
  for (const [name, b] of solids) {
    it(`${name}: one geometry entry per use, edge and face; one shape per topological item`, () => {
      const { text } = toOcctBrepText(b);
      expect(text.split('\n')[1]).toBe('CASCADE Topology V3, (c) Open Cascade');
      expect(sections(text)).toEqual({
        Locations: 0,
        Curve2ds: uses(b),
        Curves: b.edges.length,
        Polygon3D: 0,
        PolygonOnTriangulations: 0,
        Surfaces: b.faces.length,
        Triangulations: 0,
        TShapes: b.vertices.length + b.edges.length + loops(b) + b.faces.length + 2,
      });
      expect(records(text, 'Ve')).toHaveLength(b.vertices.length);
      expect(records(text, 'Ed')).toHaveLength(b.edges.length);
      expect(records(text, 'Wi')).toHaveLength(loops(b));
      // The shell: a face enters `+` when its sense is the surface's, `-` when not.
      const shell = records(text, 'Sh')[0]!
        .split(' ')
        .filter((t) => t !== '*' && t !== '0');
      expect(shell.map((t) => t[0] === '+')).toEqual(b.faces.map((f) => f.sameSense));
      // The root is the solid, written last, so referenced as 1.
      expect(text.trimEnd().endsWith('\n+1 0')).toBe(true);
    });
  }

  it('declares the uncertainty writeStep declares, in the output unit', () => {
    const b = ellipticPuckSolid(3, 2, 1, { bicubicDeck: true });
    const mm = toOcctBrepText(b);
    expect(mm.tolerance).toBe(writeStep(b).stats.uncertainty);
    // A fitted deck: twice a real gap, above the floor (`Tolerances.point`, cm → mm).
    expect(mm.tolerance).toBeGreaterThan(DEFAULT_TOLERANCES.point * 10);
    const cm = toOcctBrepText(b, { unit: 'cm' });
    expect(cm.tolerance).toBeCloseTo(mm.tolerance / 10, 15);
    expect(writeStep(b, { fileUnit: 'cm' }).stats.uncertainty).toBe(cm.tolerance);
    // Every shape carries it.
    expect(mm.text).toContain(`Ve\n${mm.tolerance}\n`);
    expect(mm.text).toContain(`Ed\n ${mm.tolerance} 1 1 0\n`);
    expect(mm.text).toContain(`Fa\n0  ${mm.tolerance} 1 0\n`);
  });

  it('scales lengths to the unit and never parameters', () => {
    const b = boxSolid(2, 3, 5);
    const mm = toOcctBrepText(b).text;
    const cm = toOcctBrepText(b, { unit: 'cm' }).text;
    expect(mm).toContain('\n20 30 50\n0 0\n'); // the far corner, in mm
    expect(cm).toContain('\n2 3 5\n0 0\n');
    // Edge ranges are parameters: the same in both.
    const ranges = (t: string) => t.match(/^1 {2}\d+ 0 .*$/gm);
    expect(ranges(mm)).toEqual(ranges(cm));
  });

  it('writes the loop of a reversed face backwards (surface orientation)', () => {
    const b = cylinderSolid(1.5, 4);
    const bottom = b.faces.findIndex((f) => !f.sameSense);
    expect(bottom).toBeGreaterThanOrEqual(0);
    const loop = b.faces[bottom]!.outer.coedges;
    const { text } = toOcctBrepText(b);
    // Wires are written in face order, one per loop, and every face here has one loop:
    // the bottom cap's is wire `bottom`.
    expect(b.faces.every((f) => f.holes.length === 0)).toBe(true);
    const line = records(text, 'Wi')[bottom]!;
    const wire = line.split(' ').filter((t) => t !== '*' && t !== '0');
    expect(wire.map((t) => t[0] === '+')).toEqual(
      loop
        .slice()
        .reverse()
        .map((c) => !c.sense),
    );
  });

  it('is deterministic and round-trips every number', () => {
    const b = ellipticPuckSolid(3, 2, 1, { bicubicDeck: true });
    const a = toOcctBrepText(b).text;
    expect(toOcctBrepText(b).text).toBe(a);
    for (const t of a.split(/\s+/)) {
      // Numbers, not the 7-digit shape flags.
      if (/^-?\d/.test(t) && !/^[01]{7}$/.test(t)) expect(String(Number(t))).toBe(t);
    }
  });

  it('refuses an invalid B-rep; the unchecked variant writes it', () => {
    const inverted = flipBrep(boxSolid(2, 3, 5));
    let caught: unknown;
    try {
      toOcctBrepText(inverted);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GeomError);
    expect((caught as GeomError).code).toBe('brep-invalid');
    const u = toOcctBrepTextUnchecked(inverted);
    expect(u.tolerance).toBe(DEFAULT_TOLERANCES.point * 10); // the floor, cm → mm
    expect(toOcctBrepTextUnchecked(inverted, { tolerance: 0.25 }).tolerance).toBe(0.25);
    expect(() => toOcctBrepTextUnchecked(inverted, { tolerance: 0 })).toThrow(GeomError);
    expect(() => toOcctBrepTextUnchecked(inverted, { tolerance: Number.NaN })).toThrow(GeomError);
  });
});
