import {
  canDeleteKnot,
  getTargetSpline,
  type BoardState,
  type SplineTarget,
} from '@openshaper/store';
import { Button, Input } from '@openshaper/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { cmToUnitNumber, parseLen, unitDecimals, unitSuffix, type LengthUnit } from './format';

/** A clean decimal in the current unit (the editable fields parse fractions on input). */
const display = (cm: number, units: LengthUnit): string =>
  cmToUnitNumber(cm, units).toFixed(unitDecimals(units));

const parse = (text: string, units: LengthUnit): number => parseLen(text, units);

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
 * `ControlPointInfo`. Edits the on-curve endpoint (X/Y), toggles smooth/corner
 * continuity, and deletes interior points. Tangent handles stay drag-only.
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

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {targetLabel(target)} · point {index + 1}/{spline.knots.length}
      </div>
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
    </div>
  );
}
