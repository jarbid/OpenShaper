// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The worker's compute on the section model: a classic board in, a typed-array surface
 * out, with curvature, deviation, ladder reuse, identity-preserving conversion, the
 * refusals and the test boards.
 */
import { parseBrd, parseS3dx } from '@openshaper/io';
import { moveKnotEnd } from '@openshaper/store';
import { beforeEach, describe, expect, it } from 'vitest';
import sampleBrd from '../sample-board.brd?raw';
import vBottomS3dx from '../../../../packages/io/src/__fixtures__/synthetic-rocker-absolute-deck.s3dx?raw';
import pointedS3dx from '../../../../packages/io/src/__fixtures__/synthetic-clean-6x22x2-75.s3dx?raw';
import type { BoardDoc } from '@openshaper/board2';
import {
  canonical,
  canonicalDoc,
  convertAndMesh,
  convertToDoc,
  meshDocument,
  meshTestBoard,
  resetCore,
} from './nurbs-core';
import { meshTransferables, TEST_BOARDS, type JobOptions } from './nurbs-protocol';

const classic = parseBrd(sampleBrd).board;
const NONE: JobOptions = { curvature: false, deviation: false, reuseLadders: false };

beforeEach(() => resetCore());

describe('convertAndMesh', () => {
  it('converts, builds and meshes a classic board into closed typed arrays', () => {
    const stages: string[] = [];
    const out = convertAndMesh(classic, NONE, (s) => stages.push(s));
    if (!out.ok) throw new Error(out.error);
    expect(stages).toEqual(['converting', 'building', 'meshing']);
    const { mesh, summary, timings } = out;
    const n = mesh.positions.length / 3;
    expect(n).toBeGreaterThan(2000);
    expect(mesh.normals.length).toBe(3 * n);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.curvature).toBeNull();
    expect(mesh.deviation).toBeNull();
    expect(mesh.laddersReused).toBe(false);
    expect(summary.source).toBe('classic');
    expect(summary.conversion?.stations).toBeGreaterThan(3);
    // A surfboard: tens of litres (cm³), a plan area of thousands of cm².
    expect(summary.volume).toBeGreaterThan(15_000);
    expect(summary.volume).toBeLessThan(60_000);
    expect(summary.planArea).toBeGreaterThan(5_000);
    expect(timings.convertMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThan(0);
  });

  it('adds the view’s curvature quantities with their display scales on request', () => {
    const out = convertAndMesh(classic, { ...NONE, curvature: true });
    if (!out.ok) throw new Error(out.error);
    const c = out.mesh.curvature!;
    const n = out.mesh.positions.length / 3;
    expect(c.mean.length).toBe(n);
    expect(c.gaussian.length).toBe(n);
    expect(c.minRadius.length).toBe(n);
    expect(c.scale.mean).toBeGreaterThan(0);
    expect(c.scale.radius[0]).toBeLessThan(c.scale.radius[1]);
    // The deck is convex across the board (mean curvature positive) at the middle.
    let positive = 0;
    for (let i = 0; i < n; i++) if (c.mean[i]! > 0) positive++;
    expect(positive).toBeGreaterThan(n / 2);
  });

  it('measures the deviation from the classic board when asked, with no data at the tips', () => {
    const out = convertAndMesh(classic, { ...NONE, deviation: true });
    if (!out.ok) throw new Error(out.error);
    const d = out.mesh.deviation!;
    expect(d.length).toBe(out.mesh.positions.length / 3);
    expect(out.mesh.deviationNoData).toBeGreaterThan(0);
    const [lo, hi] = out.mesh.deviationRange!;
    // Between the stations the two models differ by up to ~5 mm on goldens (divergences.md).
    expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThan(0.7);
    expect(d.some((v) => Number.isNaN(v))).toBe(true);
  });

  it('reuses the ladders while an edit is in progress, and derives them afresh when it settles', () => {
    const first = convertAndMesh(classic, NONE);
    if (!first.ok) throw new Error(first.error);
    expect(first.mesh.laddersReused).toBe(false);
    const dragging = convertAndMesh(classic, { ...NONE, reuseLadders: true });
    if (!dragging.ok) throw new Error(dragging.error);
    expect(dragging.mesh.laddersReused).toBe(true);
    // Same ladders, same board: the same mesh.
    expect(dragging.mesh.positions).toEqual(first.mesh.positions);
    const settled = convertAndMesh(classic, NONE);
    if (!settled.ok) throw new Error(settled.error);
    expect(settled.mesh.laddersReused).toBe(false);
  });

  it('does not reuse ladders that belong to another board length', () => {
    const swallow = meshTestBoard('analytic', NONE);
    expect(swallow.ok).toBe(true);
    const out = convertAndMesh(classic, { ...NONE, reuseLadders: true });
    if (!out.ok) throw new Error(out.error);
    expect(out.mesh.laddersReused).toBe(false);
  });

  it('follows an edit of the outline immediately', () => {
    const a = convertAndMesh(classic, NONE);
    const k = classic.outline.knots[3]!.end;
    const edited = {
      ...classic,
      outline: moveKnotEnd(classic.outline, 3, { x: k.x, y: k.y * 0.95 }),
    };
    const b = convertAndMesh(edited, { ...NONE, reuseLadders: true });
    if (!a.ok || !b.ok) throw new Error('did not convert');
    expect(b.mesh.positions.length).toBe(a.mesh.positions.length);
    expect(b.mesh.positions).not.toEqual(a.mesh.positions);
  });
});

describe('canonical', () => {
  it('hands back the earlier slice objects for unchanged slices (a structured clone would not)', () => {
    const first = canonical(classic);
    const clone = structuredClone(classic);
    expect(clone.crossSections[2]!.spline).not.toBe(classic.crossSections[2]!.spline);
    const again = canonical(clone);
    for (let i = 0; i < classic.crossSections.length; i++) {
      expect(again.crossSections[i]!.spline).toBe(first.crossSections[i]!.spline);
    }
    // Everything else is the clone's.
    expect(again.outline).toBe(clone.outline);
  });

  it('keeps a changed slice as it is', () => {
    const first = canonical(classic);
    const clone = structuredClone(classic);
    const cs = clone.crossSections[2]!;
    const e = cs.spline.knots[1]!.end;
    const changed = {
      ...clone,
      crossSections: clone.crossSections.map((c) =>
        c === cs ? { ...c, spline: moveKnotEnd(c.spline, 1, { x: e.x * 0.9, y: e.y }) } : c,
      ),
    };
    const out = canonical(changed);
    expect(out.crossSections[2]!.spline).toBe(changed.crossSections[2]!.spline);
    expect(out.crossSections[3]!.spline).toBe(first.crossSections[3]!.spline);
  });
});

describe('refusals', () => {
  it('converts a board with a V bottom and one with no thickness at its ends (step 4)', () => {
    for (const text of [vBottomS3dx, pointedS3dx]) {
      const out = convertAndMesh(parseS3dx(text).board, NONE);
      if (!out.ok) throw new Error(out.error);
      expect(out.mesh.positions.length / 3).toBeGreaterThan(1000);
      expect(out.summary.volume).toBeGreaterThan(0);
    }
  });

  it('refuses a deck below the rocker with a readable reason and no mesh', () => {
    const dipped = pointedS3dx.split('<z>6.985</z>').join('<z>-3</z>');
    const out = convertAndMesh(parseS3dx(dipped).board, NONE);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no thickness/);
    expect(out.issues.some((i) => i.severity === 'error' && i.code === 'convert-slice')).toBe(true);
  });

  it('never throws on a malformed board', () => {
    const out = convertAndMesh({} as typeof classic, NONE);
    expect(out.ok).toBe(false);
  });
});

describe('convertToDoc', () => {
  it('converts a classic board to a section document and says what it did', () => {
    const out = convertToDoc(classic);
    if (!out.ok) throw new Error(out.error);
    expect(out.doc.format).toBe('openshaper');
    expect(out.doc.stations.length).toBe(out.conversion.stations);
    expect(out.conversion.tail).toBe('standard');
  });

  it('refuses a board it cannot hold, with the reasons, and never throws', () => {
    const dipped = pointedS3dx.split('<z>6.985</z>').join('<z>-3</z>');
    const out = convertToDoc(parseS3dx(dipped).board);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(convertToDoc({} as typeof classic).ok).toBe(false);
  });
});

/** Move a chain point up by `dz` (the revived document is frozen; these are clones). */
const bump = (q: readonly number[], dz: number): void => {
  (q as number[])[1]! += dz;
};

describe('meshDocument (the section store’s document: no converter in the loop)', () => {
  const docOf = (): BoardDoc => {
    const c = convertToDoc(classic);
    if (!c.ok) throw new Error(c.error);
    return c.doc;
  };

  it('meshes exactly what the classic job meshes for the same board', () => {
    const a = convertAndMesh(classic, NONE);
    const b = meshDocument(docOf(), null, NONE);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(b.summary.source).toBe('doc');
    expect(b.summary.conversion).toBeNull();
    expect(b.timings.convertMs).toBe(0);
    expect(Array.from(b.mesh.positions)).toEqual(Array.from(a.mesh.positions));
    expect(b.summary.volume).toBe(a.summary.volume);
  });

  it('matches the sections of a structured clone to the earlier ones by content (fits stay warm)', () => {
    const doc = docOf();
    const first = canonicalDoc(structuredClone(doc));
    // an outline edit: a new outline chain, the very same sections, all of them cloned afresh
    const edited = structuredClone({
      ...doc,
      outline: { plus: { knots: [...doc.outline.plus.knots] } },
    });
    const second = canonicalDoc(edited);
    expect(second.stations.length).toBe(first.stations.length);
    second.stations.forEach((st, i) => expect(st.plus).toBe(first.stations[i]!.plus));
    // a changed section is not matched
    const moved = structuredClone(doc);
    const k = moved.stations[1]!.plus.chain.knots[2]!;
    bump(k.p, 0.01);
    expect(canonicalDoc(moved).stations[1]!.plus).not.toBe(first.stations[1]!.plus);
  });

  it('follows an edit of the lines at once and reuses the ladders while dragging', () => {
    const doc = docOf();
    const a = meshDocument(structuredClone(doc), null, NONE);
    const bumped = structuredClone(doc);
    const knot = bumped.deck.knots[2]!;
    for (const q of [knot.p, knot.in, knot.out]) bump(q, 1);
    const b = meshDocument(bumped, null, { ...NONE, reuseLadders: true });
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(b.mesh.laddersReused).toBe(true);
    expect(b.summary.volume).toBeGreaterThan(a.summary.volume);
  });

  it('measures the deviation from the reference board when it is given', () => {
    const out = meshDocument(docOf(), classic, { ...NONE, deviation: true });
    if (!out.ok) throw new Error(out.error);
    expect(out.mesh.deviation).not.toBeNull();
    expect(out.mesh.deviationNoData).toBeGreaterThan(0);
  });

  it('refuses a document the edits made impossible, with the validator’s reason', () => {
    const doc = structuredClone(docOf());
    // the rocker pushed above the deck
    for (const k of doc.rocker.knots) {
      for (const q of [k.p, k.in, k.out]) bump(q, 50);
    }
    const out = meshDocument(doc, null, NONE);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.some((i) => i.code === 'thickness')).toBe(true);
    expect(meshDocument({} as BoardDoc, null, NONE).ok).toBe(false);
  });
});

describe('meshTestBoard', () => {
  it.each(TEST_BOARDS)('meshes the %s test board with curvature and no deviation', (name) => {
    const out = meshTestBoard(name, { ...NONE, curvature: true, deviation: true });
    if (!out.ok) throw new Error(out.error);
    expect(out.summary.source).toBe('test');
    expect(out.summary.conversion).toBeNull();
    expect(out.mesh.positions.length / 3).toBeGreaterThan(1000);
    expect(out.mesh.curvature).not.toBeNull();
    expect(out.mesh.deviation).toBeNull();
    expect(out.summary.volume).toBeGreaterThan(0);
  });
});

describe('meshTransferables', () => {
  it('lists every buffer once, curvature and deviation included when present', () => {
    const out = convertAndMesh(classic, { curvature: true, deviation: true, reuseLadders: false });
    if (!out.ok) throw new Error(out.error);
    const list = meshTransferables(out.mesh);
    expect(list).toHaveLength(7);
    expect(new Set(list).size).toBe(7);
    const bare = convertAndMesh(classic, NONE);
    if (!bare.ok) throw new Error(bare.error);
    expect(meshTransferables(bare.mesh)).toHaveLength(3);
  });
});
