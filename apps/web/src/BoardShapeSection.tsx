// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "Board shape" sidebar section (NURBS engine only, docs/design/m2-editor.md §3): symmetry, tail type
 * and notch depth. Each is one undo step on the section store. Lengths are in the editor's display unit
 * (`apps/web/CLAUDE.md`).
 */
import { Button, Input } from '@openshaper/ui';
import { notchDepthRange, tailTypeOf, type TailType } from '@openshaper/store/sections';
import { useState, useSyncExternalStore } from 'react';
import { TAIL_TYPES } from './board-shape';
import { KeepSideDialog } from './KeepSideDialog';
import {
  cmToUnitNumber,
  fmtLen,
  parseLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from './format';
import { sectionStore } from './store';
import { loadNotchChords } from './use-section-engine';
import { useSyncedText } from './use-numeric-field';

/** What the section's header shows when it is shut: the tail and, if it is, the asymmetry. */
export function boardShapeSummary(): string | undefined {
  const doc = sectionStore.getState().doc;
  if (!doc) return undefined;
  const tail = TAIL_TYPES.find((t) => t.value === tailTypeOf(doc))?.label ?? '';
  return doc.symmetry === 'asymmetric' ? `${tail}, asymmetric` : tail;
}

export function BoardShapeSection({
  units,
  segmentClass,
}: {
  units: LengthUnit;
  /** Classes of one button of a segmented choice (`SIZING.segment` in `Sidebar.tsx`). */
  segmentClass: string;
}) {
  const doc = useSyncExternalStore(sectionStore.subscribe, () => sectionStore.getState().doc);
  const [asking, setAsking] = useState(false);
  if (!doc) return null;

  const asymmetric = doc.symmetry === 'asymmetric';
  const tail = tailTypeOf(doc);
  const notched = doc.tail.kind === 'notched';
  const length = doc.outline.plus.knots.at(-1)!.p[0];
  const depth = doc.outline.plus.knots[0]!.p[0];
  const range = notchDepthRange(length);

  const setTail = async (type: TailType) => {
    if (type === tail) return;
    // the notch-zone chords of the projection come from board2's frame, loaded on first need
    if (type !== 'standard') await loadNotchChords();
    sectionStore.getState().setTail(type);
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <div className="text-muted-foreground">Symmetry</div>
        <div role="group" aria-label="Symmetry" className="flex gap-1">
          <Button
            size="sm"
            variant={asymmetric ? 'ghost' : 'secondary'}
            aria-pressed={!asymmetric}
            className={segmentClass}
            onClick={() => asymmetric && setAsking(true)}
          >
            Mirrored
          </Button>
          <Button
            size="sm"
            variant={asymmetric ? 'secondary' : 'ghost'}
            aria-pressed={asymmetric}
            className={segmentClass}
            onClick={() => !asymmetric && sectionStore.getState().setSymmetry('asymmetric')}
          >
            Asymmetric
          </Button>
        </div>
        {asymmetric && (
          <p className="text-xs text-muted-foreground">
            The outline and cross-section views show both rails; edit either one. The rocker, deck
            and bottom features are shared.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-muted-foreground">Tail</div>
        <div role="group" aria-label="Tail type" className="flex gap-1">
          {TAIL_TYPES.map((t) => (
            <Button
              key={t.value}
              size="sm"
              variant={tail === t.value ? 'secondary' : 'ghost'}
              aria-pressed={tail === t.value}
              title={t.hint}
              className={segmentClass}
              onClick={() => void setTail(t.value)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {notched && (
        <NotchDepth
          depth={depth}
          min={range.min}
          max={range.max}
          units={units}
          onCommit={(cm) => sectionStore.getState().setNotchDepth(cm)}
        />
      )}

      {asking && (
        <KeepSideDialog
          onCancel={() => setAsking(false)}
          onKeep={(side) => {
            setAsking(false);
            sectionStore.getState().setSymmetry('mirror', side);
          }}
        />
      )}
    </div>
  );
}

function NotchDepth({
  depth,
  min,
  max,
  units,
  onCommit,
}: {
  depth: number;
  min: number;
  max: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
}) {
  const shown = cmToUnitNumber(depth, units).toFixed(unitDecimals(units));
  const [text, setText] = useSyncedText(shown, `${shown}|${depth}|${units.key}`);
  const commit = () => {
    const cm = parseLen(text, units);
    if (Number.isFinite(cm) && cm > 0) onCommit(Math.min(max, Math.max(min, cm)));
    else setText(shown);
  };
  return (
    <label className="block space-y-1">
      <span className="text-muted-foreground">Notch depth</span>
      <span className="flex items-center gap-2">
        <Input
          value={text}
          inputMode="decimal"
          enterKeyHint="done"
          aria-label="Notch depth"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{unitSuffix(units)}</span>
      </span>
      <span className="block text-xs text-muted-foreground">
        From the tail tips to the notch bottom, {fmtLen(min, units)} to {fmtLen(max, units)}. Drag
        the point on the centre line of the outline to change it live.
      </span>
    </label>
  );
}
