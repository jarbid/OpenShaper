// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board edits both document stores share: the spline actions (move, tangents, locks, insert,
 * delete, ...), the whole-board resize and the fin edits. Each one reads the board the store shows,
 * applies the pure edit from `edits.ts`, and hands the result to the store's own `commit`. The classic
 * store commits a board; the section store (sections/section-store.ts) writes the changed curves back
 * into its document. One body of edit rules for both engines (docs/design/m2-editor.md §1).
 */
import type { BezierBoard, Spline, Vec2 } from '@openshaper/kernel';
import type { BoardState } from './board-store';
import {
  alignTangentsHorizontal,
  alignTangentsVertical,
  canDeleteKnot,
  capSectionHandleLengths,
  constrainSectionToBlank,
  deleteKnot,
  enforceJunctions,
  extendKnotTangent,
  fairKnot,
  getTargetSpline,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  moveSegmentTangents,
  rotateKnotTangent,
  scaleBoard,
  setFinFromPlanPoint,
  setFinSetup,
  setFinSymmetrical,
  setFinSystem,
  setKnotContinuous,
  setKnotLock,
  setKnotTangentLength,
  stepKnotTangentLength,
  updateFinSpec,
  withSpline,
  zeroKnotTangent,
  type SplineTarget,
} from './edits';

/** What the shared actions need of the store that owns them. */
export interface ActionContext {
  get(): BoardState;
  set(patch: Partial<BoardState>): void;
  /** Apply an edited board, recording a labelled history step unless mid-drag. */
  commit(next: BezierBoard, label: string): void;
}

/** The actions of {@link BoardState} that edit a spline of the board. */
export type SplineActionNames =
  | 'moveSegmentTangents'
  | 'moveControlPoint'
  | 'moveTangent'
  | 'setTangentLength'
  | 'rotateTangent'
  | 'stepTangentLength'
  | 'addControlPoint'
  | 'deleteControlPoint'
  | 'setContinuous'
  | 'setLocked'
  | 'fairControlPoint'
  | 'zeroTangent'
  | 'extendTangent'
  | 'alignTangentsHorizontal'
  | 'alignTangentsVertical';

export type SplineActions = Pick<BoardState, SplineActionNames>;

export type FinActionNames =
  | 'setFinSetup'
  | 'setFinSystem'
  | 'setFinSymmetrical'
  | 'updateFin'
  | 'moveFin'
  | 'scaleBoard';

export type FinActions = Pick<BoardState, FinActionNames>;

/** Whether two handle positions agree to well below anything an edit could mean (cm). */
const samePoint = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9;

export function createSplineActions(ctx: ActionContext): SplineActions {
  const { get, set, commit } = ctx;

  /**
   * `target`'s spline in `board` edited from `before` to `after`, as it will be stored. A
   * slice is held inside the blank first: the outline, rocker and deck define the blank,
   * and a slice edit refines it without ever moving them (`constrainSectionToBlank`).
   * Then the shared junctions are re-pinned, so curves can't be pulled apart.
   */
  const settle = (board: BezierBoard, target: SplineTarget, before: Spline, after: Spline) => {
    const held = target.kind === 'crossSection' ? constrainSectionToBlank(before, after) : after;
    return { held, board: enforceJunctions(withSpline(board, target, held), target) };
  };

  /**
   * Whether knot `index`'s handles come through {@link settle} where `after` puts them.
   * The junction pass clamps a handle past a limit back onto it, and the blank slides
   * one pushed out past a slice's apex onto the apex line; either turns or shortens it.
   * An edit that promises to keep a handle's angle or length checks this first, and does
   * not happen rather than land as something else.
   */
  const settlesAsAsked = (target: SplineTarget, before: Spline, after: Spline, index: number) => {
    const { board } = get();
    if (!board) return false;
    const want = after.knots[index];
    const got = getTargetSpline(settle(board, target, before, after).board, target).knots[index];
    return (
      !!want &&
      !!got &&
      samePoint(want.tangentToPrev, got.tangentToPrev) &&
      samePoint(want.tangentToNext, got.tangentToNext)
    );
  };

  /**
   * A handle length edit of knot `index`: on a slice stopped where the handle meets the
   * apex line, along its own direction, and refused if the blank would still turn it.
   * (The outline, rocker and deck keep their junction pass's say, as before.)
   */
  const editLength = (target: SplineTarget, index: number, fn: (s: Spline) => Spline) => {
    const { board } = get();
    if (!board) return;
    const spline = getTargetSpline(board, target);
    let next = fn(spline);
    // A collapsed free handle has no direction to change length along: no step to record.
    if (next === spline) return;
    if (target.kind === 'crossSection') {
      next = capSectionHandleLengths(spline, next, index);
      // Already on the line: stopping there again changes nothing, so records nothing.
      const was = spline.knots[index]!;
      const got = next.knots[index]!;
      if (
        samePoint(was.tangentToPrev, got.tangentToPrev) &&
        samePoint(was.tangentToNext, got.tangentToNext)
      )
        return;
      if (!settlesAsAsked(target, spline, next, index)) return;
    }
    editSpline(target, 'Set handle length', () => next);
  };

  /**
   * Align knot `index`'s handles. On a slice they keep their lengths, as the buttons
   * promise, or the align does not happen: lying an apex's handles flat would push one
   * out past the apex line, where the blank would collapse it onto the point.
   */
  const editAlign = (
    target: SplineTarget,
    index: number,
    align: (s: Spline, index: number) => Spline,
  ) => {
    const { board } = get();
    if (!board) return;
    const spline = getTargetSpline(board, target);
    const next = align(spline, index);
    if (target.kind === 'crossSection' && !settlesAsAsked(target, spline, next, index)) return;
    editSpline(target, 'Align tangents', () => next);
  };

  /** Replace `target`'s spline with `fn` of it, through {@link settle}, as one commit. */
  const editSpline = (target: SplineTarget, label: string, fn: (s: Spline) => Spline) => {
    const { board } = get();
    if (!board) return;
    const before = getTargetSpline(board, target);
    const after = fn(before);
    const settled = settle(board, target, before, after);
    // The blank took the whole edit back (a slice's centre point dragged, its apex pushed
    // sideways): there is nothing to record.
    if (settled.held === before && after !== before) return;
    commit(settled.board, label);
  };

  return {
    moveControlPoint: (target, index, end) =>
      editSpline(target, 'Move control point', (s) => moveKnotEnd(s, index, end)),

    moveTangent: (target, index, which, pos) =>
      editSpline(target, 'Move tangent', (s) => moveKnotTangent(s, index, which, pos)),

    setTangentLength: (target, index, which, length) =>
      editLength(target, index, (s) => setKnotTangentLength(s, index, which, length)),
    rotateTangent: (target, index, which, radians) => {
      const { board } = get();
      if (!board) return;
      const spline = getTargetSpline(board, target);
      const turned = rotateKnotTangent(spline, index, which, radians);
      // Locked, collapsed, or no angle: nothing turned, so no step to record.
      if (turned === spline) return;
      // A turn keeps its length or does not happen.
      if (!settlesAsAsked(target, spline, turned, index)) return;
      editSpline(target, which === 'both' ? 'Rotate handles' : 'Rotate handle', () => turned);
    },
    stepTangentLength: (target, index, which, delta) =>
      editLength(target, index, (s) => stepKnotTangentLength(s, index, which, delta)),
    moveSegmentTangents: (target, index, first, last) => {
      const { board } = get();
      if (!board) return;
      const spline = getTargetSpline(board, target);
      const next = moveSegmentTangents(spline, index, first, last);
      if (next === spline) return;
      editSpline(target, 'Adjust Tunni handles', () => next);
    },

    addControlPoint: (target, p) => {
      const { board } = get();
      if (!board) return;
      const result = insertKnotAt(getTargetSpline(board, target), p);
      if (!result) return;
      editSpline(target, 'Add control point', () => result.spline);
      set({ selection: { target, index: result.index, kind: 'end' } });
    },

    deleteControlPoint: (target, index) => {
      const { board } = get();
      if (!board) return;
      const spline = getTargetSpline(board, target);
      if (!canDeleteKnot(spline, index, target)) return;
      // Delete pressed mid-drag: close the drag's step first, so the deletion is its
      // own undo step rather than relabelling the drag's (the editor then drops the
      // drag, whose knot index no longer means the same point).
      if (get().editing) set({ editing: false });
      editSpline(target, 'Delete control point', () => deleteKnot(spline, index));
      set({ selection: null });
    },

    setContinuous: (target, index, continuous) =>
      editSpline(target, continuous ? 'Smooth control point' : 'Corner control point', (s) =>
        setKnotContinuous(s, index, continuous),
      ),

    setLocked: (target, index, locked) => {
      const { board } = get();
      if (!board) return;
      const spline = getTargetSpline(board, target);
      const next = setKnotLock(spline, index, locked);
      // A click that changes nothing must not leave an empty undo step.
      if (next === spline) return;
      editSpline(target, locked ? 'Lock handle angles' : 'Unlock handle angles', () => next);
    },

    fairControlPoint: (target, index) =>
      editSpline(target, 'Fair curve', (s) => fairKnot(s, index)),

    zeroTangent: (target, index, which) =>
      editSpline(target, 'Set handle length to zero', (s) => zeroKnotTangent(s, index, which)),

    extendTangent: (target, index, which) =>
      editSpline(target, 'Extend handle', (s) => extendKnotTangent(s, index, which)),

    alignTangentsHorizontal: (target, index) => editAlign(target, index, alignTangentsHorizontal),

    alignTangentsVertical: (target, index) => editAlign(target, index, alignTangentsVertical),
  };
}

export function createFinActions(ctx: ActionContext): FinActions {
  const { get, set, commit } = ctx;
  return {
    scaleBoard: (fL, fW, fT) => {
      const { board } = get();
      if (!board) return;
      if (fL === 1 && fW === 1 && fT === 1) return;
      commit(enforceJunctions(scaleBoard(board, fL, fW, fT)), 'Resize board');
    },

    setFinSetup: (setup) => {
      const { board } = get();
      if (!board || board.fins.setup === setup) return;
      commit(setFinSetup(board, setup), 'Change fin setup');
      set({ selectedFin: null });
    },

    setFinSystem: (system) => {
      const { board } = get();
      if (!board || board.fins.system === system) return;
      commit(setFinSystem(board, system), 'Change fin system');
    },

    setFinSymmetrical: (symmetrical) => {
      const { board } = get();
      if (!board || board.fins.symmetrical === symmetrical) return;
      commit(setFinSymmetrical(board, symmetrical), 'Toggle fin symmetry');
    },

    updateFin: (index, patch) => {
      const { board } = get();
      if (!board) return;
      const next = updateFinSpec(board, index, patch);
      if (next === board) return;
      commit(next, 'Edit fin');
    },

    moveFin: (index, point) => {
      const { board } = get();
      if (!board) return;
      const next = setFinFromPlanPoint(board, index, point);
      if (next === board) return;
      commit(next, 'Move fin');
    },
  };
}
