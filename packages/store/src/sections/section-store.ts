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
 * **Sections.** A slice edit is the classic one too (`constrainSectionToBlank` holds the centre points, the
 * apex's width and the bound `u <= apex`); `applyBoardEdit` divides the changed slice by the half-width (chord)
 * and thickness it was projected with and replaces that one `Section`. Adding, removing and moving a station,
 * paste and the rail presets are the classic functions on the projection, normalised (`edits.ts`). The
 * classic-only actions (the interpolation type, the resize-cross-sections toggle) do nothing.
 *
 * **Notch-zone chord.** A station inside a notch zone is projected with the length of its chord across the
 * rail, which needs board2's frame. The app injects it ({@link SectionState.setNotchChords}) once board2's
 * code is loaded; without it the plan's outer rail is used.
 */
import type { BoardDoc } from '@openshaper/board2';
import type { BezierBoard } from '@openshaper/kernel';
import { splineFromKnots, vec2, withHandles } from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  createFinActions,
  createSectionShapeActions,
  createSplineActions,
  type SplineActions,
} from '../board-actions';
import { selectionAfterHistory, type BoardState, type HistoryEntry } from '../board-store';
import { moveKnotEnd } from '../edits';
import { createHistory, type HistoryHost } from '../history';
import { addStation, applyBoardEdit, moveStation, removeStation } from './edits';
import { projectDoc, type NotchChords } from './project';

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
  /**
   * Inject the notch-zone chord (board2's `createChordFn`, per document). Re-projects the open document;
   * not an undo step. Call it before `loadDoc` where possible, so no board is shown with the plan's rail.
   */
  setNotchChords: (chords: NotchChords | undefined) => void;
}

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

export const createSectionStore = (): StoreApi<SectionState> =>
  createStore<SectionState>((set, get) => {
    let chords: NotchChords | undefined;
    const project = (doc: BoardDoc): BezierBoard => projectDoc(doc, chords);

    const history = createHistory<SectionState, SectionHistoryEntry>(get, set, {
      snapshot: (s, label) => (s.doc && s.board ? { doc: s.doc, board: s.board, label } : null),
      restore: (s, entry) => {
        const board = project(entry.doc);
        return {
          ...selectionAfterHistory(s.board!, board, s.selection, s.selectedFin),
          doc: entry.doc,
          board,
        };
      },
    } satisfies HistoryHost<SectionState, SectionHistoryEntry>);

    /** Record a new document as one labelled step (unless nothing changed). */
    const commitDoc = (nextDoc: BoardDoc, label: string) => {
      const { doc } = get();
      if (!doc || nextDoc === doc) return;
      history.commit({ doc: nextDoc, board: project(nextDoc) }, label);
    };

    /** Write the edited board's changed curves and slices into the document and record the step. */
    const commit = (next: BezierBoard, label: string) => {
      const { doc, board } = get();
      if (!doc || !board) return;
      // Nothing the document holds changed (the junction rules took the edit back): no empty step.
      commitDoc(applyBoardEdit(doc, board, pinPlan(next, doc)), label);
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
          board: project(doc),
          loadCount: get().loadCount + 1,
          past: [],
          future: [],
          editing: false,
          selection: null,
          selectedFin: null,
        }),
      setNotchChords: (next) => {
        chords = next;
        const { doc } = get();
        if (doc) set({ board: project(doc) });
      },
      // A classic board is converted to a document by the app (the converter lives in the NURBS
      // chunk); this store never takes one.
      load: () => {},
      setAdjustThickness: () => {},
      select: (selection) => set({ selection, selectedFin: null }),
      selectFin: (index) => set({ selectedFin: index, selection: null }),

      beginEdit: history.beginEdit,
      endEdit: history.endEdit,

      ...spline,

      ...createFinActions(ctx),

      addCrossSection: (position) => {
        const { doc } = get();
        if (!doc) return -1;
        const result = addStation(doc, position, chords);
        if (!result) return -1;
        commitDoc(result.doc, 'Add cross-section');
        return result.index;
      },

      deleteCrossSection: (index) => {
        const { doc } = get();
        if (!doc) return;
        const next = removeStation(doc, index);
        if (next === doc) return;
        commitDoc(next, 'Delete cross-section');
        set({ selection: null });
      },

      moveCrossSection: (index, position) => {
        const { doc } = get();
        if (!doc) return;
        commitDoc(moveStation(doc, index, position), 'Move cross-section');
      },

      ...createSectionShapeActions(ctx),

      // Sections always follow the outline, rocker and deck (they are normalised): nothing to switch.
      setInterpolationType: () => {},

      undo: history.undo,
      redo: history.redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      jumpTo: history.jumpTo,
    };
  });
