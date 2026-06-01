import type { BezierBoard, Vec2 } from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { InterpolationType, Spline } from '@openshaper/kernel';
import {
  canDeleteKnot,
  deleteKnot,
  enforceJunctions,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  removeCrossSection,
  scaleBoard,
  setKnotContinuous,
  withInterpolationType,
  withSpline,
  type SplineTarget,
} from './edits';

/** A selected control point, for the inspector / highlight. */
export interface Selection {
  target: SplineTarget;
  index: number;
}

export interface BoardState {
  board: BezierBoard | null;
  past: BezierBoard[];
  future: BezierBoard[];
  /** True while a drag is in progress (edits coalesce into one undo step). */
  editing: boolean;
  selection: Selection | null;

  load: (board: BezierBoard) => void;
  select: (selection: Selection | null) => void;

  /** Begin a grouped edit (call on drag start). */
  beginEdit: () => void;
  /** End a grouped edit (call on drag end). */
  endEdit: () => void;

  moveControlPoint: (target: SplineTarget, index: number, end: Vec2) => void;
  moveTangent: (target: SplineTarget, index: number, which: 'prev' | 'next', pos: Vec2) => void;

  /** Insert a control point on the target spline nearest to `p`, then select it. */
  addControlPoint: (target: SplineTarget, p: Vec2) => void;
  /** Delete an interior control point and clear the selection. No-op for endpoints. */
  deleteControlPoint: (target: SplineTarget, index: number) => void;
  /** Toggle a control point between smooth (continuous) and corner. */
  setContinuous: (target: SplineTarget, index: number, continuous: boolean) => void;

  /** Insert a shape-preserving cross-section at `position`; returns its new index (or -1). */
  addCrossSection: (position: number) => number;
  /** Remove a real cross-section by index (no-op for the nose/tail dummies). */
  deleteCrossSection: (index: number) => void;
  /** Replace a cross-section's whole spline (e.g. paste a copied section shape). */
  pasteCrossSection: (index: number, spline: Spline) => void;
  /** Scale the board by independent length / width / thickness factors. */
  scaleBoard: (fL: number, fW: number, fT: number) => void;
  /** Switch the cross-section interpolation model (control-point ↔ sLinear). */
  setInterpolationType: (type: InterpolationType) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

const MAX_HISTORY = 200;

export const createBoardStore = (): StoreApi<BoardState> =>
  createStore<BoardState>((set, get) => {
    /** Apply an edited board, recording history unless mid-drag. */
    const commit = (next: BezierBoard) => {
      const { board, editing, past } = get();
      if (!board) return;
      if (editing) {
        set({ board: next }); // snapshot already taken at beginEdit
      } else {
        set({
          board: next,
          past: [...past, board].slice(-MAX_HISTORY),
          future: [],
        });
      }
    };

    const editSpline = (
      target: SplineTarget,
      fn: (s: ReturnType<typeof getTargetSpline>) => BezierBoard,
    ) => {
      const { board } = get();
      if (!board) return;
      // Re-pin shared junctions after the edit so curves can't be pulled apart.
      commit(enforceJunctions(fn(getTargetSpline(board, target)), target));
    };

    return {
      board: null,
      past: [],
      future: [],
      editing: false,
      selection: null,

      load: (board) =>
        set({
          board: enforceJunctions(board),
          past: [],
          future: [],
          editing: false,
          selection: null,
        }),
      select: (selection) => set({ selection }),

      beginEdit: () => {
        const { board, past, editing } = get();
        if (!board || editing) return;
        set({ editing: true, past: [...past, board].slice(-MAX_HISTORY), future: [] });
      },
      endEdit: () => set({ editing: false }),

      moveControlPoint: (target, index, end) =>
        editSpline(target, (s) => withSpline(get().board!, target, moveKnotEnd(s, index, end))),

      moveTangent: (target, index, which, pos) =>
        editSpline(target, (s) =>
          withSpline(get().board!, target, moveKnotTangent(s, index, which, pos)),
        ),

      addControlPoint: (target, p) => {
        const { board } = get();
        if (!board) return;
        const result = insertKnotAt(getTargetSpline(board, target), p);
        if (!result) return;
        commit(enforceJunctions(withSpline(board, target, result.spline), target));
        set({ selection: { target, index: result.index } });
      },

      deleteControlPoint: (target, index) => {
        const { board } = get();
        if (!board) return;
        const spline = getTargetSpline(board, target);
        if (!canDeleteKnot(spline, index)) return;
        commit(enforceJunctions(withSpline(board, target, deleteKnot(spline, index)), target));
        set({ selection: null });
      },

      setContinuous: (target, index, continuous) =>
        editSpline(target, (s) =>
          withSpline(get().board!, target, setKnotContinuous(s, index, continuous)),
        ),

      addCrossSection: (position) => {
        const { board } = get();
        if (!board) return -1;
        const result = insertCrossSection(board, position);
        if (!result) return -1;
        commit(enforceJunctions(result.board));
        return result.index;
      },

      deleteCrossSection: (index) => {
        const { board } = get();
        if (!board) return;
        const next = removeCrossSection(board, index);
        if (next === board) return;
        commit(enforceJunctions(next));
        set({ selection: null });
      },

      pasteCrossSection: (index, spline) => {
        const { board } = get();
        if (!board) return;
        const target: SplineTarget = { kind: 'crossSection', index };
        commit(enforceJunctions(withSpline(board, target, spline), target));
      },

      scaleBoard: (fL, fW, fT) => {
        const { board } = get();
        if (!board) return;
        if (fL === 1 && fW === 1 && fT === 1) return;
        commit(enforceJunctions(scaleBoard(board, fL, fW, fT)));
      },

      setInterpolationType: (type) => {
        const { board } = get();
        if (!board || board.interpolationType === type) return;
        commit(withInterpolationType(board, type));
      },

      undo: () => {
        const { past, future, board } = get();
        if (past.length === 0 || !board) return;
        const prev = past[past.length - 1]!;
        set({ board: prev, past: past.slice(0, -1), future: [board, ...future], editing: false });
      },
      redo: () => {
        const { past, future, board } = get();
        if (future.length === 0 || !board) return;
        const next = future[0]!;
        set({ board: next, past: [...past, board], future: future.slice(1), editing: false });
      },
      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,
    };
  });
