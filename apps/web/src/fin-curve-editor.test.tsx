// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * FinCurveEditor under jsdom: real pointer events through the component, checked
 * against the view it reports. The pure picking and drag maths are tested in
 * render2d's fin-curve-view.test.ts; this is the wiring.
 */
import { knot, splineFromKnots, vec2, type Spline, type Vec2 } from '@openshaper/kernel';
import {
  FinCurveEditor,
  toView,
  worldToScreen,
  type FinCurveLayer,
  type FinCurvePick,
  type Viewport,
} from '@openshaper/render2d';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOUSE,
  TOUCH,
  installLayoutStubs,
  pane,
  removeLayoutStubs,
  resizeTo,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

/** An arch from (0, 0) to (10, 0), peaking at 3: a stand-in for a fin outline. */
const arch = (lift = 0): Spline =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(2, 4 + lift), false),
    knot(vec2(10, 0), vec2(8, 4 + lift), vec2(10, 0), false),
  ]);

const mount = (opts: { yScale?: number; editable?: boolean } = {}) => {
  const yScale = opts.yScale ?? 1;
  let vp: Viewport | null = null;
  const calls = {
    onSelect: vi.fn<(p: FinCurvePick | null) => void>(),
    onDragStart: vi.fn<(p: FinCurvePick) => void>(),
    onDrag: vi.fn<(p: FinCurvePick, to: Vec2) => void>(),
    onDragEnd: vi.fn<() => void>(),
    onAddPoint: vi.fn<(layer: string, at: Vec2) => void>(),
  };
  const layers = (lift = 0): FinCurveLayer[] => [
    { id: 'outline', spline: arch(lift), editable: opts.editable ?? true },
  ];
  const element = (lift = 0, frameKey: string = 'a') => (
    <FinCurveEditor
      label="Fin outline"
      layers={layers(lift)}
      selection={null}
      yScale={yScale}
      frameKey={frameKey}
      onViewport={(v) => {
        vp = v;
      }}
      {...calls}
    />
  );
  const r = render(element());
  const canvas = r.getByRole('img', { name: 'Fin outline' });
  const screenOf = (p: Vec2) => {
    const s = worldToScreen(vp!, toView(p, yScale));
    return { clientX: s.x, clientY: s.y + pane.top };
  };
  return {
    canvas,
    calls,
    screenOf,
    view: () => vp!,
    rerender: (lift: number, frameKey?: string) => r.rerender(element(lift, frameKey)),
  };
};

describe('FinCurveEditor', () => {
  it('reports a right-button drag’s distance in data space, without panning or selecting', () => {
    const onRightDragStart = vi.fn();
    const onRightDrag = vi.fn<(by: Vec2) => void>();
    const onSelect = vi.fn();
    let vp: Viewport | null = null;
    const { getByRole } = render(
      <FinCurveEditor
        label="Fin outline"
        layers={[{ id: 'outline', spline: arch(), editable: true }]}
        selection={null}
        yScale={2}
        onViewport={(v) => (vp = v)}
        onSelect={onSelect}
        onRightDragStart={onRightDragStart}
        onRightDrag={onRightDrag}
      />,
    );
    const canvas = getByRole('img', { name: 'Fin outline' });
    const scale = vp!.scale;
    const from = { clientX: 200, clientY: pane.top + 120 };
    fireEvent.pointerDown(canvas, { ...MOUSE, ...from, button: 2 });
    fireEvent.pointerMove(canvas, {
      ...MOUSE,
      clientX: from.clientX + scale,
      clientY: from.clientY - scale,
    });
    fireEvent.pointerUp(canvas, { ...MOUSE, button: 2 });
    expect(onRightDragStart).toHaveBeenCalledOnce();
    const by = onRightDrag.mock.lastCall![0];
    expect(by.x).toBeCloseTo(1, 6);
    expect(by.y).toBeCloseTo(0.5, 6); // through the view's stretch
    expect(onSelect).not.toHaveBeenCalled();
    expect(vp!.scale).toBe(scale);
    // No menu in the way, and a control-click does the same on a Mac.
    expect(fireEvent.contextMenu(canvas)).toBe(false);
    fireEvent.pointerDown(canvas, { ...MOUSE, ...from, ctrlKey: true });
    expect(onRightDragStart).toHaveBeenCalledTimes(2);
  });

  it('grabs a point off-centre by touch and drags it by the pointer’s travel', () => {
    const { canvas, calls, screenOf, view } = mount();
    const on = screenOf(vec2(10, 0));
    const grab = { clientX: on.clientX - 15, clientY: on.clientY + 10 }; // inside 22 px
    fireEvent.pointerDown(canvas, { ...TOUCH, ...grab });
    const pick = { layer: 'outline', index: 1, kind: 'end' };
    expect(calls.onSelect).toHaveBeenLastCalledWith(pick, false);
    expect(calls.onDragStart).toHaveBeenCalledWith(pick);

    const s = view().scale;
    fireEvent.pointerMove(canvas, {
      ...TOUCH,
      clientX: grab.clientX + 2 * s,
      clientY: grab.clientY - s,
    });
    const [, to] = calls.onDrag.mock.calls.at(-1)!;
    expect(to.x).toBeCloseTo(12, 9); // knot (10, 0) + travel (2, 1), not the pointer
    expect(to.y).toBeCloseTo(1, 9);

    fireEvent.pointerUp(canvas, { ...TOUCH, ...grab });
    expect(calls.onDragEnd).toHaveBeenCalledOnce();
  });

  it('passes a shift-click on as extending the selection, and keeps it on a miss', () => {
    const { canvas, calls, screenOf } = mount();
    const on = screenOf(vec2(10, 0));
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on, shiftKey: true });
    expect(calls.onSelect).toHaveBeenLastCalledWith(
      { layer: 'outline', index: 1, kind: 'end' },
      true,
    );
    fireEvent.pointerUp(canvas, { ...MOUSE, ...on, shiftKey: true });
    const n = calls.onSelect.mock.calls.length;
    fireEvent.pointerDown(canvas, { ...MOUSE, clientX: 1, clientY: pane.top + 1, shiftKey: true });
    expect(calls.onSelect).toHaveBeenCalledTimes(n); // the miss didn't clear it
  });

  it('needs a mouse closer: the same miss pans the view instead', () => {
    const { canvas, calls, screenOf, view } = mount();
    const on = screenOf(vec2(10, 0));
    const before = view();
    fireEvent.pointerDown(canvas, { ...MOUSE, clientX: on.clientX - 15, clientY: on.clientY + 10 });
    expect(calls.onDragStart).not.toHaveBeenCalled();
    expect(calls.onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.pointerMove(canvas, { ...MOUSE, clientX: on.clientX + 25, clientY: on.clientY + 10 });
    expect(calls.onDrag).not.toHaveBeenCalled();
    expect(view().originX).toBeCloseTo(before.originX + 40, 9);
  });

  it('turns a drag in a stretched view back into data units', () => {
    const { canvas, calls, screenOf, view } = mount({ yScale: 4 });
    const on = screenOf(vec2(2, 4)); // the first knot's outgoing handle
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
    expect(calls.onDragStart).toHaveBeenCalledWith({ layer: 'outline', index: 0, kind: 'next' });
    fireEvent.pointerMove(canvas, {
      ...MOUSE,
      clientX: on.clientX,
      clientY: on.clientY - view().scale,
    });
    const [, to] = calls.onDrag.mock.calls.at(-1)!;
    expect(to.y).toBeCloseTo(4.25, 9); // one view unit up is a quarter of a data unit
  });

  it('adds a point where a curve is double-clicked', () => {
    const { canvas, calls, screenOf } = mount();
    const near = screenOf(vec2(5, 3)); // the arch's peak
    fireEvent.doubleClick(canvas, { clientX: near.clientX, clientY: near.clientY + 4 });
    const [layer, at] = calls.onAddPoint.mock.calls[0]!;
    expect(layer).toBe('outline');
    expect(at.x).toBeCloseTo(5, 1);
    expect(at.y).toBeCloseTo(3, 1);
  });

  it('cannot grab a curve that is not editable', () => {
    const { canvas, calls, screenOf } = mount({ editable: false });
    fireEvent.pointerDown(canvas, { ...MOUSE, ...screenOf(vec2(10, 0)) });
    expect(calls.onDragStart).not.toHaveBeenCalled();
  });

  it('refits when the pane settles to a new size, until the user frames it', () => {
    // A phone's pane often changes size after first paint: the fit must follow it.
    const { canvas, view, screenOf } = mount();
    const first = view();
    resizeTo(390, 420);
    const refit = view();
    expect(refit).not.toBe(first);
    expect(refit.scale).toBeLessThan(first.scale); // narrower pane, smaller scale
    // Once panned, a resize keeps the user's framing.
    const on = screenOf(vec2(5, -5)); // empty space below the arch
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
    fireEvent.pointerMove(canvas, { ...MOUSE, clientX: on.clientX + 30, clientY: on.clientY });
    fireEvent.pointerUp(canvas, { ...MOUSE, clientX: on.clientX + 30, clientY: on.clientY });
    const panned = view();
    resizeTo(390, 600);
    expect(view().scale).toBe(panned.scale);
  });

  it('keeps its framing while the curves change, and refits when told to', () => {
    const { view, rerender } = mount();
    const first = view();
    rerender(6); // the arch grows, as during a drag
    expect(view()).toBe(first);
    rerender(6, 'b');
    expect(view()).not.toBe(first);
  });
});

describe('FinCurveEditor: markers over points', () => {
  /** A marker sitting exactly on the arch's first point. */
  const mountWith = (marker: { first?: boolean; square?: boolean }) => {
    let vp: Viewport | null = null;
    const onDragStart = vi.fn();
    const onMarkerDragStart = vi.fn();
    const { getByRole } = render(
      <FinCurveEditor
        label="Fin outline"
        layers={[{ id: 'outline', spline: arch(), editable: true }]}
        selection={null}
        onViewport={(v) => {
          vp = v;
        }}
        onDragStart={onDragStart}
        onMarkerDragStart={onMarkerDragStart}
        markers={[{ id: 'm', at: vec2(0, 0), color: '#fff', label: 'Block', ...marker }]}
      />,
    );
    const s = worldToScreen(vp!, toView(vec2(0, 0), 1));
    // Right on the point, where both the point and the marker could take it.
    fireEvent.pointerDown(getByRole('img', { name: 'Fin outline' }), {
      ...MOUSE,
      clientX: s.x,
      clientY: s.y + pane.top,
    });
    return { onDragStart, onMarkerDragStart };
  };

  it('lets a point under an ordinary marker take the drag', () => {
    const { onDragStart, onMarkerDragStart } = mountWith({});
    expect(onDragStart).toHaveBeenCalled();
    expect(onMarkerDragStart).not.toHaveBeenCalled();
  });

  it('gives a tool’s block the drag over a point under it', () => {
    const { onDragStart, onMarkerDragStart } = mountWith({ first: true, square: true });
    expect(onMarkerDragStart).toHaveBeenCalledWith('m');
    expect(onDragStart).not.toHaveBeenCalled();
  });
});
