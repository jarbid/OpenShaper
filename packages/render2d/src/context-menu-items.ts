import {
  closestPointOnSpline,
  value,
  type BezierBoard,
  type Spline,
  type Vec2,
} from '@openshaper/kernel';
import { getTargetSpline, type BoardState, type SplineTarget } from '@openshaper/store';
import type { MenuItem } from '@openshaper/ui';
import type { StoreApi } from 'zustand/vanilla';
import { hitTest } from './hit';
import { screenToWorld, type ScreenPoint, type Viewport } from './viewport';

/** Distance from a world point to the nearest point on a spline. */
const splineDistance = (s: Spline, p: Vec2): number => {
  const hit = closestPointOnSpline(s, p);
  if (!hit) return Infinity;
  const pt = value(s.coeffs[hit.index]!, hit.t);
  return Math.hypot(pt.x - p.x, pt.y - p.y);
};

export interface ContextMenuRequest {
  board: BezierBoard;
  /** The spline(s) this editor pane is drawing/editing. */
  targets: SplineTarget[];
  vp: Viewport;
  /** Click position in canvas-local pixels (same space `hitTest` expects). */
  screen: ScreenPoint;
  mirrorY: boolean;
  mirrorX: boolean;
  store: StoreApi<BoardState>;
  /** Re-home the viewport to fit the curves (owned by the editor). */
  onFitView: () => void;
}

/**
 * Build the right-click context menu for a 2D editor pane, adapting to what is under
 * the cursor (modern enhancement over the legacy's single static popup):
 *
 *  - on a control-point handle → Make smooth/corner (interior only) + Delete point
 *    (disabled on endpoints, matching `canDeleteKnot`);
 *  - on a curve (but not a handle) → Add point here;
 *  - empty space → just the view group.
 *
 * "Fit view" is always offered. All actions dispatch existing, individually-undoable
 * store commands. Pure: it only wires `onSelect` handlers and reads a board snapshot.
 */
export function buildContextMenuItems(req: ContextMenuRequest): MenuItem[] {
  const { board, targets, vp, screen, mirrorX, mirrorY, store, onFitView } = req;
  const viewGroup: MenuItem[] = [
    { kind: 'separator' },
    { kind: 'action', label: 'Fit view', onSelect: onFitView },
  ];

  // 1. Did we land on a control-point handle?
  for (const target of targets) {
    const spline = getTargetSpline(board, target);
    const hit = hitTest(spline, vp, screen);
    if (!hit) continue;
    const knot = spline.knots[hit.index]!;
    const isEndpoint = hit.index === 0 || hit.index === spline.knots.length - 1;
    const items: MenuItem[] = [];
    if (!isEndpoint) {
      items.push({
        kind: 'action',
        label: knot.continuous ? 'Make corner' : 'Make smooth',
        onSelect: () => store.getState().setContinuous(target, hit.index, !knot.continuous),
      });
    }
    items.push({
      kind: 'action',
      label: 'Delete point',
      disabled: isEndpoint,
      shortcut: 'Del',
      onSelect: () => store.getState().deleteControlPoint(target, hit.index),
    });
    return [...items, ...viewGroup];
  }

  // 2. Otherwise, are we close enough to a curve to insert a point there?
  // Reflect into the canonical half the splines live on (the other half is a drawn mirror).
  let world = screenToWorld(vp, screen);
  if (mirrorY && world.y < 0) world = { x: world.x, y: -world.y };
  if (mirrorX && world.x < 0) world = { x: -world.x, y: world.y };
  const tolWorld = 14 / vp.scale;
  let best: { target: SplineTarget; dist: number } | null = null;
  for (const target of targets) {
    const dist = splineDistance(getTargetSpline(board, target), world);
    if (!best || dist < best.dist) best = { target, dist };
  }
  if (best && best.dist <= tolWorld) {
    const addTarget = best.target;
    return [
      {
        kind: 'action',
        label: 'Add point here',
        onSelect: () => store.getState().addControlPoint(addTarget, world),
      },
      ...viewGroup,
    ];
  }

  // 3. Empty space — view group only (drop the leading separator).
  return viewGroup.slice(1);
}
