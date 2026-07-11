// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loop, partBbox } from './geom';
import { layoutNestedSheet, nestedSheetViews, nestParts } from './nest';
import type { Part, TemplateSheet } from './types';
import { sheetToDxf } from '../sheet-dxf';
import { sheetToSvg } from '../sheet-svg';

/** Axis-aligned test rectangle part, w × h cm, corner at the origin. */
const rect = (id: string, w: number, h: number, count = 1): Part => ({
  id,
  label: id,
  count,
  loops: [
    loop('cut', true, [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ]),
  ],
});

const SPEC = { widthCm: 100, heightCm: 50, marginCm: 1, gapCm: 1 };

describe('nestParts', () => {
  it('is deterministic', () => {
    const parts = [rect('a', 40, 20), rect('b', 30, 10), rect('c', 40, 20)];
    expect(nestParts(parts, SPEC)).toEqual(nestParts(parts, SPEC));
  });

  it('packs four 40×20 rectangles onto one sheet, six onto two', () => {
    const four = Array.from({ length: 4 }, (_, i) => rect(`p${i}`, 40, 20));
    expect(nestParts(four, SPEC).sheets).toBe(1);
    const six = Array.from({ length: 6 }, (_, i) => rect(`p${i}`, 40, 20));
    expect(nestParts(six, SPEC).sheets).toBe(2);
  });

  it('keeps every placement inside the sheet margins with no bbox overlap', () => {
    const parts = [
      rect('a', 40, 20),
      rect('b', 60, 15),
      rect('c', 25, 25),
      rect('d', 80, 10),
      rect('e', 30, 30),
    ];
    const nest = nestParts(parts, SPEC);
    expect(nest.unplaced).toHaveLength(0);
    for (const pl of nest.placements) {
      const bb = partBbox(pl.part);
      expect(bb.minX).toBeGreaterThanOrEqual(SPEC.marginCm - 1e-9);
      expect(bb.minY).toBeGreaterThanOrEqual(SPEC.marginCm - 1e-9);
      expect(bb.maxX).toBeLessThanOrEqual(SPEC.widthCm - SPEC.marginCm + 1e-9);
      expect(bb.maxY).toBeLessThanOrEqual(SPEC.heightCm - SPEC.marginCm + 1e-9);
    }
    // No two placements on the same sheet overlap.
    for (let i = 0; i < nest.placements.length; i++) {
      for (let j = i + 1; j < nest.placements.length; j++) {
        const a = nest.placements[i]!;
        const b = nest.placements[j]!;
        if (a.sheet !== b.sheet) continue;
        const ba = partBbox(a.part);
        const bbx = partBbox(b.part);
        const separated =
          ba.maxX <= bbx.minX + 1e-9 ||
          bbx.maxX <= ba.minX + 1e-9 ||
          ba.maxY <= bbx.minY + 1e-9 ||
          bbx.maxY <= ba.minY + 1e-9;
        expect(separated).toBe(true);
      }
    }
  });

  it('rotates a too-tall part when allowed, reports it unplaced when not', () => {
    const tall = [rect('tall', 10, 90)];
    const rotated = nestParts(tall, { ...SPEC, allowRotate: true });
    expect(rotated.unplaced).toHaveLength(0);
    expect(rotated.placements[0]!.rotated).toBe(true);

    const stuck = nestParts(tall, { ...SPEC, allowRotate: false });
    expect(stuck.placements).toHaveLength(0);
    expect(stuck.unplaced.map((p) => p.id)).toEqual(['tall']);
  });

  it('expands count copies with (k/N) labels', () => {
    const nest = nestParts([rect('strip', 40, 5, 3)], SPEC);
    expect(nest.placements).toHaveLength(3);
    expect(nest.placements.map((pl) => pl.part.label).sort()).toEqual([
      'strip (1/3)',
      'strip (2/3)',
      'strip (3/3)',
    ]);
    // Ids stay unique for the SVG <g id> attribute.
    expect(new Set(nest.placements.map((pl) => pl.part.id)).size).toBe(3);
  });
});

describe('layoutNestedSheet', () => {
  const sheet: TemplateSheet = {
    parts: Array.from({ length: 6 }, (_, i) => rect(`p${i}`, 40, 20)),
    units: 'cm',
    meta: { title: 'Nested', note: 'note' },
  };
  const nest = nestParts(sheet.parts, SPEC);

  it('lays sheets side by side with boundary marks and Sheet i/N labels', () => {
    const out = layoutNestedSheet(sheet, nest);
    expect(out.prearranged).toBe(true);
    const bounds = out.parts.filter((p) => p.id.startsWith('sheet-'));
    expect(bounds).toHaveLength(nest.sheets);
    expect(bounds[0]!.labels?.[0]?.text).toBe(`Sheet 1/${nest.sheets}`);
    // Boundary rectangles are marks (never cut) and don't overlap horizontally.
    expect(bounds.every((b) => b.loops.every((l) => l.kind === 'mark'))).toBe(true);
    const b0 = partBbox(bounds[0]!);
    const b1 = partBbox(bounds[1]!);
    expect(b1.minX).toBeGreaterThanOrEqual(b0.maxX);
  });
});

describe('nestedSheetViews', () => {
  it('returns one prearranged view per sheet with its own boundary + parts', () => {
    const parts = Array.from({ length: 6 }, (_, i) => rect(`p${i}`, 40, 20));
    const sheet: TemplateSheet = { parts, units: 'cm' };
    const nest = nestParts(parts, SPEC);
    const views = nestedSheetViews(sheet, nest);
    expect(views).toHaveLength(nest.sheets);
    expect(views.every((v) => v.prearranged)).toBe(true);
    // Every placement appears in exactly one view; boundaries carry i/N labels.
    const total = views.reduce((s, v) => s + v.parts.length - 1, 0);
    expect(total).toBe(nest.placements.length);
    expect(views[0]!.parts[0]!.label).toBe(`Sheet 1/${nest.sheets}`);
  });
});

describe('writers honour prearranged sheets', () => {
  const placed: TemplateSheet = {
    prearranged: true,
    units: 'cm',
    parts: [
      {
        ...rect('far', 10, 10),
        loops: [
          loop('cut', true, [
            { x: 100, y: 20 },
            { x: 110, y: 20 },
            { x: 110, y: 30 },
            { x: 100, y: 30 },
          ]),
        ],
      },
    ],
  };

  it('SVG keeps prearranged coordinates instead of re-stacking', () => {
    // 100 cm → 1000 mm; columnLayout would have moved the part to the 5 cm gap.
    expect(sheetToSvg(placed)).toContain('M1000.000');
  });

  it('DXF keeps prearranged coordinates instead of re-stacking', () => {
    expect(sheetToDxf(placed)).toContain('1000.0000');
  });
});
