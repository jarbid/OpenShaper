// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Point tools for a curve view's toolbar (docs/design/fin-designer.md, round 1, R4):
 * add a point halfway along the selected span, delete the selected point, and make it
 * smooth or a corner. They act on the selected point whichever view it is in, on the foil
 * being edited (owner testing: they read the base foil, and greyed out for a slice's or
 * the tip foil's later points; and a point picked in a small pane greyed out the large
 * pane's tools), and are greyed out with nothing selected. A curve's two end points
 * can't be deleted or made smooth: they are pinned to the base, the tip or the chord.
 */
import { canDeleteKnot, getFinCurve, selectedEnds, type FinState } from '@openshaper/store';
import { Button, Tooltip } from '@openshaper/ui';
import { Minus, Plus } from 'lucide-react';
import { memo } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { shortcutKeys } from '../shortcuts';
import { useFinState } from './use-fin';

export const PointTools = memo(function PointTools({ store }: { store: StoreApi<FinState> }) {
  const sel = useFinState(store, (s) => s.selection);
  const design = useFinState(store, (s) => s.design);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  const spline = sel && design ? getFinCurve(design, sel.curve, activeFoil) : null;
  const k = sel && spline ? spline.knots[sel.index] : undefined;
  const interior = !!spline && !!sel && sel.index > 0 && sel.index < spline.knots.length - 1;
  const s = store.getState;
  const hint = sel ? undefined : 'Select a point first';
  // Shift-click selects more than one: Delete removes them all.
  const ends = selectedEnds(sel);
  const many = ends.length > 1;
  const deletable =
    !!spline && (many ? ends : sel ? [sel.index] : []).some((i) => canDeleteKnot(spline, i));
  // Off: no border, so it reads as off at a glance (owner review), not as one more button.
  const shown = (enabled: boolean) => (enabled ? 'outline' : 'ghost');

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Point tools">
      <Tooltip label={hint ?? 'Add a point halfway to the next one'}>
        <Button
          variant={shown(!!sel)}
          size="icon"
          className="h-8 w-8"
          aria-label="Add a point"
          disabled={!sel}
          onClick={() => sel && s().addControlPointAfter(sel.curve, sel.index)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </Tooltip>
      <Tooltip
        label={
          hint ?? (many ? `Delete the ${ends.length} selected points` : 'Delete the selected point')
        }
        shortcut={sel ? shortcutKeys('delete-point') : undefined}
      >
        <Button
          variant={shown(deletable)}
          size="icon"
          className="h-8 w-8"
          aria-label={many ? 'Delete the selected points' : 'Delete the selected point'}
          disabled={!deletable}
          onClick={() => s().deleteSelectedPoints()}
        >
          <Minus className="h-4 w-4" />
        </Button>
      </Tooltip>
      <Button
        size="sm"
        variant={interior && k?.continuous ? 'selected' : shown(interior)}
        aria-pressed={interior && !!k?.continuous}
        disabled={!interior}
        onClick={() => sel && s().setContinuous(sel.curve, sel.index, true)}
      >
        Smooth
      </Button>
      <Button
        size="sm"
        variant={interior && k && !k.continuous ? 'selected' : shown(interior)}
        aria-pressed={interior && !!k && !k.continuous}
        disabled={!interior}
        onClick={() => sel && s().setContinuous(sel.curve, sel.index, false)}
      >
        Corner
      </Button>
    </div>
  );
});
