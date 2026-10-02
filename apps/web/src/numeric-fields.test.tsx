/**
 * P10: the inspector and fin length fields commit only what the user typed.
 *
 * Before the fix, focusing and leaving a field committed the rounded display value
 * (an undo step and a moved point), Escape's blur committed the text it meant to
 * discard, Enter committed twice, and text with no number in it committed 0.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createBoardStore } from '@openshaper/store';
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { ControlPointInspector, SelectedPointEditor } from './ControlPointInspector';
import { FinPanel } from './FinPanel';
import { DEFAULT_LENGTH_UNIT } from './format';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

/** Interior outline knot at x = 50.01234 cm: finer than any display precision. */
function makeBoard(): BezierBoard {
  const outline = splineFromKnots([
    knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
    knot(vec2(50.01234, 10), vec2(45, 5), vec2(55, 15), false),
    knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
  ]);
  const rail = (y: number) =>
    splineFromKnots([
      knot(vec2(0, y), vec2(-5, y), vec2(5, y)),
      knot(vec2(100, y), vec2(95, y), vec2(105, y)),
    ]);
  const prof = splineFromKnots([
    knot(vec2(0, 2), vec2(0, 2), vec2(10, 2)),
    knot(vec2(10, 5), vec2(10, 3), vec2(10, 5)),
  ]);
  return board(outline, rail(2), rail(8), [
    crossSection(0, prof),
    crossSection(50, prof),
    crossSection(100, prof),
  ]);
}

function withPoint() {
  const store = createBoardStore();
  act(() => {
    store.getState().load(makeBoard());
    store.getState().select({ target: { kind: 'outline' }, index: 1 });
  });
  return store;
}

const pointX = (store: ReturnType<typeof createBoardStore>) =>
  store.getState().board!.outline.knots[1]!.end.x;

describe('inspector point fields (P10)', () => {
  const xField = () => (screen.getAllByRole('textbox') as HTMLInputElement[])[0]!;

  it('focusing and leaving an untouched field commits nothing', () => {
    const store = withPoint();
    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);
    const x = xField();
    act(() => x.focus());
    act(() => x.blur());
    expect(store.getState().past).toHaveLength(0);
    expect(pointX(store)).toBe(50.01234);
  });

  it('Escape reverts the typed text and commits nothing', () => {
    const store = withPoint();
    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);
    const x = xField();
    const shown = x.value;
    act(() => x.focus());
    fireEvent.change(x, { target: { value: '300' } });
    fireEvent.keyDown(x, { key: 'Escape' });
    expect(store.getState().past).toHaveLength(0);
    expect(pointX(store)).toBe(50.01234);
    expect(x.value).toBe(shown);
  });

  it('text with no number reverts instead of moving the point to 0', () => {
    const store = withPoint();
    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);
    const x = xField();
    const shown = x.value;
    act(() => x.focus());
    fireEvent.change(x, { target: { value: 'abc' } });
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(store.getState().past).toHaveLength(0);
    expect(pointX(store)).toBe(50.01234);
    expect(x.value).toBe(shown);
  });

  it('Enter commits once: one undo step', () => {
    const store = withPoint();
    const move = vi.spyOn(store.getState(), 'moveControlPoint');
    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);
    const x = xField();
    act(() => x.focus());
    fireEvent.change(x, { target: { value: '600' } }); // mm
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(move).toHaveBeenCalledOnce();
    expect(store.getState().past).toHaveLength(1);
    expect(pointX(store)).toBeCloseTo(60, 9);
  });

  it('pane-header field: leaving it untouched commits nothing', () => {
    const store = withPoint();
    render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'outline' }]}
      />,
    );
    const x = screen.getByLabelText('X position') as HTMLInputElement;
    act(() => x.focus());
    act(() => x.blur());
    expect(store.getState().past).toHaveLength(0);
    expect(pointX(store)).toBe(50.01234);
  });
});

describe('fin length fields (P10)', () => {
  function withFin() {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().setFinSetup('thruster');
      store.getState().updateFin(0, { base: 11.23456 });
      store.getState().selectFin(0);
    });
    return store;
  }
  const base = (store: ReturnType<typeof createBoardStore>) =>
    store.getState().board!.fins.fins[0]!.base;

  it('leaving an untouched field commits nothing', () => {
    const store = withFin();
    const before = store.getState().past.length;
    render(<FinPanel store={store} units={DEFAULT_LENGTH_UNIT} />);
    const field = screen.getByLabelText(/^Base/) as HTMLInputElement;
    act(() => field.focus());
    act(() => field.blur());
    expect(store.getState().past).toHaveLength(before);
    expect(base(store)).toBe(11.23456);
  });

  it('text with no number reverts instead of committing', () => {
    const store = withFin();
    const before = store.getState().past.length;
    render(<FinPanel store={store} units={DEFAULT_LENGTH_UNIT} />);
    const field = screen.getByLabelText(/^Base/) as HTMLInputElement;
    const shown = field.value;
    act(() => field.focus());
    fireEvent.change(field, { target: { value: 'abc' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(store.getState().past).toHaveLength(before);
    expect(base(store)).toBe(11.23456);
    expect(field.value).toBe(shown);
  });
});
