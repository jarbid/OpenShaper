import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type RefPoint,
} from '@openshaper/kernel';
import { createBoardStore, type SplineTarget } from '@openshaper/store';
import type { MenuItem } from '@openshaper/ui';
import { describe, expect, it, vi } from 'vitest';
import { buildContextMenuItems } from './context-menu-items';
import {
  drawRefPoints,
  hitRefPoint,
  REF_POINT_COLOR,
  REF_POINT_OFF_COLOR,
  REF_POINT_OK_COLOR,
  REF_POINT_SELECTED_COLOR,
} from './ref-points';
import { worldToScreen, type Viewport } from './viewport';

const makeBoard = (): BezierBoard => {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  return board(
    outline,
    bottom,
    deck,
    [0, 50, 100].map((x) => crossSection(x, prof)),
  );
};

const VP: Viewport = { scale: 2, originX: 200, originY: 300 };
const near: RefPoint = { id: 'a', plane: 'outline', x: 30, y: 30 };
const far: RefPoint = { id: 'b', plane: 'outline', x: 80, y: 30 };

/** Records the calls a draw makes, with the stroke colour current at each stroke. */
const recordingContext = () => {
  const strokes: string[] = [];
  const texts: string[] = [];
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    font: '',
    textBaseline: 'alphabetic',
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    stroke() {
      strokes.push(this.strokeStyle);
    },
    fillText(text: string) {
      texts.push(text);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, texts };
};

describe('reference point drawing and hit-testing', () => {
  it('draws one crosshair per point, the selected one in the selection colour, with labels', () => {
    const { ctx, strokes, texts } = recordingContext();
    drawRefPoints(ctx, [near, { ...far, label: 'wide' }], VP, 'b', false);
    expect(strokes).toEqual([REF_POINT_COLOR, REF_POINT_SELECTED_COLOR]);
    expect(texts).toEqual(['wide']);
  });

  it('colours points by the tolerance verdict; selected and unjudged keep their colours', () => {
    const { ctx, strokes } = recordingContext();
    const unjudged: RefPoint = { id: 'c', plane: 'outline', x: 1, y: 1 };
    const verdicts: Record<string, boolean | null> = { a: true, b: false, c: null };
    drawRefPoints(ctx, [near, far, unjudged], VP, null, false, 6, (p) => verdicts[p.id]!);
    expect(strokes).toEqual([REF_POINT_OK_COLOR, REF_POINT_OFF_COLOR, REF_POINT_COLOR]);
    const selected = recordingContext();
    drawRefPoints(selected.ctx, [far], VP, 'b', false, 6, () => false);
    expect(selected.strokes).toEqual([REF_POINT_SELECTED_COLOR]);
  });

  it('draws nothing for no points', () => {
    const { ctx, strokes } = recordingContext();
    drawRefPoints(ctx, [], VP, null, false);
    expect(strokes).toEqual([]);
  });

  it('hits the nearest point within tolerance, and nothing outside it', () => {
    const at = worldToScreen(VP, near);
    expect(hitRefPoint([far, near], VP, { x: at.x + 3, y: at.y })).toBe(near);
    expect(hitRefPoint([far, near], VP, { x: at.x + 9, y: at.y })).toBeNull();
    expect(hitRefPoint([far, near], VP, { x: at.x + 9, y: at.y }, 22)).toBe(near);
  });
});

describe('context menu: reference points', () => {
  const setup = (targets: SplineTarget[], refPointsShown = true, mirrorY = false) => {
    const store = createBoardStore();
    store.getState().load(makeBoard(), [near]);
    const build = (screen: { x: number; y: number }): MenuItem[] =>
      buildContextMenuItems({
        board: store.getState().board!,
        targets,
        vp: VP,
        screen,
        mirrorX: false,
        mirrorY,
        store,
        onFitView: vi.fn(),
        refPointsShown,
      });
    return { store, build };
  };
  const action = (items: MenuItem[], label: string) => {
    const item = items.find((i) => i.kind === 'action' && i.label === label);
    if (item?.kind !== 'action') throw new Error(`no action ${label}`);
    return item;
  };
  const has = (items: MenuItem[], label: string) =>
    items.some((i) => i.kind === 'action' && i.label === label);

  it('adds a point where the menu was opened, in the pane it was opened in', () => {
    const { store, build } = setup([{ kind: 'outline' }]);
    action(build(worldToScreen(VP, vec2(60, 40))), 'Add reference point').onSelect();
    expect(store.getState().refPoints.at(-1)).toMatchObject({ plane: 'outline', x: 60, y: 40 });
  });

  it('adds where the menu was opened, even on the mirrored half', () => {
    const { store, build } = setup([{ kind: 'outline' }], true, true);
    action(build(worldToScreen(VP, vec2(60, -40))), 'Add reference point').onSelect();
    expect(store.getState().refPoints.at(-1)).toMatchObject({ x: 60, y: -40 });
  });

  it('offers Delete on a point, and deletes that point', () => {
    const { store, build } = setup([{ kind: 'outline' }]);
    const items = build(worldToScreen(VP, near));
    expect(has(items, 'Add reference point')).toBe(false);
    action(items, 'Delete reference point').onSelect();
    expect(store.getState().refPoints).toEqual([]);
  });

  it('offers nothing for reference points while they are hidden', () => {
    const { build } = setup([{ kind: 'outline' }], false);
    expect(has(build(worldToScreen(VP, near)), 'Delete reference point')).toBe(false);
    expect(has(build(worldToScreen(VP, vec2(60, 40))), 'Add reference point')).toBe(false);
  });

  it("ignores another pane's point under the cursor", () => {
    const { build } = setup([{ kind: 'deck' }, { kind: 'bottom' }]);
    expect(has(build(worldToScreen(VP, near)), 'Delete reference point')).toBe(false);
  });

  it('a control point wins over a reference point on top of it', () => {
    const { store, build } = setup([{ kind: 'outline' }]);
    store.getState().load(makeBoard(), [{ id: 'k', plane: 'outline', x: 50, y: 20 }]);
    const items = build(worldToScreen(VP, vec2(50, 20)));
    expect(has(items, 'Fair curve')).toBe(true);
    expect(has(items, 'Delete reference point')).toBe(false);
  });
});
