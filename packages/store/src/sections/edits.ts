// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure edits of a section document (docs/design/m2-editor.md §2). Each takes a `BoardDoc` and returns
 * one; every part an edit does not touch (a `Chain`, a `Section`, a `Station`) is passed through **by
 * reference**, so `buildBoard`'s fit cache stays warm: an outline, rocker or deck edit refits nothing.
 *
 * The line editors do not change a chain by hand. The store projects the document to the classic board
 * (`project.ts`), applies the classic spline edit and junction rules (`board-actions.ts`), and
 * {@link applyBoardEdit} writes back whichever curves the edit changed.
 */
import type {
  BoardDoc,
  BottomFeature,
  Chain,
  JsonValue,
  KeyedCurve,
  Section,
  Station,
} from '@openshaper/board2';
import type { BezierBoard } from '@openshaper/kernel';
import type { SplineTarget } from '../edits';
import { splineToChain, splineToDeckChain } from './project';

/**
 * `doc` with the chain `target` names replaced. The outline, rocker and deck, and a station's section
 * (`index` is the classic slice index, so station `index - 1`; `side: 'minus'` on an asymmetric board
 * edits the minus half). A target the document has no such chain for returns the document itself.
 */
export function withChain(doc: BoardDoc, target: SplineTarget, chain: Chain): BoardDoc {
  switch (target.kind) {
    case 'outline':
      if (target.side === 'minus') {
        if (doc.outline.minus === undefined) return doc;
        return { ...doc, outline: { ...doc.outline, minus: chain } };
      }
      return { ...doc, outline: { ...doc.outline, plus: chain } };
    case 'bottom':
      return { ...doc, rocker: chain };
    case 'deck':
      return { ...doc, deck: chain };
    case 'crossSection': {
      const i = target.index - 1;
      const st = doc.stations[i];
      if (st === undefined) return doc;
      const key = target.side === 'minus' ? 'minus' : 'plus';
      if (key === 'minus' && st.minus === undefined) return doc;
      const section: Section = { chain, apex: st[key]!.apex };
      const stations = doc.stations.map(
        (s, j): Station => (j === i ? { ...s, [key]: section } : s),
      );
      return { ...doc, stations };
    }
  }
}

const scaleKeys = (c: KeyedCurve, f: number): KeyedCurve => ({
  keys: c.keys.map((k) => ({ ...k, s: k.s * f })),
});

/**
 * The document with the board stretched along its length by `f`: every station, and the keys of every
 * bottom feature, move with it (the end stations stay at the ends). Sections are untouched.
 */
export function scaleLength(doc: BoardDoc, f: number): BoardDoc {
  if (f === 1) return doc;
  const features = doc.features.map(
    (ft): BottomFeature => ({ ...ft, depth: scaleKeys(ft.depth, f) }),
  );
  return {
    ...doc,
    stations: doc.stations.map((s) => ({ ...s, x: s.x * f })),
    features,
  };
}

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];

/**
 * The document after the classic board `before` (the projection of `doc`) was edited into `after`.
 *
 * - A curve whose spline object is the one `before` had is untouched and keeps its `Chain`.
 * - A changed outline, rocker or deck is written back. The edit's junction pass can change more than
 *   the curve that was dragged (a deck tip joined to the rocker's), so all three are compared.
 * - Fins are written back when they changed.
 * - When the nose moved (the board's length changed), the stations and feature keys scale with it.
 *
 * Returns `doc` itself when nothing changed.
 */
export function applyBoardEdit(doc: BoardDoc, before: BezierBoard, after: BezierBoard): BoardDoc {
  let next = doc;
  if (after.outline !== before.outline) {
    next = { ...next, outline: { ...next.outline, plus: splineToChain(after.outline) } };
  }
  if (after.bottom !== before.bottom) next = { ...next, rocker: splineToChain(after.bottom) };
  if (after.deck !== before.deck) next = { ...next, deck: splineToDeckChain(after.deck) };
  if (after.fins !== before.fins) next = { ...next, fins: after.fins as unknown as JsonValue };
  if (next === doc) return doc;
  const was = lengthOf(doc.outline.plus);
  const now = lengthOf(next.outline.plus);
  if (was > 0 && now > 0 && now !== was) next = scaleLength(next, now / was);
  return next;
}
