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
  capSectionHandleLengths,
  constrainSectionToBlank,
  deleteKnot,
  enforceJunctions,
  extendKnotTangent,
  fairKnot,
  fitSectionToBlank,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  moveSegmentTangents,
  moveCrossSectionPosition,
  removeCrossSection,
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
  zeroKnotTangent,
  updateFinSpec,
  withInterpolationType,
  withSpline,
  type KnotHandles,
  type SplineTarget,
} from './edits';

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

/** Whether two handle positions agree to well below anything an edit could mean (cm). */
const samePoint = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9;

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
    /** Whether the open grouped edit (`beginEdit`) has yet to record its undo step. */
    let stepPending = false;

    /** Apply an edited board, recording a labelled history step unless mid-drag. */
    const commit = (next: BezierBoard, label: string) => {
      const { board, editing, past, adjustThickness } = get();
      if (!board) return;
      // Slave the stored cross-sections to the rocker/deck (thickness) and outline
      // (width) at their stations, so editing a global curve resizes the sections in
      // that area (legacy adjustCrosssectionsToThicknessAndWidth on every change). When
      // `adjustThickness` is off (legacy JC-4-y), the sections keep their own profile.
      const settled = adjustThickness ? adjustCrossSectionsToThicknessAndWidth(next) : next;
      if (editing && !stepPending) {
        // The drag's step is already recorded — give it this action's name.
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
        // A new step: a single edit, or the first commit of a drag.
        stepPending = false;
        set({
          board: settled,
          past: [...past, { board, label }].slice(-MAX_HISTORY),
          future: [],
        });
      }
    };

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
      board: null,
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

      beginEdit: () => {
        const { board, editing } = get();
        if (!board || editing) return;
        stepPending = true;
        set({ editing: true });
      },
      endEdit: () => set({ editing: false }),

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
        // The shape is pasted; the station keeps its own blank, as for any slice edit.
        const fitted = fitSectionToBlank(getTargetSpline(board, target), spline);
        commit(enforceJunctions(withSpline(board, target, fitted), target), 'Paste cross-section');
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
