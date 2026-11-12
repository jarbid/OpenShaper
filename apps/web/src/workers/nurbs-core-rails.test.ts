// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The engine choice of the worker's compute (`JobOptions.engine`): the 'sections' answer is the one
 * captured before the choice existed, and the 'rails' answer is a consistent mesh, within 1.5 % of the
 * sections volume, with the sections, apex curves and exports the app reads.
 */
import {
  buildBoard,
  buildRails,
  convertSections,
  halfWidthRails,
  type BoardDoc,
} from '@openshaper/board2';
import { analyticBoard, asymmetricBoard, swallowBoard } from '@openshaper/board2/testing';
import { createHash } from 'node:crypto';
import { parseBrd } from '@openshaper/io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import fixture from './__fixtures__/nurbs-core-sections.json';
import {
  convertToDoc,
  curvesOfBuilt,
  exportDocument,
  measureDocument,
  meshDocument,
  probeDocument,
  resetCore,
} from './nurbs-core';
import type { ExportJob, JobOptions } from './nurbs-protocol';

const shortboard = (): BoardDoc => {
  const c = convertToDoc(parseBrd(sampleBrd).board);
  if (!c.ok) throw new Error(c.error);
  return c.doc;
};

const BOARDS: readonly [string, () => BoardDoc][] = [
  ['shortboard', shortboard],
  ['swallow', swallowBoard],
  ['asymmetric', asymmetricBoard],
];

const SETTLED: JobOptions = { curvature: true, deviation: false, reuseLadders: false };
const DRAG: JobOptions = { curvature: false, deviation: false, reuseLadders: true };
const RAILS = { engine: 'rails' } as const;

const midX = (doc: BoardDoc): number => doc.stations[Math.floor(doc.stations.length / 2)]!.x;

const mesh = (doc: BoardDoc, options: JobOptions, probes: readonly number[] = []) => {
  const out = meshDocument(doc, null, options, undefined, probes);
  if (!out.ok) throw new Error(out.error);
  return out;
};

// --- A comparable digest of what the 'sections' engine answers on the made boards -------------------
// Every scalar exactly, every typed array and file as its length and a hash of its bytes, timings left
// out. `__fixtures__/nurbs-core-sections.json` was captured from the code before the engine choice existed.

const hash = (a: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    .digest('hex');

const arr = (a: ArrayBufferView | null | undefined) =>
  a == null ? null : { length: (a as unknown as { length: number }).length, sha: hash(a) };

/** The outcome of a mesh job with its typed arrays digested and its timings dropped. */
export function digestOutcome(out: ReturnType<typeof meshDocument>): unknown {
  if (!out.ok) return { ok: false, error: out.error, issues: out.issues };
  const { mesh, timings: _t, ...rest } = out;
  return {
    ...rest,
    mesh: {
      positions: arr(mesh.positions),
      normals: arr(mesh.normals),
      indices: arr(mesh.indices),
      curvature:
        mesh.curvature === null
          ? null
          : {
              mean: arr(mesh.curvature.mean),
              gaussian: arr(mesh.curvature.gaussian),
              minRadius: arr(mesh.curvature.minRadius),
              scale: mesh.curvature.scale,
            },
      deviation: arr(mesh.deviation),
      deviationRange: mesh.deviationRange,
      deviationNoData: mesh.deviationNoData,
      laddersReused: mesh.laddersReused,
    },
  };
}

const DIGEST_BOARDS: readonly [string, () => BoardDoc][] = [
  ['analytic', analyticBoard],
  ['swallow', swallowBoard],
  ['asymmetric', asymmetricBoard],
];

/** What the sections engine answers for a fixed script on each board. */
export function sectionsDigest(engine?: 'sections'): Record<string, unknown> {
  const choice = engine ? { engine } : {};
  const out: Record<string, unknown> = {};
  for (const [name, make] of DIGEST_BOARDS) {
    resetCore();
    const doc = make();
    const x = doc.stations[Math.floor(doc.stations.length / 2)]!.x;
    const settled = meshDocument(
      doc,
      null,
      { curvature: true, deviation: false, reuseLadders: false, ...choice },
      undefined,
      [x],
    );
    const drag = meshDocument(
      doc,
      null,
      { curvature: false, deviation: false, reuseLadders: true, ...choice },
      undefined,
      [x],
    );
    const stl: ExportJob = { format: 'stl', faceSize: 1, slug: 'b', ...choice };
    const dxf: ExportJob = {
      format: 'dxf',
      curveMode: 'polyline',
      crossSectionCount: 5,
      ghost: null,
      fins: [],
      slug: 'b',
      ...choice,
    };
    const files = (job: ExportJob) => {
      const r = exportDocument(doc, job);
      return r.ok ? r.files.map((f) => ({ name: f.name, type: f.type, sha: hash(f.bytes) })) : r;
    };
    const m = measureDocument(doc, engine);
    out[name] = {
      settled: digestOutcome(settled),
      drag: digestOutcome(drag),
      probe: probeDocument(doc, [x, doc.stations[0]!.x + 1], engine),
      measure: m,
      stl: files(stl),
      dxf: files(dxf),
    };
  }
  return out;
}

beforeEach(() => resetCore());

/** The fixture without the field the choice added. */
const withoutEngine = (v: unknown): unknown => {
  const copy = structuredClone(v) as Record<
    string,
    Record<string, { summary?: { engine?: string } }>
  >;
  for (const board of Object.values(copy)) {
    for (const k of ['settled', 'drag']) delete board[k]!.summary!.engine;
  }
  return copy;
};

describe("engine 'sections' is the engine that was there before", () => {
  const captured = fixture as unknown;

  it('answers a made board exactly as before the choice existed (no engine given)', () => {
    const now = sectionsDigest();
    for (const board of Object.values(now) as Record<string, { summary: { engine?: string } }>[]) {
      expect(board.settled!.summary.engine).toBe('sections');
      expect(board.drag!.summary.engine).toBe('sections');
    }
    expect(withoutEngine(now)).toEqual(captured);
  });

  it("answers the same when 'sections' is asked for by name", () => {
    expect(withoutEngine(sectionsDigest('sections'))).toEqual(captured);
  });
});

describe.each(BOARDS)("engine 'rails' on the %s", (_name, make) => {
  it('says it built the surface, with a consistent finite mesh', () => {
    const out = mesh(make(), { ...SETTLED, engine: 'rails' });
    expect(out.summary.engine).toBe('rails');
    expect(out.issues.filter((i) => i.code === 'rails-fallback')).toEqual([]);
    const { positions, normals, indices } = out.mesh;
    expect(positions.length).toBeGreaterThan(3000);
    expect(normals.length).toBe(positions.length);
    expect(indices.length % 3).toBe(0);
    expect(positions.every(Number.isFinite)).toBe(true);
    expect(normals.every(Number.isFinite)).toBe(true);
    let top = 0;
    for (const i of indices) top = Math.max(top, i);
    expect(top).toBeLessThan(positions.length / 3);
    expect(out.mesh.laddersReused).toBe(false);
  });

  it('has a volume within 1.5 % of the sections engine, and the specs from the same mesh', () => {
    const doc = make();
    const sections = mesh(doc, SETTLED);
    const rails = mesh(doc, { ...SETTLED, engine: 'rails' });
    expect(rails.summary.volume / sections.summary.volume).toBeCloseTo(1, 1);
    expect(Math.abs(rails.summary.volume / sections.summary.volume - 1)).toBeLessThan(0.015);
    expect(rails.summary.planArea).toBeGreaterThan(0);
    expect(rails.summary.surfaceArea).toBeGreaterThan(rails.summary.planArea);
    const m = measureDocument(doc, 'rails');
    if (!m.ok) throw new Error(m.error);
    expect(Math.abs(m.volume / rails.summary.volume - 1)).toBeLessThan(0.01);
  });

  it('returns a mesh on the drag path and on the STL path', () => {
    const doc = make();
    const settled = mesh(doc, { ...SETTLED, engine: 'rails' });
    const drag = mesh(doc, { ...DRAG, engine: 'rails' });
    expect(drag.summary.engine).toBe('rails');
    expect(drag.mesh.positions.length).toBeGreaterThan(0);
    expect(drag.mesh.positions.length).toBeLessThanOrEqual(settled.mesh.positions.length);
    expect(drag.mesh.curvature).toBeNull();
    const stl = exportDocument(doc, { format: 'stl', faceSize: 1, slug: 'b', ...RAILS });
    if (!stl.ok) throw new Error(stl.error);
    expect(stl.files[0]!.name).toBe('b.stl');
    expect(stl.files[0]!.bytes.length).toBeGreaterThan(84);
  });

  it('has curvature arrays when asked, and none when not', () => {
    const doc = make();
    const n = mesh(doc, { ...SETTLED, engine: 'rails' }).mesh;
    expect(n.curvature).not.toBeNull();
    const vertices = n.positions.length / 3;
    expect(n.curvature!.mean.length).toBe(vertices);
    expect(n.curvature!.gaussian.length).toBe(vertices);
    expect(n.curvature!.minRadius.length).toBe(vertices);
    expect(mesh(doc, { ...SETTLED, curvature: false, engine: 'rails' }).mesh.curvature).toBeNull();
  });

  it('probes the section with the requested points, its apex at the half width', () => {
    const doc = make();
    const x = midX(doc);
    const board = convertSections(doc);
    if (!board.ok) throw new Error('not convertible');
    const probed = probeDocument(doc, [x], 'rails');
    if (!probed.ok) throw new Error(probed.error);
    const p = probed.probes[0]!;
    expect(p.plus.length).toBe(2 * 64);
    expect(p.plus.every(Number.isFinite)).toBe(true);
    // 64 points: the bottom takes the first 32, and the apex is the last of them
    expect(p.plus[2 * 31]).toBeCloseTo(halfWidthRails(board.value.board)(x), 6);
    expect(p.plus[0]).toBeCloseTo(0, 9);
    if (doc.symmetry === 'asymmetric') {
      expect(p.minus).not.toBeNull();
      expect(p.minus![2 * 31]).toBeCloseTo(halfWidthRails(board.value.board, 'minus')(x), 6);
    } else {
      expect(p.minus).toBeNull();
    }
    // the same probes ride on a mesh job
    expect(mesh(doc, { ...SETTLED, engine: 'rails' }, [x]).probes[0]!.plus.length).toBe(2 * 64);
  });

  it('draws the apex line and plan points of the DXF and PDF from the rails', () => {
    const doc = make();
    const built = buildBoard(doc, { check: false });
    if (!built.ok) throw new Error('did not build');
    const dxf: ExportJob = {
      format: 'dxf',
      curveMode: 'polyline',
      crossSectionCount: 5,
      ghost: null,
      fins: [],
      slug: 'b',
      ...RAILS,
    };
    const d = exportDocument(doc, dxf);
    if (!d.ok) throw new Error(d.error);
    expect(new TextDecoder().decode(d.files[0]!.bytes)).toContain('SECTION');
    const p = exportDocument(doc, {
      format: 'pdf-1to1',
      options: {},
      fins: [],
      slug: 'b',
      ...RAILS,
    });
    if (!p.ok) throw new Error(p.error);
    expect(new TextDecoder('latin1').decode(p.files[0]!.bytes).startsWith('%PDF')).toBe(true);
    // the curves themselves: the apex line is one height per x on the stringer, and the plan point of
    // a station is the half width at it
    const rails = convertSections(doc);
    if (!rails.ok) throw new Error('not convertible');
    const builtRails = buildRails(rails.value.board);
    if (!builtRails.ok) throw new Error('did not build');
    const onSections = curvesOfBuilt(built.value, 5, undefined);
    const onRails = curvesOfBuilt(built.value, 5, undefined, undefined, builtRails.value);
    expect(onRails.apex).toHaveLength(201);
    expect(onRails.sections).toHaveLength(5);
    expect(onRails.apex.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y))).toBe(true);
    const half = halfWidthRails(rails.value.board);
    for (const sec of onRails.sections) {
      expect(sec.chordPlus.x).toBe(sec.pos);
      expect(sec.chordPlus.y).toBeCloseTo(half(sec.pos), 6);
    }
    // mid-board the two engines' apex heights agree to a few millimetres
    const mid = Math.floor(onRails.apex.length / 2);
    expect(Math.abs(onRails.apex[mid]!.y - onSections.apex[mid]!.y)).toBeLessThan(0.3);
  });
});

describe('STEP stays on the sections engine whatever the choice', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('writes the same text for a rails request as for a sections request', () => {
    const doc = swallowBoard();
    const step = (job: Partial<ExportJob>) => {
      const out = exportDocument(doc, {
        format: 'step',
        unit: 'mm',
        slug: 'b',
        ...job,
      } as ExportJob);
      if (!out.ok) throw new Error(out.error);
      return new TextDecoder().decode(out.files[0]!.bytes);
    };
    const sections = step({});
    expect(sections).toContain('ISO-10303-21');
    expect(step({ engine: 'rails' })).toBe(sections);
  }, 120_000);
});

describe('a document the rails engine cannot convert', () => {
  // The swallow with only its station nearest the nose: today's build takes it, but no station is thick
  // and wide enough to carry a rail, so the converter refuses.
  const nosed = (): BoardDoc => {
    const doc = swallowBoard();
    return { ...doc, stations: [doc.stations[doc.stations.length - 1]!] };
  };

  it('is built by the sections engine, which the result says, with a warning why', () => {
    const doc = nosed();
    expect(convertSections(doc).ok).toBe(false);
    const sections = mesh(doc, SETTLED);
    const out = mesh(doc, { ...SETTLED, engine: 'rails' });
    expect(out.summary.engine).toBe('sections');
    const warning = out.issues.find((i) => i.code === 'rails-fallback');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('no station thick and wide enough');
    expect(out.summary.volume).toBe(sections.summary.volume);
    expect(out.mesh.positions).toEqual(sections.mesh.positions);
  });

  it('is probed, measured and exported on the sections engine too', () => {
    const doc = nosed();
    const x = doc.stations[0]!.x;
    const rails = probeDocument(doc, [x], 'rails');
    const sections = probeDocument(doc, [x]);
    expect(rails).toEqual(sections);
    expect(measureDocument(doc, 'rails')).toEqual(measureDocument(doc));
    const stl = exportDocument(doc, { format: 'stl', faceSize: 1, slug: 'b', ...RAILS });
    expect(stl.ok).toBe(true);
  });

  it('is refused as today when the sections engine refuses it', () => {
    const doc = { ...swallowBoard(), stations: [] };
    const out = meshDocument(doc, null, { ...SETTLED, engine: 'rails' });
    expect(out.ok).toBe(false);
  });
});
