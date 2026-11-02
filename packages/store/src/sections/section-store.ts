// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section store (docs/design/m2-editor.md §1): a second document behind the same interface.
 *
 * It holds a `BoardDoc` and implements {@link BoardState}, so the panes, the inspector, the locks, the
 * Tunni controls, R/T nudging, the apex line and the context menus, which all take a
 * `StoreApi<BoardState>`, edit a NURBS board unchanged. Its `board` is the memoised classic projection
 * of the document (`project.ts`).
 *
 * Every spline edit is the classic one (`board-actions.ts`, shared with the classic store): project,
 * apply the same kernel edit and junction rules, then write back only the curves that changed
 * (`applyBoardEdit`) and commit the new document on the shared history (`history.ts`).
 *
 * **Step 1 scope.** The outline, rocker and deck are editable. Sections are read-only: an edit aimed at
 * a cross-section, and the classic-only actions (station add, delete, move, paste, rail presets, the
 * interpolation type, the resize-cross-sections toggle), do nothing. The section editor is step 2.
 */
import type { BoardDoc } from '@openshaper/board2';
import type { BezierBoard } from '@openshaper/kernel';
import { splineFromKnots, vec2, withHandles } from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createFinActions, createSplineActions, type SplineActions } from '../board-actions';
import { selectionAfterHistory, type BoardState, type HistoryEntry } from '../board-store';
import { moveKnotEnd, type SplineTarget } from '../edits';
import { createHistory, type HistoryHost } from '../history';
import { applyBoardEdit } from './edits';
import { projectDoc } from './project';

/** An undo step of the section store: the classic projection, and the document that restores it. */
export interface SectionHistoryEntry extends HistoryEntry {
  doc: BoardDoc;
}

export interface SectionState extends BoardState {
  /** The document being edited (null until one is loaded). `board` is its projection. */
  doc: BoardDoc | null;
  past: SectionHistoryEntry[];
  future: SectionHistoryEntry[];
  /**
   * Replace the document (another file, a conversion). Clears the history and the selection and counts
   * as a load (`loadCount`), as `load` does for the classic store.
   */
  loadDoc: (doc: BoardDoc) => void;
}

const sectionHistoryHost: HistoryHost<SectionState, SectionHistoryEntry> = {
  snapshot: (s, label) => (s.doc && s.board ? { doc: s.doc, board: s.board, label } : null),
  restore: (s, entry) => ({
    ...selectionAfterHistory(s.board!, entry.board, s.selection, s.selectedFin),
    doc: entry.doc,
    board: entry.board,
  }),
};

/**
 * The plan rules the document adds to the classic junction pass: both halves of the plan lie on the
 * plus side (every control point has y >= 0, a handle too, which classic lets cross the stringer), and
 * a standard tail's outline starts at the tail tip (0, 0) (classic leaves the tail's y free for a squash
 * tail, and lets the tail tip move to another knot; the document makes a squash tail's edge an explicit
 * knot, as the converter does).
 */
const pinPlan = (b: BezierBoard, doc: BoardDoc): BezierBoard => {
  let outline = b.outline;
  const first = outline.knots[0];
  if (doc.tail.kind === 'standard' && first && (first.end.x !== 0 || first.end.y !== 0)) {
    outline = moveKnotEnd(outline, 0, vec2(0, 0));
  }
  if (outline.knots.some((k) => k.tangentToPrev.y < 0 || k.tangentToNext.y < 0)) {
    outline = splineFromKnots(
      outline.knots.map((k) =>
        k.tangentToPrev.y >= 0 && k.tangentToNext.y >= 0
          ? k
          : withHandles(
              k,
              k.tangentToPrev.y < 0 ? vec2(k.tangentToPrev.x, 0) : k.tangentToPrev,
              k.tangentToNext.y < 0 ? vec2(k.tangentToNext.x, 0) : k.tangentToNext,
            ),
      ),
    );
  }
  return outline === b.outline ? b : { ...b, outline };
};

/** A spline action that does nothing on a cross-section (read-only in step 1). */
const lines =
  <A extends unknown[]>(fn: (target: SplineTarget, ...rest: A) => void) =>
  (target: SplineTarget, ...rest: A): void => {
    if (target.kind === 'crossSection') return;
    fn(target, ...rest);
  };

export const createSectionStore = (): StoreApi<SectionState> =>
  createStore<SectionState>((set, get) => {
    const history = createHistory<SectionState, SectionHistoryEntry>(get, set, sectionHistoryHost);

    /** Write the edited board's changed curves into the document and record the step. */
    const commit = (next: BezierBoard, label: string) => {
      const { doc, board } = get();
      if (!doc || !board) return;
      const nextDoc = applyBoardEdit(doc, board, pinPlan(next, doc));
      // Nothing the document holds changed (the junction rules took the edit back): no empty step.
      if (nextDoc === doc) return;
      history.commit({ doc: nextDoc, board: projectDoc(nextDoc) }, label);
    };

    const ctx = {
      get: (): BoardState => get(),
      set: (patch: Partial<BoardState>) => set(patch as Partial<SectionState>),
      commit,
    };
    const spline: SplineActions = createSplineActions(ctx);

    return {
      doc: null,
      board: null,
      loadCount: 0,
      past: [],
      future: [],
      editing: false,
      adjustThickness: true,
      selection: null,
      selectedFin: null,

      loadDoc: (doc) =>
        set({
          doc,
          board: projectDoc(doc),
          loadCount: get().loadCount + 1,
          past: [],
          future: [],
          editing: false,
          selection: null,
          selectedFin: null,
        }),
      // A classic board is converted to a document by the app (the converter lives in the NURBS
      // chunk); this store never takes one.
      load: () => {},
      setAdjustThickness: () => {},
      select: (selection) => set({ selection, selectedFin: null }),
      selectFin: (index) => set({ selectedFin: index, selection: null }),

      beginEdit: history.beginEdit,
      endEdit: history.endEdit,

      moveSegmentTangents: lines(spline.moveSegmentTangents),
      moveControlPoint: lines(spline.moveControlPoint),
      moveTangent: lines(spline.moveTangent),
      setTangentLength: lines(spline.setTangentLength),
      rotateTangent: lines(spline.rotateTangent),
      stepTangentLength: lines(spline.stepTangentLength),
      addControlPoint: lines(spline.addControlPoint),
      deleteControlPoint: lines(spline.deleteControlPoint),
      setContinuous: lines(spline.setContinuous),
      setLocked: lines(spline.setLocked),
      fairControlPoint: lines(spline.fairControlPoint),
      zeroTangent: lines(spline.zeroTangent),
      extendTangent: lines(spline.extendTangent),
      alignTangentsHorizontal: lines(spline.alignTangentsHorizontal),
      alignTangentsVertical: lines(spline.alignTangentsVertical),

      ...createFinActions(ctx),

      // Sections are read-only in step 1.
      addCrossSection: () => -1,
      deleteCrossSection: () => {},
      moveCrossSection: () => {},
      pasteCrossSection: () => {},
      applyRailPreset: () => {},
      setInterpolationType: () => {},

      undo: history.undo,
      redo: history.redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      jumpTo: history.jumpTo,
    };
  });
