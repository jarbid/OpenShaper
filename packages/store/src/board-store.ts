import type { BezierBoard, RailPresetId, RefPoints, Vec2 } from '@openshaper/kernel';
import {
  adjustCrossSectionsToThicknessAndWidth,
  applyRailProfile,
  railPresetById,
} from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FinSetup, FinSpec, FinSystem, InterpolationType, Spline } from '@openshaper/kernel';
import {
  addRefPoint,
  addRefPoints,
  alignTangentsHorizontal,
  alignTangentsVertical,
  canDeleteKnot,
  deleteKnot,
  deleteRefPoint,
  enforceJunctions,
  extendKnotTangent,
  fairKnot,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  moveSegmentTangents,
  moveCrossSectionPosition,
  propagateCrossSectionToCurves,
  removeCrossSection,
  scaleBoard,
  setFinFromPlanPoint,
  setFinSetup,
  setFinSymmetrical,
  setFinSystem,
  setKnotContinuous,
  setKnotLock,
  setKnotTangentLength,
  zeroKnotTangent,
  updateFinSpec,
  updateRefPoint,
  withInterpolationType,
  withSpline,
  type RefPointDraft,
  type SplineTarget,
} from './edits';

/** A selected control point, for the inspector / highlight. */
export interface Selection {
  target: SplineTarget;
  index: number;
  /** The endpoint or one of its two tangent handles. Omitted means the endpoint. */
  kind?: 'end' | 'prev' | 'next';
}

/**
 * One undo/redo step: the board and reference points to restore, plus the action that
 * produced the change. Both live on one timeline, so undo walks back shape edits and
 * reference-point edits in the order they were made.
 */
export interface HistoryEntry {
  board: BezierBoard;
  refPoints: RefPoints;
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
  /** Index of the selected fin (for the fin inspector / highlight), or null. */
  selectedFin: number | null;
  /**
   * Measurements beside the board (`kernel/src/reference-points.ts`). Kept out of
   * `board`, so geometry, specs and meshing never see them, but undone with it.
   */
  refPoints: RefPoints;
  /** Id of the selected reference point, or null. Exclusive with `selection`/`selectedFin`. */
  selectedRef: string | null;

  /** Replace the document. Reference points travel with the board's file. */
  load: (board: BezierBoard, refPoints?: RefPoints) => void;
  /** Toggle whether cross-sections are slaved to the rocker/deck/outline (JC-4-y). */
  setAdjustThickness: (v: boolean) => void;
  select: (selection: Selection | null) => void;
  /** Select a fin by index (clears any control-point selection). */
  selectFin: (index: number | null) => void;
  /** Select a reference point by id (clears the control-point and fin selection). */
  selectRef: (id: string | null) => void;

  /** Add a reference point and select it; returns its id ('' when there is no board). */
  addRefPoint: (draft: RefPointDraft) => string;
  /** Add several reference points as one undo step (a paste, generated stations). */
  addRefPoints: (drafts: readonly RefPointDraft[], label: string) => string[];
  /** Edit a reference point's coordinates and/or label (empty label clears it). */
  updateRefPoint: (id: string, patch: { x?: number; y?: number; label?: string }) => void;
  /** Drag a reference point (coalesces inside a `beginEdit` … `endEdit` group). */
  moveRefPoint: (id: string, at: Vec2) => void;
  deleteRefPoint: (id: string) => void;

  /** Begin a grouped edit (call on drag start). The first commit labels the step. */
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

  /** Insert a control point on the target spline nearest to `p`, then select it. */
  addControlPoint: (target: SplineTarget, p: Vec2) => void;
  /** Delete an interior control point and clear the selection. No-op for endpoints. */
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
  toRefs: RefPoints,
  {
    selection,
    selectedFin,
    selectedRef,
  }: Pick<BoardState, 'selection' | 'selectedFin' | 'selectedRef'>,
): Pick<BoardState, 'selection' | 'selectedFin' | 'selectedRef'> => {
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
    // An id names the same point in every snapshot, so it survives whenever it exists.
    selectedRef:
      selectedRef !== null && toRefs.some((p) => p.id === selectedRef) ? selectedRef : null,
  };
};

export const createBoardStore = (): StoreApi<BoardState> =>
  createStore<BoardState>((set, get) => {
    /** Apply an edited document, recording a labelled history step unless mid-drag. */
    const record = (nextBoard: BezierBoard, nextRefs: RefPoints, label: string) => {
      const { board, refPoints, editing, past } = get();
      if (!board) return;
      if (editing) {
        // Snapshot already taken at beginEdit — give it this action's name.
        // Keep the same `past` array when the label is unchanged (every move of a
        // drag after the first), so history subscribers don't re-render per move.
        const last = past[past.length - 1];
        set({
          board: nextBoard,
          refPoints: nextRefs,
          past: last && last.label !== label ? [...past.slice(0, -1), { ...last, label }] : past,
        });
      } else {
        set({
          board: nextBoard,
          refPoints: nextRefs,
          past: [...past, { board, refPoints, label }].slice(-MAX_HISTORY),
          future: [],
        });
      }
    };

    /** Apply an edited board (reference points unchanged). */
    const commit = (next: BezierBoard, label: string) => {
      const { adjustThickness, refPoints } = get();
      // Slave the stored cross-sections to the rocker/deck (thickness) and outline
      // (width) at their stations, so editing a global curve resizes the sections in
      // that area (legacy adjustCrosssectionsToThicknessAndWidth on every change). When
      // `adjustThickness` is off (legacy JC-4-y), the sections keep their own profile.
      const settled = adjustThickness ? adjustCrossSectionsToThicknessAndWidth(next) : next;
      record(settled, refPoints, label);
    };

    /** Apply edited reference points (board unchanged); no step when nothing changed. */
    const commitRefs = (next: RefPoints, label: string) => {
      const { board, refPoints } = get();
      if (!board || next === refPoints) return;
      record(board, next, label);
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
      selectedFin: null,
      refPoints: [],
      selectedRef: null,

      load: (board, refPoints = []) => {
        const pinned = enforceJunctions(board);
        set({
          board: get().adjustThickness ? adjustCrossSectionsToThicknessAndWidth(pinned) : pinned,
          refPoints,
          past: [],
          future: [],
          editing: false,
          selection: null,
          selectedFin: null,
          selectedRef: null,
        });
      },
      setAdjustThickness: (v) => set({ adjustThickness: v }),
      select: (selection) => set({ selection, selectedFin: null, selectedRef: null }),
      selectFin: (index) => set({ selectedFin: index, selection: null, selectedRef: null }),
      selectRef: (id) => set({ selectedRef: id, selection: null, selectedFin: null }),

      addRefPoint: (draft) => {
        if (!get().board) return '';
        const { points, id } = addRefPoint(get().refPoints, draft);
        commitRefs(points, 'Add reference point');
        set({ selectedRef: id, selection: null, selectedFin: null });
        return id;
      },
      addRefPoints: (drafts, label) => {
        if (!get().board || drafts.length === 0) return [];
        const { points, ids } = addRefPoints(get().refPoints, drafts);
        commitRefs(points, label);
        return ids;
      },
      updateRefPoint: (id, patch) =>
        commitRefs(
          updateRefPoint(get().refPoints, id, patch),
          patch.label !== undefined && patch.x === undefined && patch.y === undefined
            ? 'Rename reference point'
            : 'Edit reference point',
        ),
      moveRefPoint: (id, at) =>
        commitRefs(updateRefPoint(get().refPoints, id, at), 'Move reference point'),
      deleteRefPoint: (id) => {
        const next = deleteRefPoint(get().refPoints, id);
        if (next === get().refPoints) return;
        // Delete pressed mid-drag: close the drag's step first (as deleteControlPoint does).
        if (get().editing) set({ editing: false });
        commitRefs(next, 'Delete reference point');
        if (get().selectedRef === id) set({ selectedRef: null });
      },

      beginEdit: (label = 'Edit') => {
        const { board, refPoints, past, editing } = get();
        if (!board || editing) return;
        set({
          editing: true,
          past: [...past, { board, refPoints, label }].slice(-MAX_HISTORY),
          future: [],
        });
      },
      endEdit: () => set({ editing: false }),

      moveControlPoint: (target, index, end) =>
        editSpline(target, 'Move control point', (s) =>
          withSpline(get().board!, target, moveKnotEnd(s, index, end)),
        ),

      moveTangent: (target, index, which, pos) =>
        editSpline(target, 'Move tangent', (s) =>
          withSpline(get().board!, target, moveKnotTangent(s, index, which, pos)),
        ),

      setTangentLength: (target, index, which, length) => {
        const { board } = get();
        if (!board) return;
        const spline = getTargetSpline(board, target);
        const next = setKnotTangentLength(spline, index, which, length);
        // A collapsed free handle has no direction to lengthen along: no step to record.
        if (next === spline) return;
        editSpline(target, 'Set handle length', () => withSpline(board, target, next));
      },
      moveSegmentTangents: (target, index, first, last) => {
        const { board } = get();
        if (!board) return;
        const spline = getTargetSpline(board, target);
        const next = moveSegmentTangents(spline, index, first, last);
        if (next === spline) return;
        editSpline(target, 'Adjust Tunni handles', () => withSpline(board, target, next));
      },

      addControlPoint: (target, p) => {
        const { board } = get();
        if (!board) return;
        const result = insertKnotAt(getTargetSpline(board, target), p);
        if (!result) return;
        commit(
          enforceJunctions(withSpline(board, target, result.spline), target),
          'Add control point',
        );
        set({ selection: { target, index: result.index, kind: 'end' } });
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
        set({ selection: null });
      },

      setContinuous: (target, index, continuous) =>
        editSpline(target, continuous ? 'Smooth control point' : 'Corner control point', (s) =>
          withSpline(get().board!, target, setKnotContinuous(s, index, continuous)),
        ),

      setLocked: (target, index, locked) => {
        const { board } = get();
        if (!board) return;
        const spline = getTargetSpline(board, target);
        const next = setKnotLock(spline, index, locked);
        // A click that changes nothing must not leave an empty undo step.
        if (next === spline) return;
        editSpline(target, locked ? 'Lock handle angles' : 'Unlock handle angles', () =>
          withSpline(board, target, next),
        );
      },

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
        const state = get();
        const { past, future, board, refPoints } = state;
        if (past.length === 0 || !board) return;
        const prev = past[past.length - 1]!;
        set({
          ...selectionAfterHistory(board, prev.board, prev.refPoints, state),
          board: prev.board,
          refPoints: prev.refPoints,
          past: past.slice(0, -1),
          // The redo entry re-applies the action we just undid, so it keeps its label.
          future: [{ board, refPoints, label: prev.label }, ...future],
          editing: false,
        });
      },
      redo: () => {
        const state = get();
        const { past, future, board, refPoints } = state;
        if (future.length === 0 || !board) return;
        const next = future[0]!;
        set({
          ...selectionAfterHistory(board, next.board, next.refPoints, state),
          board: next.board,
          refPoints: next.refPoints,
          past: [...past, { board, refPoints, label: next.label }],
          future: future.slice(1),
          editing: false,
        });
      },
      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,

      jumpTo: (index) => {
        const state = get();
        const { past, future, board } = state;
        if (!board || index < 0 || index >= past.length) return;
        // Equivalent to (past.length - index) undos in one step: walk back from the
        // current document, pushing each undone step onto the redo stack.
        let cur = board;
        let curRefs = state.refPoints;
        const undone: HistoryEntry[] = [];
        for (let i = past.length - 1; i >= index; i--) {
          undone.push({ board: cur, refPoints: curRefs, label: past[i]!.label });
          cur = past[i]!.board;
          curRefs = past[i]!.refPoints;
        }
        set({
          ...selectionAfterHistory(board, cur, curRefs, state),
          board: cur,
          refPoints: curRefs,
          past: past.slice(0, index),
          future: [...undone.reverse(), ...future],
          editing: false,
        });
      },
    };
  });
