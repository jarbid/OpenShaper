import type { BezierBoard, RailPresetId, Vec2 } from '@openshaper/kernel';
import {
  adjustCrossSectionsToThicknessAndWidth,
  applyRailProfile,
  railPresetById,
} from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FinSetup, FinSpec, FinSystem, InterpolationType, Spline } from '@openshaper/kernel';
import {
  alignTangentsHorizontal,
  alignTangentsVertical,
  canDeleteKnot,
  deleteKnot,
  enforceJunctions,
  extendKnotTangent,
  fairKnot,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  moveCrossSectionPosition,
  propagateCrossSectionToCurves,
  removeCrossSection,
  scaleBoard,
  sameTarget,
  setFinFromPlanPoint,
  setFinSetup,
  setFinSymmetrical,
  setFinSystem,
  setKnotContinuous,
  zeroKnotTangent,
  updateFinSpec,
  withInterpolationType,
  withSpline,
  type SplineTarget,
} from './edits';

/** A selected control point, for the inspector / highlight. */
export interface Selection {
  target: SplineTarget;
  index: number;
  /** The endpoint or one of its two tangent handles. Omitted means the endpoint. */
  kind?: 'end' | 'prev' | 'next';
}

export interface AngleLock {
  target: SplineTarget;
  index: number;
}

const hasAngleLock = (locks: readonly AngleLock[], target: SplineTarget, index: number): boolean =>
  locks.some((lock) => lock.index === index && sameTarget(lock.target, target));

/** One undo/redo step: the board to restore plus the action that produced the change. */
export interface HistoryEntry {
  board: BezierBoard;
  label: string;
}

export interface BoardState {
  board: BezierBoard | null;
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
  /** Control points whose tangent directions are fixed while handle lengths remain editable. */
  angleLocks: readonly AngleLock[];
  /** Index of the selected fin (for the fin inspector / highlight), or null. */
  selectedFin: number | null;

  load: (board: BezierBoard) => void;
  /** Toggle whether cross-sections are slaved to the rocker/deck/outline (JC-4-y). */
  setAdjustThickness: (v: boolean) => void;
  select: (selection: Selection | null) => void;
  setAngleLocked: (target: SplineTarget, index: number, locked: boolean) => void;
  /** Select a fin by index (clears any control-point selection). */
  selectFin: (index: number | null) => void;

  /** Begin a grouped edit (call on drag start). The first commit labels the step. */
  beginEdit: (label?: string) => void;
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
  pasteCrossSection: (index: number, spline: Spline) => void;
  /**
   * Restyle a cross-section's rail to a named preset (50/50, 60/40 tucked, …), keeping
   * the station's width and thickness. The result is an ordinary editable profile.
   */
  applyRailPreset: (index: number, preset: RailPresetId) => void;
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

const MAX_HISTORY = 200;

/**
 * What survives of the selection when history replaces `from` with `to`.
 *
 * A selection is an index into a spline, so it is kept only if that spline still
 * exists and has the same number of knots — then the index still names the same
 * point (undoing a drag keeps the dragged point selected). Otherwise it is cleared:
 * an index into a removed station would crash the inspector, and one into a spline
 * that gained or lost knots would silently point at a different knot.
 */
const selectionAfterHistory = (
  from: BezierBoard,
  to: BezierBoard,
  selection: Selection | null,
  selectedFin: number | null,
): { selection: Selection | null; selectedFin: number | null } => {
  const knotCount = (b: BezierBoard, t: SplineTarget): number | null =>
    t.kind === 'crossSection'
      ? (b.crossSections[t.index]?.spline.knots.length ?? null)
      : getTargetSpline(b, t).knots.length;
  const keep =
    selection !== null &&
    knotCount(to, selection.target) !== null &&
    knotCount(to, selection.target) === knotCount(from, selection.target);
  return {
    selection: keep ? selection : null,
    selectedFin: selectedFin !== null && selectedFin < to.fins.fins.length ? selectedFin : null,
  };
};

export const createBoardStore = (): StoreApi<BoardState> =>
  createStore<BoardState>((set, get) => {
    /** Apply an edited board, recording a labelled history step unless mid-drag. */
    const commit = (next: BezierBoard, label: string) => {
      const { board, editing, past, adjustThickness } = get();
      if (!board) return;
      // Slave the stored cross-sections to the rocker/deck (thickness) and outline
      // (width) at their stations, so editing a global curve resizes the sections in
      // that area (legacy adjustCrosssectionsToThicknessAndWidth on every change). When
      // `adjustThickness` is off (legacy JC-4-y), the sections keep their own profile.
      const settled = adjustThickness ? adjustCrossSectionsToThicknessAndWidth(next) : next;
      if (editing) {
        // Snapshot already taken at beginEdit — give it this action's name.
        // Keep the same `past` array when the label is unchanged (every move of a
        // drag after the first), so history subscribers don't re-render per move.
        const last = past[past.length - 1];
        set({
          board: settled,
          past:
            last && last.label !== label
              ? [...past.slice(0, -1), { board: last.board, label }]
              : past,
        });
      } else {
        set({
          board: settled,
          past: [...past, { board, label }].slice(-MAX_HISTORY),
          future: [],
        });
      }
    };

    const editSpline = (
      target: SplineTarget,
      label: string,
      fn: (s: ReturnType<typeof getTargetSpline>) => BezierBoard,
    ) => {
      const { board } = get();
      if (!board) return;
      let edited = fn(getTargetSpline(board, target));
      // Two-way link: a cross-section centerline/width edit drives the rocker/deck/outline
      // at that station, so it isn't snapped back by the adjust pass inside commit().
      if (target.kind === 'crossSection') {
        edited = propagateCrossSectionToCurves(board, edited, target.index);
      }
      // Re-pin shared junctions after the edit so curves can't be pulled apart.
      commit(enforceJunctions(edited, target), label);
    };

    return {
      board: null,
      past: [],
      future: [],
      editing: false,
      adjustThickness: true,
      selection: null,
      angleLocks: [],
      selectedFin: null,

      load: (board) => {
        const pinned = enforceJunctions(board);
        set({
          board: get().adjustThickness ? adjustCrossSectionsToThicknessAndWidth(pinned) : pinned,
          past: [],
          future: [],
          editing: false,
          selection: null,
          angleLocks: [],
          selectedFin: null,
        });
      },
      setAdjustThickness: (v) => set({ adjustThickness: v }),
      select: (selection) => set({ selection, selectedFin: null }),
      setAngleLocked: (target, index, locked) => {
        const angleLocks = get().angleLocks;
        const alreadyLocked = hasAngleLock(angleLocks, target, index);
        if (locked === alreadyLocked) return;
        set({
          angleLocks: locked
            ? [...angleLocks, { target, index }]
            : angleLocks.filter(
                (entry) => !(entry.index === index && sameTarget(entry.target, target)),
              ),
        });
      },
      selectFin: (index) => set({ selectedFin: index, selection: null }),

      beginEdit: (label = 'Edit') => {
        const { board, past, editing } = get();
        if (!board || editing) return;
        set({ editing: true, past: [...past, { board, label }].slice(-MAX_HISTORY), future: [] });
      },
      endEdit: () => set({ editing: false }),

      moveControlPoint: (target, index, end) =>
        editSpline(target, 'Move control point', (s) =>
          withSpline(get().board!, target, moveKnotEnd(s, index, end)),
        ),

      moveTangent: (target, index, which, pos) =>
        editSpline(target, 'Move tangent', (s) =>
          withSpline(
            get().board!,
            target,
            moveKnotTangent(s, index, which, pos, hasAngleLock(get().angleLocks, target, index)),
          ),
        ),

      addControlPoint: (target, p) => {
        const { board } = get();
        if (!board) return;
        const result = insertKnotAt(getTargetSpline(board, target), p);
        if (!result) return;
        commit(
          enforceJunctions(withSpline(board, target, result.spline), target),
          'Add control point',
        );
        set({
          selection: { target, index: result.index, kind: 'end' },
          angleLocks: get().angleLocks.map((lock) =>
            sameTarget(lock.target, target) && lock.index >= result.index
              ? { ...lock, index: lock.index + 1 }
              : lock,
          ),
        });
      },

      deleteControlPoint: (target, index) => {
        const { board } = get();
        if (!board) return;
        const spline = getTargetSpline(board, target);
        if (!canDeleteKnot(spline, index)) return;
        // Delete pressed mid-drag: close the drag's step first, so the deletion is its
        // own undo step rather than relabelling the drag's (the editor then drops the
        // drag, whose knot index no longer means the same point).
        if (get().editing) set({ editing: false });
        commit(
          enforceJunctions(withSpline(board, target, deleteKnot(spline, index)), target),
          'Delete control point',
        );
        set({
          selection: null,
          angleLocks: get()
            .angleLocks.filter((lock) => !(sameTarget(lock.target, target) && lock.index === index))
            .map((lock) =>
              sameTarget(lock.target, target) && lock.index > index
                ? { ...lock, index: lock.index - 1 }
                : lock,
            ),
        });
      },

      setContinuous: (target, index, continuous) =>
        editSpline(target, continuous ? 'Smooth control point' : 'Corner control point', (s) =>
          withSpline(get().board!, target, setKnotContinuous(s, index, continuous)),
        ),

      fairControlPoint: (target, index) =>
        editSpline(target, 'Fair curve', (s) =>
          withSpline(get().board!, target, fairKnot(s, index)),
        ),

      zeroTangent: (target, index, which) =>
        editSpline(target, 'Set handle length to zero', (s) =>
          withSpline(get().board!, target, zeroKnotTangent(s, index, which)),
        ),

      extendTangent: (target, index, which) =>
        editSpline(target, 'Extend handle', (s) =>
          withSpline(get().board!, target, extendKnotTangent(s, index, which)),
        ),

      alignTangentsHorizontal: (target, index) =>
        editSpline(target, 'Align tangents', (s) =>
          withSpline(get().board!, target, alignTangentsHorizontal(s, index)),
        ),

      alignTangentsVertical: (target, index) =>
        editSpline(target, 'Align tangents', (s) =>
          withSpline(get().board!, target, alignTangentsVertical(s, index)),
        ),

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

      pasteCrossSection: (index, spline) => {
        const { board } = get();
        if (!board) return;
        const target: SplineTarget = { kind: 'crossSection', index };
        commit(enforceJunctions(withSpline(board, target, spline), target), 'Paste cross-section');
      },

      applyRailPreset: (index, presetId) => {
        const { board } = get();
        if (!board) return;
        // The nose and tail dummies bookend the list and have no rail to shape.
        if (index <= 0 || index >= board.crossSections.length - 1) return;
        const cs = board.crossSections[index];
        const preset = railPresetById(presetId);
        if (!cs || !preset) return;
        const next = applyRailProfile(cs, preset.params);
        // Nothing to shape — a nose/tail dummy, or a collapsed station.
        if (next === cs) return;
        const target: SplineTarget = { kind: 'crossSection', index };
        commit(
          enforceJunctions(withSpline(board, target, next.spline), target),
          `Rail preset: ${preset.label}`,
        );
        // The profile is rebuilt from scratch, so any selected control point index is
        // now meaningless — and may not even exist on the new spline.
        set({ selection: null });
      },

      scaleBoard: (fL, fW, fT) => {
        const { board } = get();
        if (!board) return;
        if (fL === 1 && fW === 1 && fT === 1) return;
        commit(enforceJunctions(scaleBoard(board, fL, fW, fT)), 'Resize board');
      },

      setInterpolationType: (type) => {
        const { board } = get();
        if (!board || board.interpolationType === type) return;
        commit(withInterpolationType(board, type), 'Change interpolation');
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

      undo: () => {
        const { past, future, board, selection, selectedFin } = get();
        if (past.length === 0 || !board) return;
        const prev = past[past.length - 1]!;
        set({
          ...selectionAfterHistory(board, prev.board, selection, selectedFin),
          board: prev.board,
          past: past.slice(0, -1),
          // The redo entry re-applies the action we just undid, so it keeps its label.
          future: [{ board, label: prev.label }, ...future],
          editing: false,
        });
      },
      redo: () => {
        const { past, future, board, selection, selectedFin } = get();
        if (future.length === 0 || !board) return;
        const next = future[0]!;
        set({
          ...selectionAfterHistory(board, next.board, selection, selectedFin),
          board: next.board,
          past: [...past, { board, label: next.label }],
          future: future.slice(1),
          editing: false,
        });
      },
      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,

      jumpTo: (index) => {
        const { past, future, board, selection, selectedFin } = get();
        if (!board || index < 0 || index >= past.length) return;
        // Equivalent to (past.length - index) undos in one step: walk back from the
        // current board, pushing each undone step onto the redo stack.
        let cur = board;
        const undone: HistoryEntry[] = [];
        for (let i = past.length - 1; i >= index; i--) {
          undone.push({ board: cur, label: past[i]!.label });
          cur = past[i]!.board;
        }
        set({
          ...selectionAfterHistory(board, cur, selection, selectedFin),
          board: cur,
          past: past.slice(0, index),
          future: [...undone.reverse(), ...future],
          editing: false,
        });
      },
    };
  });
