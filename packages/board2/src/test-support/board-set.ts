// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: the set of boards the review-fix tests run over (the three converted goldens, a classic
 * swallow and a classic fish made from the shortboard, and the three test boards), and a few
 * measurements of a built board that more than one test needs.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { convertClassic } from '../classic';
import { buildBoard, createEvaluator, MEASURE } from '../surface';
import type { BuiltBoard } from '../surface';
import { asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import { classicNotched, GOLDENS } from './classic-samples';

export interface NamedBoard {
  readonly name: string;
  readonly doc: BoardDoc;
  /** The classic board a converted document came from. */
  readonly classic?: BezierBoard;
}

/** Converts a classic board, throwing with the reasons if it is refused. */
export function convertOrThrow(b: BezierBoard): BoardDoc {
  const r = convertClassic(b);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  return r.value.doc;
}

/** Builds without validation, throwing with the reasons if it fails. */
export function buildOrThrow(doc: BoardDoc): BuiltBoard {
  const r = buildBoard(doc, { check: false });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

export function boardSet(): NamedBoard[] {
  const goldens = GOLDENS.map((s) => ({
    name: s.name.replace(/.*\//, '').replace('.brd', ''),
    classic: s.load(),
  }));
  const out: NamedBoard[] = goldens.map((g) => ({
    name: g.name,
    classic: g.classic,
    doc: convertOrThrow(g.classic),
  }));
  const base = goldens[0]!.classic;
  const swallow = classicNotched(base, swallowBoard());
  const fish = classicNotched(base, fishBoard());
  out.push({ name: 'classic swallow', classic: swallow, doc: convertOrThrow(swallow) });
  out.push({ name: 'classic fish', classic: fish, doc: convertOrThrow(fish) });
  out.push({ name: 'swallow', doc: swallowBoard() });
  out.push({ name: 'fish', doc: fishBoard() });
  out.push({ name: 'asymmetric', doc: asymmetricBoard() });
  return out;
}

/**
 * The angle (degrees) between the surface normals just below and just above the apex (t = 1/2)
 * along the board, every `step` cm of ξ (the first and last 2 % are skipped: the tips). Both sides
 * of an asymmetric board.
 */
export function apexCrease(
  board: BuiltBoard,
  step = 0.5,
): { max: number; at: number; list: [number, number][] } {
  const ev = createEvaluator(board);
  const below = new Float64Array(MEASURE.size);
  const above = new Float64Array(MEASURE.size);
  const span = board.xiMax - board.xiMin;
  const list: [number, number][] = [];
  let max = 0;
  let at = 0;
  const mirror = board.doc.symmetry === 'mirror';
  for (let x = board.xiMin + 0.02 * span; x <= board.xiMax - 0.02 * span; x += step) {
    for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
      ev.row(side, x, 2);
      ev.measure(0.5, below, true);
      ev.measure(0.5, above, false);
      const c = below[0]! * above[0]! + below[1]! * above[1]! + below[2]! * above[2]!;
      const deg = (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
      if (side === 0) list.push([x, deg]);
      if (deg > max) {
        max = deg;
        at = x;
      }
    }
  }
  return { max, at, list };
}
