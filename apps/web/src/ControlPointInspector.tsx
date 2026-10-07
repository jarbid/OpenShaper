import { tangentToNextLength, tangentToPrevLength, type Knot } from '@openshaper/kernel';
import {
  canDeleteKnot,
  canLockKnot,
  getTargetSpline,
  sameTarget,
  type BoardState,
  type SplineTarget,
} from '@openshaper/store';
import { handleSideName, visualSideForHandleKind } from '@openshaper/render2d';
import { Button, Input } from '@openshaper/ui';
import { Lock, LockOpen } from 'lucide-react';
import { NumericInput } from './components/numeric-input';
import { shortcutKeys } from './shortcuts';
import { useSyncedText } from './use-numeric-field';
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import {
  cmToUnitNumber,
  lengthEditStep,
  parseLen,
  parseTypedLen,
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

/**
 * Display names for a target spline's own x and y, as board axes.
 *
 * Outline is length × half-width, deck and bottom are length × height, and a
 * cross-section lies in the board's transverse Y-Z plane. Deliberately not
 * "horizontal"/"vertical": a phone pane draws the board turned nose-up, so the
 * spline's x is the axis running *up* the screen there (see `turnFitsLarger`).
 */
const coordinateLabels = (target: SplineTarget): readonly [string, string] =>
  target.kind === 'crossSection' ? ['Y', 'Z'] : ['X', target.kind === 'outline' ? 'Y' : 'Z'];

/** A handle's length (cm): its distance from the point. */
const handleLength = (knot: Knot, which: 'prev' | 'next'): number =>
  which === 'prev' ? tangentToPrevLength(knot) : tangentToNextLength(knot);

/** Whether a handle's direction is locked. */
const handleLocked = (knot: Knot, which: 'prev' | 'next'): boolean =>
  (which === 'prev' ? knot.lock?.prev : knot.lock?.next) !== undefined;

/**
 * Toggle for a point's handle-angle lock — both of its handles. Disabled on a point
 * with no handle to lock (both collapsed), where there is no direction to keep.
 */
function LockToggle({
  store,
  target,
  index,
  knot,
  className,
}: {
  store: StoreApi<BoardState>;
  target: SplineTarget;
  index: number;
  knot: Knot;
  className?: string;
}) {
  const locked = knot.lock !== undefined;
  const lockable = locked || canLockKnot(knot);
  const action = locked ? 'Unlock handle angles' : 'Lock handle angles';
  return (
    <Button
      size="sm"
      variant={locked ? 'secondary' : 'ghost'}
      className={className}
      aria-label={action}
      title={
        lockable
          ? `${action} (${shortcutKeys('toggle-lock')})`
          : 'Pull a handle out first: there is no direction to lock'
      }
      aria-pressed={locked}
      disabled={!lockable}
      onClick={() => store.getState().setLocked(target, index, !locked)}
    >
      {locked ? <Lock /> : <LockOpen />}
    </Button>
  );
}

/** One compact native-number field; browser steppers commit immediately on pointer/arrow release. */
function HeaderCoordInput({
  label,
  ariaLabel = `${label} position`,
  valueCm,
  units,
  onCommit,
  onDismiss,
  onNudge,
}: {
  label: string;
  ariaLabel?: string;
  valueCm: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
  onDismiss: () => void;
  onNudge: (key: ArrowKey) => void;
}) {
  const shown = display(valueCm, units);
  // Re-sync when the value changes, even below display precision (drag, undo, reselect).
  const [text, setText] = useSyncedText(shown, `${shown}|${valueCm}`);
  const lastCommitted = useRef(valueCm);
  // Set by typing or the native steppers; leaving an untouched field must not
  // commit the rounded display value over the exact one.
  const dirty = useRef(false);
  useEffect(() => {
    lastCommitted.current = valueCm;
    dirty.current = false;
  }, [shown, valueCm]);
  const commit = (next = text) => {
    if (!dirty.current) return;
    if (next.trim() === '' || !Number.isFinite(Number(next))) return;
    dirty.current = false;
    const parsed = parse(next, units);
    if (Math.abs(parsed - lastCommitted.current) <= 1e-9) return;
    lastCommitted.current = parsed;
    onCommit(parsed);
  };
  return (
    <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        aria-label={ariaLabel}
        type="number"
        step={pointEditStep(units)}
        value={text}
        onChange={(e) => {
          dirty.current = true;
          setText(e.target.value);
        }}
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
            dirty.current = false;
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
      : `${handleSideName(selection.target, visualSideForHandleKind(knot, selection.target, kind))} handle`;
  const commit = (x: number, y: number) => {
    if (kind === 'end')
      store.getState().moveControlPoint(selection.target, selection.index, { x, y });
    else store.getState().moveTangent(selection.target, selection.index, kind, { x, y });
  };
  const [splineXLabel, splineYLabel] = coordinateLabels(selection.target);
  const dismiss = () => store.getState().select(null);

  return (
    // min-w-0 + horizontal scroll (never wrap): this sits in a fixed-height pane
    // header, and adding a row there resizes the canvas mid-drag.
    <div
      className="no-scrollbar flex min-w-0 items-center gap-2 overflow-x-auto"
      aria-label={`${label} position editor`}
    >
      <span className="shrink-0 text-xs font-medium text-foreground">{label}</span>
      <LockToggle
        store={store}
        target={selection.target}
        index={selection.index}
        knot={knot}
        className="h-7 w-7 shrink-0 p-0 pointer-coarse:h-9 pointer-coarse:w-9"
      />
      {kind !== 'end' && handleLocked(knot, kind) ? (
        // A locked handle only slides along its line, so its length is the one
        // number left to edit; X and Y could not be typed independently.
        <HeaderCoordInput
          label="Length"
          ariaLabel={`${label} length`}
          valueCm={handleLength(knot, kind)}
          units={units}
          onCommit={(len) =>
            store.getState().setTangentLength(selection.target, selection.index, kind, len)
          }
          onDismiss={dismiss}
          onNudge={(key) => {
            // Read the live knot: key repeat can outrun this render.
            const state = store.getState();
            const live =
              state.board && getTargetSpline(state.board, selection.target).knots[selection.index];
            if (!live) return;
            const step = parse(String(pointEditStep(units)), units);
            const grow = key === 'ArrowUp' || key === 'ArrowRight';
            state.setTangentLength(
              selection.target,
              selection.index,
              kind,
              handleLength(live, kind) + (grow ? step : -step),
            );
          }}
        />
      ) : (
        <>
          <HeaderCoordInput
            label={splineXLabel}
            valueCm={point.x}
            units={units}
            onCommit={(x) => commit(x, point.y)}
            onDismiss={dismiss}
            onNudge={nudge}
          />
          <HeaderCoordInput
            label={splineYLabel}
            valueCm={point.y}
            units={units}
            onCommit={(y) => commit(point.x, y)}
            onDismiss={dismiss}
            onNudge={nudge}
          />
        </>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">{unitSuffix(units)}</span>
    </div>
  );
}

/**
 * One coordinate field: commits on Enter/blur, reverts on Escape, re-syncs on edits.
 *
 * `group` names the row this field belongs to ("Endpoint", "Tangent to next", …).
 * Without it the wrapping `<label>` supplies the accessible name, which is the axis
 * letter run straight into the unit suffix ("Ymm") and is repeated by all six fields.
 * Spelled out rather than reusing the visible "Tangent ← prev": arrow glyphs do not
 * read aloud.
 */
function CoordInput({
  group,
  label,
  valueCm,
  units,
  onCommit,
  disabled,
}: {
  group: string;
  label: string;
  valueCm: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
  /** Shown but not editable — a locked handle's X/Y. */
  disabled?: boolean;
}) {
  const shown = display(valueCm, units);
  // Re-sync when the underlying value changes (drag, undo, reselect).
  const [text, setText] = useSyncedText(shown);

  const commit = () => {
    const cm = parseTypedLen(text, units);
    if (cm === null) setText(shown);
    else onCommit(cm);
  };
  return (
    <label className="flex items-center gap-2">
      <span className="min-w-3 text-muted-foreground">{label}</span>
      <NumericInput
        value={text}
        onValueChange={setText}
        onCommit={commit}
        onEscape={() => setText(shown)}
        ariaLabel={`${group} ${label}`}
        className="tabular-nums"
        disabled={disabled}
      />
      <span className="text-xs text-muted-foreground">{unitSuffix(units)}</span>
    </label>
  );
}

/**
 * One tangent handle's fields. While the point's handle angles are locked the handle
 * can only slide along its line, so its X/Y are shown read-only and its length is
 * the field to edit.
 */
function HandleFields({
  store,
  target,
  index,
  knot,
  which,
  units,
}: {
  store: StoreApi<BoardState>;
  target: SplineTarget;
  index: number;
  knot: Knot;
  which: 'prev' | 'next';
  units: LengthUnit;
}) {
  const [xLabel, yLabel] = coordinateLabels(target);
  const handle = which === 'prev' ? knot.tangentToPrev : knot.tangentToNext;
  const group = which === 'prev' ? 'Tangent to previous' : 'Tangent to next';
  const locked = handleLocked(knot, which);
  const move = (x: number, y: number) =>
    store.getState().moveTangent(target, index, which, { x, y });
  return (
    <>
      <div className="text-xs font-medium text-muted-foreground">
        {which === 'prev' ? 'Tangent ← prev' : 'Tangent → next'}
        {locked ? ' · angle locked' : ''}
      </div>
      <CoordInput
        group={group}
        label={xLabel}
        valueCm={handle.x}
        units={units}
        onCommit={(x) => move(x, handle.y)}
        disabled={locked}
      />
      <CoordInput
        group={group}
        label={yLabel}
        valueCm={handle.y}
        units={units}
        onCommit={(y) => move(handle.x, y)}
        disabled={locked}
      />
      {locked && (
        <CoordInput
          group={group}
          label="Length"
          valueCm={handleLength(knot, which)}
          units={units}
          onCommit={(len) => store.getState().setTangentLength(target, index, which, len)}
        />
      )}
    </>
  );
}

/**
 * Numeric editor for the selected control point — port of the legacy
 * `ControlPointInfo`. Edits the on-curve endpoint (X/Y), numeric tangent-handle
 * X/Y fields (prev + next), toggles smooth/corner continuity and the handle-angle
 * lock, deletes interior points, and offers horizontal/vertical tangent alignment
 * buttons.
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
  const [splineXLabel, splineYLabel] = coordinateLabels(target);
  const deletable = canDeleteKnot(spline, index);
  const setEnd = (x: number, y: number) =>
    store.getState().moveControlPoint(target, index, { x, y });

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {targetLabel(target)} · point {index + 1}/{spline.knots.length}
      </div>

      {/* Endpoint */}
      <div className="text-xs font-medium text-muted-foreground">Endpoint</div>
      <CoordInput
        group="Endpoint"
        label={splineXLabel}
        valueCm={knot.end.x}
        units={units}
        onCommit={(x) => setEnd(x, knot.end.y)}
      />
      <CoordInput
        group="Endpoint"
        label={splineYLabel}
        valueCm={knot.end.y}
        units={units}
        onCommit={(y) => setEnd(knot.end.x, y)}
      />

      {/* Tangent handles, toward the previous and the next segment */}
      <HandleFields
        store={store}
        target={target}
        index={index}
        knot={knot}
        which="prev"
        units={units}
      />
      <HandleFields
        store={store}
        target={target}
        index={index}
        knot={knot}
        which="next"
        units={units}
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
        <LockToggle store={store} target={target} index={index} knot={knot} className="shrink-0" />
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
          title="Align both tangent handles to horizontal axis, preserving their lengths. A locked point stays locked, now horizontal."
        >
          —
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 font-mono"
          onClick={() => store.getState().alignTangentsVertical(target, index)}
          title="Align both tangent handles to vertical axis, preserving their lengths. A locked point stays locked, now vertical."
        >
          |
        </Button>
      </div>
    </div>
  );
}
