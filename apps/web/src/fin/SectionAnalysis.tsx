// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The 3D view's section analysis: an Analysis button that turns the fin see-through and
 * shows section planes, each with a slider and readouts.
 *
 * - **Vertical**: an upright plane square to the base, at a point along it. Its slider
 *   runs along the bottom of the view; it reads how far back from the leading edge, the
 *   blade's height there and its greatest thickness.
 * - **Horizontal**: a plane at a height up the blade, showing the foil there. Its slider
 *   runs up the right edge; it reads the height, the chord and the thickness.
 *
 * - **Zebra**: black and white stripes over the blade, to judge how smooth it is: they run
 *   on unbroken over a smooth face, and break or kink where it creases.
 *
 * Any of them can be on (Vertical by default). The sliders are fixed to the view's
 * edges rather than handles in 3D, so they stay in reach however the fin is turned.
 * Reset puts the camera back to its starting view. The cuts come from the kernel
 * (`sliceMesh`, `measureSlice`) on a finer mesh than the preview's, made once per edit
 * while the analysis is open; moving a slider only re-cuts it.
 */
import {
  DEG_TO_RAD,
  finMesh,
  finOutward,
  measureSlice,
  sliceMesh,
  type BoardMesh,
  type FinDesign,
  type FinEngine,
  type SliceMeasure,
} from '@openshaper/kernel';
import type { FinSectionPlane } from '@openshaper/render3d';
import { Button } from '@openshaper/ui';
import { useMemo } from 'react';
import { fmtLen, fmtThick, type LengthUnit } from '../format';

/** What the analysis shows: which planes, and where each is (0–1 across its range). */
export interface SectionState {
  readonly on: boolean;
  readonly vertical: boolean;
  readonly horizontal: boolean;
  /**
   * Vertical plane, across the blade's length as the starting view shows it: 0 at the
   * screen's left, 1 at its right (the nose is on the left for a left or centre fin, on
   * the right for a right fin).
   */
  readonly x: number;
  /** Horizontal plane: from the tab top (0) to the tip (1). */
  readonly z: number;
  /** Zebra stripes on the blade. */
  readonly zebra: boolean;
}

export const SECTION_DEFAULT: SectionState = {
  on: false,
  vertical: true,
  horizontal: false,
  x: 0.5,
  z: 0.5,
  zebra: false,
};

/** Finer than the preview, so the cut and its numbers follow the surface closely. */
const ANALYSIS_MESH = { rows: 120, stations: 64, tipGap: 0.01, arcTolerance: 0.001 };

/** How far inside the blade's ends a plane stops (cm): 0.001 mm. */
const EDGE = 1e-4;

/** Slider steps across a plane's range. */
const STEPS = 400;

interface Cut {
  readonly plane: FinSectionPlane;
  /** The blade's numbers at the cut, thickness square to the blade; null off the blade. */
  readonly measure: SliceMeasure | null;
}

export interface SectionCuts {
  readonly vertical: Cut | null;
  readonly horizontal: Cut | null;
  /** The blade's leading-edge root (cm): what the vertical plane's position is read from. */
  readonly leadingRoot: number;
  /** The planes to draw, or null when the analysis is off. */
  readonly planes: readonly FinSectionPlane[] | null;
}

const bounds = (m: BoardMesh, k: 0 | 2) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = k; i < m.positions.length; i += 3) {
    lo = Math.min(lo, m.positions[i]!);
    hi = Math.max(hi, m.positions[i]!);
  }
  return { lo, hi };
};

/** The cuts for the analysis's planes; nothing is computed while it is off. */
export function useSectionCuts(
  design: FinDesign | null,
  state: SectionState,
  engine: FinEngine = 'sweep',
): SectionCuts | null {
  const mesh = useMemo(
    () => (design && state.on ? finMesh(design, { ...ANALYSIS_MESH, engine }) : null),
    [design, state.on, engine],
  );
  return useMemo(() => {
    if (!design || !mesh) return null;
    // Widths are measured across the blade horizontally; square to a canted blade they
    // are narrower by cos(cant).
    const square = Math.cos(design.cant * DEG_TO_RAD);
    const cut = (axis: 'x' | 'z', at: number): Cut => {
      const blade = sliceMesh(mesh.blade, axis, at);
      const m = measureSlice(blade, axis);
      return {
        plane: { axis, at, cut: [...blade, ...sliceMesh(mesh.tab, axis, at)] },
        measure: m && { length: m.length, thickness: m.thickness * square },
      };
    };
    // A hair inside the blade's ends: a plane exactly on a row of mesh points (the root,
    // the leading edge) would cross no edge.
    const inset = ({ lo, hi }: { lo: number; hi: number }) => ({ lo: lo + EDGE, hi: hi - EDGE });
    const xs = inset(bounds(mesh.blade, 0));
    const zs = inset(bounds(mesh.blade, 2));
    // The slider runs the way the fin lies in the starting view: nose on the left for a
    // left or centre fin (outside face toward +Y), on the right for a right fin.
    const along = finOutward(design.hand) > 0 ? 1 - state.x : state.x;
    const vertical = state.vertical ? cut('x', xs.lo + (xs.hi - xs.lo) * along) : null;
    const root = Math.max(EDGE, zs.lo);
    const horizontal = state.horizontal ? cut('z', root + (zs.hi - root) * state.z) : null;
    return {
      vertical,
      horizontal,
      leadingRoot: design.outline.knots[0]!.end.x,
      planes: [vertical?.plane, horizontal?.plane].filter((p): p is FinSectionPlane => !!p),
    };
  }, [design, mesh, state.vertical, state.horizontal, state.x, state.z]);
}

/** The controls over the 3D view: the Analysis button, and with it on, everything else. */
export function SectionOverlay({
  state,
  onChange,
  onReset,
  cuts,
  units,
}: {
  state: SectionState;
  onChange: (next: SectionState) => void;
  onReset: () => void;
  cuts: SectionCuts | null;
  units: LengthUnit;
}) {
  const set = (patch: Partial<SectionState>) => onChange({ ...state, ...patch });
  const len = (cm: number) => fmtLen(cm, units);
  const v = cuts?.vertical;
  const h = cuts?.horizontal;
  return (
    <>
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2 text-xs">
        <Button
          size="sm"
          variant={state.on ? 'selected' : 'outline'}
          aria-pressed={state.on}
          onClick={() => set({ on: !state.on })}
        >
          Analysis
        </Button>
        {state.on && (
          <>
            <label className="flex items-center gap-1 rounded bg-background/80 px-1.5 py-1">
              <input
                type="checkbox"
                checked={state.vertical}
                onChange={(e) => set({ vertical: e.target.checked })}
              />
              Vertical
            </label>
            <label className="flex items-center gap-1 rounded bg-background/80 px-1.5 py-1">
              <input
                type="checkbox"
                checked={state.horizontal}
                onChange={(e) => set({ horizontal: e.target.checked })}
              />
              Horizontal
            </label>
            <label className="flex items-center gap-1 rounded bg-background/80 px-1.5 py-1">
              <input
                type="checkbox"
                checked={state.zebra}
                onChange={(e) => set({ zebra: e.target.checked })}
              />
              Zebra
            </label>
            <Button size="sm" variant="outline" onClick={onReset}>
              Reset view
            </Button>
          </>
        )}
      </div>
      {state.on && (state.vertical || state.horizontal) && (
        // Both readouts in one strip at the bottom: in a short pane a column down the right
        // ran up over the toolbar (owner review).
        <div className="absolute bottom-2 left-2 right-12 z-10 flex flex-col gap-1 rounded bg-background/80 px-2 py-1 text-xs">
          {state.vertical && (
            <input
              type="range"
              min={0}
              max={STEPS}
              value={Math.round(state.x * STEPS)}
              onChange={(e) => set({ x: Number(e.target.value) / STEPS })}
              aria-label="Vertical plane position"
              className="fin-range w-full"
            />
          )}
          {state.vertical && v && (
            <span className="tabular-nums" aria-live="polite">
              {`${len(cuts!.leadingRoot - v.plane.at)} back · ` +
                (v.measure
                  ? `${len(v.measure.length)} high · ${fmtThick(v.measure.thickness, units)} thick`
                  : 'clear of the blade')}
            </span>
          )}
          {state.horizontal && h && (
            <span className="tabular-nums" aria-live="polite">
              {`${len(h.plane.at)} up · ` +
                (h.measure
                  ? `chord ${len(h.measure.length)} · ${fmtThick(h.measure.thickness, units)} thick`
                  : 'above the tip')}
            </span>
          )}
        </div>
      )}
      {state.on && state.horizontal && (
        <div className="absolute bottom-20 right-2 top-12 z-10 flex flex-col items-end">
          <input
            type="range"
            min={0}
            max={STEPS}
            value={Math.round(state.z * STEPS)}
            onChange={(e) => set({ z: Number(e.target.value) / STEPS })}
            aria-label="Horizontal plane height"
            className="fin-range min-h-0 flex-1"
            // Upright, with the top of the slider at the top of the blade.
            style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
          />
        </div>
      )}
    </>
  );
}
