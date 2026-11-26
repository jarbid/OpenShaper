// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The drawing for the Tail step: the plan, zoomed on the tail, with a round handle on each corner.
 *
 * It is the outline editor, so the outline's own points and handles stay editable as they are in the Outline step (an edit of
 * one makes the tail Custom, and the panel says so), framed on the tail (`tailFrame`, derived from the board's own length and
 * width) and with the Tail step's handles laid over it (`TailHandles`): a radius on each corner and the tail's width. The
 * shell builds the editor, which owns its many props, and is handed the frame and the overlay to give it, as the Deck step
 * is handed the curve control.
 *
 * The framing is the step's own: it is not remembered as the Outline's, and a double-click on empty canvas returns to it. It is
 * the shape's: another shape is another frame (`tailFrame`), taken up while the view is as it was fitted, and a width dragged
 * does not move it.
 */
import type { Bounds, EditorFrame } from '@openshaper/render2d';
import { useCallback, useMemo, type ReactNode } from 'react';
import type { LengthUnit } from '../format';
import { useRailsDoc } from './deck-data';
import { TailHandles } from './TailHandles';
import { tailFrame } from './tail-handles';

export interface TailStepProps {
  units: LengthUnit;
  /** The outline editor, given the box to frame and the handles to lay over it. */
  renderEditor: (tail: { frame: Bounds; overlay: (frame: EditorFrame) => ReactNode }) => ReactNode;
}

export function TailStep({ units, renderEditor }: TailStepProps) {
  const doc = useRailsDoc();
  const frame = useMemo(() => (doc ? tailFrame(doc) : null), [doc]);
  const overlay = useCallback((f: EditorFrame) => <TailHandles frame={f} units={units} />, [units]);
  if (!frame) return null;
  return <>{renderEditor({ frame, overlay })}</>;
}
