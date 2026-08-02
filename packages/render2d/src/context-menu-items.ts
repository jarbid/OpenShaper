import {
  RAIL_PRESETS,
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
  /**
   * Insert a cross-section at a board-length position (cursor x). Only provided for
   * length-axis panes (outline / rocker); when present, the menu offers "Add
   * cross-section here". The cross-section pane's x is lateral, so it omits this.
   */
  onAddSectionAt?: (x: number) => void;
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
 * "Fit view" is always offered, and in the cross-section pane so is the "Rail preset"
 * submenu — that one restyles the pane's active section rather than whatever sits under
 * the cursor, so like "Fit view" it is offered from all three branches. Gating it on the
 * hit test would mean a right-click landing within a few pixels of one of the five
 * handles silently lost the feature.
 *
 * All actions dispatch existing, individually-undoable store commands. Pure: it only
 * wires `onSelect` handlers and reads a board snapshot.
 */
export function buildContextMenuItems(req: ContextMenuRequest): MenuItem[] {
  const { board, targets, vp, screen, mirrorX, mirrorY, store, onFitView, onAddSectionAt } = req;
  const viewGroup: MenuItem[] = [
    { kind: 'separator' },
    { kind: 'action', label: 'Fit view', onSelect: onFitView },
  ];

  // The nose and tail dummies carry a single knot and have no rail to shape. `App.tsx`
  // clamps the active section away from them, but this builder is pure and unit-tested
  // standalone, so it guards for itself.
  const csTarget = targets.find(
    (t): t is Extract<SplineTarget, { kind: 'crossSection' }> =>
      t.kind === 'crossSection' && t.index > 0 && t.index < board.crossSections.length - 1,
  );
  const railGroup: MenuItem[] = csTarget
    ? [
        {
          kind: 'submenu',
          label: 'Rail preset',
          items: RAIL_PRESETS.map((preset) => ({
            kind: 'action' as const,
            label: preset.label,
            onSelect: () => store.getState().applyRailPreset(csTarget.index, preset.id),
          })),
        },
      ]
    : [];
  const tail: MenuItem[] = [...railGroup, ...viewGroup];

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
    return [...items, ...tail];
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
  const items: MenuItem[] = [];
  if (best && best.dist <= tolWorld) {
    const addTarget = best.target;
    items.push({
      kind: 'action',
      label: 'Add point here',
      onSelect: () => store.getState().addControlPoint(addTarget, world),
    });
  }
  // A cross-section can be added anywhere along the length axis (it just needs an x),
  // so this is offered whether or not we landed near a curve.
  if (onAddSectionAt) {
    const x = world.x;
    items.push({
      kind: 'action',
      label: 'Add cross-section here',
      onSelect: () => onAddSectionAt(x),
    });
  }

  // 3. Otherwise — the gathered items (if any) plus the tail, else the tail alone with
  // its leading separator dropped (nothing precedes it to separate from).
  if (items.length > 0) return [...items, ...tail];
  return railGroup.length > 0 ? tail : viewGroup.slice(1);
}
