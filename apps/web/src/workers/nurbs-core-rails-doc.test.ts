// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rails board as the worker's document: every request that takes a document takes it, builds it
 * directly, and answers what the same request answers for the sections document it was converted from
 * with `engine: 'rails'`. `toRails` makes the board; the text readers and writers carry it.
 */
import { convertSections, type BoardDoc, type Chain, type RailsBoard } from '@openshaper/board2';
import { analyticBoard, asymmetricBoard, swallowBoard } from '@openshaper/board2/testing';
import { parseBrd } from '@openshaper/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import {
  convertToDoc,
  docFromAnyJson,
  docFromJson,
  docToText,
  exportDocument,
  measureDocument,
  meshDocument,
  probeDocument,
  railsToText,
  resetCore,
  toRails,
} from './nurbs-core';
import type { ExportJob, JobOptions } from './nurbs-protocol';

// Each comparison builds and meshes a board twice at full quality: seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const shortboard = (): BoardDoc => {
  const c = convertToDoc(parseBrd(sampleBrd).board);
  if (!c.ok) throw new Error(c.error);
  return c.doc;
};

const BOARDS: readonly [string, () => BoardDoc][] = [
  ['shortboard', shortboard],
  ['swallow', swallowBoard],
  ['asymmetric', asymmetricBoard],
  ['analytic', analyticBoard],
];

/** The rails board of a sections document, as `convertSections` makes it. */
export const railsOfDoc = (doc: BoardDoc): RailsBoard => {
  const c = convertSections(doc);
  if (!c.ok) throw new Error('not convertible');
  return c.value.board;
};

const SETTLED: JobOptions = { curvature: true, deviation: false, reuseLadders: false };
const DRAG: JobOptions = { curvature: false, deviation: false, reuseLadders: true };
const RAILS = { engine: 'rails' } as const;

const midX = (doc: BoardDoc): number => doc.stations[Math.floor(doc.stations.length / 2)]!.x;

const mesh = (doc: BoardDoc | RailsBoard, options: JobOptions, probes: readonly number[] = []) => {
  const out = meshDocument(doc, null, options, undefined, probes);
  if (!out.ok) throw new Error(out.error);
  return out;
};

beforeEach(() => resetCore());

describe('toRails', () => {
  it('from a section document is convertSections of it', () => {
    const doc = swallowBoard();
    const out = toRails({ doc });
    if (!out.ok) throw new Error(out.error);
    expect(out.board).toEqual(railsOfDoc(doc));
    expect(out.board.model).toBe('rails');
    expect(out.conversion).toBeNull();
  });

  it('from a classic board is the classic conversion to a document, then convertSections', () => {
    const classic = parseBrd(sampleBrd).board;
    const out = toRails({ classic });
    if (!out.ok) throw new Error(out.error);
    const c = convertToDoc(classic);
    if (!c.ok) throw new Error(c.error);
    expect(out.board).toEqual(railsOfDoc(c.doc));
    expect(out.conversion).toEqual(c.conversion);
    expect(out.issues.slice(0, c.issues.length)).toEqual(c.issues);
  });

  it('refuses a board the sections converter refuses, with its issues', () => {
    const doc = swallowBoard();
    const nosed = { ...doc, stations: [doc.stations[doc.stations.length - 1]!] };
    expect(convertSections(nosed).ok).toBe(false);
    const out = toRails({ doc: nosed });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('no station thick and wide enough');
    expect(out.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('refuses a classic board the classic converter refuses, with its issues', () => {
    const classic = { ...parseBrd(sampleBrd).board, crossSections: [] };
    const refused = convertToDoc(classic);
    expect(refused.ok).toBe(false);
    const out = toRails({ classic });
    expect(out).toEqual(refused);
    expect(out.ok).toBe(false);
  });
});

describe.each(BOARDS)(
  'a rails board of the %s gives what its sections document gives on the rails engine',
  (_name, make) => {
    it.each([
      ['settled (view quality, curvature)', SETTLED],
      ['drag (draft quality)', DRAG],
    ])('mesh, %s', (_label, options) => {
      const doc = make();
      const x = midX(doc);
      const board = railsOfDoc(doc);
      const fromDoc = mesh(doc, { ...options, engine: 'rails' }, [x, doc.stations[0]!.x + 1]);
      resetCore();
      const direct = mesh(board, options, [x, doc.stations[0]!.x + 1]);
      // the engine option does not matter to a rails board
      resetCore();
      const asked = mesh(board, { ...options, engine: 'sections' }, [x]);
      expect(direct.summary.engine).toBe('rails');
      expect(direct.summary.source).toBe('doc');
      expect(direct.issues.filter((i) => i.code === 'rails-fallback')).toEqual([]);
      expect(direct.mesh.positions).toEqual(fromDoc.mesh.positions);
      expect(direct.mesh.normals).toEqual(fromDoc.mesh.normals);
      expect(direct.mesh.indices).toEqual(fromDoc.mesh.indices);
      expect(direct.mesh.curvature).toEqual(fromDoc.mesh.curvature);
      expect(direct.mesh.laddersReused).toBe(false);
      expect(direct.summary.volume).toBe(fromDoc.summary.volume);
      expect(direct.summary.planArea).toBe(fromDoc.summary.planArea);
      expect(direct.summary.surfaceArea).toBe(fromDoc.summary.surfaceArea);
      expect(direct.probes).toEqual(fromDoc.probes);
      expect(asked.mesh.positions).toEqual(fromDoc.mesh.positions);
      expect(asked.summary.engine).toBe('rails');
      expect(direct.mesh.curvature === null).toBe(!options.curvature);
    });

    it('probe', () => {
      const doc = make();
      const board = railsOfDoc(doc);
      const xs = [midX(doc), doc.stations[0]!.x + 1];
      const expected = probeDocument(doc, xs, 'rails');
      expect(expected.ok).toBe(true);
      expect(probeDocument(board, xs)).toEqual(expected);
      expect(probeDocument(board, xs, 'sections')).toEqual(expected);
    });

    it('measure', () => {
      const doc = make();
      const board = railsOfDoc(doc);
      const expected = measureDocument(doc, 'rails');
      expect(expected.ok).toBe(true);
      expect(measureDocument(board)).toEqual(expected);
      expect(measureDocument(board, 'sections')).toEqual(expected);
    });

    it.each<[string, ExportJob]>([
      ['STL', { format: 'stl', faceSize: 2, slug: 'b' }],
      [
        'DXF',
        {
          format: 'dxf',
          curveMode: 'polyline',
          crossSectionCount: 5,
          ghost: null,
          fins: [],
          slug: 'b',
        },
      ],
      ['PDF 1:1', { format: 'pdf-1to1', options: {}, fins: [], slug: 'b' }],
    ])(
      '%s export',
      (_label, job) => {
        const doc = make();
        const expected = exportDocument(doc, { ...job, ...RAILS });
        if (!expected.ok) throw new Error(expected.error);
        const out = exportDocument(railsOfDoc(doc), job);
        if (!out.ok) throw new Error(out.error);
        expect(out.files.map((f) => ({ name: f.name, type: f.type }))).toEqual(
          expected.files.map((f) => ({ name: f.name, type: f.type })),
        );
        // A rails board records no notch zone, so a notched board's drawings differ in the plan markers and
        // labels of the stations in it (the surface and the sections drawn are the same).
        if (job.format !== 'stl' && doc.tail.kind === 'notched') return;
        for (const [i, f] of out.files.entries()) {
          expect(f.bytes).toEqual(expected.files[i]!.bytes);
        }
      },
      120_000,
    );

    it('STEP is one file holding a solid', () => {
      const out = exportDocument(railsOfDoc(make()), {
        format: 'step',
        unit: 'mm',
        slug: 'b',
      });
      if (!out.ok) throw new Error(out.error);
      expect(out.files.map((f) => [f.name, f.type])).toEqual([['b.step', 'model/step']]);
      const text = new TextDecoder().decode(out.files[0]!.bytes);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text).toContain('MANIFOLD_SOLID_BREP');
    });
  },
);

describe('a rails board the engine refuses', () => {
  const broken = (): RailsBoard => ({ ...railsOfDoc(swallowBoard()), stations: [] });

  it('is a refused mesh, probe, measure and export, never an exception', () => {
    const out = meshDocument(broken(), null, SETTLED);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(probeDocument(broken(), [10]).ok).toBe(false);
    expect(measureDocument(broken()).ok).toBe(false);
    expect(exportDocument(broken(), { format: 'stl', faceSize: 1, slug: 'b' }).ok).toBe(false);
  });
});

describe('the rails build reuse', () => {
  const moveKnot = (chain: Chain, i: number, dv: number): Chain => ({
    ...chain,
    knots: chain.knots.map((k, j) =>
      j === i
        ? {
            ...k,
            p: [k.p[0], k.p[1] + dv] as [number, number],
            in: [k.in[0], k.in[1] + dv] as [number, number],
            out: [k.out[0], k.out[1] + dv] as [number, number],
          }
        : k,
    ),
  });

  it('measures a moved outline knot and a changed station curve', () => {
    const board = railsOfDoc(swallowBoard());
    const base = mesh(board, SETTLED);
    const outline = moveKnot(board.outline.plus, 2, 0.4);
    const wider = mesh({ ...board, outline: { ...board.outline, plus: outline } }, SETTLED);
    expect(wider.summary.planArea).toBeGreaterThan(base.summary.planArea);
    const st = board.stations[2]!;
    const curve = { ...st.plus, bottom: moveKnot(st.plus.bottom, 1, 0.05) };
    const stations = board.stations.map((s, i) => (i === 2 ? { ...s, plus: curve } : s));
    const changed = mesh({ ...board, stations }, SETTLED);
    expect(changed.mesh.positions).not.toEqual(base.mesh.positions);
  });
});

describe('the text', () => {
  it('a rails board comes back from its text through the reader of either kind', () => {
    const board = railsOfDoc(swallowBoard());
    const text = railsToText(board);
    const r = docFromAnyJson(JSON.parse(text));
    if (!r.ok || r.model !== 'rails') throw new Error('not a rails board');
    expect(r.board).toEqual(board);
    expect(railsToText(r.board)).toBe(text);
  });

  it('a sections text is read as sections, as docFromJson reads it', () => {
    const doc = swallowBoard();
    const json: unknown = JSON.parse(docToText(doc));
    const r = docFromAnyJson(json);
    if (!r.ok || r.model !== 'sections') throw new Error('not a sections document');
    const same = docFromJson(json);
    if (!same.ok) throw new Error(same.error);
    expect(r.doc).toEqual(same.doc);
  });

  it('fails as docFromJson does for something that is neither', () => {
    for (const bad of [null, 7, 'text', {}, { format: 'openshaper', model: 'other' }]) {
      expect(docFromAnyJson(bad)).toEqual(docFromJson(bad));
      expect(docFromAnyJson(bad).ok).toBe(false);
    }
  });

  it('fails with the reasons for a rails text that is malformed', () => {
    const json = JSON.parse(railsToText(railsOfDoc(swallowBoard()))) as Record<string, unknown>;
    delete json.corners;
    const r = docFromAnyJson(json);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.error).toContain('corners');
    }
  });
});
