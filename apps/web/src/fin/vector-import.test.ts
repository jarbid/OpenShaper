// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign, sectionThickest, validateFinDesign } from '@openshaper/kernel';
import { createFinStore } from '@openshaper/store';
import { describe, expect, it } from 'vitest';
import { dragGhost, ghostMarkers, makeGhost, moveGhost, GHOST_MOVE, GHOST_SCALE } from './ghost';
import {
  parseEps,
  parsePathData,
  parseSvg,
  parseVector,
  vectorFoil,
  vectorLines,
  vectorOutline,
  vectorOutlineSize,
  VectorError,
} from './vector-import';

/** A fin drawn facing left, in mm: leading edge up from (0, 80), tip at (60, 0), closed along its base. */
const FIN = `<svg xmlns="http://www.w3.org/2000/svg" width="110mm" height="90mm" viewBox="0 0 110 90">
  <path d="M 0 80 C 20 40 40 10 70 5 C 75 20 72 50 85 80 Z"/>
  <circle cx="10" cy="10" r="1"/>
</svg>`;
const FOIL = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="20mm" viewBox="0 0 100 20">
  <path d="M 0 10 C 0 2 30 2 40 2 C 70 2 90 8 100 10 C 70 12 30 13 0 10 Z"/>
</svg>`;

describe('reading vector files', () => {
  it('reads SVG commands, relative and shorthand, every point and handle', () => {
    const [p] = parsePathData('M1 1 l2 0 h1 v1 c1 0 1 1 2 1 s1 1 2 1 Q10 5 11 6 Z');
    expect(p!.closed).toBe(true);
    expect(p!.segs[3]).toEqual([
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
      { x: 6, y: 3 },
    ]);
    // The smooth curve's first handle is the last one reflected.
    expect(p!.segs[4]![1]).toEqual({ x: 7, y: 3 });
  });

  it('turns an arc into curves ending on its end', () => {
    const [p] = parsePathData('M0 0 A5 5 0 0 1 10 0');
    expect(p!.segs.length).toBeGreaterThanOrEqual(2);
    const last = p!.segs[p!.segs.length - 1]![3];
    expect(last.x).toBeCloseTo(10, 9);
    expect(last.y).toBeCloseTo(0, 9);
  });

  it('reads an SVG at real size, y up, its transforms applied', () => {
    const [p] = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 100 100"><g transform="translate(10 0)"><path d="M0 0 L10 20"/></g></svg>',
    );
    // 100 units across 10 mm: a unit is 0.1 mm, 0.01 cm.
    expect(p!.segs[0]![0].x).toBeCloseTo(0.1, 9);
    expect(p!.segs[0]![3].x).toBeCloseTo(0.2, 9);
    expect(p!.segs[0]![3].y).toBeCloseTo(-0.2, 9);
  });

  it('reads EPS in points, its abbreviations, and leaves clip paths out', () => {
    const eps = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 100 100
/m { moveto } bind def
/c { curveto } bind def
q 0 0 100 100 re W n
0 0 m 72 0 l 72 72 72 72 0 72 c h f
Q`;
    const [p, none] = parseEps(eps);
    expect(none).toBeUndefined();
    expect(p!.closed).toBe(true);
    expect(p!.segs[0]![3].x).toBeCloseTo(2.54, 9);
    expect(p!.segs[1]![3].y).toBeCloseTo(2.54, 9);
  });

  it('says so when a file has nothing in it to use', () => {
    expect(() => parseVector('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow(
      VectorError,
    );
    expect(() => parseVector('a.svg', 'not a drawing')).toThrow(VectorError);
    expect(() => parseVector('a.eps', '%!PS\nshowpage')).toThrow(/uncompressed/);
  });
});

describe('a vector as the profile', () => {
  const paths = parseSvg(FIN);

  it('leaves out the base and any smaller shape, keeping the points and handles', () => {
    const o = vectorOutline(paths, 'left');
    expect(o.knots).toHaveLength(3);
    // Facing left: the leading edge on the left is the outline's +x end.
    expect(o.knots[0]!.end.x).toBeGreaterThan(o.knots[2]!.end.x);
    expect(o.knots[0]!.end.y).toBe(0);
    expect(o.knots[2]!.end.y).toBe(0);
    // Height 75 mm, handle 20 mm along from the leading edge, in the mirrored frame.
    expect(o.knots[1]!.end.y).toBeCloseTo(7.5, 9);
    expect(o.knots[0]!.tangentToNext.x - o.knots[0]!.end.x).toBeCloseTo(-2, 9);
  });

  it('flips a right-facing drawing, and leaves a left-facing one', () => {
    const left = vectorOutline(paths, 'left');
    const right = vectorOutline(paths, 'right');
    // Same outline read the other way: the leading edge root is the file's other end.
    expect(left.knots[0]!.end.x - left.knots[2]!.end.x).toBeCloseTo(8.5, 9);
    expect(right.knots[0]!.end.x - right.knots[2]!.end.x).toBeCloseTo(8.5, 9);
    expect(right.knots[1]!.end.x).toBeCloseTo(7, 9);
    expect(left.knots[1]!.end.x).toBeCloseTo(-7, 9);
  });

  it('scales, and says how big it will come in', () => {
    const half = vectorOutline(paths, 'left', 0.5);
    expect(half.knots[1]!.end.y).toBeCloseTo(3.75, 9);
    expect(half.knots[0]!.end.x - half.knots[2]!.end.x).toBeCloseTo(4.25, 9);
    const size = vectorOutlineSize(paths)!;
    expect(size.base).toBeCloseTo(8.5, 9);
    expect(size.depth).toBeCloseTo(7.5, 2);
  });

  it('lands on the current tab, one undo step', () => {
    const s = createFinStore();
    s.getState().load(defaultFinDesign('side', 'left'));
    const before = s.getState().design!;
    const small = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="110mm" viewBox="0 0 110 110"><path d="M 0 100 C 30 60 60 10 90 5 C 95 40 92 70 105 100 Z"/></svg>',
    );
    expect(s.getState().importOutline(vectorOutline(small, 'left'))).toEqual([]);
    const d = s.getState().design!;
    expect(d.base).toBe(before.base);
    expect(d.outline.knots).toHaveLength(3);
    expect(validateFinDesign(d)).toEqual([]);
    s.getState().undo();
    expect(s.getState().design).toBe(before);
  });

  it('says what is wrong instead of importing a fin the tab can’t take', () => {
    const s = createFinStore();
    s.getState().load(defaultFinDesign('side', 'left'));
    const before = s.getState().design!;
    const huge = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400mm" viewBox="0 0 400 400"><path d="M 0 390 C 100 200 200 50 300 20 C 320 100 310 300 390 390 Z"/></svg>',
    );
    expect(s.getState().importOutline(vectorOutline(huge, 'left')).join()).toMatch(/overhangs/);
    expect(s.getState().design).toBe(before);
  });
});

describe('a vector as the base foil', () => {
  const paths = parseSvg(FOIL);

  it('cuts a closed shape into two faces, leading edge at 0, upper outside', () => {
    const f = vectorFoil(paths, 'left', false);
    const o = f.outside.knots;
    expect(o[0]!.end).toEqual(expect.objectContaining({ x: 0, y: 0 }));
    expect(o[o.length - 1]!.end).toEqual(expect.objectContaining({ x: 1, y: 0 }));
    expect(f.inside!.knots.at(-1)!.end.x).toBe(1);
    // Upper in the drawing (y up) is the outside: above the chord.
    expect(Math.max(...o.map((k) => k.end.y))).toBeGreaterThan(0.05);
    expect(f.inside!.knots[0]!.tangentToNext.y).toBeLessThan(0);
  });

  it('flips a right-facing foil', () => {
    const left = vectorFoil(paths, 'left', false);
    const right = vectorFoil(paths, 'right', false);
    expect(sectionThickest(left).at).toBeLessThan(0.5);
    expect(sectionThickest(right).at).toBeGreaterThan(0.5);
  });

  it('squares a tilted drawing to its chord', () => {
    const tilted = parseSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" viewBox="0 0 100 100"><g transform="rotate(12)"><path d="M 0 10 C 0 2 30 2 40 2 C 70 2 90 8 100 10 C 70 12 30 13 0 10 Z"/></g></svg>`,
    );
    expect(sectionThickest(vectorFoil(tilted, 'left', false)).thickness).toBeCloseTo(
      sectionThickest(vectorFoil(paths, 'left', false)).thickness,
      2,
    );
  });

  it('is symmetric on a centre fin, and an open line is the outside over a flat inside', () => {
    expect(vectorFoil(paths, 'left', true).inside).toBeNull();
    const open = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" viewBox="0 0 100 20"><path d="M0 10 C 10 2 60 2 100 10"/></svg>',
    );
    const f = vectorFoil(open, 'left', false);
    expect(f.inside!.knots).toHaveLength(2);
    expect(f.inside!.knots[1]!.end.y).toBe(0);
  });

  it('replaces the base foil, and shows it', () => {
    const s = createFinStore();
    s.getState().load(defaultFinDesign('side', 'left'));
    s.getState().setActiveFoil(-1);
    expect(s.getState().importBaseFoil(vectorFoil(paths, 'left', false))).toEqual([]);
    expect(s.getState().activeFoil).toBe(0);
    expect(validateFinDesign(s.getState().design!)).toEqual([]);
  });
});

describe('a ghost', () => {
  const ghost = () =>
    makeGhost(vectorLines(parseSvg(FIN), 'left', true), () => ({ x: 5, y: 4, scale: 1 }));

  it('moves by its centre dot and scales by its corner dot', () => {
    const g = ghost();
    const moved = dragGhost(g, GHOST_MOVE, { x: 8, y: 1 });
    expect([moved.x, moved.y, moved.scale]).toEqual([8, 1, 1]);
    const corner = ghostMarkers(g)[1]!.at;
    const twice = dragGhost(g, GHOST_SCALE, {
      x: g.x + (corner.x - g.x) * 2,
      y: g.y + (corner.y - g.y) * 2,
    });
    expect(twice.scale).toBeCloseTo(2, 9);
    expect([twice.x, twice.y]).toEqual([g.x, g.y]);
  });

  it('moves by a right-button drag’s distance, true to scale in the foil view', () => {
    const g = ghost();
    const by = { x: 1, y: 2 };
    expect(moveGhost(g, by)).toMatchObject({ x: 6, y: 6, scale: 1 });
    expect(moveGhost(g, by, 4)).toMatchObject({ x: 6, y: 12 });
  });

  it('keeps its handles true to scale in the stretched foil view', () => {
    const g = ghost();
    const [move] = ghostMarkers(g, 4);
    expect(move!.at.y).toBeCloseTo(1, 9);
    expect(dragGhost(g, GHOST_MOVE, { x: 0, y: 2 }, 4).y).toBeCloseTo(8, 9);
  });
});
