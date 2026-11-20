// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails store: a `RailsBoard` behind the same interface as the classic and section stores.
 *
 * It implements {@link BoardState}, so every pane, inspector, lock, Tunni control and context menu
 * that takes a `StoreApi<BoardState>` edits a rails board unchanged. Its `board` is the memoised
 * classic projection of the document (`project.ts`), with each station's bottom and deck curves
 * besides (`stationCurves`), edited through the targets `stationBottom` and `stationDeck`.
 *
 * Every spline edit is the classic one (`board-actions.ts`): project, apply the kernel edit and
 * the junction rules (and, on a station curve, the half-curve rules of `half-curve.ts`), then
 * write back only what changed (`applyRailsEdit`) and commit the new document on the shared
 * history (`history.ts`). A classic slice (`crossSection`) is the engine's closed section, drawn
 * for reading only: its spline actions do nothing.
 *
 * **Slices.** The closed section at each station can only be computed by the engine, which this
 * package may not import; the app sends it (`setSlices`). Slices are derived data: not part of
 * undo, never written into the document, kept (stale by at most one engine build) while the
 * document is edited, and dropped for a station that leaves the document.
 *
 * **Edits computed elsewhere.** `commitDoc` records a document the app made (the engine, in a
 * worker) as one undo step, or as part of the open drag.
 *
 * **Rail zones.** The rail keys of each side are read as zones and blends and edited by the pure
 * functions of `zones.ts` (`setZoneRail`, `moveZoneEnd`, `splitZoneAt`, …), each one undo step. A
 * zone is named by its index on a side; an edit on `'both'` sides reaches the zone of that index on
 * each side that has one. The board's length is the outline's.
 */
import type { RailsBoard } from '@openshaper/board2';
import type { BezierBoard } from '@openshaper/kernel';
import { splineFromKnots, vec2, withHandles } from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  createFinActions,
  createSplineActions,
  type ActionContext,
  type SplineActionNames,
  type SplineActions,
} from '../board-actions';
import { selectionAfterHistory, type BoardState, type HistoryEntry } from '../board-store';
import { minusHalf, moveKnotEnd, type RailsProjection, type SplineTarget } from '../edits';
import { createHistory, type HistoryHost } from '../history';
import {
  addFeature,
  addFeatureKey,
  featureKindOf,
  featureLimits,
  refitFeatures,
  removeFeature,
  removeFeatureKey,
  setFeatureDepth,
  setFeatureEnabled,
  setFeatureKey,
  setFeatureParams,
  type ChordProvider,
  type FeatureKind,
  type FeatureParams,
} from '../sections/features';
import type { KeepSide, TailType } from '../sections/shape';
import {
  applyDeckShape,
  type DeckScope,
  type DeckShapeRequest,
  type DeckSide,
} from './deck-shapes';
import {
  applyRailsEdit,
  applyRailsMinusEdit,
  moveStation,
  removeStation,
  scaledMinus,
  scaleRailWidths,
} from './edits';
import { halfWidthFn, isNotched } from './measure';
import { insertStation } from './station-insert';
import { projectRails } from './project';
import { setNotchDepth, setSymmetry, setTail } from './shape';
import type { RailRecipe, RailsSlices } from './types';
import {
  TIDY_TOLERANCE,
  editSides,
  linkSides,
  moveZone,
  moveZoneEnd,
  removeZone,
  sameRailSides,
  setZoneNumber,
  setZoneRail,
  splitZoneAt,
  tidyRails,
  unlockSide,
} from './zones';
import type { RailNumber, RailSide } from './zones';

/** An undo step of the rails store: the classic projection, and the document that restores it. */
export interface RailsHistoryEntry extends HistoryEntry {
  doc: RailsBoard;
}

export interface RailsState extends BoardState {
  /** The document being edited (null until one is loaded). `board` is its projection. */
  doc: RailsBoard | null;
  /** The classic projection of `doc`, with its station curves. */
  board: RailsProjection | null;
  /** The engine's closed sections, by station id, as the app last sent them (null: none yet). */
  slices: RailsSlices | null;
  past: RailsHistoryEntry[];
  future: RailsHistoryEntry[];
  /**
   * Replace the document (another file, a conversion). Clears the history, the selection and the
   * slices, and counts as a load (`loadCount`).
   */
  loadDoc: (doc: RailsBoard) => void;
  /**
   * Record `next` as one undo step named `label`, for an edit computed elsewhere (by the engine,
   * in a worker). Inside `beginEdit` … `endEdit` it is part of that one step. Nothing is recorded
   * when `next` is the current document.
   */
  commitDoc: (next: RailsBoard, label: string) => void;
  /**
   * The engine's closed section at each station (`null` to drop them all). Not an undo step: the
   * projection's `crossSections` draw them, and a station without one is drawn from its curves.
   */
  setSlices: (slices: RailsSlices | null) => void;
  /**
   * Make the board asymmetric (the minus side starts as the plus side, sharing every object) or
   * mirror symmetric again, keeping the side `keep` names (default plus). One undo step.
   */
  setSymmetry: (symmetry: RailsBoard['symmetry'], keep?: KeepSide) => void;
  /** Change the tail type, optionally with a notch depth `d` (cm). One undo step. */
  setTail: (type: TailType, d?: number) => void;
  /** Move the notch bottom to depth `d` (cm) of a swallow or fish tail. One undo step per drag. */
  setNotchDepth: (d: number) => void;
  /**
   * Bottom features, as the section store edits them. Each is one undo step, and a drag of a
   * slider or field (`beginEdit` … `endEdit`) is one step in all. Values are held to `featureLimits`.
   */
  addFeature: (kind: FeatureKind) => void;
  /** The ranges a feature's fields are held to on this board (null for an unknown id). */
  featureLimits: (id: string) => ReturnType<typeof featureLimits> | null;
  removeFeature: (id: string) => void;
  setFeatureEnabled: (id: string, enabled: boolean) => void;
  setFeatureParams: (id: string, patch: FeatureParams) => void;
  setFeatureDepth: (id: string, depth: number) => void;
  /** One key of the depth curve: the first and last move along x only. */
  setFeatureKey: (id: string, index: number, patch: { s?: number; value?: number }) => void;
  addFeatureKey: (id: string, s?: number) => void;
  removeFeatureKey: (id: string, index: number) => void;
  /**
   * Rail zones (`zones.ts`). Every action is one undo step, part of the open drag inside `beginEdit`
   * … `endEdit`, and does nothing, recording no step, when it changes nothing. `side` is the plus
   * side, the minus side (which starts as a copy of the plus keys on a board that has no minus
   * keys), or both; `zone` is an index in `railZones` of that side, and with `'both'` on a board
   * whose sides differ it names the zone on each side that has one.
   *
   * **In a drag**, repeating an action on the same target (the same action, side, zone and end) is
   * computed from the document the drag began with, so an action is a function of the pointer: `x` is
   * a place on the board, and `dx` is how far the zone has slid since the drag began, not since the
   * last call. A different action or target inside the drag carries on from the document as it is.
   */
  setZoneRail: (side: RailSide, zone: number, rail: RailRecipe) => void;
  setZoneNumber: (side: RailSide, zone: number, name: RailNumber, value: number) => void;
  moveZoneEnd: (side: RailSide, zone: number, end: 'from' | 'to', x: number) => void;
  moveZone: (side: RailSide, zone: number, dx: number) => void;
  /** A zone added at `x`: with `rail`, the part of the zone after `x` (or the new zone) holds it. */
  splitZoneAt: (side: RailSide, x: number, rail?: RailRecipe) => void;
  removeZone: (side: RailSide, zone: number) => void;
  /** Join neighbouring keys within `tolerance` (`TIDY_TOLERANCE` by default; see `tidyRails`). */
  tidyRails: (side: RailSide, tolerance?: number) => void;
  /**
   * Apply a deck shape (`deck-shapes.ts`) to the deck curve of the stations in `scope`, on both
   * sides of the board or the one named. One undo step, and nothing recorded when it changes nothing.
   * In a drag (`beginEdit` … `endEdit`) every call is computed from the document the drag began with,
   * so a crown is a function of the pointer: a dial dragged past what the board can hold and back
   * follows it.
   */
  setDeckShape: (request: DeckShapeRequest, scope: DeckScope, side?: DeckSide) => void;
  /**
   * A station added at `x` whose curves follow both neighbours' even where they are made of different
   * numbers of knots (`station-insert.ts`); `addCrossSection` is the same station under the old
   * layout's name for it. Returns the new station's classic slice index, or -1 for an `x` that cannot
   * take one. One undo step.
   */
  insertStation: (x: number) => number;
  /** Give the minus side its own rail keys, starting as the plus keys. */
  unlockRailSide: () => void;
  /** Make the two sides one again, keeping the side `keep` names. */
  linkRailSides: (keep: 'plus' | 'minus') => void;
}

/** The half width a feature edit measures channels against: the engine's, with a notch filled in. */
const chords: ChordProvider<RailsBoard> = (doc, side) => halfWidthFn(doc.outline, side);

/**
 * The plan rules the document adds to the classic junction pass, as the section store's: every
 * outline control point has y >= 0 (classic lets a handle cross the stringer), and a standard
 * tail's outline starts at the tail tip (0, 0).
 */
const pinPlan = (b: BezierBoard, doc: RailsBoard): BezierBoard => {
  let outline = b.outline;
  const first = outline.knots[0];
  if (!isNotched(doc.outline) && first && (first.end.x !== 0 || first.end.y !== 0)) {
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

const FEATURE_LABELS: Record<FeatureKind, string> = {
  vee: 'Vee',
  'single-concave': 'Single concave',
  'double-concave': 'Double concave',
  channels: 'Channels',
};

const isMinus = (t: SplineTarget): boolean =>
  t.kind !== 'deck' && t.kind !== 'bottom' && t.side === 'minus';

/** The target as the minus half's own board names it (no side). */
const plain = (t: SplineTarget): SplineTarget => {
  if (t.kind === 'deck' || t.kind === 'bottom') return t;
  const { side: _side, ...rest } = t;
  return rest;
};

/** A target of the plus board as the store names it on the minus half. */
const onMinus = (t: SplineTarget): SplineTarget =>
  t.kind === 'deck' || t.kind === 'bottom' ? t : { ...t, side: 'minus' };

/** The slices of the stations `doc` still has: a station that leaves the document takes its slice with it. */
function pruneSlices(slices: RailsSlices | null, doc: RailsBoard): RailsSlices | null {
  if (slices === null) return null;
  const ids = new Set(doc.stations.map((s) => s.id));
  const keys = Object.keys(slices);
  if (keys.every((k) => ids.has(k))) return slices;
  return Object.fromEntries(keys.filter((k) => ids.has(k)).map((k) => [k, slices[k]!]));
}

/** The board's length (cm): where its outline ends, the tail being at 0. */
const lengthOf = (doc: RailsBoard): number =>
  doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];

/** Whether two documents differ in nothing but their rails: every other part is the same object. */
const onlyRailsDiffer = (a: RailsBoard, b: RailsBoard): boolean =>
  (Object.keys(b) as (keyof RailsBoard)[]).every((k) => k === 'rails' || a[k] === b[k]);

export const createRailsStore = (): StoreApi<RailsState> =>
  createStore<RailsState>((set, get) => {
    /** The state patch that shows `doc`: its projection with the slices of the stations it has. */
    const show = (doc: RailsBoard): Pick<RailsState, 'doc' | 'board' | 'slices'> => {
      const slices = pruneSlices(get().slices, doc);
      return { doc, board: projectRails(doc, slices), slices };
    };

    const history = createHistory<RailsState, RailsHistoryEntry>(get, set, {
      snapshot: (s, label) => (s.doc && s.board ? { doc: s.doc, board: s.board, label } : null),
      restore: (s, entry) => {
        const next = show(entry.doc);
        return {
          ...selectionAfterHistory(s.board!, next.board!, s.selection, s.selectedFin),
          ...next,
        };
      },
    } satisfies HistoryHost<RailsState, RailsHistoryEntry>);

    /** Record a new document as one labelled step (unless nothing changed). */
    const commitDoc = (nextDoc: RailsBoard, label: string) => {
      const { doc } = get();
      if (!doc || nextDoc === doc) return;
      history.commit(show(nextDoc), label);
    };

    /** A bottom-feature edit as one step named "<verb> <feature>" (the feature's kind, lower case). */
    const featureEdit = (id: string, edit: (doc: RailsBoard) => RailsBoard, verb: string) => {
      const { doc } = get();
      const f = doc?.features.find((q) => q.id === id);
      if (!doc || !f) return;
      commitDoc(edit(doc), `${verb} ${FEATURE_LABELS[featureKindOf(f)].toLowerCase()}`);
    };

    /**
     * The open drag of a rail edit: the document it began from, and what was being edited (the
     * action and its target). A rail edit of the same kind and target inside the drag is computed
     * from that document, so it is a function of the pointer alone: a dial that passes through a
     * neighbour's numbers cannot join two zones for good, and a slide that hits a limit and comes back
     * follows the pointer. Cleared when the drag ends, and replaced by an edit of another kind.
     */
    let railDrag: { readonly origin: RailsBoard; readonly key: string } | null = null;

    /**
     * A rail edit as one step named `label`. `edit` maps the document's rails (given the document and
     * the board's length) to the rails after; nothing is recorded when they are what is there.
     */
    const railEdit = (
      key: string,
      label: string,
      edit: (rails: RailsBoard['rails'], doc: RailsBoard, length: number) => RailsBoard['rails'],
    ) => {
      const { doc, editing } = get();
      if (!doc) return;
      if (!editing) railDrag = null;
      else if (
        railDrag === null ||
        railDrag.key !== key ||
        !onlyRailsDiffer(railDrag.origin, doc)
      ) {
        railDrag = { origin: doc, key };
      }
      const base = railDrag === null ? doc : railDrag.origin;
      const rails = edit(base.rails, base, lengthOf(base));
      const next = rails === base.rails ? base : { ...base, rails };
      if (next === doc || (base !== doc && sameRailSides(next.rails, doc.rails))) return;
      commitDoc(next, label);
    };

    /**
     * The document when the open drag began (`beginEdit`), cleared at `endEdit`. Edits that depend
     * on how far a handle has moved (the notch depth, the channel refit) are computed from it, so
     * they are pure functions of the pointer.
     */
    let dragOrigin: RailsBoard | null = null;

    /** An outline edit can leave channels wider than the half width: bring them inside it. */
    const refitChannels = (doc: RailsBoard, nextDoc: RailsBoard): RailsBoard => {
      if (nextDoc.outline === doc.outline) return nextDoc;
      const base = dragOrigin?.features ?? doc.features;
      if (!base.some((f) => f.enabled && featureKindOf(f) === 'channels')) return nextDoc;
      const features = refitFeatures({ ...nextDoc, features: base }, chords);
      return features === nextDoc.features ? nextDoc : { ...nextDoc, features };
    };

    /** The whole-board resize in progress: the minus outline and the rails scale with the board. */
    let resize: { readonly fL: number; readonly fW: number } | null = null;

    /** Write the edited board's changed curves into the document and record the step. */
    const commit = (next: BezierBoard, label: string) => {
      const { doc, board } = get();
      if (!doc || !board) return;
      let nextDoc = applyRailsEdit(doc, board, pinPlan(next, doc));
      if (resize !== null && nextDoc !== doc) {
        if (nextDoc.outline.minus !== undefined) {
          // the old minus outline scaled, not the one `applyRailsEdit` aligned to the new plus one
          const minus = scaledMinus(doc.outline.minus!, nextDoc.outline.plus, resize.fL, resize.fW);
          nextDoc = { ...nextDoc, outline: { ...nextDoc.outline, minus } };
        }
        nextDoc = scaleRailWidths(nextDoc, resize.fW);
      }
      commitDoc(refitChannels(doc, nextDoc), label);
    };

    /** The same, for an edit of the minus half (`board.minus` edited into `next`). */
    const commitMinus = (next: BezierBoard, label: string) => {
      const { doc, board } = get();
      const half = board && minusHalf(board);
      if (!doc || !half) return;
      commitDoc(refitChannels(doc, applyRailsMinusEdit(doc, half, pinPlan(next, doc))), label);
    };

    const ctx: ActionContext = {
      get: (): BoardState => get(),
      set: (patch: Partial<BoardState>) => set(patch as Partial<RailsState>),
      commit,
    };
    // The minus half is edited by the same actions on its own board (the rocker, deck and fins are
    // shared objects), with the minus target named without its side and a selection it makes named
    // with it.
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
            : patch) as Partial<RailsState>,
        ),
      commit: commitMinus,
    };
    const plusActions: SplineActions = createSplineActions(ctx);
    const minusActions: SplineActions = createSplineActions(minusCtx);
    const spline = Object.fromEntries(
      SPLINE_ACTIONS.map((name) => [
        name,
        (target: SplineTarget, ...rest: unknown[]) => {
          // the closed sections are the engine's: drawn, not edited
          if (target.kind === 'crossSection') return;
          const fn = (isMinus(target) ? minusActions : plusActions)[name] as (
            ...args: unknown[]
          ) => void;
          // the notch bottom is a depth, not a point: dragging it along the stringer sets the depth
          const { doc } = get();
          if (
            name === 'moveControlPoint' &&
            target.kind === 'outline' &&
            rest[0] === 0 &&
            doc !== null &&
            isNotched(doc.outline)
          ) {
            commitDoc(
              setNotchDepth(dragOrigin ?? doc, (rest[1] as { x: number }).x, chords),
              'Move notch depth',
            );
            return;
          }
          fn(isMinus(target) ? plain(target) : target, ...rest);
        },
      ]),
    ) as unknown as SplineActions;
    const fins = createFinActions(ctx);

    return {
      doc: null,
      slices: null,
      board: null,
      loadCount: 0,
      past: [],
      future: [],
      editing: false,
      adjustThickness: true,
      selection: null,
      selectedFin: null,

      loadDoc: (doc) => {
        dragOrigin = null;
        railDrag = null;
        set({
          doc,
          slices: null,
          board: projectRails(doc, null),
          loadCount: get().loadCount + 1,
          past: [],
          future: [],
          editing: false,
          selection: null,
          selectedFin: null,
        });
      },
      commitDoc,
      setSlices: (slices) => {
        const { doc } = get();
        if (!doc) {
          set({ slices });
          return;
        }
        const kept = pruneSlices(slices, doc);
        set({ slices: kept, board: projectRails(doc, kept) });
      },
      // A classic board is converted to a rails board by the app (the converter is engine code);
      // this store never takes one.
      load: () => {},
      setAdjustThickness: () => {},
      select: (selection) => set({ selection, selectedFin: null }),
      selectFin: (index) => set({ selectedFin: index, selection: null }),

      beginEdit: () => {
        if (!get().editing) {
          dragOrigin = get().doc;
          railDrag = null;
        }
        history.beginEdit();
      },
      endEdit: () => {
        dragOrigin = null;
        railDrag = null;
        history.endEdit();
      },

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
        const next = setTail(doc, type, d, chords);
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
        commitDoc(setNotchDepth(doc, d, chords), 'Set notch depth');
      },

      addFeature: (kind) => {
        const { doc } = get();
        if (!doc) return;
        commitDoc(addFeature(doc, kind, chords), `Add ${FEATURE_LABELS[kind]}`);
      },
      featureLimits: (id) => {
        const { doc } = get();
        const f = doc?.features.find((q) => q.id === id);
        return doc && f ? featureLimits(doc, f, chords) : null;
      },
      removeFeature: (id) => featureEdit(id, (d) => removeFeature(d, id), 'Remove'),
      setFeatureEnabled: (id, enabled) =>
        featureEdit(
          id,
          (d) => setFeatureEnabled(d, id, enabled, chords),
          enabled ? 'Enable' : 'Disable',
        ),
      setFeatureParams: (id, patch) =>
        featureEdit(id, (d) => setFeatureParams(d, id, patch, chords), 'Set'),
      setFeatureDepth: (id, depth) =>
        featureEdit(id, (d) => setFeatureDepth(d, id, depth), 'Set depth of'),
      setFeatureKey: (id, index, patch) =>
        featureEdit(id, (d) => setFeatureKey(d, id, index, patch, chords), 'Move a key of'),
      addFeatureKey: (id, s) => featureEdit(id, (d) => addFeatureKey(d, id, s), 'Add a key to'),
      removeFeatureKey: (id, index) =>
        featureEdit(id, (d) => removeFeatureKey(d, id, index), 'Remove a key from'),

      setZoneRail: (side, zone, rail) =>
        railEdit(`setZoneRail:${side}:${zone}`, 'Edit rail', (rails) =>
          editSides(rails, side, (keys) => setZoneRail(keys, zone, rail)),
        ),
      setZoneNumber: (side, zone, name, value) =>
        railEdit(`setZoneNumber:${side}:${zone}:${name}`, 'Edit rail', (rails) =>
          editSides(rails, side, (keys) => setZoneNumber(keys, zone, name, value)),
        ),
      moveZoneEnd: (side, zone, end, x) =>
        railEdit(`moveZoneEnd:${side}:${zone}:${end}`, 'Move rail zone', (rails, _doc, length) =>
          editSides(rails, side, (keys) => moveZoneEnd(keys, zone, end, x, length)),
        ),
      moveZone: (side, zone, dx) =>
        railEdit(`moveZone:${side}:${zone}`, 'Move rail zone', (rails, _doc, length) =>
          editSides(rails, side, (keys) => moveZone(keys, zone, dx, length)),
        ),
      splitZoneAt: (side, x, rail) =>
        railEdit(`splitZoneAt:${side}`, 'Add rail zone', (rails, _doc, length) =>
          editSides(rails, side, (keys) => splitZoneAt(keys, x, length, rail)),
        ),
      removeZone: (side, zone) =>
        railEdit(`removeZone:${side}:${zone}`, 'Remove rail zone', (rails) =>
          editSides(rails, side, (keys) => removeZone(keys, zone)),
        ),
      tidyRails: (side, tolerance = TIDY_TOLERANCE) =>
        railEdit(`tidyRails:${side}`, 'Tidy rails', (rails, _doc, length) =>
          editSides(rails, side, (keys) => tidyRails(keys, tolerance, length)),
        ),
      setDeckShape: (request, scope, side) => {
        const { doc, board } = get();
        if (!doc || !board) return;
        const next = applyDeckShape(dragOrigin ?? doc, request, scope, side);
        if (next === doc) return;
        commitDoc(
          next,
          request.shape === 'flat'
            ? 'Flat deck'
            : request.crown === undefined
              ? 'Domed deck'
              : 'Deck crown',
        );
        // a selected knot of a curve that now has other knots is no longer there
        const s = get();
        if (s.board) set(selectionAfterHistory(board, s.board, s.selection, s.selectedFin));
      },
      insertStation: (x) => {
        const { doc } = get();
        const result = doc && insertStation(doc, x);
        if (!result) return -1;
        commitDoc(result.doc, 'Add station');
        return result.index;
      },
      unlockRailSide: () => railEdit('unlockRailSide', 'Unlock rail sides', unlockSide),
      linkRailSides: (keep) =>
        railEdit('linkRailSides', 'Link rail sides', (rails, doc) =>
          linkSides(rails, keep, doc.symmetry === 'asymmetric'),
        ),

      addCrossSection: (position) => {
        const { doc } = get();
        if (!doc) return -1;
        const result = insertStation(doc, position);
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

      /**
       * Does nothing on a rails board: a station's closed section is the engine's, built from its
       * curves and its rail. Pasting a rail shape belongs to rail editing.
       */
      pasteCrossSection: () => {},
      /**
       * Does nothing on a rails board: a rail is set by its rail keys, which rail editing will
       * change; a classic rail preset reshapes a closed section, which this board does not store.
       */
      applyRailPreset: () => {},

      // Station curves always follow the outline, rocker and deck (they are normalised).
      setInterpolationType: () => {},

      undo: history.undo,
      redo: history.redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      jumpTo: history.jumpTo,
    };
  });
