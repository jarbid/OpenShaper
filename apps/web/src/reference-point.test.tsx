import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { readBoardJson, writeBoardJson } from '@openshaper/io';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ReferencePointSelection } from '@openshaper/render2d';
import { longitudinalFor } from './longitudinal';
import { lengthUnitByKey } from './format';
import { ReferencePointEditor } from './ControlPointInspector';
import {
  installLayoutStubs,
  removeLayoutStubs,
  mountEditor,
  MOUSE,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

it('selects and drags a reference point without changing the curves', () => {
  const onSelection = vi.fn();
  const rig = mountEditor({ onReferencePointSelectionChange: onSelection });
  const board = rig.store.getState().board;
  const at = rig.screenOf({ x: 40, y: -15 });
  fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at, button: 2 });
  fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...at, button: 2 });
  fireEvent.click(screen.getByText('Add reference point'));
  fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at });
  const selected = onSelection.mock.lastCall![0] as ReferencePointSelection;
  expect(selected.point.x).toBeCloseTo(40);
  expect(selected.point.y).toBeCloseTo(-15);
  const next = rig.screenOf({ x: 45, y: -12 });
  fireEvent.pointerMove(rig.canvas, { ...MOUSE, ...next });
  fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...next });
  const moved = onSelection.mock.lastCall![0] as ReferencePointSelection;
  expect(moved.point.x).toBeCloseTo(45);
  expect(moved.point.y).toBeCloseTo(-12);
  expect(rig.store.getState().board!.outline).toBe(board!.outline);
  expect(rig.store.getState().board!.referencePoints?.outline?.[0]?.x).toBeCloseTo(45);
  expect(rig.store.getState().past).toHaveLength(2); // add + one grouped drag
  fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...rig.screenOf({ x: 80, y: -20 }) });
  expect(onSelection).toHaveBeenLastCalledWith(null);
});

it('edits coordinates with the shared fields and dismisses with Escape', () => {
  const onChange = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ReferencePointEditor
      selection={{ point: { x: -2, y: 3 }, onChange, onDismiss }}
      target={{ kind: 'crossSection', index: 1 }}
      units={lengthUnitByKey('cm')}
    />,
  );
  const input = screen.getByRole('spinbutton', { name: 'Y position' });
  fireEvent.change(input, { target: { value: '-4' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith({ x: -4, y: 3 });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(onDismiss).toHaveBeenCalledOnce();
});

it('restores selectable reference points after saving and opening a board in a fresh pane', () => {
  const original = mountEditor();
  act(() => original.store.getState().addReferencePoint('outline', { x: 40, y: -15 }));
  const saved = writeBoardJson(original.store.getState().board!);
  original.unmount();
  const onSelection = vi.fn();
  const reopened = mountEditor({ onReferencePointSelectionChange: onSelection });
  act(() => reopened.store.getState().load(readBoardJson(saved).board));
  const at = reopened.screenOf({ x: 40, y: -15 });
  fireEvent.pointerDown(reopened.canvas, { ...MOUSE, ...at });
  fireEvent.pointerUp(reopened.canvas, { ...MOUSE, ...at });
  const selected = onSelection.mock.lastCall![0] as ReferencePointSelection;
  expect(selected.point).toEqual({ x: 40, y: -15, name: 'ref_1' });
});

it('offers deletion only for a selected reference point and supports undo/redo', () => {
  const onSelection = vi.fn();
  const rig = mountEditor({ onReferencePointSelectionChange: onSelection });
  const point = { x: 40, y: -15, name: 'ref_1' };
  const other = { x: 60, y: -10, name: 'ref_2' };
  act(() => {
    rig.store.getState().addReferencePoint('outline', point);
    rig.store.getState().addReferencePoint('outline', other);
  });
  const at = rig.screenOf(point);
  const openMenu = () => {
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at, button: 2 });
    fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...at, button: 2 });
  };
  openMenu();
  expect(screen.queryByText('Delete reference point')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at });
  fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...at });
  openMenu();
  fireEvent.click(screen.getByText('Delete reference point'));
  expect(rig.store.getState().board!.referencePoints?.outline).toEqual([other]);
  expect(onSelection).toHaveBeenLastCalledWith(null);
  act(() => rig.store.getState().undo());
  expect(rig.store.getState().board!.referencePoints?.outline).toEqual([point, other]);
  act(() => rig.store.getState().redo());
  expect(rig.store.getState().board!.referencePoints?.outline).toEqual([other]);
});

it('opens the array prompt with the nearest rocker curve', () => {
  const onReferencePointArray = vi.fn();
  const rig = mountEditor({
    targets: [{ kind: 'deck' }, { kind: 'bottom' }],
    onReferencePointArray,
  });
  act(() =>
    rig.store.getState().load({
      ...rig.store.getState().board!,
      bottom: splineFromKnots([
        knot(vec2(0, 11), vec2(0, 11), vec2(30, 11)),
        knot(vec2(50, 5), vec2(40, 5), vec2(60, 5)),
        knot(vec2(100, 11), vec2(70, 11), vec2(100, 11)),
      ]),
    }),
  );
  const at = rig.screenOf({ x: 50, y: 5 });
  fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...at, button: 2 });
  fireEvent.pointerUp(rig.canvas, { ...MOUSE, ...at, button: 2 });
  fireEvent.click(screen.getByText('Reference Point Array…'));
  expect(onReferencePointArray).toHaveBeenCalledExactlyOnceWith(
    { kind: 'bottom' },
    { mirrorX: false, mirrorY: false },
  );
});

it('shows the selected name and commits a custom name', () => {
  const onRename = vi.fn();
  render(
    <ReferencePointEditor
      selection={{
        point: { x: 0, y: 0, name: 'ref_100' },
        onChange: vi.fn(),
        onDismiss: vi.fn(),
        onRename,
      }}
      target={{ kind: 'outline' }}
      units={lengthUnitByKey('mm')}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Reference point name' });
  expect((input as HTMLInputElement).value).toBe('ref_100');
  fireEvent.change(input, { target: { value: 'Tail mark' } });
  fireEvent.blur(input);
  expect(onRename).toHaveBeenCalledWith('Tail mark');
});

it('adapts reference point nudges and displayed precision to zoom', () => {
  const onChange = vi.fn();
  const props = {
    selection: { point: { x: 1.234, y: 2 }, onChange, onDismiss: vi.fn() },
    target: { kind: 'outline' } as const,
    units: lengthUnitByKey('mm'),
  };
  const { rerender } = render(<ReferencePointEditor {...props} pixelsPerCm={20} />);
  fireEvent.keyDown(screen.getByLabelText('X position'), { key: 'ArrowRight' });
  expect(onChange.mock.lastCall![0].x).toBeCloseTo(1.334, 8);
  rerender(<ReferencePointEditor {...props} pixelsPerCm={2000} />);
  const input = screen.getByLabelText('X position') as HTMLInputElement;
  expect(input.step).toBe('0.01');
  expect(input.value).toBe('12.34');
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(onChange.mock.lastCall![0].x).toBeCloseTo(1.235, 8);
  fireEvent.change(input, { target: { value: '12.345' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange.mock.lastCall![0].x).toBeCloseTo(1.2345, 8); // Typed values remain exact.
});

const slopedBottom = splineFromKnots([
  knot(vec2(0, 0), vec2(0, 0), vec2(100 / 3, 25)),
  knot(vec2(100, 75), vec2(200 / 3, 50), vec2(100, 75)),
]);

it.each(['outline', 'deck'] as const)(
  'shows and edits reference X over the bottom curve in %s',
  (kind) => {
    const onChange = vi.fn();
    render(
      <ReferencePointEditor
        selection={{ point: { x: 20, y: 7 }, onChange, onDismiss: vi.fn() }}
        target={{ kind }}
        units={lengthUnitByKey('cm')}
        pixelsPerCm={20}
        longitudinal={longitudinalFor(slopedBottom, 'o-curve')}
      />,
    );
    const x = screen.getByLabelText('X o/c position') as HTMLInputElement;
    // Straight sloped rocker: arc length = 1.25 * model X.
    expect(x.value).toBe('25.00');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(x, { key: 'ArrowRight' });
    expect(onChange.mock.lastCall![0].x).toBeCloseTo(20.08, 6);
    expect(onChange.mock.lastCall![0].y).toBe(7);
    const y = screen.getByLabelText(kind === 'outline' ? 'Y position' : 'Z position');
    fireEvent.keyDown(y, { key: 'ArrowUp' });
    expect(onChange.mock.lastCall![0].x).toBeCloseTo(20.08, 6);
    expect(onChange.mock.lastCall![0].y).toBeCloseTo(7.1, 8);
    fireEvent.change(x, { target: { value: '50' } });
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(onChange.mock.lastCall![0].x).toBeCloseTo(40, 6);
    expect(onChange.mock.lastCall![0].y).toBeCloseTo(7.1, 8);
  },
);

it('switches reference X display modes without moving the point and leaves cross-sections unchanged', () => {
  const onChange = vi.fn();
  const props = {
    selection: { point: { x: 20, y: 7 }, onChange, onDismiss: vi.fn() },
    units: lengthUnitByKey('cm'),
  };
  const { rerender } = render(
    <ReferencePointEditor
      {...props}
      target={{ kind: 'outline' }}
      longitudinal={longitudinalFor(slopedBottom, 'o-curve')}
    />,
  );
  expect((screen.getByLabelText('X o/c position') as HTMLInputElement).value).toBe('25.00');
  rerender(
    <ReferencePointEditor
      {...props}
      target={{ kind: 'outline' }}
      longitudinal={longitudinalFor(slopedBottom, 'x-axis')}
    />,
  );
  expect((screen.getByLabelText('X position') as HTMLInputElement).value).toBe('20.00');
  rerender(
    <ReferencePointEditor
      {...props}
      target={{ kind: 'crossSection', index: 1 }}
      longitudinal={longitudinalFor(slopedBottom, 'o-curve')}
    />,
  );
  expect((screen.getByLabelText('Y position') as HTMLInputElement).value).toBe('20.00');
  expect(screen.queryByLabelText('X o/c position')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
