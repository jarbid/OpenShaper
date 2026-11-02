// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An asymmetric board's two halves in one pane (docs/design/m2-editor.md §3): the minus outline is drawn
 * reflected below the stringer and a drag of its point edits the minus half only, in the minus spline's
 * own coordinates.
 */
import { asymmetricBoard } from '@openshaper/board2/testing';
import {
  SplineEditor,
  viewportFromCenter,
  worldToScreen,
  type ViewCenter,
} from '@openshaper/render2d';
import { createSectionStore } from '@openshaper/store/sections';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLayoutStubs, MOUSE, pane, removeLayoutStubs } from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

describe('SplineEditor: both halves of an asymmetric outline', () => {
  it('drags a minus point where it is drawn (below the stringer) and edits only the minus half', () => {
    const store = createSectionStore();
    const doc = asymmetricBoard();
    act(() => store.getState().loadDoc(doc));
    let view: ViewCenter | null = null;
    const { container } = render(
      <SplineEditor
        store={store}
        targets={[{ kind: 'outline' }, { kind: 'outline', side: 'minus' }]}
        colors={['#fff', '#aaa']}
        mirrorY
        splitSides
        onViewChange={(v) => {
          view = v;
        }}
      />,
    );
    const canvas = container.querySelector('canvas')!;
    const screenOf = (x: number, y: number) => {
      const p = worldToScreen(viewportFromCenter(view!, pane.w, pane.h), { x, y });
      return { clientX: p.x, clientY: p.y };
    };
    const mid = doc.outline.minus!.knots[2]!.p;
    // the minus half is drawn at -y
    const on = screenOf(mid[0], -mid[1]);
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
    expect(store.getState().selection).toEqual({
      target: { kind: 'outline', side: 'minus' },
      index: 2,
      kind: 'end',
    });
    // 2 cm further from the stringer on screen is 2 cm more half-width
    const scale = view!.scale;
    fireEvent.pointerMove(canvas, {
      ...MOUSE,
      clientX: on.clientX,
      clientY: on.clientY + 2 * scale,
    });
    fireEvent.pointerUp(canvas, { ...MOUSE, clientX: on.clientX, clientY: on.clientY + 2 * scale });
    const next = store.getState().doc!;
    expect(next.outline.plus).toBe(doc.outline.plus);
    expect(next.outline.minus!.knots[2]!.p[0]).toBeCloseTo(mid[0], 6);
    expect(next.outline.minus!.knots[2]!.p[1]).toBeCloseTo(mid[1] + 2, 6);
    // the plus point sits above the stringer and is a different point
    const plusOn = screenOf(doc.outline.plus.knots[2]!.p[0], doc.outline.plus.knots[2]!.p[1]);
    fireEvent.pointerDown(canvas, { ...MOUSE, ...plusOn });
    expect(store.getState().selection?.target).toEqual({ kind: 'outline' });
  });
});
