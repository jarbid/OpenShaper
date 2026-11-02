import type { BezierBoard, RailPresetId, Vec2 } from '@openshaper/kernel';
import { adjustCrossSectionsToThicknessAndWidth } from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FinSetup, FinSpec, FinSystem, InterpolationType, Spline } from '@openshaper/kernel';
import { createFinActions, createSectionShapeActions, createSplineActions } from './board-actions';
import {
  enforceJunctions,
  findTargetSpline,
  insertCrossSection,
  moveCrossSectionPosition,
  removeCrossSection,
  withInterpolationType,
  type KnotHandles,
  type SplineTarget,
} from './edits';
import { createHistory, type HistoryHost } from './history';

/** A selected control point, for the inspector / highlight. */
export interface Selection {
  target: SplineTarget;
  index: number;
  /** The endpoint or one of its two tangent handles. Omitted means the endpoint. */
  kind?: 'end' | 'prev' | 'next';
}

/** One undo/redo step: the board to restore plus the action that produced the change. */
export interface HistoryEntry {
  board: BezierBoard;
  label: string;
}

export interface BoardState {
  board: BezierBoard | null;
  /**
   * Counts `load` calls: it changes exactly when another document replaces this one (not on an edit,
   * an undo or a redo). Views that keep derived data of the board (the experimental NURBS surface) use
   * it to tell "the board was edited" from "another file was opened".
   */
  loadCount: number;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** True while a drag is in progress (edits coalesce into one undo step). */
  editing: boolean;
  /**
   * When true (default), cross-sections are slaved to the rocker/deck (thickness) and
   * outline (width) on every commit/load — editing a global curve resizes the sections in
   * that area. When false, sections keep their own thickness/width and a curve edit leaves
   * them alone (legacy `BoardCADSettings.getAdjustCrossectionThickness`, JC-4-y).
   */
  adjustThickness: boolean;
  selection: Selection | null;
  /** Index of the selected fin (for the fin inspector / highlight), or null. */
  selectedFin: number | null;

  load: (board: BezierBoard) => void;
  /** Toggle whether cross-sections are slaved to the rocker/deck/outline (JC-4-y). */
  setAdjustThickness: (v: boolean) => void;
  select: (selection: Selection | null) => void;
  /** Select a fin by index (clears any control-point selection). */
  selectFin: (index: number | null) => void;

  /**
   * Begin a grouped edit (call on drag start): every commit until `endEdit` lands in one
   * undo step, named for the latest of them. The first commit records the step, so a drag
   * that commits nothing (each move refused, as for a slice's centre point held by the
   * blank) leaves no step that undoes nothing, and keeps the redo stack. `label` is not
   * used: a step is named for the commits in it.
   */
  beginEdit: (label?: string) => void;
  /** End a grouped edit (call on drag end). */
  endEdit: () => void;

  moveSegmentTangents: (target: SplineTarget, index: number, first: Vec2, last: Vec2) => void;
  moveControlPoint: (target: SplineTarget, index: number, end: Vec2) => void;
  moveTangent: (target: SplineTarget, index: number, which: 'prev' | 'next', pos: Vec2) => void;
  /** Set one handle's length along its current (or locked) direction. */
  setTangentLength: (
    target: SplineTarget,
    index: number,
    which: 'prev' | 'next',
    length: number,
  ) => void;
  /**
   * Turn a handle, or both handles of a point (`'both'`), about the point by `radians`
   * (counter-clockwise positive), keeping their lengths. One undo step per call. No-op,
   * with no step, on a locked handle, and when the turn would cross a junction limit
   * (a profile curve folding back, an outline tip turning in past the centreline): the
   * junction pass would bend the handle back onto the limit and shorten it.
   */
  rotateTangent: (target: SplineTarget, index: number, which: KnotHandles, radians: number) => void;
  /**
   * Lengthen (positive) or shorten a handle, or both handles of a point, by `delta` cm
   * along their directions, never below zero. One undo step per call.
   */
  stepTangentLength: (
    target: SplineTarget,
    index: number,
    which: KnotHandles,
    delta: number,
  ) => void;

  /** Insert a control point on the target spline nearest to `p`, then select it. */
  addControlPoint: (target: SplineTarget, p: Vec2) => void;
  /**
   * Delete an interior control point and clear the selection. No-op for endpoints, and for
   * a cross-section's apex, which holds the slice to the outline's width.
   */
  deleteControlPoint: (target: SplineTarget, index: number) => void;
  /** Toggle a control point between smooth (continuous) and corner. */
  setContinuous: (target: SplineTarget, index: number, continuous: boolean) => void;
  /**
   * Lock or unlock a control point's handle directions. A locked handle keeps its
   * direction through every edit; only its length changes. No-op (and no undo step)
   * when the point is already in that state or has no handle to lock.
   */
  setLocked: (target: SplineTarget, index: number, locked: boolean) => void;
  /** Rebuild a point's handles from the local neighbour chord. */
  fairControlPoint: (target: SplineTarget, index: number) => void;
  /** Collapse one tangent handle onto its control point. */
  zeroTangent: (target: SplineTarget, index: number, which: 'prev' | 'next') => void;
  /** Extend a collapsed tangent far enough to grab and drag. */
  extendTangent: (target: SplineTarget, index: number, which: 'prev' | 'next') => void;
  /** Rotate both tangent handles to horizontal, preserving their lengths. */
  alignTangentsHorizontal: (target: SplineTarget, index: number) => void;
  /** Rotate both tangent handles to vertical, preserving their lengths. */
  alignTangentsVertical: (target: SplineTarget, index: number) => void;

  /** Insert a shape-preserving cross-section at `position`; returns its new index (or -1). */
  addCrossSection: (position: number) => number;
  /** Remove a real cross-section by index (no-op for the nose/tail dummies). */
  deleteCrossSection: (index: number) => void;
  /** Move a real cross-section to a new longitudinal position. */
  moveCrossSection: (index: number, position: number) => void;
  /** Replace a cross-section's whole spline (e.g. paste a copied section shape). */
  pasteCrossSection: (index: number, spline: Spline, side?: 'minus') => void;
  /**
   * Restyle a cross-section's rail to a named preset (50/50, 60/40 tucked, …), keeping
   * the station's width and thickness. The result is an ordinary editable profile.
   */
  applyRailPreset: (index: number, preset: RailPresetId, side?: 'minus') => void;
  /** Scale the board by independent length / width / thickness factors. */
  scaleBoard: (fL: number, fW: number, fT: number) => void;
  /** Switch the cross-section interpolation model (control-point ↔ sLinear). */
  setInterpolationType: (type: InterpolationType) => void;

  /** Change the fin setup (single/twin/thruster/…), re-seeding default placement. */
  setFinSetup: (setup: FinSetup) => void;
  /** Change the fin system (FCS/Futures/glass-on). */
  setFinSystem: (system: FinSystem) => void;
  /** Toggle symmetric port/starboard pair editing. */
  setFinSymmetrical: (symmetrical: boolean) => void;
  /** Patch one fin's parametric spec (distance, inset, base, depth, toe, cant, …). */
  updateFin: (index: number, patch: Partial<FinSpec>) => void;
  /** Re-place a fin from a dropped plan point (2D drag); keeps the fin's side. */
  moveFin: (index: number, point: Vec2) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Jump straight back to `past[index]`, moving the jumped-over steps onto the redo stack. */
  jumpTo: (index: number) => void;
}

/**
 * What survives of the selection when history replaces `from` with `to`.
 *
 * A selection is an index into a spline, so it is kept only if that spline still
 * exists and has the same number of knots — then the index still names the same
 * point (undoing a drag keeps the dragged point selected). Otherwise it is cleared:
 * an index into a removed station would crash the inspector, and one into a spline
 * that gained or lost knots would silently point at a different knot.
 */
export const selectionAfterHistory = (
  from: BezierBoard,
  to: BezierBoard,
  selection: Selection | null,
  selectedFin: number | null,
): { selection: Selection | null; selectedFin: number | null } => {
  const knotCount = (b: BezierBoard, t: SplineTarget): number | null =>
    findTargetSpline(b, t)?.knots.length ?? null;
  const keep =
    selection !== null &&
    knotCount(to, selection.target) !== null &&
    knotCount(to, selection.target) === knotCount(from, selection.target);
  return {
    selection: keep ? selection : null,
    selectedFin: selectedFin !== null && selectedFin < to.fins.fins.length ? selectedFin : null,
  };
};

const classicHistoryHost: HistoryHost<BoardState, HistoryEntry> = {
  snapshot: (s, label) => (s.board ? { board: s.board, label } : null),
  restore: (s, entry) => ({
    ...selectionAfterHistory(s.board!, entry.board, s.selection, s.selectedFin),
    board: entry.board,
  }),
};

export const createBoardStore = (): StoreApi<BoardState> =>
  createStore<BoardState>((set, get) => {
    const history = createHistory<BoardState, HistoryEntry>(get, set, classicHistoryHost);

    /** Apply an edited board, recording a labelled history step unless mid-drag. */
    const commit = (next: BezierBoard, label: string) => {
      const { board, adjustThickness } = get();
      if (!board) return;
      // Slave the stored cross-sections to the rocker/deck (thickness) and outline
      // (width) at their stations, so editing a global curve resizes the sections in
      // that area (legacy adjustCrosssectionsToThicknessAndWidth on every change). When
      // `adjustThickness` is off (legacy JC-4-y), the sections keep their own profile.
      const settled = adjustThickness ? adjustCrossSectionsToThicknessAndWidth(next) : next;
      history.commit({ board: settled }, label);
    };

    const ctx = { get, set, commit };

    return {
      board: null,
      loadCount: 0,
      past: [],
      future: [],
      editing: false,
      adjustThickness: true,
      selection: null,
      selectedFin: null,

      load: (board) => {
        const pinned = enforceJunctions(board);
        set({
          board: get().adjustThickness ? adjustCrossSectionsToThicknessAndWidth(pinned) : pinned,
          loadCount: get().loadCount + 1,
          past: [],
          future: [],
          editing: false,
          selection: null,
          selectedFin: null,
        });
      },
      setAdjustThickness: (v) => set({ adjustThickness: v }),
      select: (selection) => set({ selection, selectedFin: null }),
      selectFin: (index) => set({ selectedFin: index, selection: null }),

      beginEdit: history.beginEdit,
      endEdit: history.endEdit,

      ...createSplineActions(ctx),
      ...createFinActions(ctx),

      addCrossSection: (position) => {
        const { board } = get();
        if (!board) return -1;
        const result = insertCrossSection(board, position);
        if (!result) return -1;
        commit(enforceJunctions(result.board), 'Add cross-section');
        return result.index;
      },

      deleteCrossSection: (index) => {
        const { board } = get();
        if (!board) return;
        const next = removeCrossSection(board, index);
        if (next === board) return;
        commit(enforceJunctions(next), 'Delete cross-section');
        set({ selection: null });
      },

      moveCrossSection: (index, position) => {
        const { board } = get();
        if (!board) return;
        const next = moveCrossSectionPosition(board, index, position);
        if (next === board) return;
        commit(next, 'Move cross-section');
      },

      ...createSectionShapeActions(ctx),

      setInterpolationType: (type) => {
        const { board } = get();
        if (!board || board.interpolationType === type) return;
        commit(withInterpolationType(board, type), 'Change interpolation');
      },

      undo: history.undo,
      redo: history.redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      jumpTo: history.jumpTo,
    };
  });
