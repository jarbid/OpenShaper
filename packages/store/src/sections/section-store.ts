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
  type ActionContext,
  type SplineActionNames,
  type SplineActions,
} from '../board-actions';
import { selectionAfterHistory, type BoardState, type HistoryEntry } from '../board-store';
import { minusHalf, moveKnotEnd, type SplineTarget } from '../edits';
import { createHistory, type HistoryHost } from '../history';
import {
  addStation,
  alignEnds,
  applyBoardEdit,
  applyMinusEdit,
  moveStation,
  removeStation,
  scalePlan,
} from './edits';
import { projectDoc, type NotchChords } from './project';
import { setNotchDepth, setSymmetry, setTail, type KeepSide, type TailType } from './shape';

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
  /**
   * Make the board asymmetric (the minus half starts as the plus half, sharing every object) or mirror
   * symmetric again, keeping the half `keep` names (default plus). One undo step.
   */
  setSymmetry: (symmetry: BoardDoc['symmetry'], keep?: KeepSide) => void;
  /**
   * Change the tail type, optionally with a notch depth `d` (cm). A notched tail needs the app's chord
   * provider ({@link SectionState.setNotchChords}) loaded first. One undo step.
   */
  setTail: (type: TailType, d?: number) => void;
  /** Move the notch bottom to depth `d` (cm) of a swallow or fish tail. One undo step per drag. */
  setNotchDepth: (d: number) => void;
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

const SPLINE_ACTIONS: readonly SplineActionNames[] = [
  'moveSegmentTangents',
  'moveControlPoint',
  'moveTangent',
  'setTangentLength',
  'rotateTangent',
  'stepTangentLength',
  'addControlPoint',
  'deleteControlPoint',
  'setContinuous',
  'setLocked',
  'fairControlPoint',
  'zeroTangent',
  'extendTangent',
  'alignTangentsHorizontal',
  'alignTangentsVertical',
];

const isMinus = (t: SplineTarget): boolean =>
  (t.kind === 'outline' || t.kind === 'crossSection') && t.side === 'minus';

/** The target as the minus half's own board names it (no side). */
const plain = (t: SplineTarget): SplineTarget =>
  t.kind === 'outline'
    ? { kind: 'outline' }
    : t.kind === 'crossSection'
      ? { kind: 'crossSection', index: t.index }
      : t;

/** A target of the plus board as the section store names it on the minus half. */
const onMinus = (t: SplineTarget): SplineTarget =>
  t.kind === 'outline'
    ? { kind: 'outline', side: 'minus' }
    : t.kind === 'crossSection'
      ? { kind: 'crossSection', index: t.index, side: 'minus' }
      : t;

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

    /** The whole-board resize in progress: the minus outline scales with the plus one. */
    let resize: { readonly fL: number; readonly fW: number } | null = null;

    /** Write the edited board's changed curves and slices into the document and record the step. */
    const commit = (next: BezierBoard, label: string) => {
      const { doc, board } = get();
      if (!doc || !board) return;
      // Nothing the document holds changed (the junction rules took the edit back): no empty step.
      let nextDoc = applyBoardEdit(doc, board, pinPlan(next, doc));
      if (resize !== null && nextDoc !== doc && nextDoc.outline.minus !== undefined) {
        // the old minus outline scaled, not the one `applyBoardEdit` aligned to the unscaled-by-us plus
        const scaled = scalePlan(doc.outline.minus!, resize.fL, resize.fW);
        const minus = alignEnds(scaled, nextDoc.outline.plus);
        nextDoc = { ...nextDoc, outline: { ...nextDoc.outline, minus } };
      }
      commitDoc(nextDoc, label);
    };

    /** The same, for an edit of the minus half (`board.minus` edited into `next`). */
    const commitMinus = (next: BezierBoard, label: string) => {
      const { doc, board } = get();
      const half = board && minusHalf(board);
      if (!doc || !half) return;
      commitDoc(applyMinusEdit(doc, half, pinPlan(next, doc)), label);
    };

    const ctx: ActionContext = {
      get: (): BoardState => get(),
      set: (patch: Partial<BoardState>) => set(patch as Partial<SectionState>),
      commit,
    };
    // The minus half is edited by the same actions on its own board (the rocker, deck and fins are shared
    // objects), with the minus target named without its side and a selection it makes named with it.
    const minusCtx: ActionContext = {
      get: (): BoardState => {
        const s = get();
        return { ...s, board: (s.board && minusHalf(s.board)) ?? null };
      },
      set: (patch) =>
        set(
          (patch.selection
            ? {
                ...patch,
                selection: { ...patch.selection, target: onMinus(patch.selection.target) },
              }
            : patch) as Partial<SectionState>,
        ),
      commit: commitMinus,
    };
    const plusActions: SplineActions = createSplineActions(ctx);
    const minusActions: SplineActions = createSplineActions(minusCtx);
    const spline = Object.fromEntries(
      SPLINE_ACTIONS.map((name) => [
        name,
        (target: SplineTarget, ...rest: unknown[]) => {
          const fn = (isMinus(target) ? minusActions : plusActions)[name] as (
            ...args: unknown[]
          ) => void;
          // the notch bottom is a depth, not a point: dragging it along the stringer sets the depth
          const { doc } = get();
          if (
            name === 'moveControlPoint' &&
            target.kind === 'outline' &&
            rest[0] === 0 &&
            doc?.tail.kind === 'notched'
          ) {
            commitDoc(setNotchDepth(doc, (rest[1] as { x: number }).x), 'Move notch depth');
            return;
          }
          fn(isMinus(target) ? plain(target) : target, ...rest);
        },
      ]),
    ) as unknown as SplineActions;
    const fins = createFinActions(ctx);
    const plusShape = createSectionShapeActions(ctx);
    const minusShape = createSectionShapeActions(minusCtx);

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

      ...fins,

      scaleBoard: (fL, fW, fT) => {
        resize = { fL, fW };
        try {
          fins.scaleBoard(fL, fW, fT);
        } finally {
          resize = null;
        }
      },

      setSymmetry: (symmetry, keep) => {
        const { doc, selection } = get();
        if (!doc) return;
        const next = setSymmetry(doc, symmetry, keep);
        if (next === doc) return;
        commitDoc(next, symmetry === 'asymmetric' ? 'Make asymmetric' : 'Make symmetric');
        if (selection && isMinus(selection.target)) set({ selection: null });
      },

      setTail: (type, d) => {
        const { doc } = get();
        if (!doc) return;
        const next = setTail(doc, type, d);
        if (next === doc) return;
        commitDoc(
          next,
          type === 'standard' ? 'Standard tail' : `${type === 'swallow' ? 'Swallow' : 'Fish'} tail`,
        );
        // the outline's knots are new ones: an index into the old outline means nothing now
        set({ selection: null });
      },

      setNotchDepth: (d) => {
        const { doc } = get();
        if (!doc) return;
        commitDoc(setNotchDepth(doc, d), 'Set notch depth');
      },

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

      // paste and the rail presets go to the half `side` names (the minus half of an asymmetric board)
      pasteCrossSection: (index, spline, side) =>
        (side === 'minus' ? minusShape : plusShape).pasteCrossSection(index, spline),
      applyRailPreset: (index, preset, side) =>
        (side === 'minus' ? minusShape : plusShape).applyRailPreset(index, preset),

      // Sections always follow the outline, rocker and deck (they are normalised): nothing to switch.
      setInterpolationType: () => {},

      undo: history.undo,
      redo: history.redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      jumpTo: history.jumpTo,
    };
  });
