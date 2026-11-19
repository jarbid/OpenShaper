// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The slice: the board's closed section at a place along it, as the engine builds it, to true scale.
 * Read-only.
 *
 * - {@link RailSlice}, under the rail map: the section at the map's cursor, to the scale of the board (the
 *   width and thickness it really has there), the stringer, a dimension for the half width and for the
 *   thickness in the display unit, and a marker at the rail's apex. Where the cursor is in a blend, it says
 *   so and how far across.
 * - {@link ZoneSlice}, in the rail panel: the section at the chosen zone's first place, to fit its box, with
 *   the section at the zone's last place behind it, dashed, when the zone has length. It is the zone's own
 *   rail, not the blend at the cursor.
 *
 * The sections come from the engine through the wanted-places mechanism the cross-section pane uses
 * (`nurbs-probes.ts`): `RailsStep` asks for the places and these read the answers. A place whose answer has
 * not come yet shows the last one, so the drawing does not blink while the cursor is moved or a drag is on.
 */
import { apexLabel, railAt } from '@openshaper/store/rails';
import { memo, useRef } from 'react';
import { fmtLen, type LengthUnit } from '../format';
import { useMyRails } from '../my-rails';
import { probeAt, useProbes } from '../nurbs-probes';
import { useRailChoice, useRailPlace } from '../rail-choice';
import {
  useBoardLength,
  useBoardRails,
  zonesOfSide,
  type Side,
  type SideZones,
} from '../rail-zones';
import { useElementSize } from '../use-element-size';
import type { SectionProbe } from '../workers/nurbs-protocol';
import { blendSentence, railTitle } from './rail-panel';
import {
  closedPath,
  fitSlices,
  halfPath,
  measureSlice,
  toScreen,
  type SliceFrame,
  type SliceMeasure,
} from './rail-slice';

/** The answer for a place, or the last one there was while the answer for this one is on its way. */
function useProbeAt(x: number | null): SectionProbe | null {
  const items = useProbes();
  const last = useRef<SectionProbe | null>(null);
  const found = x === null ? undefined : probeAt(items, x);
  if (found) last.current = found;
  return found ?? last.current;
}

/** The two halves of a probe: the left is the plus side, the right the minus side (the plus side again on a mirror board). */
const halvesOf = (p: SectionProbe) => {
  // drawn from the fine polyline when there is one: the coarse one has a rail's bend in two or three points
  const drawn = p.fine ?? p;
  return { left: drawn.plus, right: drawn.minus ?? drawn.plus };
};

interface DrawingProps {
  probe: SectionProbe;
  /** A second section drawn behind it, dashed. */
  ghost?: SectionProbe | null;
  size: { width: number; height: number };
  /** Draw the dimensions and the stringer's label; the small drawing in the panel has none. */
  dimensions: boolean;
  units: LengthUnit;
  /** The rail's apex as the dial says it, written at the marker. */
  apexText?: string;
  label: string;
}

// room for the apex label at the left, the thickness label at the right, and a dimension line and its words below
const MARGIN_BIG = { x: 100, top: 22, bottom: 42 };
const MARGIN_SMALL = { x: 10, top: 10, bottom: 10 };

function SectionDrawing({ probe, ghost, size, dimensions, units, apexText, label }: DrawingProps) {
  const { left, right } = halvesOf(probe);
  const lm = measureSlice(left);
  const rm = measureSlice(right);
  if (!lm || !rm) return <NoSection />;
  const g = ghost ? halvesOf(ghost) : null;
  const gm = g
    ? [measureSlice(g.left), measureSlice(g.right)].filter((m): m is SliceMeasure => !!m)
    : [];
  const frame = fitSlices([lm, rm, ...gm], size, dimensions ? MARGIN_BIG : MARGIN_SMALL);
  if (!frame) return <NoSection />;
  const twoSided = probe.minus !== null && probe.minus !== undefined;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size.width}
      height={size.height}
      className="block text-foreground"
    >
      {g && gm.length === 2 ? (
        <>
          <path
            d={halfPath(g.left, frame, 'left')}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeDasharray="4 3"
          />
          <path
            d={halfPath(g.right, frame, 'right')}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.45}
            strokeDasharray="4 3"
          />
        </>
      ) : null}
      <path
        d={closedPath(left, right, frame)}
        fill="currentColor"
        fillOpacity={0.1}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {dimensions ? (
        <Dimensions
          frame={frame}
          left={lm}
          right={rm}
          units={units}
          twoSided={twoSided}
          apexText={apexText}
        />
      ) : (
        <StringerOnly frame={frame} measures={[lm, rm]} />
      )}
    </svg>
  );
}

/** What a place that has no section to draw says: the very tip of the nose or the tail has no width. */
function NoSection() {
  return (
    <p className="p-2 text-xs text-muted-foreground">
      Nothing to draw here: the board has no width or no thickness at this place.
    </p>
  );
}

/** The stringer, a dashed line through the section. */
function StringerOnly({
  frame,
  measures,
}: {
  frame: SliceFrame;
  measures: readonly SliceMeasure[];
}) {
  const top = toScreen(frame, 0, Math.max(...measures.map((m) => m.zMax)), 'right');
  const bottom = toScreen(frame, 0, Math.min(...measures.map((m) => m.zMin)), 'right');
  return (
    <line
      x1={top.x}
      x2={bottom.x}
      y1={top.y - 3}
      y2={bottom.y + 3}
      stroke="currentColor"
      strokeOpacity={0.4}
      strokeDasharray="3 3"
    />
  );
}

function Dimensions({
  frame,
  left,
  right,
  units,
  twoSided,
  apexText,
}: {
  frame: SliceFrame;
  left: SliceMeasure;
  right: SliceMeasure;
  units: LengthUnit;
  twoSided: boolean;
  apexText?: string;
}) {
  const zTop = Math.max(left.zMax, right.zMax);
  const zBottom = Math.min(left.zMin, right.zMin);
  const top = toScreen(frame, 0, zTop, 'right');
  const bottom = toScreen(frame, 0, zBottom, 'right');
  const dimY = bottom.y + 18;
  const thickX = toScreen(frame, Math.max(left.halfWidth, right.halfWidth), 0, 'right').x + 22;
  const bottomCentre = toScreen(frame, 0, 0, 'right').y;
  const deckCentre = toScreen(frame, 0, right.thickness, 'right').y;
  const halves = [
    { m: left, side: 'left' as const, name: 'Left' },
    { m: right, side: 'right' as const, name: 'Right' },
  ];
  const tick = 'stroke-current';
  return (
    <g fontSize={11} fill="currentColor" className="text-muted-foreground">
      <line
        x1={top.x}
        x2={bottom.x}
        y1={top.y - 8}
        y2={bottom.y + 6}
        stroke="currentColor"
        strokeOpacity={0.5}
        strokeDasharray="3 3"
      />
      {halves.map(({ m, side, name }) => {
        const apex = toScreen(frame, m.apex.y, m.apex.z, side);
        const edge = toScreen(frame, m.halfWidth, 0, side);
        const centre = toScreen(frame, 0, 0, side);
        const mid = (centre.x + edge.x) / 2;
        return (
          <g key={side}>
            <line className={tick} x1={centre.x} x2={edge.x} y1={dimY} y2={dimY} />
            <line className={tick} x1={centre.x} x2={centre.x} y1={dimY - 4} y2={dimY + 4} />
            <line className={tick} x1={edge.x} x2={edge.x} y1={dimY - 4} y2={dimY + 4} />
            <line
              className={tick}
              x1={edge.x}
              x2={edge.x}
              y1={apex.y + 4}
              y2={dimY - 4}
              strokeOpacity={0.35}
              strokeDasharray="2 3"
            />
            <text x={mid} y={dimY + 15} textAnchor="middle">
              {twoSided ? `${name} half width ` : 'Half width '}
              {fmtLen(m.halfWidth, units)}
            </text>
            <circle cx={apex.x} cy={apex.y} r={4} className="fill-primary" />
            {side === 'left' && apexText ? (
              <text x={apex.x - 8} y={apex.y - 7} textAnchor="end" className="fill-foreground">
                Apex {apexText}
              </text>
            ) : null}
          </g>
        );
      })}
      <line className={tick} x1={thickX} x2={thickX} y1={bottomCentre} y2={deckCentre} />
      <line className={tick} x1={thickX - 4} x2={thickX + 4} y1={bottomCentre} y2={bottomCentre} />
      <line className={tick} x1={thickX - 4} x2={thickX + 4} y1={deckCentre} y2={deckCentre} />
      <text x={thickX + 8} y={(bottomCentre + deckCentre) / 2 - 2}>
        Thickness
      </text>
      <text x={thickX + 8} y={(bottomCentre + deckCentre) / 2 + 12}>
        {fmtLen(right.thickness, units)}
      </text>
    </g>
  );
}

// --- under the map ---------------------------------------------------------------------------------

/** Where a place is on a side's zones, in words. */
function placeWords(
  side: SideZones,
  at: number,
  mine: ReturnType<typeof useMyRails>,
  units: LengthUnit,
): string {
  const blend = blendSentence(side, at, mine);
  if (blend) return blend;
  const i = side.zones.findIndex((z) => at <= z.to);
  const index = i < 0 ? side.zones.length - 1 : i;
  const zone = side.zones[index];
  if (!zone) return `At ${fmtLen(at, units)}.`;
  const name = railTitle(zone.rail, mine).name;
  return `In zone ${index + 1}, ${name}.`;
}

export const RailSlice = memo(function RailSlice({ units }: { units: LengthUnit }) {
  const rails = useBoardRails();
  const length = useBoardLength();
  const place = useRailPlace();
  const choice = useRailChoice();
  const mine = useMyRails();
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box, { width: 480, height: 220 });
  const at = place ?? length / 2;
  const probe = useProbeAt(rails ? at : null);
  if (!rails) return null;

  const lanes: Side[] = rails.minus && rails.minus !== rails.plus ? ['plus', 'minus'] : ['plus'];
  const words = lanes.map((side) => {
    const text = placeWords(zonesOfSide(rails, side), at, mine, units);
    return lanes.length > 1 ? `${side === 'plus' ? 'Left' : 'Right'}: ${text}` : text;
  });
  // the apex as the dial says it, from the rail the board has at the cursor on the side that is chosen
  const keys = choice?.side === 'minus' && rails.minus ? rails.minus : rails.plus;
  const apex = apexLabel(railAt(keys, at).apex);
  const half = probe ? measureSlice(halvesOf(probe).left) : null;

  return (
    <section aria-label="Slice of the board" className="flex min-h-0 flex-1 flex-col gap-1">
      <div ref={box} className="min-h-32 flex-1" data-testid="rail-slice">
        {probe ? (
          <SectionDrawing
            probe={probe}
            size={size}
            dimensions
            units={units}
            apexText={apex}
            label={
              half
                ? `Section of the board at ${fmtLen(at, units)}: half width ${fmtLen(half.halfWidth, units)}, thickness ${fmtLen(half.thickness, units)}`
                : `Section of the board at ${fmtLen(at, units)}`
            }
          />
        ) : (
          <p className="p-2 text-xs text-muted-foreground">Building the section…</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Slice at {fmtLen(at, units)}, to scale. {words.join(' ')}
      </p>
    </section>
  );
});

// --- in the panel ----------------------------------------------------------------------------------

export const ZoneSlice = memo(function ZoneSlice({
  from,
  to,
  units,
}: {
  /** The chosen zone's first and last places, cm. */
  from: number;
  to: number;
  units: LengthUnit;
}) {
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box, { width: 296, height: 120 });
  const start = useProbeAt(from);
  const end = useProbeAt(to !== from ? to : null);
  return (
    <figure className="flex flex-col gap-1" aria-label="This zone's rail">
      <div
        ref={box}
        className="h-28 rounded-md border border-border bg-muted/20"
        data-testid="zone-slice"
      >
        {start ? (
          <SectionDrawing
            probe={start}
            ghost={end}
            size={size}
            dimensions={false}
            units={units}
            label={`The zone's own rail, in the section at ${fmtLen(from, units)}`}
          />
        ) : (
          <p className="p-2 text-xs text-muted-foreground">Building the section…</p>
        )}
      </div>
      <figcaption className="text-[11px] text-muted-foreground">
        Section at the zone&rsquo;s start, {fmtLen(from, units)}
        {to !== from ? `; dashed: at its end, ${fmtLen(to, units)}` : ''}.
      </figcaption>
    </figure>
  );
});
