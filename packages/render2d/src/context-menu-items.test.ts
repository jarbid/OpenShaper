import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  value,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { createBoardStore, type SplineTarget } from '@openshaper/store';
import type { MenuItem } from '@openshaper/ui';
import { describe, expect, it, vi } from 'vitest';
import { buildContextMenuItems } from './context-menu-items';
import type { Viewport } from './viewport';
import { worldToScreen } from './viewport';

// A small valid board; the outline has three knots: two endpoints + one interior (index 1).
const makeBoard = (): BezierBoard => {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
  return board(outline, bottom, deck, cs);
};

const VP: Viewport = { scale: 2, originX: 200, originY: 300 };
const TARGETS: SplineTarget[] = [{ kind: 'outline' }];

const setup = () => {
  const store = createBoardStore();
  store.getState().load(makeBoard());
  const onFitView = vi.fn();
  const build = (screen: { x: number; y: number }): MenuItem[] =>
    buildContextMenuItems({
      board: store.getState().board!,
      targets: TARGETS,
      vp: VP,
      screen,
      mirrorX: false,
      mirrorY: false,
      store,
      onFitView,
    });
  return { store, onFitView, build };
};

const labels = (items: MenuItem[]): string[] =>
  items.flatMap((i) => (i.kind === 'action' || i.kind === 'checkbox' ? [i.label] : []));

const find = (items: MenuItem[], label: string) =>
  items.find((i) => (i.kind === 'action' || i.kind === 'checkbox') && i.label === label);

describe('buildContextMenuItems', () => {
  it('on an interior point: offers smooth/corner toggle + an enabled Delete, plus Fit view', () => {
    const { store, build } = setup();
    const items = build(worldToScreen(VP, vec2(50, 20))); // outline knot index 1

    expect(labels(items)).toEqual(['Make corner', 'Delete point', 'Fit view']);
    const del = find(items, 'Delete point');
    expect(del?.kind === 'action' && del.disabled).toBeFalsy();

    // Delete dispatches to the store and removes the interior knot (3 -> 2).
    (del as { onSelect: () => void }).onSelect();
    expect(store.getState().board!.outline.knots).toHaveLength(2);
  });

  it('toggling smooth/corner flips the knot continuity in the store', () => {
    const { store, build } = setup();
    const items = build(worldToScreen(VP, vec2(50, 20)));
    const before = store.getState().board!.outline.knots[1]!.continuous;

    (find(items, 'Make corner') as { onSelect: () => void }).onSelect();
    expect(store.getState().board!.outline.knots[1]!.continuous).toBe(!before);
  });

  it('on an endpoint: no smooth/corner toggle, and Delete is disabled (and a no-op)', () => {
    const { store, build } = setup();
    const items = build(worldToScreen(VP, vec2(0, 0))); // outline knot index 0 (endpoint)

    expect(labels(items)).toEqual(['Delete point', 'Fit view']);
    const del = find(items, 'Delete point');
    expect(del?.kind === 'action' && del.disabled).toBe(true);

    (del as { onSelect: () => void }).onSelect();
    expect(store.getState().board!.outline.knots).toHaveLength(3); // unchanged
  });

  it('on a curve but not a handle: offers Add point here, which inserts a knot', () => {
    const { store, build } = setup();
    // Midpoint of the first segment is on the curve but away from any handle.
    const onCurve = worldToScreen(VP, value(store.getState().board!.outline.coeffs[0]!, 0.5));
    const items = build(onCurve);

    expect(labels(items)).toEqual(['Add point here', 'Fit view']);
    (find(items, 'Add point here') as { onSelect: () => void }).onSelect();
    expect(store.getState().board!.outline.knots).toHaveLength(4);
  });

  it('on empty space: only Fit view (no leading separator)', () => {
    const { onFitView, build } = setup();
    const items = build({ x: 9999, y: 9999 });

    expect(items).toHaveLength(1);
    expect(labels(items)).toEqual(['Fit view']);
    (items[0] as { onSelect: () => void }).onSelect();
    expect(onFitView).toHaveBeenCalledOnce();
  });
});
