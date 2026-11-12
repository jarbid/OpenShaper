// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A study board put through the rails engine and held against today's engine, for the
 * measurement tests (`native.measure.test.ts`, `grid.measure.test.ts`). Test-only.
 *
 * The reference is today's engine: `buildBoard` and `createEvaluator`. A rails board reads its
 * stations as plane sections, and today's notched engine fans a notched board's sections inside
 * its notch zone, so for sections the reference of a notched board is today's engine on its
 * notch-free twin (`notchFreeTwin`); its volume is compared with the real notched board's.
 */
import { funcEval } from '../../chain';
import { meshBoard } from '../../mesh';
import { DENSE_STATIONS } from '../../railproto/rail-params';
import { buildBoard, createEvaluator } from '../../surface';
import type { BuiltBoard, SurfaceEvaluator } from '../../surface';
import type { BoardDoc } from '../../types';
import { convertSections } from '../convert';
import type { ConvertReport } from '../convert';
import { buildRails } from '../native';
import type { BuiltRails } from '../native';
import { sliceX } from '../solid';
import type { TrimMesh } from '../solid';
import { notchFreeTwin } from './bridge';
import { gap, halfOfSlice } from './measure';

/** A station this close (cm) to either end of the board, or to a corner of its loop, is in a tip; so is a notched board's tail aft of this far beyond the crotch. */
export const TIP_REACH = 3;
/** Samples of the reference section a slice is measured against. */
export const SECTION_SAMPLES = 1201;
/** Rows across the blends of the measured meshes: twice the display mesh's, so its facets are not what is measured. */
export const MEASURE_ROWS = { deckRows: 28, tuckRows: 20 } as const;
/** The gate, cm. */
export const GATE = 0.1;

export const buildOf = (doc: BoardDoc, name: string): BuiltBoard => {
  const r = buildBoard(doc, { check: false });
  if (!r.ok)
    throw new Error(`${name}: does not build: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.value;
};

/** A board converted, built and ready to be sliced against its reference. */
export interface Prepared {
  readonly name: string;
  readonly doc: BoardDoc;
  readonly notched: boolean;
  /** x of the notch's bottom, 0 on a standard tail. */
  readonly depth: number;
  readonly report: ConvertReport;
  readonly built: BuiltRails;
  /** Today's engine for sections: the board, or its notch-free twin. */
  readonly ref: BuiltBoard;
  readonly ev: SurfaceEvaluator;
  /** Today's board as drawn, for the volume. */
  readonly real: BuiltBoard;
  readonly corners: readonly number[];
}

/** `doc` converted and built; `doc` is used as given (the caller removes the features). */
export function prepare(name: string, doc: BoardDoc): Prepared {
  const c = convertSections(doc);
  if (!c.ok) throw new Error(`${name}: ${c.issues.map((i) => i.message).join('; ')}`);
  const b = buildRails(c.value.board);
  if (!b.ok) throw new Error(`${name}: ${b.issues.map((i) => i.message).join('; ')}`);
  const real = buildOf(doc, name);
  const notched = doc.tail.kind === 'notched';
  const ref = notched ? buildOf(notchFreeTwin(doc), `${name} twin`) : real;
  const built = b.value;
  const corners: number[] = [built.xiMin, built.xiMax];
  for (let i = 0; i < built.loop.n; i++)
    if (built.loop.corner[i] !== 0) corners.push(built.loop.x[i]!);
  return {
    name,
    doc,
    notched,
    depth: notched ? doc.outline.plus.knots[0]!.p[0] : 0,
    report: c.value.report,
    built,
    ref,
    ev: createEvaluator(ref),
    real,
    corners,
  };
}

/** Whether a station at x is in a tip. */
export const inTip = (p: Prepared, x: number): boolean =>
  (p.notched && x < p.depth + TIP_REACH) || p.corners.some((c) => Math.abs(c - x) < TIP_REACH);

/** The board's own stations that are gated: usable on that side by the converter's report, and not in a tip. Both sides of an asymmetric board. */
export function gatedStations(p: Prepared): { x: number; side: 0 | 1 }[] {
  const out: { x: number; side: 0 | 1 }[] = [];
  const sides: ('plus' | 'minus')[] =
    p.doc.symmetry === 'asymmetric' ? ['plus', 'minus'] : ['plus'];
  for (const s of sides) {
    for (const row of p.report.stations) {
      if (row.side !== s || row.tip || inTip(p, row.x)) continue;
      out.push({ x: row.x, side: s === 'plus' ? 0 : 1 });
    }
  }
  return out;
}

/** `DENSE_STATIONS` even stations from the first to the last usable station of the plus side, each with whether it is in a tip. */
export function evenStations(p: Prepared): { x: number; tip: boolean }[] {
  const usable = p.report.stations.filter((r) => r.side === 'plus' && !r.tip).map((r) => r.x);
  const x0 = usable[0]!;
  const x1 = usable[usable.length - 1]!;
  return Array.from({ length: DENSE_STATIONS }, (_, k) => {
    const x = x0 + ((x1 - x0) * k) / (DENSE_STATIONS - 1);
    return { x, tip: inTip(p, x) };
  });
}

/** Where the worst gap at a station lies, and where on the section that is. */
export interface Worst {
  readonly gap: number;
  readonly y: number;
  readonly z: number;
}

/** The two-sided gap between the mesh's slice at x on `side` and today's section there. */
export function sectionGap(p: Prepared, mesh: TrimMesh, x: number, side: 0 | 1): Worst {
  const out = new Float64Array(3);
  const section = new Float64Array(2 * SECTION_SAMPLES);
  p.ev.row(side, x, 0);
  for (let i = 0; i < SECTION_SAMPLES; i++) {
    p.ev.eval(i / (SECTION_SAMPLES - 1), 0, out);
    section[2 * i] = out[1]!;
    section[2 * i + 1] = out[2]!;
  }
  const g = gap(halfOfSlice(sliceX(mesh, mesh.panels, x), side), section);
  return { gap: g.max, y: g.y, z: g.z };
}

/** The thinnest rail wall over the loop, cm. */
export function thinnestWall(mesh: TrimMesh): number {
  let min = Infinity;
  for (let i = 0; i < mesh.loop.n; i++) min = Math.min(min, mesh.wallTop[i]! - mesh.wallBottom[i]!);
  return min;
}

/** Today's volume of the board as drawn, cm³. */
export const realVolume = (p: Prepared): number => meshBoard(p.real).volume;

/** u and v of a point of a section at x: the share of the half width and of the thickness over the rocker. */
export function sectionShares(
  p: Prepared,
  x: number,
  y: number,
  z: number,
): { u: number; v: number } {
  const r = new Float64Array(3);
  const d = new Float64Array(3);
  funcEval(p.ref.rocker, x, r, 0);
  funcEval(p.ref.deck, x, d, 0);
  const out = new Float64Array(3);
  p.ev.at(y >= 0 ? 0 : 1, x, 0.5, 0, out);
  const w = Math.abs(out[1]!);
  return { u: w > 0 ? Math.abs(y) / w : 0, v: (z - r[0]!) / (d[0]! - r[0]!) };
}

export const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.floor(s.length / 2)]!;
};
