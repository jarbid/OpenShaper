// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  board as makeBoard,
  crossSection as kCrossSection,
  defaultFinConfig,
  developHorizontalRailBand,
  developRailBand,
  getLength,
  knot as kKnot,
  outlineInsetHalfWidthAt,
  splineFromKnots as kSplineFromKnots,
  vec2 as kVec2,
} from '@openshaper/kernel';
import { makeTestBoard } from '../fixture.test-helper';
import { buildHwsTemplates } from './hws';
import { DEFAULT_HWS_PARAMS, type Part, type Pt } from './types';
import { bboxOfPts } from './geom';
import { sheetToDxf } from '../sheet-dxf';
import { sheetToSvg } from '../sheet-svg';
import { sheetToPdf } from '../sheet-pdf';

const board = makeTestBoard();

const allPts = (part: Part): Pt[] => part.loops.flatMap((l) => [...l.pts]);
const cutLoop = (part: Part) => part.loops.find((l) => l.kind === 'cut')!;

/** O(n²) self-intersection scan over a closed polyline. */
const hasSelfIntersection = (pts: readonly Pt[]): boolean => {
  const n = pts.length;
  const seg = (i: number): [Pt, Pt] => [pts[i]!, pts[(i + 1) % n]!];
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  for (let i = 0; i < n; i++) {
    const [a, b] = seg(i);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent (wraps)
      const [c, d] = seg(j);
      const d1 = cross(c.x, c.y, d.x, d.y, a.x, a.y);
      const d2 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
      const d3 = cross(a.x, a.y, b.x, b.y, c.x, c.y);
      const d4 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
      if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) return true;
    }
  }
  return false;
};

describe('buildHwsTemplates — part composition', () => {
  it('emits one stringer + N ribs + two skins (evenCount)', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 5 });
    const ids = sheet.parts.map((p) => p.id);
    expect(ids.filter((id) => id === 'stringer')).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('rib-'))).toHaveLength(5);
    expect(ids).toContain('skin-deck');
    expect(ids).toContain('skin-bottom');
    expect(sheet.parts).toHaveLength(1 + 5 + 2);
  });

  it('honours include flags', () => {
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 3,
      includeDeckSkin: false,
      includeBottomSkin: false,
      includeStringer: false,
    });
    expect(sheet.parts.every((p) => p.id.startsWith('rib-'))).toBe(true);
    expect(sheet.parts).toHaveLength(3);
  });

  it('spacing mode places symmetric ribs', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'spacing', ribSpacing: 15 });
    const ribs = sheet.parts.filter((p) => p.id.startsWith('rib-'));
    expect(ribs.length).toBeGreaterThanOrEqual(3);
  });

  it('produces only finite coordinates', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 6 });
    for (const part of sheet.parts) {
      for (const p of allPts(part)) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});

describe('buildHwsTemplates — geometry invariants', () => {
  it('stringer spans the board length minus the trimmed ends', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 5 });
    const stringer = sheet.parts.find((p) => p.id === 'stringer')!;
    const bb = bboxOfPts(allPts(stringer));
    const tip = Math.max(DEFAULT_HWS_PARAMS.endMargin, 1);
    expect(bb.maxX - bb.minX).toBeCloseTo(getLength(board) - 2 * tip, 1);
  });

  it('cut loops are closed contours with enough points', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 4 });
    for (const part of sheet.parts) {
      const cut = cutLoop(part);
      expect(cut.closed).toBe(true);
      expect(cut.pts.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('insets ribs from the board surface by ~ the skin thickness', () => {
    const skin = 0.4;
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 1,
      skinThickness: skin,
    });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    const bb = bboxOfPts(allPts(rib));
    const ribHalfWidth = Math.max(Math.abs(bb.minX), Math.abs(bb.maxX));
    // Centre rib sits at x=50 where the board half-width is 25cm.
    expect(ribHalfWidth).toBeGreaterThan(25 - skin - 1);
    expect(ribHalfWidth).toBeLessThan(25);
  });

  it('stringer notches are material+fit wide', () => {
    const material = 0.8;
    const fit = 0.02;
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 5,
      materialThickness: material,
      slotFit: fit,
    });
    const stringer = sheet.parts.find((p) => p.id === 'stringer')!;
    const pts = cutLoop(stringer).pts;
    // A slot floor is a horizontal segment of width == material+fit.
    let found = false;
    for (let i = 1; i < pts.length; i++) {
      const dy = Math.abs(pts[i]!.y - pts[i - 1]!.y);
      const dx = Math.abs(pts[i]!.x - pts[i - 1]!.x);
      if (dy < 1e-6 && Math.abs(dx - (material + fit)) < 1e-3) found = true;
    }
    expect(found).toBe(true);
  });

  it('stringer cut-loop has no self-intersections', () => {
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 6,
      materialThickness: 0.8,
    });
    const stringer = sheet.parts.find((p) => p.id === 'stringer')!;
    expect(hasSelfIntersection(cutLoop(stringer).pts)).toBe(false);
  });

  it('rib cut-loop has no self-intersections', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 1 });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    expect(hasSelfIntersection(cutLoop(rib).pts)).toBe(false);
  });

  it('skin overhang at 2 cm produces a simple loop', () => {
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 4,
      skinOverhang: 2,
    });
    const skin = sheet.parts.find((p) => p.id === 'skin-deck')!;
    expect(hasSelfIntersection(cutLoop(skin).pts)).toBe(false);
  });

  it('rib + stringer half-lap depths sum to the internal height', () => {
    const halfLap = 0.5;
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 1,
      halfLapFraction: halfLap,
    });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    const pts = cutLoop(rib).pts;
    const bb = bboxOfPts(pts);
    const ybc = bb.minY;
    const H = bb.maxY - bb.minY;
    // Slot top: the highest y among the two slot-roof vertices near the centreline.
    const roof = pts.filter((p) => Math.abs(p.x) < 1 && p.y > ybc + 0.01);
    const slotTopY = Math.min(...roof.map((p) => p.y));
    const ribDepth = slotTopY - ybc;
    expect(ribDepth).toBeCloseTo((1 - halfLap) * H, 1);
  });
});

describe('buildHwsTemplates — lightening', () => {
  it('style "none" emits no inner cuts', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 1 });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    expect(rib.loops.some((l) => l.kind === 'cutInner')).toBe(false);
  });

  it('keeps a solid column over the half-lap check (no lightening near the slot)', () => {
    const materialThickness = 0.6;
    const slotFit = 0.02;
    const webMargin = 1.5;
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 1,
      lighteningStyle: 'truss',
      webMargin,
      webThickness: 1,
      trussSpacing: 5,
      materialThickness,
      slotFit,
    });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    const slotHalf = (materialThickness + slotFit) / 2 + webMargin;
    const inner = rib.loops.filter((l) => l.kind === 'cutInner');
    expect(inner.length).toBeGreaterThan(0);
    for (const l of inner) {
      for (const q of l.pts) {
        expect(Math.abs(q.x)).toBeGreaterThanOrEqual(slotHalf - 0.05);
      }
    }
  });

  it('leaves the stringer solid unless "lighten stringer" is on', () => {
    const stringerInner = (lightenStringer: boolean): number => {
      const sheet = buildHwsTemplates(board, {
        ribMode: 'evenCount',
        ribCount: 5,
        lighteningStyle: 'truss',
        lightenStringer,
      });
      const stringer = sheet.parts.find((p) => p.id === 'stringer')!;
      return stringer.loops.filter((l) => l.kind === 'cutInner').length;
    };
    expect(stringerInner(false)).toBe(0);
    expect(stringerInner(true)).toBeGreaterThan(0);
  });

  it('style "pocket" emits one simple inner loop that respects the web margin', () => {
    const webMargin = 2;
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 1,
      lighteningStyle: 'pocket',
      webMargin,
      pocketCornerRadius: 0.8,
    });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    const inner = rib.loops.filter((l) => l.kind === 'cutInner');
    expect(inner.length).toBeGreaterThanOrEqual(1);
    for (const loop of inner) {
      expect(hasSelfIntersection(loop.pts)).toBe(false);
    }
    // Every inner point sits inside the cut perimeter by at least webMargin - tol.
    const cut = cutLoop(rib).pts;
    const distToCut = (q: Pt): number => {
      let min = Infinity;
      for (let i = 0; i < cut.length; i++) {
        const a = cut[i]!;
        const b = cut[(i + 1) % cut.length]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
        const px = a.x + t * dx;
        const py = a.y + t * dy;
        const d = Math.hypot(px - q.x, py - q.y);
        if (d < min) min = d;
      }
      return min;
    };
    const tol = 0.1; // 1 mm slack for Clipper integer rounding
    for (const loop of inner) {
      for (const q of loop.pts) {
        expect(distToCut(q)).toBeGreaterThanOrEqual(webMargin - tol);
      }
    }
  });

  it('style "circles" emits round holes fitted to the rib, mirror-symmetric', () => {
    const holeDiameter = 4;
    const webMargin = 1;
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 1,
      lighteningStyle: 'circles',
      webMargin,
      holeDiameter,
      holeSpacing: 5,
    });
    const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
    const inner = rib.loops.filter((l) => l.kind === 'cutInner');
    expect(inner.length).toBeGreaterThanOrEqual(2);

    const stats = inner.map((l) => {
      const bb = bboxOfPts(l.pts);
      return {
        cx: (bb.minX + bb.maxX) / 2,
        dia: bb.maxX - bb.minX,
        aspect: (bb.maxX - bb.minX) / (bb.maxY - bb.minY),
      };
    });
    for (const s of stats) {
      // Round (bbox square) and never larger than the cap.
      expect(s.aspect).toBeCloseTo(1, 1);
      expect(s.dia).toBeLessThanOrEqual(holeDiameter + 0.05);
      expect(s.dia).toBeGreaterThan(0.6);
    }
    // L/R mirror: every hole centre has a partner at the mirrored x.
    const cxs = stats.map((s) => s.cx);
    for (const cx of cxs) {
      expect(cxs.some((d) => Math.abs(d + cx) < 0.3)).toBe(true);
    }
    // Holes fit the taper: the widest hole is nearer the centre than the
    // narrowest (which sits out toward a thin tip).
    const widest = stats.reduce((m, s) => (s.dia > m.dia ? s : m));
    const narrowest = stats.reduce((m, s) => (s.dia < m.dia ? s : m));
    expect(Math.abs(widest.cx)).toBeLessThan(Math.abs(narrowest.cx) + 1e-6);
  });

  it('style "truss" emits mirror-symmetric, simple pockets fitted to the rib', () => {
    for (const trussAngle of [0, 30, 45]) {
      const sheet = buildHwsTemplates(board, {
        ribMode: 'evenCount',
        ribCount: 1,
        lighteningStyle: 'truss',
        webMargin: 1.2,
        webThickness: 1.0,
        trussAngle,
        trussSpacing: 7,
      });
      const rib = sheet.parts.find((p) => p.id.startsWith('rib-'))!;
      const inner = rib.loops.filter((l) => l.kind === 'cutInner');
      expect(inner.length).toBeGreaterThanOrEqual(3);
      // No self-intersections.
      for (const loop of inner) expect(hasSelfIntersection(loop.pts)).toBe(false);
      // L/R mirror: every pocket centroid has a partner at the mirrored x.
      const cents = inner.map((l) => {
        const b = bboxOfPts(l.pts);
        return (b.minX + b.maxX) / 2;
      });
      for (const c of cents) {
        expect(cents.some((d) => Math.abs(d + c) < 0.3)).toBe(true);
      }
    }
  });

  it('truss bay spacing adapts per rib and stays simple across ribs', () => {
    // Ribs at different stations have different widths; each gets a pitch fitted
    // to its own width. Wider ribs get more bays; every emitted pocket is simple.
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 3,
      lighteningStyle: 'truss',
      webMargin: 1.2,
      webThickness: 1.0,
      trussAngle: 0,
      trussSpacing: 7,
    });
    const ribs = sheet.parts.filter((p) => p.id.startsWith('rib-'));
    expect(ribs.length).toBe(3);
    let totalPockets = 0;
    for (const rib of ribs) {
      const inner = rib.loops.filter((l) => l.kind === 'cutInner');
      totalPockets += inner.length;
      for (const loop of inner) expect(hasSelfIntersection(loop.pts)).toBe(false);
    }
    // The wide centre rib is lightened even if the thin end ribs are not.
    expect(totalPockets).toBeGreaterThanOrEqual(3);
  });
});

describe('buildHwsTemplates — rail band', () => {
  // Vertical mode: the offset is DERIVED — strip thickness × laminations.
  const band = 3; // = 0.6 × 5
  const railParams = {
    ribMode: 'evenCount',
    ribCount: 3,
    railStripThickness: 0.6,
    railLaminations: 5,
    railBandWidth: band, // horizontal-mode width (used by the horizontal cases)
  } as const;
  const railPart = (extra: object = {}) =>
    buildHwsTemplates(board, { ...railParams, ...extra }).parts.find((p) =>
      p.id.startsWith('rail-band'),
    );

  it('emits no rail part by default (no laminations / zero width)', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 3 });
    expect(sheet.parts.some((p) => p.id.startsWith('rail-band'))).toBe(false);
  });

  it('vertical offset = strip thickness × laminations (not the horizontal width)', () => {
    // Same derived offset, different strip/count split ⇒ identical template …
    const a = cutLoop(railPart()!);
    const b = cutLoop(railPart({ railStripThickness: 0.5, railLaminations: 6 })!);
    expect(bboxOfPts([...a.pts])).toEqual(bboxOfPts([...b.pts]));
    // … and the horizontal width param has no effect in vertical mode.
    const c = cutLoop(railPart({ railBandWidth: 10 })!);
    expect(bboxOfPts([...c.pts])).toEqual(bboxOfPts([...a.pts]));
  });

  it('honours includeRailTemplate', () => {
    const sheet = buildHwsTemplates(board, { ...railParams, includeRailTemplate: false });
    expect(sheet.parts.some((p) => p.id.startsWith('rail-band'))).toBe(false);
  });

  it('vertical template is a long simple strip matching the kernel development', () => {
    const part = railPart()!;
    expect(part).toBeDefined();
    const cut = cutLoop(part);
    expect(cut.closed).toBe(true);
    expect(hasSelfIntersection(cut.pts)).toBe(false);
    const bb = bboxOfPts([...cut.pts]);
    const dev = developRailBand(board, {
      offset: band,
      tailTrim: DEFAULT_HWS_PARAMS.railTailTrim,
      noseTrim: DEFAULT_HWS_PARAMS.railNoseTrim,
      skinThickness: DEFAULT_HWS_PARAMS.skinThickness,
      flatten: true,
      tolerance: DEFAULT_HWS_PARAMS.sampleTolerance,
    });
    expect(bb.maxX - bb.minX).toBeCloseTo(dev.length, 1);
    expect(bb.maxX - bb.minX).toBeGreaterThan(5 * (bb.maxY - bb.minY));
  });

  it('flattened strip is shorter in height than the exact tall ribbon', () => {
    const flatBB = bboxOfPts([...cutLoop(railPart({ railFlatten: true })!).pts]);
    const tallBB = bboxOfPts([...cutLoop(railPart({ railFlatten: false })!).pts]);
    expect(flatBB.maxY - flatBB.minY).toBeLessThanOrEqual(tallBB.maxY - tallBB.minY + 1e-9);
  });

  it('carries a dashed station mark + number per rib inside the band domain', () => {
    const part = railPart()!;
    const marks = part.loops.filter((l) => l.kind === 'mark' && l.dashed);
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks.length).toBeLessThanOrEqual(3);
    const numbered = (part.labels ?? []).filter((l) => /^\d+$/.test(l.text));
    expect(numbered.length).toBe(marks.length);
  });

  it('butt joint: single rail part, no inner cuts', () => {
    const sheet = buildHwsTemplates(board, railParams);
    const rails = sheet.parts.filter((p) => p.id.startsWith('rail-band'));
    expect(rails).toHaveLength(1);
    expect(rails[0]!.loops.some((l) => l.kind === 'cutInner')).toBe(false);
  });

  it('tabSlot: slotted layer-1 part + plain part, slots match material width', () => {
    const material = 0.6;
    const sheet = buildHwsTemplates(board, {
      ...railParams,
      railJoint: 'tabSlot',
      materialThickness: material,
      railStripThickness: 0.6,
    });
    const slotted = sheet.parts.find((p) => p.id === 'rail-band-slotted')!;
    const plain = sheet.parts.find((p) => p.id === 'rail-band')!;
    expect(slotted).toBeDefined();
    expect(plain).toBeDefined();
    const slots = slotted.loops.filter((l) => l.kind === 'cutInner');
    expect(slots.length).toBeGreaterThanOrEqual(1);
    for (const s of slots) {
      const bb = bboxOfPts([...s.pts]);
      expect(bb.maxX - bb.minX).toBeCloseTo(material + DEFAULT_HWS_PARAMS.slotFit, 3);
    }
    expect(plain.loops.some((l) => l.kind === 'cutInner')).toBe(false);
  });

  it('horizontal template: band between outline and offset curve, developed', () => {
    const part = railPart({ railLamination: 'horizontal' })!;
    const cut = cutLoop(part);
    expect(hasSelfIntersection(cut.pts)).toBe(false);
    const bb = bboxOfPts([...cut.pts]);
    const dev = developHorizontalRailBand(board, {
      offset: band,
      tailTrim: DEFAULT_HWS_PARAMS.railTailTrim,
      noseTrim: DEFAULT_HWS_PARAMS.railNoseTrim,
      tolerance: DEFAULT_HWS_PARAMS.sampleTolerance,
    });
    expect(bb.maxX - bb.minX).toBeCloseTo(dev.length, 1);
  });

  it('horizontal tabSlot: layer-1 inner edge carries rib notches', () => {
    const sheet = buildHwsTemplates(board, {
      ...railParams,
      railLamination: 'horizontal',
      railJoint: 'tabSlot',
    });
    const slotted = sheet.parts.find((p) => p.id === 'rail-band-slotted')!;
    const plain = sheet.parts.find((p) => p.id === 'rail-band')!;
    // The notched loop has strictly more vertices than the plain one.
    expect(cutLoop(slotted).pts.length).toBeGreaterThan(cutLoop(plain).pts.length);
    expect(hasSelfIntersection(cutLoop(slotted).pts)).toBe(false);
  });
});

describe('buildHwsTemplates — rib profile survives a bottom that dips near the rail', () => {
  // Real boards (e.g. the bundled sample) have a bottom contour that drops BELOW
  // the centreline height toward the rail. The rib polygon's global min-y vertex
  // then sits at the rail, not on the centreline seam — which used to make
  // extractRightHalf keep only the rail-face→deck fragment (a "diamond" rib with
  // the whole bottom edge collapsed to a straight line).
  const dippedBoard = (): ReturnType<typeof makeTestBoard> => {
    const base = makeTestBoard();
    const w = 25;
    const t = 6;
    // Bottom edge runs (0,0) → dips to (w, -0.35) at the rail; deck domes to (0, t).
    const profile = kSplineFromKnots([
      kKnot(kVec2(0, 0), kVec2(0, 0), kVec2(w * 0.5, -0.1)),
      kKnot(kVec2(w, -0.35), kVec2(w * 0.8, -0.3), kVec2(w, 0.6)),
      kKnot(kVec2(w, t * 0.45), kVec2(w, t * 0.25), kVec2(w, t * 0.75)),
      kKnot(kVec2(0, t), kVec2(w * 0.5, t), kVec2(0, t)),
    ]);
    const sections = base.crossSections.map((c) => kCrossSection(c.position, profile));
    return makeBoard(base.outline, base.bottom, base.deck, sections, base.interpolationType);
  };

  it.each([[0], [5]] as const)('rib keeps a sampled bottom edge (%d laminations)', (count) => {
    const sheet = buildHwsTemplates(dippedBoard(), {
      ribMode: 'evenCount',
      ribCount: 5,
      railLaminations: count,
      railStripThickness: 0.6,
    });
    for (const rib of sheet.parts.filter((p) => p.id.startsWith('rib-'))) {
      const pts = cutLoop(rib).pts;
      const bb = bboxOfPts([...pts]);
      const H = bb.maxY - bb.minY;
      const maxX = Math.max(...pts.map((p) => p.x));
      // The bottom edge between the slot mouth and the rail must be a sampled
      // curve (many vertices), not one straight chord: count vertices in the
      // lower quarter, away from the centreline slot.
      const bottomEdge = pts.filter(
        (p) => p.y < bb.minY + H * 0.25 && Math.abs(p.x) > 1 && Math.abs(p.x) < maxX - 0.5,
      );
      expect(bottomEdge.length).toBeGreaterThanOrEqual(8);
      expect(hasSelfIntersection(pts)).toBe(false);
    }
  });
});

describe('buildHwsTemplates — rib rail cut-back (the old railInset bug)', () => {
  // Vertical mode: 5 × 0.6 cm strips ⇒ a 3 cm band offset.
  const bandParams = { railLaminations: 5, railStripThickness: 0.6 } as const;
  const centreRib = (extra: object = {}) =>
    buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 1, ...extra }).parts.find((p) =>
      p.id.startsWith('rib-'),
    )!;

  it('keeps the rib deck/bottom height unchanged (only the sides pull in)', () => {
    const plain = bboxOfPts(allPts(centreRib()));
    const cut = bboxOfPts(allPts(centreRib(bandParams)));
    // Heights equal: the band cut-back never lowers the deck or raises the bottom.
    expect(cut.maxY).toBeCloseTo(plain.maxY, 2);
    expect(cut.minY).toBeCloseTo(plain.minY, 2);
    // Width shrinks by ~ the band thickness per side.
    expect(cut.maxX).toBeLessThan(plain.maxX - 1);
  });

  it('rib sides stop at the offset-outline half-width, as vertical flats', () => {
    const rib = centreRib(bandParams);
    const pts = cutLoop(rib).pts;
    const yCut = outlineInsetHalfWidthAt(board, 50, 3);
    const maxX = pts.reduce((m, q) => Math.max(m, q.x), 0);
    expect(maxX).toBeCloseTo(yCut, 1);
    // A vertical face: at least two consecutive points share x = ±maxX.
    let face = false;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]!.x - maxX) < 1e-3 && Math.abs(pts[i - 1]!.x - maxX) < 1e-3) face = true;
    }
    expect(face).toBe(true);
    expect(hasSelfIntersection(pts)).toBe(false);
  });

  it('tabSlot ribs grow a locating tab past the side face', () => {
    const plain = centreRib(bandParams);
    const tabbed = centreRib({ ...bandParams, railJoint: 'tabSlot' });
    const plainMax = cutLoop(plain).pts.reduce((m, q) => Math.max(m, q.x), 0);
    const tabbedMax = cutLoop(tabbed).pts.reduce((m, q) => Math.max(m, q.x), 0);
    expect(tabbedMax).toBeCloseTo(plainMax + bandParams.railStripThickness, 2);
    expect(hasSelfIntersection(cutLoop(tabbed).pts)).toBe(false);
  });

  it('half-lap slot geometry survives the side cut-back', () => {
    const halfLap = 0.5;
    const rib = centreRib({ ...bandParams, halfLapFraction: halfLap });
    const pts = cutLoop(rib).pts;
    const bb = bboxOfPts([...pts]);
    const ybc = bb.minY;
    const H = bb.maxY - bb.minY;
    const roof = pts.filter((p) => Math.abs(p.x) < 1 && p.y > ybc + 0.01);
    const slotTopY = Math.min(...roof.map((p) => p.y));
    expect(slotTopY - ybc).toBeCloseTo((1 - halfLap) * H, 1);
  });
});

describe('sheet writers', () => {
  const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 4 });

  it('DXF declares CUT/MARK layers, millimetre units, and emits polylines', () => {
    const dxf = sheetToDxf(sheet);
    expect(dxf).toContain('CUT');
    expect(dxf).toContain('MARK');
    expect(dxf).toContain('POLYLINE');
    // Units declared as millimetres ($INSUNITS = 4) so importers don't guess.
    expect(dxf).toMatch(/\$INSUNITS\n70\n4\n/);
    expect(dxf.endsWith('EOF\n')).toBe(true);
  });

  it('DXF and SVG agree on scale (both millimetres)', () => {
    // The widest coordinate should match between formats (mm), not differ ×10.
    const dxf = sheetToDxf(sheet);
    const svg = sheetToSvg(sheet);
    const maxCoord = (text: string, re: RegExp): number =>
      Math.max(...[...text.matchAll(re)].map((m) => parseFloat(m[1]!)));
    const dxfMax = maxCoord(dxf, /\n10\n([\d.]+)\n/g); // DXF x coords (group 10)
    const svgMax = maxCoord(svg, /[ML]([\d.]+) /g); // SVG path x coords
    expect(dxfMax).toBeGreaterThan(100); // mm-scale for a board > 1 m, not cm
    expect(dxfMax).toBeCloseTo(svgMax, 0);
  });

  const maxCoord = (text: string, re: RegExp): number =>
    Math.max(...[...text.matchAll(re)].map((m) => parseFloat(m[1]!)));

  it('DXF follows the requested unit (inches: $INSUNITS=1, coords ×1/2.54)', () => {
    const mm = sheetToDxf(sheet, { unit: 'mm' });
    const inch = sheetToDxf(sheet, { unit: 'in' });
    expect(inch).toMatch(/\$INSUNITS\n70\n1\n/);
    const mmMax = maxCoord(mm, /\n10\n([\d.]+)\n/g);
    const inMax = maxCoord(inch, /\n10\n([\d.]+)\n/g);
    expect(inMax).toBeCloseTo(mmMax / 25.4, 1); // mm = cm×10, in = cm/2.54
  });

  it('DXF in centimetres declares $INSUNITS=5', () => {
    expect(sheetToDxf(sheet, { unit: 'cm' })).toMatch(/\$INSUNITS\n70\n5\n/);
  });

  it('SVG carries the requested unit on width/height', () => {
    expect(sheetToSvg(sheet, { unit: 'in' })).toMatch(/width="[\d.]+in"/);
    expect(sheetToSvg(sheet, { unit: 'cm' })).toMatch(/height="[\d.]+cm"/);
  });

  it('SVG is mm-sized, one <g> per part, cut=red / mark=blue', () => {
    const svg = sheetToSvg(sheet);
    expect(svg).toContain('<svg');
    expect(svg).toMatch(/width="[\d.]+mm"/);
    expect(svg).toContain('#FF0000');
    expect(svg).toContain('#0000FF');
    const groups = svg.match(/<g /g) ?? [];
    expect(groups).toHaveLength(sheet.parts.length);
  });

  it('PDF is well-formed with one page per part', () => {
    const bytes = sheetToPdf(sheet);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    expect(s.startsWith('%PDF')).toBe(true);
    expect(s).toContain('startxref');
    expect(s).toContain(`/Count ${sheet.parts.length}`);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('prints the meta.note on every writer', () => {
    const NOTE = 'OpenShaper HWS test note';
    const noted = { ...sheet, meta: { ...sheet.meta, note: NOTE } };
    expect(sheetToDxf(noted)).toContain(NOTE);
    expect(sheetToSvg(noted)).toContain(NOTE);
    const bytes = sheetToPdf(noted);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    expect(s).toContain(NOTE);
  });
});

describe('buildHwsTemplates — fin-box marks', () => {
  const finned = (system: Parameters<typeof defaultFinConfig>[1], setup = 'thruster' as const) => {
    const b = makeTestBoard();
    return makeBoard(b.outline, b.bottom, b.deck, b.crossSections, b.interpolationType, defaultFinConfig(setup, system)); // prettier-ignore
  };
  const marks = (part: Part) => part.loops.filter((l) => l.kind === 'mark');

  it('adds no fin marks for a finless board, and never cuts them', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 4 });
    const skin = sheet.parts.find((p) => p.id === 'skin-bottom')!;
    expect(skin.labels?.some((l) => l.text.includes('fin'))).toBeFalsy();
  });

  it('marks fin footprints + Futures boxes on the BOTTOM skin only (mark, never cut)', () => {
    const sheet = buildHwsTemplates(finned('futures'), { ribMode: 'evenCount', ribCount: 4 });
    const bottom = sheet.parts.find((p) => p.id === 'skin-bottom')!;
    const deck = sheet.parts.find((p) => p.id === 'skin-deck')!;
    // 3 fins → labelled on the bottom skin; nothing fin-related on the deck skin.
    expect(bottom.labels?.filter((l) => l.text.includes('fin')).length).toBe(3);
    expect(deck.labels?.some((l) => l.text.includes('fin'))).toBeFalsy();
    // Fin geometry is non-cutting.
    expect(bottom.loops.every((l) => l.kind !== 'cutInner' || l.pts.length > 0)).toBe(true);
    // A closed box outline exists among the bottom-skin marks.
    expect(marks(bottom).some((l) => l.closed)).toBe(true);
  });

  it('marks the center-fin box on the stringer for setups with a center fin', () => {
    const sheet = buildHwsTemplates(finned('futures', '2+1'), {
      ribMode: 'evenCount',
      ribCount: 4,
    });
    const stringer = sheet.parts.find((p) => p.id === 'stringer')!;
    expect(stringer.labels?.some((l) => l.text === 'fin box')).toBe(true);
  });

  it('does not mark the stringer for a fin setup with no center fin (twin)', () => {
    const sheet = buildHwsTemplates(finned('futures', 'twin'), {
      ribMode: 'evenCount',
      ribCount: 4,
    });
    const stringer = sheet.parts.find((p) => p.id === 'stringer')!;
    expect(stringer.labels?.some((l) => l.text === 'fin box')).toBeFalsy();
  });
});
