import {
  canDeleteKnot,
  getTargetSpline,
  type BoardState,
  type SplineTarget,
} from '@openshaper/store';
import { visualSideForHandleKind } from '@openshaper/render2d';
import { Button, Input } from '@openshaper/ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { StoreApi } from 'zustand/vanilla';
import {
  cmToUnitNumber,
  lengthEditStep,
  parseLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from './format';

/** A clean decimal in the current unit (the editable fields parse fractions on input). */
const display = (cm: number, units: LengthUnit): string =>
  cmToUnitNumber(cm, units).toFixed(unitDecimals(units));

const parse = (text: string, units: LengthUnit): number => parseLen(text, units);

/** Control-point nudges are intentionally finer than station-position edits. */
const pointEditStep = (units: LengthUnit): number => lengthEditStep(units) / 2;

type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const isArrowKey = (key: string): key is ArrowKey =>
  key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';

const targetLabel = (t: SplineTarget): string => {
  switch (t.kind) {
    case 'outline':
      return 'Outline';
    case 'deck':
      return 'Deck';
    case 'bottom':
      return 'Bottom';
    case 'crossSection':
      return `Cross-section ${t.index}`;
  }
};

const sameTarget = (a: SplineTarget, b: SplineTarget): boolean =>
  a.kind === b.kind && (a.kind !== 'crossSection' || (b as { index: number }).index === a.index);

/** One compact native-number field; browser steppers commit immediately on pointer/arrow release. */
function HeaderCoordInput({
  label,
  valueCm,
  units,
  onCommit,
  onDismiss,
  onNudge,
}: {
  label: string;
  valueCm: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
  onDismiss: () => void;
  onNudge: (key: ArrowKey) => void;
}) {
  const shown = display(valueCm, units);
  const [text, setText] = useState(shown);
  const lastCommitted = useRef(valueCm);
  useEffect(() => {
    setText(shown);
    lastCommitted.current = valueCm;
  }, [shown, valueCm]);
  const commit = (next = text) => {
    if (next.trim() === '' || !Number.isFinite(Number(next))) return;
    const parsed = parse(next, units);
    if (Math.abs(parsed - lastCommitted.current) <= 1e-9) return;
    lastCommitted.current = parsed;
    onCommit(parsed);
  };
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        aria-label={`${label} position`}
        type="number"
        step={pointEditStep(units)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit()}
        onPointerUp={(e) => commit(e.currentTarget.value)}
        onKeyUp={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (isArrowKey(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            onNudge(e.key);
          } else if (e.key === 'Enter') {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDismiss();
          }
        }}
        className="h-7 w-24 px-1.5 text-xs tabular-nums pointer-coarse:h-9 pointer-coarse:w-28"
      />
    </label>
  );
}

/** Position editor shown in the header of the pane containing the active point/handle. */
export function SelectedPointEditor({
  store,
  units,
  targets,
  fallback,
}: {
  store: StoreApi<BoardState>;
  units: LengthUnit;
  targets: SplineTarget[];
  /** Header content shown whenever this pane does not own the spline selection. */
  fallback?: ReactNode;
}) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  const selection = useSyncExternalStore(store.subscribe, () => store.getState().selection);

  const nudge = useCallback(
    (key: ArrowKey): boolean => {
      const state = store.getState();
      const active = state.selection;
      if (!state.board || !active || !targets.some((target) => sameTarget(target, active.target)))
        return false;

      const activeKnot = getTargetSpline(state.board, active.target).knots[active.index];
      if (!activeKnot) return false;
      const activeKind = active.kind ?? 'end';
      const activePoint =
        activeKind === 'prev'
          ? activeKnot.tangentToPrev
          : activeKind === 'next'
            ? activeKnot.tangentToNext
            : activeKnot.end;
      const stepCm = parse(String(pointEditStep(units)), units);
      const next = {
        x: activePoint.x + (key === 'ArrowLeft' ? -stepCm : key === 'ArrowRight' ? stepCm : 0),
        y: activePoint.y + (key === 'ArrowDown' ? -stepCm : key === 'ArrowUp' ? stepCm : 0),
      };

      if (activeKind === 'end') state.moveControlPoint(active.target, active.index, next);
      else state.moveTangent(active.target, active.index, activeKind, next);
      return true;
    },
    [store, targets, units],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !isArrowKey(event.key) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return;
      if (nudge(event.key)) event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nudge]);

  if (!board || !selection || !targets.some((target) => sameTarget(target, selection.target)))
    return fallback ?? null;

  const knot = getTargetSpline(board, selection.target).knots[selection.index];
  if (!knot) return fallback ?? null;
  const kind = selection.kind ?? 'end';
  const point =
    kind === 'prev' ? knot.tangentToPrev : kind === 'next' ? knot.tangentToNext : knot.end;
  const label =
    kind === 'end'
      ? 'Point'
      : visualSideForHandleKind(knot, selection.target, kind) === 'left'
        ? 'Left handle'
        : 'Right handle';
  const commit = (x: number, y: number) => {
    if (kind === 'end')
      store.getState().moveControlPoint(selection.target, selection.index, { x, y });
    else store.getState().moveTangent(selection.target, selection.index, kind, { x, y });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={`${label} position editor`}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      <HeaderCoordInput
        label="X"
        valueCm={point.x}
        units={units}
        onCommit={(x) => commit(x, point.y)}
        onDismiss={() => store.getState().select(null)}
        onNudge={nudge}
      />
      <HeaderCoordInput
        label="Y"
        valueCm={point.y}
        units={units}
        onCommit={(y) => commit(point.x, y)}
        onDismiss={() => store.getState().select(null)}
        onNudge={nudge}
      />
      <span className="text-[11px] text-muted-foreground">{unitSuffix(units)}</span>
    </div>
  );
}

/** One coordinate field: commits on Enter/blur, reverts on Escape, re-syncs on edits. */
function CoordInput({
  label,
  valueCm,
  units,
  onCommit,
}: {
  label: string;
  valueCm: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
}) {
  const shown = display(valueCm, units);
  const [text, setText] = useState(shown);
  // Re-sync when the underlying value changes (drag, undo, reselect).
  useEffect(() => setText(shown), [shown]);

  const commit = () => onCommit(parse(text, units));
  return (
    <label className="flex items-center gap-2">
      <span className="w-3 text-muted-foreground">{label}</span>
      <Input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="tabular-nums"
      />
      <span className="text-xs text-muted-foreground">{unitSuffix(units)}</span>
    </label>
  );
}

/**
 * Numeric editor for the selected control point — port of the legacy
 * `ControlPointInfo`. Edits the on-curve endpoint (X/Y), numeric tangent-handle
 * X/Y fields (prev + next), toggles smooth/corner continuity, deletes interior
 * points, and offers horizontal/vertical tangent alignment buttons.
 */
export function ControlPointInspector({
  store,
  units,
}: {
  store: StoreApi<BoardState>;
  units: LengthUnit;
}) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  const selection = useSyncExternalStore(store.subscribe, () => store.getState().selection);

  if (!board || !selection) {
    return (
      <p className="text-xs text-muted-foreground">
        Double-click a curve to add a point. Click a point to edit it here; press Delete to remove
        it.
      </p>
    );
  }

  const spline = getTargetSpline(board, selection.target);
  const knot = spline.knots[selection.index];
  if (!knot) return null; // selection went stale (e.g. just deleted)

  const { target, index } = selection;
  const deletable = canDeleteKnot(spline, index);
  const setEnd = (x: number, y: number) =>
    store.getState().moveControlPoint(target, index, { x, y });
  const setPrev = (x: number, y: number) =>
    store.getState().moveTangent(target, index, 'prev', { x, y });
  const setNext = (x: number, y: number) =>
    store.getState().moveTangent(target, index, 'next', { x, y });

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {targetLabel(target)} · point {index + 1}/{spline.knots.length}
      </div>

      {/* Endpoint */}
      <div className="text-xs font-medium text-muted-foreground">Endpoint</div>
      <CoordInput
        label="X"
        valueCm={knot.end.x}
        units={units}
        onCommit={(x) => setEnd(x, knot.end.y)}
      />
      <CoordInput
        label="Y"
        valueCm={knot.end.y}
        units={units}
        onCommit={(y) => setEnd(knot.end.x, y)}
      />

      {/* Tangent prev (toward previous segment) */}
      <div className="text-xs font-medium text-muted-foreground">Tangent ← prev</div>
      <CoordInput
        label="X"
        valueCm={knot.tangentToPrev.x}
        units={units}
        onCommit={(x) => setPrev(x, knot.tangentToPrev.y)}
      />
      <CoordInput
        label="Y"
        valueCm={knot.tangentToPrev.y}
        units={units}
        onCommit={(y) => setPrev(knot.tangentToPrev.x, y)}
      />

      {/* Tangent next (toward next segment) */}
      <div className="text-xs font-medium text-muted-foreground">Tangent → next</div>
      <CoordInput
        label="X"
        valueCm={knot.tangentToNext.x}
        units={units}
        onCommit={(x) => setNext(x, knot.tangentToNext.y)}
      />
      <CoordInput
        label="Y"
        valueCm={knot.tangentToNext.y}
        units={units}
        onCommit={(y) => setNext(knot.tangentToNext.x, y)}
      />

      {/* Controls row */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant={knot.continuous ? 'secondary' : 'outline'}
          className="flex-1"
          onClick={() => store.getState().setContinuous(target, index, !knot.continuous)}
          title="Toggle smooth (collinear tangents) vs corner"
        >
          {knot.continuous ? 'Smooth' : 'Corner'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!deletable}
          onClick={() => store.getState().deleteControlPoint(target, index)}
          title={deletable ? 'Delete this point (Del)' : 'Endpoints cannot be deleted'}
        >
          Delete
        </Button>
      </div>

      {/* Tangent alignment buttons — port of the legacy ControlPointInfo mask buttons */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 font-mono"
          onClick={() => store.getState().alignTangentsHorizontal(target, index)}
          title="Align both tangent handles to horizontal axis, preserving their lengths"
        >
          —
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 font-mono"
          onClick={() => store.getState().alignTangentsVertical(target, index)}
          title="Align both tangent handles to vertical axis, preserving their lengths"
        >
          |
        </Button>
      </div>
    </div>
  );
}
