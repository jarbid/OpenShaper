// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS exports (docs/design/m3-exports.md, step 1): STL closed and the right size, the DXF outline on
 * the document's chains, the sections the surface's own, both halves of an asymmetric board, and the
 * client's cancel. Boards: the three goldens, a swallow and a fish (with bottom features), an asymmetric
 * board with channels.
 */
import { buildBoard, meshBoard, probeSection, createEvaluator } from '@openshaper/board2';
import type { BoardDoc } from '@openshaper/board2';
import { asymmetricBoard, fishBoard, swallowBoard } from '@openshaper/board2/testing';
import { parseBrd } from '@openshaper/io';
import { describe, expect, it } from 'vitest';
import funBrd from '../funboard.brd?raw';
import longBrd from '../longboard.brd?raw';
import sampleBrd from '../sample-board.brd?raw';
import {
  ExportCancelledError,
  startNurbsExport,
  type ExportTransport,
} from '../nurbs-export-client';
import { convertToDoc, curvesOfBuilt, exportDocument, resetCore } from './nurbs-core';
import type { ExportJob, ExportResponse, ExportStage } from './nurbs-protocol';

const converted = (brd: string): BoardDoc => {
  const c = convertToDoc(parseBrd(brd).board);
  if (!c.ok) throw new Error(c.error);
  return c.doc;
};

const BOARDS: readonly [string, () => BoardDoc][] = [
  ['shortboard', () => converted(sampleBrd)],
  ['funboard', () => converted(funBrd)],
  ['longboard', () => converted(longBrd)],
  ['swallow (vee, double concave)', swallowBoard],
  ['fish', fishBoard],
  ['asymmetric (channels)', asymmetricBoard],
];

const built = (doc: BoardDoc) => {
  const r = buildBoard(doc, { check: false });
  if (!r.ok) throw new Error('build');
  return r.value;
};

/** The facets of a binary STL as float32 positions. */
const facets = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(80, true);
  const out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 9; k++) out[9 * t + k] = view.getFloat32(84 + 50 * t + 12 + 4 * k, true);
  }
  return out;
};

/** Directed edges that are not used exactly once with their reverse used exactly once, by float32 position. */
const badEdges = (tri: Float32Array): number => {
  const ids = new Map<string, number>();
  const id = (o: number): number => {
    const key = `${tri[o]},${tri[o + 1]},${tri[o + 2]}`;
    let v = ids.get(key);
    if (v === undefined) ids.set(key, (v = ids.size));
    return v;
  };
  const edges = new Map<string, number>();
  for (let t = 0; t < tri.length; t += 9) {
    const v = [id(t), id(t + 3), id(t + 6)];
    for (let e = 0; e < 3; e++) {
      const k = `${v[e]}>${v[(e + 1) % 3]}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) bad++;
  }
  return bad;
};

/** Volume of a closed triangle list (signed tetrahedra about the origin). */
const volume = (tri: Float32Array): number => {
  let v = 0;
  for (let t = 0; t < tri.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from(tri.subarray(t, t + 9)) as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
};

const ok = (out: ReturnType<typeof exportDocument>) => {
  if (!out.ok) throw new Error(out.error);
  return out;
};

describe('STL from the document', () => {
  it.each(BOARDS)('%s: a closed manifold within 1 % of the live mesh volume', (_name, make) => {
    const doc = make();
    const out = ok(exportDocument(doc, { format: 'stl', faceSize: 1, slug: 'b' }));
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.name).toBe('b.stl');
    const tri = facets(out.files[0]!.bytes);
    expect(tri.length).toBeGreaterThan(9 * 5000);
    expect(badEdges(tri)).toBe(0);
    const live = meshBoard(built(doc)).volume;
    expect(Math.abs(volume(tri) - live) / live).toBeLessThan(0.01);
  });

  it('is finer with a smaller face size', () => {
    const doc = BOARDS[0]![1]();
    const coarse = ok(exportDocument(doc, { format: 'stl', faceSize: 2, slug: 'b' }));
    const fine = ok(exportDocument(doc, { format: 'stl', faceSize: 0.75, slug: 'b' }));
    expect(fine.files[0]!.bytes.length).toBeGreaterThan(2 * coarse.files[0]!.bytes.length);
  });
});

describe('STEP from the document', () => {
  it.each([BOARDS[0]!, BOARDS[3]!])(
    '%s: a Part 21 solid, with progress',
    (_name, make) => {
      const stages: ExportStage[] = [];
      const out = ok(
        exportDocument(make(), { format: 'step', unit: 'mm', slug: 'b' }, (s) => stages.push(s)),
      );
      expect(out.files).toHaveLength(1);
      expect(out.files[0]!.name).toBe('b.step');
      expect(out.files[0]!.type).toBe('model/step');
      const text = new TextDecoder().decode(out.files[0]!.bytes);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
      expect(text).toContain('MANIFOLD_SOLID_BREP');
      expect(text).toContain('.MILLI.');
      expect(stages).toEqual(['building', 'fitting', 'writing']);
    },
    60_000,
  );
});

/** The polylines of one DXF layer: R12 POLYLINE / VERTEX records. */
const dxfPolylines = (dxf: string, layer: string): { x: number; y: number }[][] => {
  const lines = dxf.split('\n');
  const out: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] | null = null;
  let x = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim();
    const val = lines[i + 1]!.trim();
    if (code === '0') {
      if (val === 'POLYLINE') cur = [];
      else if (val === 'SEQEND' && cur) {
        out.push(cur);
        cur = null;
      }
    } else if (code === '8' && cur && val !== layer && cur.length === 0) cur = null;
    else if (cur && code === '10') x = Number(val);
    else if (cur && code === '20') cur.push({ x, y: Number(val) });
  }
  return out;
};

const distToPolyline = (p: { x: number; y: number }, pl: { x: number; y: number }[]): number => {
  let best = Infinity;
  for (let i = 0; i + 1 < pl.length; i++) {
    const a = pl[i]!;
    const b = pl[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
};

const dxfJob = (over: Partial<Extract<ExportJob, { format: 'dxf' }>> = {}): ExportJob => ({
  format: 'dxf',
  curveMode: 'polyline',
  crossSectionCount: 7,
  ghost: null,
  fins: [],
  slug: 'b',
  ...over,
});

describe('DXF from the document', () => {
  it.each([BOARDS[0]!, BOARDS[3]!, BOARDS[5]!])(
    '%s: the outline is within 0.01 mm of the document chains, both halves',
    (_name, make) => {
      const doc = make();
      const out = ok(exportDocument(doc, dxfJob()));
      const text = new TextDecoder().decode(out.files[0]!.bytes);
      const outline = dxfPolylines(text, 'OUTLINE')[0]!;
      const c = curvesOfBuilt(built(doc), 7, []);
      // the chains, dense: plus half as is, minus half mirrored to -y
      const dense = (segs: typeof c.outlinePlus, sign: 1 | -1) =>
        segs.flatMap((s) =>
          Array.from({ length: 4001 }, (_, i) => {
            const t = i / 4000;
            const u = 1 - t;
            const f = (a: number, b: number, cc: number, d: number) =>
              u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * cc + t * t * t * d;
            return {
              x: f(s.p0.x, s.c1.x, s.c2.x, s.p3.x),
              y: sign * f(s.p0.y, s.c1.y, s.c2.y, s.p3.y),
            };
          }),
        );
      const plus = dense(c.outlinePlus, 1);
      const minus = dense(c.outlineMinus ?? c.outlinePlus, -1);
      const MM = 0.001; // 0.01 mm in cm
      for (const p of outline) {
        expect(Math.min(distToPolyline(p, plus), distToPolyline(p, minus))).toBeLessThan(MM);
      }
      // and the other way: no stretch of a chain is missing from the polyline
      for (const side of [plus, minus]) {
        for (let i = 0; i < side.length; i += 97) {
          expect(distToPolyline(side[i]!, outline)).toBeLessThan(MM);
        }
      }
      // both halves are drawn: the plan reaches each half's own width
      const ys = outline.map((p) => p.y);
      const maxY = Math.max(...c.outlinePlus.flatMap((s) => [s.p0.y, s.p3.y, s.c1.y, s.c2.y]));
      expect(Math.max(...ys)).toBeGreaterThan(0.9 * maxY);
      if (doc.symmetry === 'asymmetric') {
        const minusWidth = -Math.min(...ys);
        expect(Math.abs(minusWidth - Math.max(...ys))).toBeGreaterThan(0.05);
      }
    },
  );

  it('draws the sections the surface has: within 0.5 mm of dense probes, both sides, features in', () => {
    for (const make of [swallowBoard, asymmetricBoard]) {
      const doc = make();
      const b = built(doc);
      const ev = createEvaluator(b);
      const c = curvesOfBuilt(b, 9, []);
      expect(c.sections).toHaveLength(9);
      for (const sec of c.sections) {
        for (const side of doc.symmetry === 'asymmetric' ? ([0, 1] as const) : ([0] as const)) {
          const mine = side === 0 ? sec.plus : sec.minus!;
          const dense = probeSection(b, ev, side, sec.pos, 1500);
          const poly = mine.map((p) => ({ x: p.x, y: p.y }));
          for (let i = 0; i < dense.length; i += 2) {
            expect(distToPolyline({ x: dense[i]!, y: dense[i + 1]! }, poly)).toBeLessThan(0.05);
          }
        }
      }
    }
  });

  it('labels a station in the notch zone "rail section"', () => {
    const text = new TextDecoder().decode(ok(exportDocument(swallowBoard(), dxfJob())).files[0]!.bytes); // prettier-ignore
    expect(text).toContain('rail section');
    const plain = new TextDecoder().decode(ok(exportDocument(BOARDS[0]![1](), dxfJob())).files[0]!.bytes); // prettier-ignore
    expect(plain).not.toContain('rail section');
  });

  it.each([
    ['swallow', swallowBoard],
    ['fish', fishBoard],
  ])('%s: notch-zone stations are two fan chords and two unjoined half-sections', (_n, make) => {
    const doc = make();
    const c = curvesOfBuilt(built(doc), 7, []);
    const text = new TextDecoder().decode(ok(exportDocument(doc, dxfJob())).files[0]!.bytes);
    const rails = c.sections.filter((s) => s.rail);
    expect(rails.length).toBeGreaterThan(0);
    // MARKERS lines: [x1,y1,x2,y2]
    const lines = text.split('\n');
    const marks: number[][] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      if (lines[i]!.trim() !== '0' || lines[i + 1]!.trim() !== 'LINE') continue;
      const rec: Record<string, string> = {};
      for (let j = i + 2; j + 1 < lines.length && lines[j]!.trim() !== '0'; j += 2) rec[lines[j]!.trim()] = lines[j + 1]!.trim(); // prettier-ignore
      if (rec['8'] === 'MARKERS') marks.push([+rec['10']!, +rec['20']!, +rec['11']!, +rec['21']!]);
    }
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;
    for (const s of rails) {
      for (const end of [s.chordPlus, s.chordMinus]) {
        // a marker from (pos, 0) to the chord end, and none straight across the board
        expect(marks.some((m) => near(m[0]!, s.pos) && near(m[1]!, 0) && near(m[2]!, end.x) && near(m[3]!, end.y))).toBe(true); // prettier-ignore
      }
      expect(marks.some((m) => near(m[1]!, s.chordMinus.y) && near(m[3]!, s.chordPlus.y))).toBe(false); // prettier-ignore
    }
    // sections: the rail halves are open polylines, only the x-plane stations are rings
    const closedFlags: string[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      if (
        lines[i]!.trim() === '8' &&
        lines[i + 1]!.trim() === 'CROSSSECTION' &&
        lines[i - 1]!.trim() === 'POLYLINE'
      ) {
        // prettier-ignore
        const k = lines.findIndex((l, j) => j > i && l.trim() === '70');
        closedFlags.push(lines[k + 1]!.trim());
      }
    }
    const plain = c.sections.length - rails.length;
    expect(closedFlags.filter((f) => f === '1')).toHaveLength(plain);
    expect(closedFlags.filter((f) => f === '0')).toHaveLength(2 * rails.length);
    expect(text).toContain('chord');
  });

  it('PDF: a notch-zone station is two half-section pages, with no width and no flip note', () => {
    const out = ok(exportDocument(swallowBoard(), { format: 'pdf-1to1', options: { crossSectionCount: 7 }, fins: [], slug: 'b' })); // prettier-ignore
    const t = new TextDecoder('latin1').decode(out.files[0]!.bytes);
    expect(t).toContain('Rail section + side');
    expect(t).toContain('Rail section - side');
    expect(t).not.toMatch(/rail section[^)]*flip about the stringer/);
    expect(t).not.toMatch(/rail section\)? ?[^\n]*w \d/);
  });

  it('writes true curves for the outline in spline mode', () => {
    const out = ok(exportDocument(BOARDS[0]![1](), dxfJob({ curveMode: 'spline' })));
    expect(out.files[0]!.name).toBe('b-spline.dxf');
    expect(new TextDecoder().decode(out.files[0]!.bytes)).toContain('SPLINE');
  });
});

describe('PDF 1:1 from the document', () => {
  const pdf = (doc: BoardDoc, options = {}) => {
    const out = ok(exportDocument(doc, { format: 'pdf-1to1', options, fins: [], slug: 'b' }));
    return { out, text: new TextDecoder('latin1').decode(out.files[0]!.bytes) };
  };

  it('is a PDF with one page per part, the sections as built', () => {
    const { out, text } = pdf(BOARDS[0]![1](), { crossSectionCount: 5, halfSections: false });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.name).toBe('b-1to1.pdf');
    expect(text.startsWith('%PDF')).toBe(true);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(2 + 5);
  });

  it('prints an asymmetric board whole, whatever the half options say', () => {
    const { text } = pdf(asymmetricBoard(), { halfOutline: true, halfSections: true });
    expect(text).not.toContain('Outline half');
    expect(text).not.toContain('Section half');
  });

  it('labels the notch-zone sections', () => {
    expect(pdf(swallowBoard()).text).toContain('rail section');
  });
});

describe('the job', () => {
  it('reports its stages in order and refuses a document the model refuses', () => {
    resetCore();
    const stages: ExportStage[] = [];
    ok(exportDocument(BOARDS[0]![1](), dxfJob(), (s) => stages.push(s)));
    expect(stages).toEqual(['building', 'sampling', 'drawing', 'writing']);
    const doc = BOARDS[0]![1]();
    const broken: BoardDoc = { ...doc, stations: [] };
    const out = exportDocument(broken, dxfJob());
    expect(out.ok).toBe(false);
  });
});

describe('the export client', () => {
  it('exports the document it was given, and Cancel terminates the worker', async () => {
    const doc = BOARDS[0]![1]();
    let posted: unknown = null;
    let terminated = 0;
    const transport: ExportTransport = {
      post: (req) => (posted = req),
      terminate: () => terminated++,
    };
    const run = startNurbsExport(doc, dxfJob(), undefined, () => transport);
    const caught = run.result.catch((e: unknown) => e);
    expect((posted as { doc: BoardDoc }).doc).toBe(doc);
    run.cancel();
    expect(await caught).toBeInstanceOf(ExportCancelledError);
    expect(terminated).toBe(1);
    run.cancel(); // no effect twice
    expect(terminated).toBe(1);
  });

  it('reports the worker’s stages and answers with its files, then stops the worker', async () => {
    const doc = BOARDS[0]![1]();
    const stages: ExportStage[] = [];
    let id = -1;
    let terminated = 0;
    let send!: (res: ExportResponse) => void;
    const run = startNurbsExport(
      doc,
      dxfJob(),
      (s) => stages.push(s),
      (h) => {
        send = h.onMessage;
        return { post: (req) => (id = req.id), terminate: () => terminated++ };
      },
    );
    send({ kind: 'export-progress', id: id + 100, stage: 'writing' }); // another export's: ignored
    send({ kind: 'export-progress', id, stage: 'drawing' });
    const files = [{ name: 'b.dxf', type: 'application/dxf', bytes: new Uint8Array(3) }];
    send({ kind: 'exported', id, ok: true, files, ms: 5 });
    expect(await run.result).toEqual({ ok: true, files, ms: 5 });
    expect(stages).toEqual(['drawing']);
    expect(terminated).toBe(1);
  });
});
