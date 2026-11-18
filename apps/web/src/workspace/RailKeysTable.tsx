// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Rails step's footer: the rail's keys, read-only, as a table. A key is a place along the board
 * and the rail there; the rail is seven numbers, and each runs between keys as a curve. Per side:
 * the key's x and the seven, in the display unit where the number is a length. A later slice
 * replaces this with the rail map and the rail panel.
 *
 * A mirror board has one list for both sides; an asymmetric one has a list for each, as the outline
 * draws them (the upper rail is the plus side).
 *
 * The table never takes more than two fifths of the drawing area (it scrolls inside that), so the
 * closed section above it keeps room to be read on a short screen.
 *
 * It subscribes to the document's `rails` field only, so a drag of the outline, which makes a new
 * document with the same rail keys, does not re-render it.
 */
import type { RailsBoard } from '@openshaper/board2';
import { useSyncExternalStore } from 'react';
import { cmToUnitNumber, unitDecimals, unitSuffix, type LengthUnit } from '../format';
import { activeStore, docOf } from '../store';

type RailKey = RailsBoard['rails']['plus'][number];

/** The rail keys of the document being edited, or null when it is not a rails board. */
const railKeysOf = (): RailsBoard['rails'] | null => {
  const doc = docOf(activeStore.getState());
  return doc?.model === 'rails' ? doc.rails : null;
};

/** One column of the table: its heading, and how a key's value shows in it. */
interface Column {
  readonly id: string;
  /** The heading; a length's carries the unit. */
  readonly head: (units: LengthUnit) => string;
  readonly cell: (key: RailKey, units: LengthUnit) => string;
}

const length = (cm: number, units: LengthUnit) =>
  cmToUnitNumber(cm, units).toFixed(unitDecimals(units));

/** x, then the rail's seven numbers in the order the engine's recipe lists them. */
export const RAIL_KEY_COLUMNS: readonly Column[] = [
  { id: 'x', head: (u) => `x (${unitSuffix(u)})`, cell: (k, u) => length(k.x, u) },
  { id: 'band', head: (u) => `Band (${unitSuffix(u)})`, cell: (k, u) => length(k.rail.band, u) },
  { id: 'shoulder', head: () => 'Shoulder', cell: (k) => k.rail.hardness.toFixed(2) },
  { id: 'tuck', head: (u) => `Tuck (${unitSuffix(u)})`, cell: (k, u) => length(k.rail.tuck, u) },
  { id: 'tuckShape', head: () => 'Tuck shape', cell: (k) => k.rail.tuckShape.toFixed(2) },
  { id: 'bottomEdge', head: () => 'Bottom edge (°)', cell: (k) => k.rail.bottomEdge.toFixed(1) },
  { id: 'deckEdge', head: () => 'Deck edge (°)', cell: (k) => k.rail.deckEdge.toFixed(1) },
  { id: 'apex', head: () => 'Apex', cell: (k) => k.rail.apex.toFixed(2) },
];

function SideTable({
  name,
  keys,
  units,
}: {
  name: string;
  keys: readonly RailKey[];
  units: LengthUnit;
}) {
  return (
    <table aria-label={name} className="w-full min-w-max text-right text-xs tabular-nums">
      <caption className="px-2 pb-1 text-left font-medium text-foreground">{name}</caption>
      <thead>
        <tr className="text-muted-foreground">
          {RAIL_KEY_COLUMNS.map((c) => (
            <th key={c.id} scope="col" className="px-2 py-1 font-medium">
              {c.head(units)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {keys.map((k, i) => (
          <tr key={i} className="border-t border-border/60">
            {RAIL_KEY_COLUMNS.map((c) => (
              <td key={c.id} className="px-2 py-1">
                {c.cell(k, units)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RailKeysTable({ units }: { units: LengthUnit }) {
  const rails = useSyncExternalStore(activeStore.subscribe, railKeysOf, () => null);
  if (!rails) return null;
  const sides = rails.minus
    ? [
        { name: 'Upper rail', keys: rails.plus },
        { name: 'Lower rail', keys: rails.minus },
      ]
    : [{ name: 'Both rails', keys: rails.plus }];
  return (
    <section
      aria-label="Rail keys"
      className="max-h-[40%] shrink-0 overflow-auto rounded-lg border border-border bg-card p-2 text-card-foreground"
    >
      <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        Rail keys (read-only)
      </h3>
      <div className="flex flex-col gap-3">
        {sides.map((s) => (
          <SideTable key={s.name} name={s.name} keys={s.keys} units={units} />
        ))}
      </div>
    </section>
  );
}
