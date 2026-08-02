import {
  RAIL_PRESETS,
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

/** Top-level row labels; a submenu contributes its own label, not its children's. */
const labels = (items: MenuItem[]): string[] =>
  items.flatMap((i) =>
    i.kind === 'action' || i.kind === 'checkbox' || i.kind === 'submenu' ? [i.label] : [],
  );

const find = (items: MenuItem[], label: string) =>
  items.find(
    (i) =>
      (i.kind === 'action' || i.kind === 'checkbox' || i.kind === 'submenu') && i.label === label,
  );

const submenu = (items: MenuItem[], label: string): Extract<MenuItem, { kind: 'submenu' }> => {
  const found = find(items, label);
  if (found?.kind !== 'submenu') throw new Error(`no submenu labelled ${label}`);
  return found;
};

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

  it('offers "Add cross-section here" when onAddSectionAt is provided, calling it with cursor x', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    const onAddSectionAt = vi.fn();
    // A point off the curve and away from any handle (empty space) at world x=30.
    const items = buildContextMenuItems({
      board: store.getState().board!,
      targets: TARGETS,
      vp: VP,
      screen: worldToScreen(VP, vec2(30, 50)),
      mirrorX: false,
      mirrorY: false,
      store,
      onFitView: vi.fn(),
      onAddSectionAt,
    });

    expect(labels(items)).toEqual(['Add cross-section here', 'Fit view']);
    (find(items, 'Add cross-section here') as { onSelect: () => void }).onSelect();
    expect(onAddSectionAt).toHaveBeenCalledWith(30);
  });

  it('omits "Add cross-section here" when onAddSectionAt is absent (cross-section pane)', () => {
    const { build } = setup();
    const items = build(worldToScreen(VP, vec2(30, 50)));
    expect(labels(items)).not.toContain('Add cross-section here');
  });
});

describe('buildContextMenuItems: rail presets', () => {
  /**
   * A board whose cross-sections are big enough to right-click *between* the handles —
   * the shared `makeBoard` profile is only a few world units across, so at this
   * viewport scale every point on it falls inside the handle-pick radius.
   */
  const makeCsBoard = (): BezierBoard => {
    const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
    const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
    const bottom = splineFromKnots([k(0, 0), k(50, 0), k(100, 0)]);
    const deck = splineFromKnots([k(0, 0), k(50, 12), k(100, 0)]);
    const prof = splineFromKnots([
      knot(vec2(0, 0), vec2(-8, 0), vec2(8, 0)),
      knot(vec2(20, 6), vec2(20, 2), vec2(20, 10)),
      knot(vec2(0, 12), vec2(8, 12), vec2(-8, 12)),
    ]);
    const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
    return board(outline, bottom, deck, cs);
  };

  const csSetup = (targets: SplineTarget[] = [{ kind: 'crossSection', index: 1 }]) => {
    const store = createBoardStore();
    store.getState().load(makeCsBoard());
    const build = (screen: { x: number; y: number }): MenuItem[] =>
      buildContextMenuItems({
        board: store.getState().board!,
        targets,
        vp: VP,
        screen,
        mirrorX: true,
        mirrorY: false,
        store,
        onFitView: vi.fn(),
      });
    // Three places a right-click can land, in the cross-section pane's own space.
    const spline = store.getState().board!.crossSections[1]!.spline;
    const onHandle = worldToScreen(VP, spline.knots[1]!.end);
    const onCurve = worldToScreen(VP, value(spline.coeffs[0]!, 0.5));
    const empty = worldToScreen(VP, vec2(900, 900));
    return { store, build, onHandle, onCurve, empty };
  };

  /**
   * The preset acts on the pane's active section, not on whatever is under the cursor,
   * so it has to be reachable from every right-click — including one that happens to
   * land within the handle-pick radius of a control point.
   */
  it('is offered wherever the click lands in the cross-section pane', () => {
    const { build, onHandle, onCurve, empty } = csSetup();
    expect(labels(build(onHandle))).toContain('Rail preset');
    expect(labels(build(onCurve))).toContain('Rail preset');
    expect(labels(build(empty))).toContain('Rail preset');
    // Still a hit-test-driven menu underneath.
    expect(labels(build(onHandle))).toContain('Delete point');
    expect(labels(build(onCurve))).toContain('Add point here');
  });

  it('lists every preset, in kernel order, as an action', () => {
    const { build, empty } = csSetup();
    const items = submenu(build(empty), 'Rail preset').items;
    expect(items.map((i) => (i.kind === 'action' ? i.label : null))).toEqual(
      RAIL_PRESETS.map((p) => p.label),
    );
  });

  it('applies the chosen preset to the pane’s active section', () => {
    const { store, build, empty } = csSetup();
    const before = store.getState().board!.crossSections[1]!.spline;
    const item = submenu(build(empty), 'Rail preset').items.find(
      (i) => i.kind === 'action' && i.label === '80/20 hard',
    );
    expect(item?.kind).toBe('action');
    if (item?.kind === 'action') item.onSelect();

    const after = store.getState().board!;
    expect(after.crossSections[1]!.spline).not.toBe(before);
    expect(store.getState().past.at(-1)!.label).toBe('Rail preset: 80/20 hard');
    // The neighbouring stations are the shaper's business, not the preset's.
    expect(after.crossSections[0]).toBe(store.getState().past.at(-1)!.board.crossSections[0]);
  });

  it('is not offered outside the cross-section pane', () => {
    const { build, empty } = csSetup([{ kind: 'outline' }]);
    expect(labels(build(empty))).not.toContain('Rail preset');
    const rocker = csSetup([{ kind: 'deck' }, { kind: 'bottom' }]);
    expect(labels(rocker.build(rocker.empty))).not.toContain('Rail preset');
  });

  it('is not offered for the nose and tail dummy stations', () => {
    for (const index of [0, 2]) {
      const { build, empty } = csSetup([{ kind: 'crossSection', index }]);
      expect(labels(build(empty)), `station ${index}`).not.toContain('Rail preset');
    }
  });
});
