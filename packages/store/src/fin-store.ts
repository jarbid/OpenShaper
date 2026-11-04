// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin designer's document store (docs/design/fin-designer.md, step 9): the fin
 * being edited, undo/redo, and the edits the UI calls. Shaped like `createBoardStore`
 * (board-store.ts): a vanilla Zustand store, edits as pure functions (fin-edits.ts),
 * every change through `commit(next, label)`, and a drag coalesced into one undo step
 * between `beginEdit` and `endEdit`.
 *
 * The fin's rules (`validateFinDesign`) are enforced here, as the edit happens: an
 * edit may not break a rule the design didn't already break. Drags of points and
 * handles are clamped (the point stops at the boundary, see `clampEdit`), numeric
 * fields are clamped to their range, and anything else that would break a rule is
 * refused, returning false. A design loaded with an issue can still be edited, as long
 * as the edit adds none.
 */
import {
  finReadouts,
  nudgeFore,
  nudgeLateral,
  placeOnBase,
  vec2,
  type FinBase,
  type FinDesign,
  type FinTwist,
  type FinHand,
  type Vec2,
} from '@openshaper/kernel';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  canDeleteKnot,
  deleteKnot,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  setKnotContinuous,
} from './edits';
import {
  addSlice,
  applyNaca,
  clampEdit,
  constrainKnot,
  edgesFree,
  withoutStackedPoints,
  withFoilsNearTrueScale,
  withCrossingPoints,
  getFinCurve,
  newFin,
  moveSlice,
  resetThicknessPath,
  setFoilThickest,
  TIP_FOIL,
  resetTipLine,
  setThicknessPath,
  setTipLineEnd,
  newIssues,
  removeSlice,
  setCant,
  setDepth,
  setHand,
  setFoilSplit,
  setInsideFace,
  setRootThickness,
  setSliceTwist,
  setToe,
  setPanelAngle,
  setPanelThickness,
  setMinThickness,
  setPanelTilt,
  smoothKnot,
  spanMidpoint,
  withFinCurve,
  type FinCurve,
  type FinStart,
} from './fin-edits';

/** A selected control point of one of the fin's curves. */
export interface FinSelection {
  curve: FinCurve;
  index: number;
  /** The endpoint or one of its handles. Omitted means the endpoint. */
  kind?: 'end' | 'prev' | 'next';
  /**
   * Other endpoints on the same curve selected with it (shift-click): dragging any of
   * them moves them all, and Delete removes them all. Only with an endpoint selected.
   */
  also?: readonly number[];
}

/** The endpoints a selection holds: the selected one and any selected with it. */
export const selectedEnds = (s: FinSelection | null): number[] =>
  s && (s.kind ?? 'end') === 'end' ? [s.index, ...(s.also ?? [])] : [];

export interface FinHistoryEntry {
  design: FinDesign;
  label: string;
}

export interface FinState {
  design: FinDesign | null;
  past: FinHistoryEntry[];
  future: FinHistoryEntry[];
  /** True during a drag: its moves coalesce into one undo step. */
  editing: boolean;
  selection: FinSelection | null;
  /**
   * The foil the section curves (`outside`, `inside`) edit: 0 the root, k the k-th
   * slice. NACA presets and the inside-face buttons act on it too.
   */
  activeFoil: number;

  /** Open a design (a file, an autosave): history starts afresh. */
  load: (d: FinDesign) => void;
  /** Start again from a starting fin: a position's default, or the canard (undoable). */
  newFin: (start: FinStart, hand?: FinHand) => void;
  /**
   * Select a point. Picking an endpoint that is already one of several selected keeps
   * them all selected, so any of them can be grabbed to drag the group.
   */
  select: (selection: FinSelection | null) => void;
  /**
   * Shift-click: add an endpoint to the selection, or take it out if it is in it. A
   * handle, or a point on another curve, is selected on its own.
   */
  toggleSelect: (selection: FinSelection) => void;

  beginEdit: (label?: string) => void;
  endEdit: () => void;

  /** Drag a knot's endpoint toward `p`, clamped to the rules. False if it can't move. */
  moveControlPoint: (curve: FinCurve, index: number, p: Vec2) => boolean;
  /**
   * Drag several endpoints together: `lead` toward `p`, the others the same distance
   * the same way, each pinned end kept on its line, all stopping together where a rule
   * would break.
   */
  moveControlPoints: (
    curve: FinCurve,
    indices: readonly number[],
    lead: number,
    p: Vec2,
  ) => boolean;
  /** Drag one of a knot's handles toward `p`, clamped to the rules. */
  moveTangent: (curve: FinCurve, index: number, which: 'prev' | 'next', p: Vec2) => boolean;
  addControlPoint: (curve: FinCurve, p: Vec2) => boolean;
  /** The toolbar's add button: a point halfway along the span after knot `index`. */
  addControlPointAfter: (curve: FinCurve, index: number) => boolean;
  deleteControlPoint: (curve: FinCurve, index: number) => boolean;
  /** Delete every selected point that can be deleted, as one step. */
  deleteSelectedPoints: () => boolean;
  setContinuous: (curve: FinCurve, index: number, continuous: boolean) => boolean;

  setCant: (deg: number) => boolean;
  setRootThickness: (cm: number) => boolean;
  setDepth: (cm: number) => boolean;
  setHand: (hand: FinHand) => boolean;
  /**
   * Slice `foil` (1-based) changing the cant / toe / transition (any of them), or `null`
   * to drop its change. Clamped to range.
   */
  setSliceTwist: (foil: number, change: Partial<FinTwist> | null) => boolean;
  /** Toe correction (deg, + toe in), clamped to ±5°. */
  setToe: (deg: number) => boolean;
  /** The thinnest the blade may get (cm), the taper following (fin-edits setMinThickness). */
  setMinThickness: (cm: number) => boolean;
  /** The panel the fin is cut from (cm), or null for none (panel-fit.ts). */
  setPanelThickness: (thickness: number | null) => boolean;
  /** Turn the fin in its panel (deg). */
  setPanelAngle: (deg: number, label?: string) => boolean;
  /** Tilt the panel about its length (deg). */
  setPanelTilt: (deg: number) => boolean;
  /** Turn and tilt the fin in its panel at once (bestPanelPose), as one undo step. */
  fitPanel: (pose: { angle: number; tilt: number }) => boolean;
  /** Move the fin onto another tab, placed as that tab's fins start (placeOnBase). */
  setBase: (base: FinBase) => boolean;
  /** Apply a NACA 4-digit preset to the section ('2412'). */
  applyNaca: (code: string) => boolean;
  setInsideFace: (kind: 'flat' | 'symmetric') => boolean;
  /**
   * Split the active foil's thickness: `outside` (0 to 1) above the chord line, the rest
   * below, as leading-edge radii and straight lines to the trailing edge.
   */
  setFoilSplit: (outside: number) => boolean;

  /** Edit foil `foil` (0 the root, k the k-th slice). */
  setActiveFoil: (foil: number) => void;
  /** A new slice at `height` (fraction of the depth), made the active foil. */
  addSlice: (height: number) => boolean;
  /** Remove slice `foil` (1-based); the root becomes the active foil. */
  removeSlice: (foil: number) => boolean;
  /**
   * Move slice `foil` to `height`, past other slices if need be (kept in order, so it may
   * become another index: it stays the active foil). Wrap a drag in beginEdit / endEdit
   * so its moves are one undo step.
   */
  moveSlice: (foil: number, height: number) => boolean;
  /**
   * Move one end of the tip line (where the foil sweep ends) to a fraction of the
   * outline's length. Wrap a drag in beginEdit / endEdit.
   */
  setTipLineEnd: (which: 'start' | 'end', fraction: number) => boolean;
  /** The tip line back to the designer's default. */
  resetTipLine: () => boolean;
  /**
   * Move a point of the thickness path (0 base, 1 halfway, 2 tip line) to a fraction of
   * its section. Wrap a drag in beginEdit / endEdit.
   */
  setThicknessPath: (index: 0 | 1 | 2, fraction: number) => boolean;
  /** The thickness path's middle back to halfway between its ends. */
  resetThicknessPath: () => boolean;
  /** Reshape foil `foil` so it is thickest at `fraction` of its chord. Wrap a drag in beginEdit / endEdit. */
  setFoilThickest: (foil: number, fraction: number) => boolean;
  /** Arrow buttons: move the fin along the tab (cm, + toward the nose). */
  nudgeFore: (dx: number) => boolean;
  /** Arrow buttons: slide the blade across the tab (cm, + outboard). */
  nudgeLateral: (dy: number) => boolean;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

const MAX_HISTORY = 200;

/** The active foil, or the root if an undo took its slice away. */
const validFoil = (d: FinDesign, foil: number): number =>
  foil === TIP_FOIL || (foil >= 0 && foil <= d.slices.length) ? foil : 0;

/** Keep a selection only while the point it names still exists. */
const validSelection = (
  d: FinDesign,
  s: FinSelection | null,
  foil: number,
): FinSelection | null => {
  if (!s) return null;
  const curve = getFinCurve(d, s.curve, validFoil(d, foil));
  if (!curve || s.index >= curve.knots.length) return null;
  const also = s.also?.filter((i) => i < curve.knots.length);
  return also && also.length !== s.also!.length ? { ...s, also } : s;
};

export const createFinStore = (): StoreApi<FinState> =>
  createStore<FinState>((set, get) => {
    /** Apply an edited design, recording a labelled step unless mid-drag. */
    const commit = (next: FinDesign, label: string): boolean => {
      const { design, editing, past } = get();
      if (!design || next === design) return false;
      if (editing) {
        const last = past[past.length - 1];
        set({
          design: next,
          past:
            last && last.label !== label
              ? [...past.slice(0, -1), { design: last.design, label }]
              : past,
        });
      } else {
        set({
          design: next,
          past: [...past, { design, label }].slice(-MAX_HISTORY),
          future: [],
        });
      }
      return true;
    };

    /** Commit `next` only if it breaks no rule the current design didn't. */
    const commitChecked = (next: FinDesign | null, label: string): boolean => {
      const { design } = get();
      if (!design || !next || next === design) return false;
      if (newIssues(design, next).length > 0) return false;
      return commit(next, label);
    };

    /** A drag from the knot's current spot toward `target`, clamped along the way. */
    const drag = (
      label: string,
      from: Vec2,
      target: Vec2,
      apply: (p: Vec2) => FinDesign | null,
    ): boolean => {
      const { design } = get();
      if (!design) return false;
      const along = (t: number) =>
        apply(vec2(from.x + (target.x - from.x) * t, from.y + (target.y - from.y) * t)) ?? design;
      const next = clampEdit(design, along);
      return next ? commit(next, label) : false;
    };

    const editCurve = (
      curve: FinCurve,
      label: string,
      fn: (s: NonNullable<ReturnType<typeof getFinCurve>>) => FinDesign | null,
    ): boolean => {
      const { design } = get();
      const s = design && getFinCurve(design, curve, get().activeFoil);
      if (!design || !s) return false;
      return commitChecked(fn(s), label);
    };

    /** Where the slice being dragged started: its design and index (moveSlice). */
    let sliceDrag: { design: FinDesign; index: number } | null = null;

    return {
      design: null,
      past: [],
      future: [],
      editing: false,
      selection: null,
      activeFoil: 0,

      load: (d) =>
        set({
          // Points a slip of the add-point button stacked on one another, made one; foils
          // stored far from their true thickness stored at it.
          design: withFoilsNearTrueScale(withoutStackedPoints(d)),
          past: [],
          future: [],
          editing: false,
          selection: null,
          activeFoil: 0,
        }),
      newFin: (position, hand) => {
        if (!get().design) {
          get().load(newFin(position, hand));
          return;
        }
        if (commit(newFin(position, hand), 'New fin')) set({ selection: null, activeFoil: 0 });
      },
      select: (selection) => {
        const cur = get().selection;
        const kept =
          selection &&
          cur?.curve === selection.curve &&
          (selection.kind ?? 'end') === 'end' &&
          cur.also?.includes(selection.index);
        if (!kept) return set({ selection });
        // Grabbing one of a group keeps the group, with the grabbed point leading.
        const also = selectedEnds(cur).filter((i) => i !== selection.index);
        set({ selection: { curve: selection.curve, index: selection.index, kind: 'end', also } });
      },
      toggleSelect: (selection) => {
        const cur = get().selection;
        const ends = selectedEnds(cur);
        if (
          !cur ||
          cur.curve !== selection.curve ||
          (selection.kind ?? 'end') !== 'end' ||
          ends.length === 0
        ) {
          return set({ selection });
        }
        const i = selection.index;
        if (ends.includes(i)) {
          const rest = ends.filter((j) => j !== i);
          return set({
            selection: rest.length
              ? { curve: cur.curve, index: rest[0]!, kind: 'end', also: rest.slice(1) }
              : null,
          });
        }
        set({ selection: { curve: cur.curve, index: i, kind: 'end', also: ends } });
      },

      beginEdit: (label = 'Edit') => {
        const { design, past, editing } = get();
        if (!design || editing) return;
        set({ editing: true, past: [...past, { design, label }].slice(-MAX_HISTORY), future: [] });
      },
      endEdit: () => {
        const { editing, past } = get();
        if (!editing) return;
        sliceDrag = null;
        let design = get().design;
        // A drag that moved a slice, the tip line or the outline may leave a slice crossing
        // the tip line somewhere new: give both foils a point there (withCrossingPoints).
        const last = past[past.length - 1];
        if (design && last && last.design !== design && design.slices.length) {
          const marked = withCrossingPoints(design, last.design);
          if (marked !== design) set({ design: (design = marked) });
        }
        // A drag in the foil view may leave a foil stored far thinner or thicker than it
        // is (the view's scale is held through the drag): stored at its true thickness.
        if (design && last && last.design !== design) {
          const near = withFoilsNearTrueScale(design);
          if (near !== design) set({ design: (design = near) });
        }
        // A drag that changed nothing leaves no undo step.
        set(
          last && last.design === design
            ? { editing: false, past: past.slice(0, -1) }
            : { editing: false },
        );
      },

      moveControlPoint: (curve, index, p) => {
        const s = get().design && getFinCurve(get().design!, curve, get().activeFoil);
        if (!s || !s.knots[index]) return false;
        const from = s.knots[index]!.end;
        // Constrain the target, not each step: every constraint is a line or a point, so
        // the straight drag to a constrained target stays on it.
        const to = constrainKnot(s, curve, index, p, edgesFree(get().design!, get().activeFoil));
        if (to.x === from.x && to.y === from.y) return false;
        return drag('Move control point', from, to, (q) =>
          withFinCurve(get().design!, curve, moveKnotEnd(s, index, q), get().activeFoil),
        );
      },

      moveTangent: (curve, index, which, p) => {
        const s = get().design && getFinCurve(get().design!, curve, get().activeFoil);
        const k = s?.knots[index];
        if (!s || !k) return false;
        const from = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
        return drag('Move handle', from, p, (q) =>
          withFinCurve(get().design!, curve, moveKnotTangent(s, index, which, q), get().activeFoil),
        );
      },

      moveControlPoints: (curve, indices, lead, p) => {
        const { design, activeFoil } = get();
        const s = design && getFinCurve(design, curve, activeFoil);
        if (!design || !s || !s.knots[lead]) return false;
        const ids = [...new Set(indices)].filter((i) => s.knots[i]);
        if (ids.length <= 1) return get().moveControlPoint(curve, lead, p);
        const from = s.knots[lead]!.end;
        const edges = edgesFree(design, activeFoil);
        const to = constrainKnot(s, curve, lead, p, edges);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (dx === 0 && dy === 0) return false;
        // Every point the same fraction t of the way, so they stop together.
        const at = (t: number): FinDesign => {
          let moved = s;
          for (const i of ids) {
            const e = s.knots[i]!.end;
            moved = moveKnotEnd(
              moved,
              i,
              constrainKnot(s, curve, i, vec2(e.x + dx * t, e.y + dy * t), edges),
            );
          }
          return withFinCurve(design, curve, moved, activeFoil);
        };
        const next = clampEdit(design, at);
        return next ? commit(next, 'Move control points') : false;
      },

      addControlPoint: (curve, p) => {
        const { design } = get();
        const s = design && getFinCurve(design, curve, get().activeFoil);
        if (!design || !s) return false;
        const r = insertKnotAt(s, p);
        if (!r) return false;
        const ok = commitChecked(
          withFinCurve(design, curve, r.spline, get().activeFoil),
          'Add control point',
        );
        if (ok) set({ selection: { curve, index: r.index, kind: 'end' } });
        return ok;
      },

      addControlPointAfter: (curve, index) => {
        const { design } = get();
        const s = design && getFinCurve(design, curve, get().activeFoil);
        const at = s && spanMidpoint(s, index);
        return at ? get().addControlPoint(curve, at) : false;
      },

      deleteControlPoint: (curve, index) => {
        const { design } = get();
        const s = design && getFinCurve(design, curve, get().activeFoil);
        if (!design || !s || !canDeleteKnot(s, index)) return false;
        if (get().editing) set({ editing: false });
        const ok = commitChecked(
          withFinCurve(design, curve, deleteKnot(s, index), get().activeFoil),
          'Delete control point',
        );
        if (ok) set({ selection: null });
        return ok;
      },

      deleteSelectedPoints: () => {
        const { design, selection, activeFoil } = get();
        const ends = selectedEnds(selection);
        if (!design || !selection) return false;
        if (ends.length <= 1) return get().deleteControlPoint(selection.curve, selection.index);
        const s = getFinCurve(design, selection.curve, activeFoil);
        if (!s) return false;
        // Highest index first, so the ones still to go keep their indices.
        let next = s;
        for (const i of [...ends].sort((a, b) => b - a)) {
          if (canDeleteKnot(next, i)) next = deleteKnot(next, i);
        }
        if (next === s) return false;
        if (get().editing) set({ editing: false });
        const ok = commitChecked(
          withFinCurve(design, selection.curve, next, activeFoil),
          'Delete control points',
        );
        if (ok) set({ selection: null });
        return ok;
      },

      setContinuous: (curve, index, continuous) =>
        editCurve(curve, continuous ? 'Smooth control point' : 'Corner control point', (s) =>
          withFinCurve(
            get().design!,
            curve,
            continuous ? smoothKnot(s, index) : setKnotContinuous(s, index, false),
            get().activeFoil,
          ),
        ),

      setSliceTwist: (foil, change) => {
        const d = get().design;
        const next = d && setSliceTwist(d, foil, change);
        if (!d || !next) return false;
        return commitChecked(next, change ? 'Change slice cant / toe' : 'Remove slice twist');
      },
      setToe: (deg) => {
        const d = get().design;
        return d ? commitChecked(setToe(d, deg), 'Set toe') : false;
      },
      setMinThickness: (cm) => {
        const d = get().design;
        const next = d && setMinThickness(d, cm);
        return !!d && !!next && next !== d && commitChecked(next, 'Set minimum thickness');
      },
      setPanelThickness: (thickness) => {
        const d = get().design;
        const next = d && setPanelThickness(d, thickness);
        return !!d && !!next && next !== d && commit(next, 'Set panel thickness');
      },
      setPanelAngle: (deg, label = 'Turn the fin in its panel') => {
        const d = get().design;
        const next = d && setPanelAngle(d, deg);
        return !!d && !!next && next !== d && commit(next, label);
      },
      setPanelTilt: (deg) => {
        const d = get().design;
        const next = d && setPanelTilt(d, deg);
        return !!d && !!next && next !== d && commit(next, 'Tilt the panel');
      },
      fitPanel: ({ angle, tilt }) => {
        const d = get().design;
        const next = d && setPanelTilt(setPanelAngle(d, angle), tilt);
        return !!d && !!next && next !== d && commit(next, 'Fit to panel');
      },
      setBase: (base) => {
        const d = get().design;
        // Re-placing can break a rule the old placement kept (a long base on a short
        // tab): commit it anyway, so the rule is listed and the user can fix it.
        return d ? commit(placeOnBase(d, base), 'Change base') : false;
      },
      setCant: (deg) => {
        const d = get().design;
        return d ? commitChecked(setCant(d, deg), 'Set cant') : false;
      },
      setRootThickness: (cm) => {
        const d = get().design;
        return d ? commitChecked(setRootThickness(d, cm), 'Set thickness') : false;
      },
      setDepth: (cm) => {
        const d = get().design;
        return d ? commitChecked(setDepth(d, cm, finReadouts(d).depth), 'Set depth') : false;
      },
      setHand: (hand) => {
        const d = get().design;
        return d ? commitChecked(setHand(d, hand), 'Set side') : false;
      },
      applyNaca: (code) => {
        const d = get().design;
        return d
          ? commitChecked(applyNaca(d, code, get().activeFoil), `NACA ${code.trim()}`)
          : false;
      },
      setInsideFace: (kind) => {
        const d = get().design;
        return d
          ? commitChecked(
              setInsideFace(d, kind, get().activeFoil),
              kind === 'flat' ? 'Asymmetric foil' : 'Symmetric foil',
            )
          : false;
      },
      setFoilSplit: (outside) => {
        const d = get().design;
        const pct = Math.round(Math.min(1, Math.max(0, outside)) * 100);
        return d
          ? commitChecked(setFoilSplit(d, outside, get().activeFoil), `Foil ${pct} / ${100 - pct}`)
          : false;
      },
      nudgeFore: (dx) => {
        const d = get().design;
        return d ? commitChecked(nudgeFore(d, dx), 'Nudge fin') : false;
      },
      nudgeLateral: (dy) => {
        const d = get().design;
        return d ? commitChecked(nudgeLateral(d, dy), 'Nudge fin') : false;
      },

      setActiveFoil: (foil) => {
        const { design, activeFoil, selection } = get();
        if (!design || foil === activeFoil || validFoil(design, foil) !== foil) return;
        const onFoil = selection?.curve === 'outside' || selection?.curve === 'inside';
        set({ activeFoil: foil, selection: onFoil ? null : selection });
      },
      addSlice: (height) => {
        const d = get().design;
        const r = d && addSlice(d, height);
        if (!r || !commitChecked(withCrossingPoints(r.design), 'Add foil slice')) return false;
        set({ activeFoil: r.foil, selection: null });
        return true;
      },
      removeSlice: (foil) => {
        const d = get().design;
        if (!d) return false;
        const next = removeSlice(d, foil);
        if (next === d || !commit(next, 'Remove foil slice')) return false;
        set({ activeFoil: 0, selection: null });
        return true;
      },
      setTipLineEnd: (which, fraction) => {
        const d = get().design;
        return !!d && commitChecked(setTipLineEnd(d, which, fraction), 'Move the tip line');
      },
      resetTipLine: () => {
        const d = get().design;
        return !!d && commit(resetTipLine(d), 'Reset the tip line');
      },
      setThicknessPath: (index, fraction) => {
        const d = get().design;
        return (
          !!d && commitChecked(setThicknessPath(d, index, fraction), 'Move the thickness path')
        );
      },
      setFoilThickest: (foil, fraction) => {
        const d = get().design;
        return !!d && commitChecked(setFoilThickest(d, foil, fraction), 'Move the thickest point');
      },
      resetThicknessPath: () => {
        const d = get().design;
        return !!d && commit(resetThicknessPath(d), 'Reset the thickness path');
      },
      moveSlice: (foil, height) => {
        const { design: d, editing, past } = get();
        if (!d) return false;
        // Mid-drag, the slice as the drag found it (see moveSlice).
        const start = editing ? past[past.length - 1]?.design : undefined;
        if (!sliceDrag || sliceDrag.design !== (start ?? d)) {
          sliceDrag = { design: start ?? d, index: foil - 1 };
        }
        const r = moveSlice(d, foil, height, sliceDrag);
        if (!commitChecked(r.design, 'Move foil slice')) return false;
        // Passing another slice changes its place in the order: keep it selected.
        if (r.foil !== get().activeFoil) set({ activeFoil: r.foil });
        return true;
      },

      undo: () => {
        const { past, future, design, selection } = get();
        if (past.length === 0 || !design) return;
        const prev = past[past.length - 1]!;
        set({
          design: prev.design,
          past: past.slice(0, -1),
          future: [{ design, label: prev.label }, ...future],
          editing: false,
          selection: validSelection(prev.design, selection, get().activeFoil),
          activeFoil: validFoil(prev.design, get().activeFoil),
        });
      },
      redo: () => {
        const { past, future, design, selection } = get();
        if (future.length === 0 || !design) return;
        const next = future[0]!;
        set({
          design: next.design,
          past: [...past, { design, label: next.label }],
          future: future.slice(1),
          editing: false,
          selection: validSelection(next.design, selection, get().activeFoil),
          activeFoil: validFoil(next.design, get().activeFoil),
        });
      },
      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,
    };
  });
