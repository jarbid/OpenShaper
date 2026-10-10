/**
 * Component tests for ControlPointInspector.
 *
 * Covers:
 *  - Tangent-prev X/Y and tangent-next X/Y fields are rendered with the knot's
 *    current tangent handle coordinates displayed in the chosen unit.
 *  - Committing a tangent X or Y field dispatches moveTangent to the store.
 *  - Horizontal-align button dispatches alignTangentsHorizontal.
 *  - Vertical-align button dispatches alignTangentsVertical.
 *  - The handle-angle lock: the toggle in the pane header and the sidebar, and a
 *    locked handle edited by its length rather than X/Y.
 *  - Keyboard nudging in the pane header: arrows, Shift ×10, hold R to turn a
 *    handle, hold T to change its length.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createBoardStore, getTargetSpline, type SplineTarget } from '@openshaper/store';
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type Knot,
} from '@openshaper/kernel';
import { ControlPointInspector, SelectedPointEditor } from './ControlPointInspector';
import { DEFAULT_LENGTH_UNIT, LENGTH_UNITS } from './format';

// Mock render3d to avoid WebGL in jsdom (same pattern as App.test.tsx)
vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

/** A minimal valid board with a 3-knot outline (interior knot at index 1). */
function makeBoard(reversedCrossSectionHandles = false): BezierBoard {
  const outline = splineFromKnots([
    knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
    knot(vec2(50, 10), vec2(45, 5), vec2(55, 15), false),
    knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
  ]);
  const bottom = splineFromKnots([
    knot(vec2(0, 2), vec2(-5, 2), vec2(5, 2)),
    knot(vec2(100, 2), vec2(95, 2), vec2(105, 2)),
  ]);
  const deck = splineFromKnots([
    knot(vec2(0, 8), vec2(-5, 8), vec2(5, 8)),
    knot(vec2(100, 8), vec2(95, 8), vec2(105, 8)),
  ]);
  const prof = splineFromKnots([
    knot(vec2(0, 2), vec2(0, 2), vec2(10, 2)),
    knot(
      vec2(10, 5),
      reversedCrossSectionHandles ? vec2(12, 3) : vec2(10, 3),
      reversedCrossSectionHandles ? vec2(8, 5) : vec2(10, 5),
    ),
  ]);
  return board(outline, bottom, deck, [
    crossSection(0, prof),
    crossSection(50, prof),
    crossSection(100, prof),
  ]);
}

describe('<ControlPointInspector />', () => {
  it('renders tangent-prev and tangent-next section headers', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    expect(screen.getByText(/Tangent.*prev/i)).toBeTruthy();
    expect(screen.getByText(/Tangent.*next/i)).toBeTruthy();
  });

  it('displays tangent handle coordinates in the chosen unit (mm)', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    // The interior knot's tangentToPrev.x is ~45 cm = 450 mm (after junction normalisation
    // the exact value may differ; we just check a value in the right ballpark is visible).
    // Find at least one non-zero tangent field value on screen.
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const values = inputs.map((i) => parseFloat(i.value));
    // There should be 6 numeric fields (end X/Y, prev X/Y, next X/Y) with numeric values.
    expect(inputs.length).toBeGreaterThanOrEqual(6);
    expect(values.some((v) => Math.abs(v) > 0)).toBe(true);
  });

  it('moveTangent is called when a tangent-prev Y field is committed', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    const moveTangent = vi.spyOn(store.getState(), 'moveTangent');

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    // The 4th input is tangent-prev X (index 2), 5th is tangent-prev Y (index 3).
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const prevYInput = inputs[3]!;
    fireEvent.change(prevYInput, { target: { value: '100' } }); // 100 mm = 10 cm
    fireEvent.keyDown(prevYInput, { key: 'Enter' });

    expect(moveTangent).toHaveBeenCalledWith(
      { kind: 'outline' },
      1,
      'prev',
      expect.objectContaining({ y: expect.any(Number) }),
    );
  });

  it('moveTangent is called when a tangent-next X field is committed', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    const moveTangent = vi.spyOn(store.getState(), 'moveTangent');

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    // Inputs: endX(0), endY(1), prevX(2), prevY(3), nextX(4), nextY(5)
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const nextXInput = inputs[4]!;
    fireEvent.change(nextXInput, { target: { value: '600' } }); // 600 mm = 60 cm
    fireEvent.keyDown(nextXInput, { key: 'Enter' });

    expect(moveTangent).toHaveBeenCalledWith(
      { kind: 'outline' },
      1,
      'next',
      expect.objectContaining({ x: expect.any(Number) }),
    );
  });

  it('horizontal-align button dispatches alignTangentsHorizontal', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    const alignH = vi.spyOn(store.getState(), 'alignTangentsHorizontal');

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    // Horizontal button renders "—"
    const hBtn = screen.getByTitle(/horizontal axis/i);
    fireEvent.click(hBtn);

    expect(alignH).toHaveBeenCalledWith({ kind: 'outline' }, 1);
  });

  it('vertical-align button dispatches alignTangentsVertical', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    const alignV = vi.spyOn(store.getState(), 'alignTangentsVertical');

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    // Vertical button renders "|"
    const vBtn = screen.getByTitle(/vertical axis/i);
    fireEvent.click(vBtn);

    expect(alignV).toHaveBeenCalledWith({ kind: 'outline' }, 1);
  });

  it('renders the empty hint when no selection', () => {
    const store = createBoardStore();
    act(() => store.getState().load(makeBoard()));
    // No selection set.

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    expect(screen.getByText(/Double-click/i)).toBeTruthy();
  });

  it('tangent fields re-sync after undo', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    // Record original tangent-prev X display value.
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const prevXInput = inputs[2]!;
    const originalValue = prevXInput.value;

    // Commit a change.
    act(() => {
      fireEvent.change(prevXInput, { target: { value: '999' } });
      fireEvent.keyDown(prevXInput, { key: 'Enter' });
    });

    // Undo.
    act(() => store.getState().undo());

    // The input should re-sync to the original value.
    expect(prevXInput.value).toBe(originalValue);
  });

  // Every other test in this block selects the outline, whose labels are X/Y either
  // way — so without these two the whole panel could revert to hardcoded X/Y with
  // the suite still green. Each row (endpoint, tangent ← prev, tangent → next)
  // contributes one field per axis, hence 3.
  it.each([
    [{ kind: 'crossSection', index: 1 } as const, 'Y', 'Z', 'X'],
    [{ kind: 'deck' } as const, 'X', 'Z', 'Y'],
  ])('labels %o coordinates as board axes', (target, across, up, absent) => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target, index: 1 });
    });

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    for (const group of ['Endpoint', 'Tangent to previous', 'Tangent to next']) {
      expect(screen.getByLabelText(`${group} ${across}`)).toBeTruthy();
      expect(screen.getByLabelText(`${group} ${up}`)).toBeTruthy();
      expect(screen.queryByLabelText(`${group} ${absent}`)).toBeNull();
    }
  });
});

describe('<ControlPointInspector /> handle-angle lock', () => {
  it('shows a locked handle read-only with an editable length, and unlocks from the sidebar', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().setLocked({ kind: 'outline' }, 1, true);
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });

    render(<ControlPointInspector store={store} units={DEFAULT_LENGTH_UNIT} />);

    expect((screen.getByLabelText('Tangent to next X') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Tangent to next Y') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Endpoint X') as HTMLInputElement).disabled).toBe(false);

    const length = screen.getByLabelText('Tangent to previous Length');
    fireEvent.change(length, { target: { value: '30' } }); // 30 mm
    fireEvent.keyDown(length, { key: 'Enter' });
    const k = store.getState().board!.outline.knots[1]!;
    // The previous handle leaves at 225°: 3 cm along that line.
    expect(k.tangentToPrev.x).toBeCloseTo(50 - 3 * Math.SQRT1_2, 9);
    expect(k.tangentToPrev.y).toBeCloseTo(10 - 3 * Math.SQRT1_2, 9);

    fireEvent.click(screen.getByRole('button', { name: 'Unlock handle angles' }));
    expect(store.getState().board!.outline.knots[1]!).not.toHaveProperty('lock');
    expect((screen.getByLabelText('Tangent to next X') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByLabelText('Tangent to previous Length')).toBeNull();
  });
});

describe('<SelectedPointEditor />', () => {
  it('toggles the point lock from a button before the axis fields', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind: 'end' });
    });

    render(<SelectedPointEditor store={store} units={DEFAULT_LENGTH_UNIT} targets={[{ kind: 'outline' }]} />); // prettier-ignore

    const unlocked = screen.getByRole('button', { name: 'Lock handle angles' });
    expect(unlocked.getAttribute('aria-pressed')).toBe('false');
    expect(unlocked.getAttribute('title')).toBe('Lock handle angles (L)');
    const xField = screen.getByLabelText('X position');
    expect(
      unlocked.compareDocumentPosition(xField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(unlocked);
    const outlinePoint = () => store.getState().board!.outline.knots[1]!;
    expect(outlinePoint().lock).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Unlock handle angles' }).getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Unlock handle angles' }));
    expect(outlinePoint()).not.toHaveProperty('lock');
    expect(store.getState().past.map((h) => h.label)).toEqual([
      'Lock handle angles',
      'Unlock handle angles',
    ]);
  });

  it('edits a locked handle by its length, along its line', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().setLocked({ kind: 'outline' }, 1, true);
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind: 'next' });
    });

    render(<SelectedPointEditor store={store} units={DEFAULT_LENGTH_UNIT} targets={[{ kind: 'outline' }]} />); // prettier-ignore

    // X and Y give way to the one number a locked handle still has.
    expect(screen.queryByLabelText('X position')).toBeNull();
    const length = screen.getByLabelText('Nose handle length') as HTMLInputElement;
    expect(length.value).toBe('70.7'); // 5√2 cm, shown in mm

    fireEvent.change(length, { target: { value: '100' } }); // 100 mm
    fireEvent.blur(length);
    const k = store.getState().board!.outline.knots[1]!;
    expect(k.tangentToNext.x).toBeCloseTo(50 + 10 * Math.SQRT1_2, 9);
    expect(k.tangentToNext.y).toBeCloseTo(10 + 10 * Math.SQRT1_2, 9);

    // Arrow keys in the field step the length, still along the 45° line.
    fireEvent.keyDown(screen.getByLabelText('Nose handle length'), { key: 'ArrowUp' });
    const longer = store.getState().board!.outline.knots[1]!;
    const len = Math.hypot(longer.tangentToNext.x - 50, longer.tangentToNext.y - 10);
    expect(len).toBeGreaterThan(10);
    expect(longer.tangentToNext.y - 10).toBeCloseTo(longer.tangentToNext.x - 50, 9);
  });

  it('disables the lock on a point with no handle to lock', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().zeroTangent({ kind: 'outline' }, 1, 'prev');
      store.getState().zeroTangent({ kind: 'outline' }, 1, 'next');
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind: 'end' });
    });

    render(<SelectedPointEditor store={store} units={DEFAULT_LENGTH_UNIT} targets={[{ kind: 'outline' }]} />); // prettier-ignore

    const lock = screen.getByRole('button', { name: 'Lock handle angles' }) as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
  });

  it.each([
    ['prev', 'Right handle'],
    ['next', 'Left handle'],
  ] as const)('labels the cross-section %s tangent by its visual side', (kind, label) => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard(true));
      store.getState().select({ target: { kind: 'crossSection', index: 1 }, index: 1, kind });
    });

    render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'crossSection', index: 1 }]}
      />,
    );

    expect(screen.getByLabelText(`${label} position editor`)).toBeTruthy();
    expect(store.getState().selection?.kind).toBe(kind);
  });

  it.each([
    ['mm', '5'],
    ['cm', '0.5'],
    ['in', '0.25'],
    ['ftin', '0.25'],
  ])('uses an appropriate native spinner increment for %s', (unitKey, expectedStep) => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1 });
    });
    const units = LENGTH_UNITS.find((unit) => unit.key === unitKey)!;

    render(<SelectedPointEditor store={store} units={units} targets={[{ kind: 'outline' }]} />);

    expect(screen.getByLabelText('X position').getAttribute('step')).toBe(expectedStep);
    expect(screen.getByLabelText('Y position').getAttribute('step')).toBe(expectedStep);
  });

  it('labels cross-section coordinates as transverse Y and vertical Z', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store
        .getState()
        .select({ target: { kind: 'crossSection', index: 1 }, index: 1, kind: 'end' });
    });

    render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'crossSection', index: 1 }]}
      />,
    );

    expect(screen.getByLabelText('Y position')).toBeTruthy();
    expect(screen.getByLabelText('Z position')).toBeTruthy();
    expect(screen.queryByLabelText('X position')).toBeNull();
  });

  it.each(['deck', 'bottom'] as const)(
    'labels %s coordinates as longitudinal X and vertical Z',
    (kind) => {
      const store = createBoardStore();
      act(() => {
        store.getState().load(makeBoard());
        store.getState().select({ target: { kind }, index: 1, kind: 'end' });
      });

      render(
        <SelectedPointEditor store={store} units={DEFAULT_LENGTH_UNIT} targets={[{ kind }]} />,
      );

      expect(screen.getByLabelText('X position')).toBeTruthy();
      expect(screen.getByLabelText('Z position')).toBeTruthy();
      expect(screen.queryByLabelText('Y position')).toBeNull();
    },
  );

  it.each([
    ['end', 'control point'],
    ['next', 'handle point'],
  ] as const)('nudges the selected %s with the axis arrow keys', (kind, _description) => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind });
    });

    const selectedPosition = () => {
      const state = store.getState();
      const selection = state.selection!;
      const knot = getTargetSpline(state.board!, selection.target).knots[selection.index]!;
      return selection.kind === 'next' ? knot.tangentToNext : knot.end;
    };
    const before = selectedPosition();

    render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'outline' }]}
      />,
    );

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByLabelText('Y position'), { key: 'ArrowUp' });

    expect(selectedPosition()).toEqual({ x: before.x + 0.5, y: before.y + 0.5 });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByLabelText('X position'), { key: 'ArrowDown' });

    expect(selectedPosition()).toEqual(before);
  });

  it('shows only the selected handle coordinates in its owning pane header', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind: 'next' });
    });

    render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'outline' }]}
      />,
    );

    // An outline handle is named for the end of the board it points at, not for
    // where it happens to be drawn — the pane turns the board nose-up on a phone,
    // and "right" would then be pointing at something above.
    expect(screen.getByLabelText(/Nose handle position editor/i)).toBeTruthy();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
  });

  it('commits native-number edits to the selected tangent', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind: 'prev' });
    });
    const moveTangent = vi.spyOn(store.getState(), 'moveTangent');
    render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'outline' }]}
      />,
    );

    const x = screen.getByLabelText('X position');
    fireEvent.change(x, { target: { value: '420' } });
    fireEvent.pointerUp(x);
    fireEvent.blur(x);

    expect(moveTangent).toHaveBeenCalledOnce();
    expect(moveTangent).toHaveBeenCalledWith(
      { kind: 'outline' },
      1,
      'prev',
      expect.objectContaining({ x: 42 }),
    );
  });

  it('does not render in a pane that does not own the selection', () => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target: { kind: 'outline' }, index: 1, kind: 'end' });
    });
    const { container } = render(
      <SelectedPointEditor
        store={store}
        units={DEFAULT_LENGTH_UNIT}
        targets={[{ kind: 'deck' }]}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('<SelectedPointEditor /> keyboard modes: Shift, hold R, hold T', () => {
  const OUTLINE = { kind: 'outline' } as const;
  const DEG = Math.PI / 180;
  /** The pane-header editor of the outline pane, with `kind` of outline point 1 selected. */
  const setup = (kind: 'end' | 'prev' | 'next', target: SplineTarget = OUTLINE, index = 1) => {
    const store = createBoardStore();
    act(() => {
      store.getState().load(makeBoard());
      store.getState().select({ target, index, kind });
    });
    render(<SelectedPointEditor store={store} units={DEFAULT_LENGTH_UNIT} targets={[target]} />);
    const knot = () => getTargetSpline(store.getState().board!, target).knots[index]!;
    return { store, knot };
  };
  const press = (key: string, init: { shiftKey?: boolean } = {}) =>
    fireEvent.keyDown(window, { key, ...init });
  const angle = (k: Knot, which: 'prev' | 'next') => {
    const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
    return Math.atan2(h.y - k.end.y, h.x - k.end.x);
  };
  const length = (k: Knot, which: 'prev' | 'next') => {
    const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
    return Math.hypot(h.x - k.end.x, h.y - k.end.y);
  };
  const labels = (store: ReturnType<typeof createBoardStore>) =>
    store.getState().past.map((h) => h.label);

  it('Shift moves ten steps, from the pane and from a header field', () => {
    const { knot } = setup('end');
    const before = knot().end;
    press('ArrowRight', { shiftKey: true });
    expect(knot().end).toEqual({ x: before.x + 5, y: before.y });
    fireEvent.keyDown(screen.getByLabelText('Y position'), { key: 'ArrowDown', shiftKey: true });
    expect(knot().end).toEqual({ x: before.x + 5, y: before.y - 5 });
  });

  it('hold R turns the selected handle 1° a press (Shift 10°), keeping its length', () => {
    const { store, knot } = setup('next');
    const a0 = angle(knot(), 'next');
    const l0 = length(knot(), 'next');
    const prev0 = knot().tangentToPrev;

    press('r');
    press('ArrowLeft'); // counter-clockwise
    expect(angle(knot(), 'next')).toBeCloseTo(a0 + DEG, 12);
    press('ArrowUp'); // counter-clockwise
    expect(angle(knot(), 'next')).toBeCloseTo(a0 + 2 * DEG, 12);
    press('ArrowDown', { shiftKey: true }); // ten clockwise
    expect(angle(knot(), 'next')).toBeCloseTo(a0 - 8 * DEG, 12);
    press('ArrowRight'); // clockwise
    expect(angle(knot(), 'next')).toBeCloseTo(a0 - 9 * DEG, 12);
    expect(length(knot(), 'next')).toBeCloseTo(l0, 12);
    expect(knot().tangentToPrev).toEqual(prev0); // a corner's other handle stays
    expect(labels(store)).toEqual(Array(4).fill('Rotate handle'));

    // Released: the arrows move again.
    fireEvent.keyUp(window, { key: 'r' });
    const h = knot().tangentToNext;
    press('ArrowRight');
    expect(knot().tangentToNext).toEqual({ x: h.x + 0.5, y: h.y });
  });

  it('R or T pressed and released on its own changes nothing', () => {
    const { store, knot } = setup('next');
    const before = store.getState().board;
    for (const key of ['r', 't', 'R', 'T']) {
      expect(press(key)).toBe(true); // not cancelled: the key keeps its default
      fireEvent.keyUp(window, { key });
    }
    expect(store.getState().board).toBe(before);
    expect(store.getState().past).toEqual([]);
    // And the arrows move again.
    const h = knot().tangentToNext;
    press('ArrowUp');
    expect(knot().tangentToNext).toEqual({ x: h.x, y: h.y + 0.5 });
  });

  it('hold R with the point selected turns both of its handles together', () => {
    const { store, knot } = setup('end');
    const before = knot();
    press('r');
    press('ArrowRight', { shiftKey: true });
    for (const which of ['prev', 'next'] as const) {
      expect(angle(knot(), which)).toBeCloseTo(angle(before, which) - 10 * DEG, 12);
      expect(length(knot(), which)).toBeCloseTo(length(before, which), 12);
    }
    expect(knot().end).toEqual(before.end);
    expect(labels(store)).toEqual(['Rotate handles']);
  });

  it('hold T lengthens with → ↑ and shortens with ← ↓, along the handle, Shift ten steps', () => {
    const { store, knot } = setup('prev');
    const a0 = angle(knot(), 'prev');
    const l0 = length(knot(), 'prev');

    press('t');
    press('ArrowRight');
    expect(length(knot(), 'prev')).toBeCloseTo(l0 + 0.5, 12);
    press('ArrowUp', { shiftKey: true });
    expect(length(knot(), 'prev')).toBeCloseTo(l0 + 5.5, 12);
    press('ArrowLeft');
    press('ArrowDown');
    expect(length(knot(), 'prev')).toBeCloseTo(l0 + 4.5, 12);
    expect(angle(knot(), 'prev')).toBeCloseTo(a0, 12);
    expect(labels(store)).toEqual(Array(4).fill('Set handle length'));

    // Never below zero.
    for (let i = 0; i < 3; i++) press('ArrowLeft', { shiftKey: true });
    expect(length(knot(), 'prev')).toBe(0);
  });

  it('hold T with the point selected changes both handles in one step', () => {
    const { store, knot } = setup('end');
    const before = knot();
    press('t');
    press('ArrowUp');
    expect(length(knot(), 'prev')).toBeCloseTo(length(before, 'prev') + 0.5, 12);
    expect(length(knot(), 'next')).toBeCloseTo(length(before, 'next') + 0.5, 12);
    expect(labels(store)).toEqual(['Set handle length']);
  });

  it('a locked handle does not turn, but its length still changes', () => {
    const { store, knot } = setup('next');
    act(() => store.getState().setLocked(OUTLINE, 1, true));
    const before = knot();

    press('r');
    press('ArrowLeft');
    expect(knot()).toBe(before);
    expect(labels(store)).toEqual(['Lock handle angles']);
    fireEvent.keyUp(window, { key: 'r' });

    press('t');
    press('ArrowRight');
    expect(length(knot(), 'next')).toBeCloseTo(length(before, 'next') + 0.5, 12);
    expect(angle(knot(), 'next')).toBeCloseTo(angle(before, 'next'), 12);
  });

  it.each([
    ['window blur', () => fireEvent.blur(window)],
    [
      'the tab being hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        fireEvent(document, new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
      },
    ],
  ])('%s ends a held mode', (_name, end) => {
    const { knot } = setup('next');
    press('r');
    end();
    const h = knot().tangentToNext;
    press('ArrowUp');
    expect(knot().tangentToNext).toEqual({ x: h.x, y: h.y + 0.5 });
  });

  it('an R typed into a field starts no mode', () => {
    const { knot } = setup('next');
    const field = screen.getByLabelText('X position');
    field.focus();
    fireEvent.keyDown(field, { key: 'r' });
    field.blur();
    const h = knot().tangentToNext;
    press('ArrowUp');
    expect(knot().tangentToNext).toEqual({ x: h.x, y: h.y + 0.5 });
  });

  it('the cross-section pane follows the same rules', () => {
    // The bottom-centre point's handle runs out along +x: ← turns it up, on screen
    // as in the spline, since the editable half of a section is the right-hand one.
    const target = { kind: 'crossSection', index: 1 } as const;
    const { store, knot } = setup('next', target, 0);
    const a0 = angle(knot(), 'next');
    const l0 = length(knot(), 'next');
    press('r');
    press('ArrowLeft');
    expect(angle(knot(), 'next')).toBeCloseTo(a0 + DEG, 9);
    expect(length(knot(), 'next')).toBeCloseTo(l0, 9);
    fireEvent.keyUp(window, { key: 'r' });

    press('t');
    press('ArrowDown', { shiftKey: true });
    expect(length(knot(), 'next')).toBeCloseTo(l0 - 5, 9);
    expect(labels(store)).toEqual(['Rotate handle', 'Set handle length']);
  });
});
