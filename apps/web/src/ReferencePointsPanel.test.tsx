import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { valueAt, type RefPoint } from '@openshaper/kernel';
import { LENGTH_UNITS } from './format';
import type { Longitudinal } from './longitudinal';
import { ReferencePointsPanel } from './ReferencePointsPanel';
import { boardStore } from './store';
import { makeBoard } from './test/spline-editor-harness';

const cm = LENGTH_UNITS.find((u) => u.key === 'cm')!;
const straight: Longitudinal = { axis: 'x-axis', toDisplay: (x) => x, toModel: (d) => d, mark: '' };

const mount = (points: RefPoint[] = [], activeSection = 1) => {
  act(() => boardStore.getState().load(makeBoard(), points));
  return render(
    <ReferencePointsPanel
      store={boardStore}
      units={cm}
      longitudinal={straight}
      activeSection={activeSection}
      tolerance={0.1}
      onToleranceChange={() => {}}
    />,
  );
};
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(name) }));
const type = (label: string, value: string) => {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
};
const s = () => boardStore.getState();

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('ReferencePointsPanel: outline and rocker', () => {
  it('lists outline points as full widths, with the board width beside them', () => {
    mount([{ id: 'r1', plane: 'outline', x: 50, y: 21 }]);
    expect((screen.getByLabelText('Position 1') as HTMLInputElement).value).toBe('50.00');
    expect((screen.getByLabelText('Width 1') as HTMLInputElement).value).toBe('42.00');
    // The test board's outline is 20 cm half-width at x = 50.
    expect(screen.getByText(/^40/)).toBeTruthy();
  });

  it('edits a width as half-widths on the side the point was placed', () => {
    mount([{ id: 'r1', plane: 'outline', x: 50, y: -21 }]);
    type('Width 1', '44');
    expect(s().refPoints[0]).toMatchObject({ x: 50, y: -22 });
  });

  it('edits a position measured from the nose', () => {
    mount([{ id: 'r1', plane: 'outline', x: 30, y: 10 }]);
    fireEvent.change(screen.getByLabelText('Measure positions from'), {
      target: { value: 'nose' },
    });
    expect((screen.getByLabelText('Position 1') as HTMLInputElement).value).toBe('70.00');
    type('Position 1', '60');
    expect(s().refPoints[0]!.x).toBeCloseTo(40, 9);
  });

  it('generates stations valued from the board as one undo step', () => {
    mount();
    type('Station spacing (cm)', '25');
    fireEvent.click(screen.getByRole('button', { name: 'Generate stations' }));
    const pts = s().refPoints;
    expect(pts.map((p) => p.x)).toEqual([25, 50, 75]);
    const outline = s().board!.outline;
    for (const p of pts) expect(p.y).toBeCloseTo(valueAt(outline, p.x), 9);
    expect(s().past.map((e) => e.label)).toEqual(['Generate reference points']);
    expect(screen.getByRole('status').textContent).toBe('3 points added.');
  });

  it('pastes rocker rows onto the chosen curve, and says which lines it skipped', () => {
    mount();
    tab('Rocker');
    fireEvent.change(screen.getByLabelText('Curve for new rocker points'), {
      target: { value: 'deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Paste…' }));
    fireEvent.change(screen.getByLabelText('Rows to paste'), {
      target: { value: 'pos\theight\n10\t12\n90\t11.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add rows' }));
    expect(s().refPoints).toEqual([
      { id: 'r1', plane: 'rocker', curve: 'deck', x: 10, y: 12 },
      { id: 'r2', plane: 'rocker', curve: 'deck', x: 90, y: 11.5 },
    ]);
    expect(screen.getByRole('status').textContent).toBe('2 points added; line 1 skipped.');
  });

  it('deletes a row', () => {
    mount([{ id: 'r1', plane: 'outline', x: 50, y: 21 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete reference point 1' }));
    expect(s().refPoints).toEqual([]);
  });

  it('selects the point whose row is being edited', () => {
    mount([{ id: 'r1', plane: 'outline', x: 50, y: 21 }]);
    fireEvent.focus(screen.getByLabelText('Width 1'));
    expect(s().selectedRef).toBe('r1');
  });
});

describe('ReferencePointsPanel: sections', () => {
  it('adds and pastes section points on the active section', () => {
    mount([], 1);
    tab('Section');
    fireEvent.click(screen.getByRole('button', { name: 'Add point' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paste…' }));
    fireEvent.change(screen.getByLabelText('Rows to paste'), {
      target: { value: '8\t5.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add rows' }));
    expect(s().refPoints.map((p) => p.plane === 'section' && [p.station, p.x, p.y])).toEqual([
      [50, 0, 0],
      [50, 8, 5.5],
    ]);
  });

  it('flags a station with no section, and puts a section there on request', () => {
    mount([{ id: 'r1', plane: 'section', station: 70, x: 8, y: 6 }]);
    tab('Section');
    expect(screen.getByText('no section')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add section here' }));
    expect(s().board!.crossSections.some((c) => Math.abs(c.position - 70) < 1e-9)).toBe(true);
    expect(screen.queryByText('no section')).toBeNull();
  });

  it('moves the nearest section to a station instead, when asked', () => {
    mount([{ id: 'r1', plane: 'section', station: 60, x: 8, y: 6 }]);
    tab('Section');
    fireEvent.click(screen.getByRole('button', { name: 'Move nearest section here' }));
    expect(s().board!.crossSections.map((c) => c.position)).toEqual([0, 60, 100]);
  });
});

describe('ReferencePointsPanel: gaps and tolerance', () => {
  it('shows the board gap signed and coloured by the tolerance', () => {
    // Measured 42 wide where the board is 40: the board is 2 cm narrower.
    mount([
      { id: 'r1', plane: 'outline', x: 50, y: 21 },
      { id: 'r2', plane: 'outline', x: 50.01, y: 20.02 },
    ]);
    const off = screen.getByTitle('Outside tolerance');
    expect(off.textContent).toMatch(/^−2/);
    expect(off.className).toMatch(/red/);
    expect(screen.getByTitle('Within tolerance').className).toMatch(/green/);
  });

  it('commits a positive tolerance and snaps anything else back', () => {
    act(() => boardStore.getState().load(makeBoard(), []));
    const onToleranceChange = vi.fn();
    render(
      <ReferencePointsPanel
        store={boardStore}
        units={cm}
        longitudinal={straight}
        activeSection={1}
        tolerance={0.1}
        onToleranceChange={onToleranceChange}
      />,
    );
    type('Tolerance (cm)', '0.25');
    expect(onToleranceChange).toHaveBeenCalledWith(0.25);
    type('Tolerance (cm)', '-1');
    expect(onToleranceChange).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Tolerance (cm)') as HTMLInputElement).value).toBe('0.1');
  });
});
