import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ReferencePointArrayDialog } from './ReferencePointArrayDialog';
import { lengthUnitByKey } from './format';
import { boardStore } from './store';
import { makeBoard } from './test/spline-editor-harness';

beforeEach(() => {
  boardStore.getState().setAdjustThickness(true);
  boardStore.getState().load(makeBoard());
});

const setup = (unit = 'mm') => {
  const onClose = vi.fn();
  render(
    <ReferencePointArrayDialog
      request={{ target: { kind: 'outline' }, mirrorX: false, mirrorY: false }}
      units={lengthUnitByKey(unit)}
      onClose={onClose}
    />,
  );
  return { onClose, input: screen.getByRole('textbox', { name: `Interval (${unit})` }) };
};

it('defaults to 100 mm and creates persistent named points as one undoable edit', () => {
  const { input, onClose } = setup();
  expect((input as HTMLInputElement).value).toBe('100');
  fireEvent.click(screen.getByRole('button', { name: 'Add array' }));
  const points = boardStore.getState().board!.referencePoints!.outline!;
  expect(points).toHaveLength(10);
  expect(points[0]).toMatchObject({ x: 10, name: 'ref_100' });
  expect(boardStore.getState().past).toHaveLength(1);
  expect(onClose).toHaveBeenCalledOnce();
});

it('converts the interval from editor units and uses those units in point names', () => {
  const { input } = setup('cm');
  expect((input as HTMLInputElement).value).toBe('10');
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add array' }));
  const points = boardStore.getState().board!.referencePoints!.outline!;
  expect(points.map((p) => p.x)).toEqual([25, 50, 75, 100]);
  expect(points.map((p) => p.name)).toEqual(['ref_25', 'ref_50', 'ref_75', 'ref_100']);
});

it.each(['0', '-10', 'nonsense', '0.001'])(
  'rejects an invalid or excessive interval %s',
  (value) => {
    const { input, onClose } = setup();
    const before = boardStore.getState().board;
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Add array' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(boardStore.getState().board).toBe(before);
  },
);

it('cancels without adding points', () => {
  const { onClose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(boardStore.getState().board!.referencePoints).toBeUndefined();
});

const loadSlopedBoard = () => {
  const b = makeBoard();
  const bottom = splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(100 / 3, 25)),
    knot(vec2(100, 75), vec2(200 / 3, 50), vec2(100, 75)),
  ]);
  boardStore.getState().load({ ...b, bottom, deck: bottom });
};

it.each(['outline', 'deck', 'bottom'] as const)(
  'can choose over-curve array spacing for %s',
  (kind) => {
    loadSlopedBoard();
    render(
      <ReferencePointArrayDialog
        request={{ target: { kind }, mirrorX: false, mirrorY: false }}
        units={lengthUnitByKey('mm')}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Array measurement axis'), {
      target: { value: 'o-curve' },
    });
    fireEvent.change(screen.getByLabelText('Interval (mm)'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add array' }));
    const points =
      boardStore.getState().board!.referencePoints![kind === 'outline' ? 'outline' : 'rocker']!;
    expect(points).toHaveLength(5);
    for (const [i, point] of points.entries()) {
      expect(point.x).toBeCloseTo((i + 1) * 20, 6);
      expect(point.name).toBe(`ref_${(i + 1) * 250}`);
    }
    expect(boardStore.getState().past).toHaveLength(1);
  },
);

it('defaults to the current setting and allows overriding it with X-axis spacing', () => {
  loadSlopedBoard();
  render(
    <ReferencePointArrayDialog
      request={{ target: { kind: 'outline' }, mirrorX: false, mirrorY: false }}
      measurementAxis="o-curve"
      units={lengthUnitByKey('mm')}
      onClose={vi.fn()}
    />,
  );
  const axis = screen.getByLabelText('Array measurement axis') as HTMLSelectElement;
  expect(axis.value).toBe('o-curve');
  fireEvent.change(axis, { target: { value: 'x-axis' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add array' }));
  const points = boardStore.getState().board!.referencePoints!.outline!;
  expect(points).toHaveLength(10);
  expect(points[0]).toMatchObject({ x: 10, name: 'ref_100' });
});

it('keeps cross-section spacing along Y without a longitudinal selector', () => {
  boardStore.getState().setAdjustThickness(false);
  const source = makeBoard();
  const profile = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(5, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 10)),
    knot(vec2(0, 11), vec2(5, 11), vec2(0, 11)),
  ]);
  boardStore.getState().load({
    ...source,
    crossSections: source.crossSections.map((section) => ({ ...section, spline: profile })),
  });
  render(
    <ReferencePointArrayDialog
      request={{ target: { kind: 'crossSection', index: 1 }, mirrorX: true, mirrorY: false }}
      measurementAxis="o-curve"
      units={lengthUnitByKey('mm')}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByLabelText('Array measurement axis')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add array' }));
  expect(boardStore.getState().board!.referencePoints!['crossSection:1']!.length).toBeGreaterThan(
    0,
  );
});
