// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { getLength } from '@openshaper/kernel';
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

describe('sheet writers', () => {
  const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 4 });

  it('DXF declares CUT/MARK layers and emits polylines', () => {
    const dxf = sheetToDxf(sheet);
    expect(dxf).toContain('CUT');
    expect(dxf).toContain('MARK');
    expect(dxf).toContain('POLYLINE');
    expect(dxf.endsWith('EOF\n')).toBe(true);
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
});
