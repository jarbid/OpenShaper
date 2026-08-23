// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  getThicknessAtPos,
  railFacetPlan,
  railFacetsAt,
  railFacetStations,
} from '@openshaper/kernel';
import { POINTS_PER_CM } from './paper';
import { BRAND_LINE } from './brand';
import { exportRailBandsPdf } from './rail-bands-pdf';
import { makeTestBoard } from './fixture.test-helper';

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

/** Stations the test board actually gets, at the settings used throughout. */
const STATIONS = { stationSpacingCm: 20, endMarginCm: 15 };

const run = (opts = {}) => exportRailBandsPdf(makeTestBoard(), { ...STATIONS, ...opts });

const pdfText = (opts = {}): string => decode(run(opts).file.bytes);

/** Every straight segment in the content streams, as [x0, y0, x1, y1] in points. */
const segments = (text: string): [number, number, number, number][] => {
  const out: [number, number, number, number][] = [];
  const re = /([-\d.]+) ([-\d.]+) m\n([-\d.]+) ([-\d.]+) l/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return out;
};

describe('exportRailBandsPdf', () => {
  it('writes a well-formed PDF', () => {
    const text = pdfText();
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('startxref');
  });

  it('emits one overview page plus one detail page per station', () => {
    const board = makeTestBoard();
    const stations = railFacetStations(board, {
      targetSpacingCm: STATIONS.stationSpacingCm,
      endMarginCm: STATIONS.endMarginCm,
    });
    expect(stations.length).toBeGreaterThan(1);
    const text = pdfText();
    const pages = text.match(/\/Type \/Page\b/g)!.length;
    expect(pages).toBe(1 + stations.length);
    expect(Number(text.match(/\/Count (\d+)/)![1])).toBe(pages);
  });

  it('drops the detail pages on request', () => {
    const text = pdfText({ detailPages: false });
    expect(text.match(/\/Type \/Page\b/g)!.length).toBe(1);
  });

  it('prints the detail pages at true 1:1', () => {
    // The blank's rail plane runs the full thickness of the section. Its drawn length
    // must be that thickness in centimetres times the points-per-cm constant — if any
    // fit-to-page crept in, this is what would catch it.
    const board = makeTestBoard();
    const x = railFacetStations(board, {
      targetSpacingCm: STATIONS.stationSpacingCm,
      endMarginCm: STATIONS.endMarginCm,
    })[0]!;
    const st = railFacetsAt(board, x)!;
    const expectedPt = st.blank.thickness * POINTS_PER_CM;

    const verticals = segments(pdfText())
      .filter(([x0, , x1]) => Math.abs(x0 - x1) < 0.01)
      .map(([, y0, , y1]) => Math.abs(y1 - y0));
    expect(verticals.some((len) => Math.abs(len - expectedPt) < 0.5)).toBe(true);
  });

  it('sizes pages to the chosen paper, not to the artwork', () => {
    const text = pdfText();
    const boxes = [...text.matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    expect(boxes.length).toBeGreaterThan(1);
    for (const [w, h] of boxes) {
      // A4 either way up
      expect(Math.max(w, h)).toBeCloseTo(841.89, 1);
      expect(Math.min(w, h)).toBeCloseTo(595.28, 1);
    }
    // Landscape throughout: a rail crop is much wider than it is tall, because the
    // shallowest band reaches a long way in from the rail before it meets the deck.
    for (const [w, h] of boxes) expect(w).toBeGreaterThan(h);
  });

  it('caps the crop at the sheet rather than growing it sideways', () => {
    // Ask for far more rail than a sheet can hold at 1:1. The scale must not shrink —
    // the whole point is measuring off the paper — and the sheet must not grow either,
    // because a page a little over A4 is what tempts "fit to page". The crop is capped
    // and any mark beyond it keeps its true number over a broken dimension line.
    const res = run({ detailCropCm: 60 });
    const text = decode(res.file.bytes);
    const boxes = [...text.matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.max(...boxes)).toBeCloseTo(841.89, 1);
    expect(res.warnings.some((w) => w.code === 'page-oversized')).toBe(false);
  });

  it('names the placement it used, and says when the angles vary along the board', () => {
    // A sheet found on a bench a week later has to say which placement produced it —
    // the marks are meaningless against the wrong one.
    const board = makeTestBoard();
    const plan = railFacetPlan(board, { ...STATIONS, angleMode: 'least-foam' });
    const wp = plan.stations.find((st) => st.position >= plan.widePoint) ?? plan.stations[0]!;
    const fitted = pdfText({ facets: { angleMode: 'least-foam' } });
    expect(fitted).toContain('fitted for least foam');
    // the widepoint's own angles, since that is the section a rail is designed around
    expect(fitted).toContain(wp.deckFacets.map((f) => `${f.targetAngle}`).join('° / '));

    const ladder = pdfText({ facets: { angleMode: 'ladder' } });
    expect(ladder).toContain('halving ladder');
    expect(ladder).toContain('45');
    // one angle set for the whole board, so there is nothing to qualify
    expect(ladder).not.toContain('varying along the board');
  });

  it('prints how much foam the cuts actually take out', () => {
    const text = pdfText();
    expect(text).toMatch(/take out \d+% of the foam standing proud/);
    expect(text).toContain('Deepest left to blend');
  });

  it('breaks a dimension whose mark lands off the crop, keeping the true number', () => {
    // A narrow crop puts the innermost deck mark outside the page. The number must
    // survive; only the line through it is interrupted.
    const st = railFacetsAt(makeTestBoard(), railFacetStations(makeTestBoard(), {
      targetSpacingCm: STATIONS.stationSpacingCm,
      endMarginCm: STATIONS.endMarginCm,
    })[0]!)!;
    const inner = st.deckFacets[st.deckFacets.length - 1]!;
    const mark = inner.marks.find((m) => m.ref.kind === 'deckPlane')!;
    const text = pdfText({ detailCropCm: 4 });
    expect(text).toContain(`${mark.distance.toFixed(1)} cm`);
  });

  it('dimensions the rail apex as a height, and does not name the rail', () => {
    // The apex is what a shaper judges rail volume by. It is dimensioned as a plain
    // height: "50/50" and "60/40" count from the deck and along the rail's curve, so a
    // ratio printed against the blank's thickness would read two ways.
    const board = makeTestBoard();
    const x = railFacetStations(board, {
      targetSpacingCm: STATIONS.stationSpacingCm,
      endMarginCm: STATIONS.endMarginCm,
    })[0]!;
    const st = railFacetsAt(board, x)!;
    const pct = Math.round(((st.apex.y - st.blank.bottomY) / st.blank.thickness) * 100);
    const text = pdfText();
    expect(text).toContain(`${(st.apex.y - st.blank.bottomY).toFixed(1)} cm`);
    expect(text).not.toContain(`${pct}/${100 - pct}`);
  });

  it('draws and names the overcut when hand marks cut into the rail', () => {
    // Manual mode keeps the shaper's numbers and reports the damage; the sheet has to
    // show where it is, not just that it exists.
    const deep = exportRailBandsPdf(makeTestBoard(), {
      ...STATIONS,
      facets: { angleMode: 'manual' },
      manual: { by: 'distance', railPercent: 25, deckInCm: [1] },
    });
    expect(deep.warnings.some((w) => w.code === 'cuts-inside')).toBe(true);
    const text = decode(deep.file.bytes);
    expect(text).toContain('marked by hand');
  });

  it('labels the map as a diagram and the detail pages as templates', () => {
    const text = pdfText();
    expect(text).toContain('NOT TO SCALE');
    expect(text).toContain('print at 100% scale');
    expect(text).toContain('5 cm @100%'); // the calibration ruler
  });

  it('follows the unit it was given', () => {
    expect(pdfText({ units: 'in' })).toContain('units in');
    expect(pdfText({ units: 'cm' })).toContain('units cm');
    expect(pdfText({ units: 'in' })).toContain('2 in @100%');
  });

  it('prints lengths through an injected formatter', () => {
    const board = makeTestBoard();
    const st = railFacetsAt(
      board,
      railFacetStations(board, {
        targetSpacingCm: STATIONS.stationSpacingCm,
        endMarginCm: STATIONS.endMarginCm,
      })[0]!,
    )!;
    const mark = st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'deckPlane')!;
    const text = pdfText({ fmt: (cm: number) => `<<${cm.toFixed(1)}>>` });
    expect(text).toContain(`<<${mark.distance.toFixed(1)}>>`);
    // and the built-in formatting is not used for a measurement alongside it
    expect(text).not.toContain(`(${mark.distance.toFixed(1)} cm)`);
  });

  it('spells out the anchoring convention and the cut order on every detail page', () => {
    const text = pdfText();
    expect(text).toContain('Cut in this order');
    expect(text).toContain('Band 1 is marked on the squared blank');
  });

  it('colours the geometry by band, so a line can be followed page to page', () => {
    const text = pdfText();
    // band 1 blue, band 2 green, band 3 red, tuck magenta — as stroke colours
    expect(text).toContain('0.13 0.31 0.78 RG');
    expect(text).toContain('0.05 0.55 0.24 RG');
    expect(text).toContain('0.8 0.13 0.13 RG');
    expect(text).toContain('0.78 0.1 0.55 RG');
  });

  it('draws station reference lines as drafting centrelines', () => {
    // dash-dot, in cyan: a station line must never read as an edge
    const text = pdfText();
    expect(text).toContain('[7 2 1.5 2] 0 d');
    expect(text).toContain('0.13 0.62 0.75 RG');
  });

  it('keeps the tuck line off the plan view, where it would read as a deck mark', () => {
    // The tuck's mark is on the underside of the board. On the map it belongs to the
    // rocker only — the plan view shows what you can see looking down at the blank.
    const page1 = decode(run().file.bytes).split('stream')[1] ?? '';
    const magenta = page1.split('0.78 0.1 0.55 RG').length - 1;
    // exactly two: the rocker's tuck line, and its swatch in the legend. A tuck line
    // drawn on the plan would be mirrored, adding two more.
    expect(magenta).toBe(2);
  });

  it('maps the plan and the rocker together, with a key', () => {
    const text = pdfText();
    for (const label of ['band 1', 'tuck', 'rail apex', 'station']) {
      expect(text).toContain(label);
    }
  });

  it('knocks out a box behind every dimension label', () => {
    // white fill + rectangle, so a number over a line stays readable
    const text = pdfText();
    expect(text).toMatch(/1 1 1 rg\n[-\d. ]+ re\nf/);
  });

  it('dimensions the blank thickness at each station', () => {
    const board = makeTestBoard();
    const x = railFacetStations(board, {
      targetSpacingCm: STATIONS.stationSpacingCm,
      endMarginCm: STATIONS.endMarginCm,
    })[0]!;
    const st = railFacetsAt(board, x)!;
    expect(pdfText()).toContain(`${st.blank.thickness.toFixed(1)} cm`);
  });

  it('sheds explanatory prose rather than growing the page, but never the cut order', () => {
    // Six bands makes the mark table long enough to squeeze the footer. The prose goes
    // first — it is also on /docs/export — and the cut order never does.
    const res = run({ facets: { deckBands: 6 } });
    const text = decode(res.file.bytes);
    // Every detail page keeps its cut order; the tight ones drop prose to get there.
    const count = (needle: string): number => text.split(needle).length - 1;
    expect(count('Cut in this order')).toBeGreaterThan(1);
    expect(count('Every later band is marked on the face you just cut')).toBeLessThan(
      count('Cut in this order'),
    );
    const boxes = [...text.matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) =>
      Number(m[2]),
    );
    // Six bands genuinely need more room than A4 holds — every one of them now lands, so
    // the table is six rows longer than it used to be — and the sheet says so rather than
    // scaling. At the default three, it fits.
    expect(Math.max(...boxes)).toBeGreaterThan(595.28);
    expect(res.warnings.some((w) => w.code === 'page-oversized')).toBe(true);

    const three = run({ facets: { deckBands: 3 } });
    const threeBoxes = [
      ...decode(three.file.bytes).matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g),
    ].map((m) => Number(m[2]));
    expect(Math.max(...threeBoxes)).toBeCloseTo(595.28, 1);
    expect(three.warnings.some((w) => w.code === 'page-oversized')).toBe(false);
  });

  it('brands each page exactly once', () => {
    const text = pdfText();
    const pages = text.match(/\/Type \/Page\b/g)!.length;
    expect(text.split(BRAND_LINE).length - 1).toBe(pages);
  });

  it('is deterministic', () => {
    expect(run().file.bytes).toEqual(run().file.bytes);
  });

  it('returns the geometry warnings alongside the file', () => {
    const res = run();
    expect(Array.isArray(res.warnings)).toBe(true);
    for (const w of res.warnings) expect(typeof w.message).toBe('string');
  });

  it('still produces a file when no station can be banded', () => {
    // Margins that swallow the whole board leave nothing to draw; the export must come
    // back with an (almost empty) PDF rather than throw at the shaper.
    const res = run({ endMarginCm: 500 });
    expect(decode(res.file.bytes).startsWith('%PDF-')).toBe(true);
    expect(decode(res.file.bytes).match(/\/Type \/Page\b/g)!.length).toBe(1);
  });

  it('agrees with the kernel on what it printed', () => {
    const board = makeTestBoard();
    const x = railFacetStations(board, {
      targetSpacingCm: STATIONS.stationSpacingCm,
      endMarginCm: STATIONS.endMarginCm,
    })[0]!;
    const st = railFacetsAt(board, x)!;
    expect(getThicknessAtPos(board, x)).toBeLessThanOrEqual(st.blank.thickness + 1e-9);

    // band 1's deck mark, formatted the way the sheet formats it, appears on the sheet
    const deckMark = st.deckFacets[0]!.marks.find((m) => m.ref.kind === 'deckPlane')!;
    const text = pdfText();
    expect(text).toContain(`${deckMark.distance.toFixed(1)} cm`);
  });
});
