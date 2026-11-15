/**
 * Reference points in the editor: selecting and dragging them on the canvas (locked
 * by default), the keyboard (Delete, Alt+arrows, Escape), the pane-header editor, and
 * the file paths that carry them.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vec2, type RefPoint } from '@openshaper/kernel';
import { parseBrd, readBoardJson, writeBoardJson, writeBrd } from '@openshaper/io';
import { SelectedRefPointEditor } from './ControlPointInspector';
import { LENGTH_UNITS } from './format';
import { openBoardFile } from './file-io';
import { boardStore } from './store';
import {
  installLayoutStubs,
  makeBoard,
  mountEditor,
  MOUSE,
  removeLayoutStubs,
} from './test/spline-editor-harness';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';

const point: RefPoint = { id: 'r1', plane: 'outline', x: 30, y: 30 };
const other: RefPoint = { id: 'r2', plane: 'outline', x: 70, y: 30 };
const cm = LENGTH_UNITS.find((u) => u.key === 'cm')!;

describe('SplineEditor: reference points', () => {
  beforeEach(installLayoutStubs);
  afterEach(removeLayoutStubs);

  const mount = (mode: 'locked' | 'unlocked' | undefined) => {
    const rig = mountEditor({ overlays: { referencePoints: mode } });
    act(() => rig.store.getState().load(makeBoard(), [point]));
    return rig;
  };
  const drag = (rig: ReturnType<typeof mount>, dx: number) => {
    const on = rig.screenOf(vec2(point.x, point.y));
    const to = { ...MOUSE, clientX: on.clientX + dx * rig.scale(), clientY: on.clientY };
    fireEvent.pointerDown(rig.canvas, { ...MOUSE, ...on });
    fireEvent.pointerMove(rig.canvas, to);
    fireEvent.pointerUp(rig.canvas, to);
  };

  it('a click selects a locked point, and a drag does not move it', () => {
    const rig = mount('locked');
    drag(rig, 5);
    expect(rig.store.getState().selectedRef).toBe('r1');
    expect(rig.store.getState().refPoints).toEqual([point]);
    expect(rig.store.getState().past).toEqual([]);
  });

  it('an unlocked point drags by the pointer movement, as one undo step', () => {
    const rig = mount('unlocked');
    drag(rig, 5);
    const moved = rig.store.getState().refPoints[0]!;
    expect(moved.x).toBeCloseTo(35, 6);
    expect(moved.y).toBeCloseTo(30, 6);
    expect(rig.store.getState().past.map((e) => e.label)).toEqual(['Move reference point']);
  });

  it('hidden points cannot be picked', () => {
    const rig = mount(undefined);
    drag(rig, 5);
    expect(rig.store.getState().selectedRef).toBeNull();
  });

  it('a double-click on a point does not add a control point under it', () => {
    const rig = mount('locked');
    const knots = rig.store.getState().board!.outline.knots.length;
    fireEvent.doubleClick(rig.canvas, rig.screenOf(vec2(point.x, point.y)));
    expect(rig.store.getState().board!.outline.knots).toHaveLength(knots);
  });
});

describe('keyboard: reference points', () => {
  beforeEach(() => {
    act(() => boardStore.getState().load(makeBoard(), [point, other]));
    renderHook(() =>
      useKeyboardShortcuts({
        setView: () => {},
        setCsIndex: () => {},
        onSave: () => {},
        onCommandPalette: () => {},
        clearSectionFocus: () => false,
      }),
    );
  });

  it('Delete removes the selected reference point', () => {
    act(() => boardStore.getState().selectRef('r1'));
    const notPrevented = fireEvent.keyDown(window, { key: 'Delete' });
    expect(notPrevented).toBe(false);
    expect(boardStore.getState().refPoints).toEqual([other]);
  });

  it('Alt+arrows step between reference points of the same pane, wrapping', () => {
    act(() => boardStore.getState().selectRef('r1'));
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(boardStore.getState().selectedRef).toBe('r2');
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(boardStore.getState().selectedRef).toBe('r1');
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    expect(boardStore.getState().selectedRef).toBe('r2');
  });

  it('Alt+arrows step along the curve from a selected control point', () => {
    act(() => boardStore.getState().select({ target: { kind: 'outline' }, index: 2 }));
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(boardStore.getState().selection).toEqual({
      target: { kind: 'outline' },
      index: 0,
      kind: 'end',
    });
  });

  it('a plain arrow is not the point-stepping chord, and nothing selected lets it through', () => {
    act(() => boardStore.getState().selectRef('r1'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(boardStore.getState().selectedRef).toBe('r1');
    act(() => boardStore.getState().selectRef(null));
    expect(fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })).toBe(true);
  });

  it('Escape clears the reference point selection', () => {
    act(() => boardStore.getState().selectRef('r1'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(boardStore.getState().selectedRef).toBeNull();
  });
});

describe('SelectedRefPointEditor', () => {
  beforeEach(() => {
    act(() => boardStore.getState().load(makeBoard(), [point]));
  });

  const mountEditorFor = (targets: Parameters<typeof SelectedRefPointEditor>[0]['targets']) =>
    render(
      <SelectedRefPointEditor
        store={boardStore}
        units={cm}
        targets={targets}
        fallback={<span>fallback</span>}
      />,
    );

  it('shows the fallback until a point in this pane is selected', () => {
    mountEditorFor([{ kind: 'outline' }]);
    expect(screen.getByText('fallback')).toBeTruthy();
    act(() => boardStore.getState().selectRef('r1'));
    expect(screen.queryByText('fallback')).toBeNull();
    expect(screen.getByLabelText('Reference point editor')).toBeTruthy();
  });

  it("stays on the fallback in another pane's header", () => {
    act(() => boardStore.getState().selectRef('r1'));
    mountEditorFor([{ kind: 'deck' }, { kind: 'bottom' }]);
    expect(screen.getByText('fallback')).toBeTruthy();
  });

  it('commits typed coordinates and a label as undoable edits', () => {
    act(() => boardStore.getState().selectRef('r1'));
    mountEditorFor([{ kind: 'outline' }]);
    const y = screen.getByLabelText('Reference point Y') as HTMLInputElement;
    fireEvent.change(y, { target: { value: '25' } });
    fireEvent.keyDown(y, { key: 'Enter' });
    const label = screen.getByLabelText('Reference point label');
    fireEvent.change(label, { target: { value: 'wide point' } });
    fireEvent.keyDown(label, { key: 'Enter' });
    expect(boardStore.getState().refPoints[0]).toEqual({ ...point, y: 25, label: 'wide point' });
    expect(boardStore.getState().past.map((e) => e.label)).toEqual([
      'Edit reference point',
      'Rename reference point',
    ]);
  });
});

describe('file paths carry reference points', () => {
  const file = (text: string, name: string) => new File([text], name);

  it('opening a .board file returns its points', async () => {
    const text = writeBoardJson(makeBoard(), undefined, [point]);
    const opened = await openBoardFile(file(text, 'x.board'));
    expect(opened.refPoints).toEqual([point]);
  });

  it('opening a .brd returns its guide points', async () => {
    const text = writeBrd(makeBoard(), undefined, [point]);
    const opened = await openBoardFile(file(text, 'x.brd'));
    expect(opened.refPoints).toEqual(parseBrd(text).referencePoints);
    expect(opened.refPoints?.[0]).toMatchObject({ plane: 'outline', x: 30, y: 30 });
  });

  it('a damaged point in a .board file reaches the import warnings', async () => {
    const doc = JSON.parse(writeBoardJson(makeBoard(), undefined, [point]));
    doc.referencePoints.push({ plane: 'nowhere' });
    const opened = await openBoardFile(file(JSON.stringify(doc), 'x.board'));
    expect(opened.warnings).toEqual(readBoardJson(JSON.stringify(doc)).warnings);
    expect(opened.warnings[0]?.severity).toBe('dropped');
  });
});
