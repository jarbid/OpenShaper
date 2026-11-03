// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The horizontal foil, editable: outside face and inside face over the chord line
 * (docs/design/fin-designer.md, step 12). Drawn four times taller than true, so a
 * 10%-thick foil can be shaped by hand. A symmetric foil (every centre fin) has one
 * face; the other is shown mirrored, dashed. NACA 4-digit presets replace both faces,
 * which stay editable afterwards. The dashed vertical marks the thickest point, where
 * the taper's thickness applies. A horizontal slice whose chord crosses the tip line
 * shows the part past it, which the tip foil shapes, shaded, and a green dot for the tip
 * there; the tip foil shows an aqua dot where each slice crosses it, for the slice there.
 * Both foils get a point at the crossing to match the dots with (owner's rules). An
 * asymmetric foil shows how its thickness is shared
 * (outside / inside, top left); typing a share rebuilds the foil as leading-edge radii
 * and straight lines (split-foil.ts).
 */
import {
  FIN_EXPORT_MIN_THICKNESS,
  chordAt,
  finReadouts,
  foilShare,
  knot,
  parseNaca4,
  prepareBlade,
  sectionThickest,
  sliceTipCrossing,
  splineFromKnots,
  sweepGrid,
  sweepPointOn,
  sweepSectionLine,
  thicknessAt,
  thicknessPathOf,
  vec2,
  yAtX,
  type FinDesign,
  type Spline,
} from '@openshaper/kernel';
import { FinCurveEditor, type FinCurveLayer } from '@openshaper/render2d';
import { getFoil, tipSpanOf, TIP_FOIL, type FinState } from '@openshaper/store';
import { Button, Tooltip } from '@openshaper/ui';
import { memo, useCallback, useMemo, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { DegField } from '../components/fields';
import { NumericInput } from '../components/numeric-input';
import { fmtLen, fmtThick, type LengthUnit } from '../format';
import { alsoFromSelection, curveEditorHandlers, pickFromSelection } from './curve-editor-wiring';
import { PointTools } from './PointTools';
import { useFinState } from './use-fin';
import { FitToPanel, PANEL_FIT, PANEL_OVER } from './panel-tools';
import { PATH_COLOR, SWEEP_LINE } from './sweep-overlay';
import { usePanelFit } from './use-panel-fit';

/**
 * The real chord and thickness a foil is drawn for: the base foil along the sweep's base,
 * the tip foil across the tip line (turned level in the foil view), a horizontal slice
 * foil along the chord at its height. Thickness from the taper at its thickest point.
 */
export const foilSize = (d: FinDesign, foil: number): { chord: number; thickness: number } => {
  const b = prepareBlade(d);
  if (foil === 0 || foil === TIP_FOIL) {
    const g = sweepGrid(d);
    const row = foil === 0 ? 0 : g.tipRow;
    const line = sweepSectionLine(g, row);
    let chord = 0;
    for (let i = 1; i < line.length; i++) {
      chord += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y);
    }
    const path = thicknessPathOf(d);
    const at = sweepPointOn(g, row, foil === 0 ? path[0] : path[2]);
    return { chord, thickness: thicknessAt(b, Math.min(b.depth, Math.max(0, at.y))) };
  }
  const sl = d.slices[foil - 1];
  const h = sl ? sl.height * b.depth : 0;
  const { leading, trailing } = chordAt(b, Math.min(b.depth, h));
  return { chord: Math.abs(leading - trailing), thickness: thicknessAt(b, h) };
};

/**
 * How much taller than its drawn shape the foil really is, to draw it true to scale
 * (owner request): its thickness over its chord (foilSize), against the shape's own
 * thickness in chords. Kept within a quarter to four times.
 */
export const foilTrueScale = (d: FinDesign, foil: number): number => {
  const sec = getFoil(d, foil);
  const { chord, thickness } = foilSize(d, foil);
  const shape = sec ? sectionThickest(sec).thickness : 0;
  if (!(chord > 0) || !(shape > 0)) return 1;
  return Math.min(4, Math.max(0.25, thickness / chord / shape));
};

/** What the foil view is showing, as the profile names it. */
export const foilTitle = (d: FinDesign, foil: number, units: LengthUnit): string =>
  foil === 0
    ? 'Foil sweep start (base)'
    : foil === TIP_FOIL
      ? 'Foil sweep end (tip)'
      : `Horizontal slice foil · ${fmtLen((d.slices[foil - 1]?.height ?? 0) * finReadouts(d).depth, units)}`;

/** Keep the chord line and a strip under it (for the labels) in view; the faces add the rest. */
const SECTION_FRAME = { minX: 0, maxX: 1, minY: -0.12, maxY: 0.02 };

/** The presets in the dropdown; "Other…" takes any 4-digit code. */
const SUGGESTED = ['0008', '0010', '0012', '2408', '2410', '2412', '4409', '4412', '6409'];

const OUTSIDE = '#22D3EE';
const INSIDE = '#A78BFA';
const GUIDE = 'rgba(138,155,179,0.7)';
/** The tip past the tip line on a slice: shaded, the tip foil shapes it. */
const TIP_PART = 'rgba(138,155,179,0.16)';
/** In a slice, the tip at the crossing: the profile's tip-line green. */
const TIP_DOT = SWEEP_LINE;
/** In the tip foil, a slice at the crossing: aqua. */
const SLICE_DOT = '#2DD4BF';

const mirrored = (s: Spline): Spline =>
  splineFromKnots(
    s.knots.map((k) => {
      const m = (p: { x: number; y: number }) => vec2(p.x, -p.y);
      return knot(m(k.end), m(k.tangentToPrev), m(k.tangentToNext), k.continuous);
    }),
  );

/** The preset dropdown's "type any code" choice. */
const OTHER = 'other';

/**
 * A preset dropdown, plus a field for any other 4-digit code. (Not an `<input list>`:
 * browsers filter a datalist by the field's text, so after one Apply it offered only
 * that code.)
 */
function NacaPicker({ store, centre }: { store: StoreApi<FinState>; centre: boolean }) {
  const presets = SUGGESTED.filter((c) => !centre || c.startsWith('00'));
  const [picked, setChoice] = useState(presets[0]!);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // A side fin's cambered preset isn't offered on a centre fin: fall back to the first.
  const choice = picked === OTHER || presets.includes(picked) ? picked : presets[0]!;
  const other = choice === OTHER;
  const apply = () => {
    const chosen = other ? code.trim() : choice;
    try {
      const n = parseNaca4(chosen);
      if (centre && n.camber > 0) {
        setProblem('A centre fin needs a symmetric foil: NACA 00xx.');
        return;
      }
    } catch {
      setProblem('Enter a NACA 4-digit code, such as 2412.');
      return;
    }
    setProblem(null);
    store.getState().applyNaca(chosen);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">NACA</span>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 tabular-nums"
          value={choice}
          aria-label="NACA preset"
          onChange={(e) => {
            setChoice(e.target.value);
            setProblem(null);
          }}
        >
          {presets.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
      </label>
      {other && (
        <input
          className="h-8 w-20 rounded-md border border-input bg-background px-2 tabular-nums"
          inputMode="numeric"
          maxLength={4}
          placeholder={centre ? '0010' : '2412'}
          value={code}
          aria-label="NACA 4-digit code"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply();
          }}
        />
      )}
      <Button size="sm" variant="outline" onClick={apply}>
        Apply
      </Button>
      {problem && (
        <span role="alert" className="w-full text-xs text-destructive">
          {problem}
        </span>
      )}
    </div>
  );
}

/**
 * The panel's controls, once the fin has one (File settings): turn the fin in it, or let
 * the app turn and tilt it to what needs the thinnest panel. The 3D view's Panel fit
 * shows the result.
 */
function PanelTools({ store, minThickness }: { store: StoreApi<FinState>; minThickness: number }) {
  const angle = useFinState(store, (s) => s.design?.panel?.angle);
  if (angle === undefined) return null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Panel">
      <Tooltip label="The fin turned in the panel, seen from above (±45°): see it in the 3D view's Panel fit. The fin itself doesn't change, nor its exports">
        <div className="w-36 text-sm">
          <DegField
            label="Panel angle"
            value={angle}
            onCommit={(v) => store.getState().setPanelAngle(v)}
          />
        </div>
      </Tooltip>
      <FitToPanel store={store} minThickness={minThickness} />
    </div>
  );
}

/**
 * The section's controls, for the large pane's toolbar: the inside-face choice (side
 * and quad-rear fins), the NACA presets, and the panel's.
 */
export const FinSectionTools = memo(function FinSectionTools({
  store,
  units,
  minThickness = FIN_EXPORT_MIN_THICKNESS.default,
}: {
  store: StoreApi<FinState>;
  units: LengthUnit;
  /** The exports' minimum thickness (cm): the panel holds the fin as exported. */
  minThickness?: number;
}) {
  const position = useFinState(store, (s) => s.design?.position);
  // Asymmetric: the foil has an inside face of its own (flat, split or NACA-cambered).
  const asymmetric = useFinState(store, (s) =>
    s.design ? getFoil(s.design, s.activeFoil)?.inside !== null : false,
  );
  if (!position) return null;
  const centre = position === 'centre';
  return (
    <>
      <FoilTabs store={store} units={units} />
      {!centre && (
        <div className="flex gap-1" role="group" aria-label="Inside face">
          <Button
            size="sm"
            variant={asymmetric ? 'outline' : 'default'}
            aria-pressed={!asymmetric}
            onClick={() => store.getState().setInsideFace('symmetric')}
          >
            Symmetric
          </Button>
          <Button
            size="sm"
            variant={asymmetric ? 'default' : 'outline'}
            aria-pressed={asymmetric}
            onClick={() => {
              // Already asymmetric: keep the faces (a split or a NACA camber) as they are.
              if (!asymmetric) store.getState().setInsideFace('flat');
            }}
          >
            Asymmetric
          </Button>
        </div>
      )}
      <NacaPicker store={store} centre={centre} />
      <PointTools store={store} />
      <PanelTools store={store} minThickness={minThickness} />
    </>
  );
});

/** Tabs for the foils: the root's and each slice's, by height. */
function FoilTabs({ store, units }: { store: StoreApi<FinState>; units: LengthUnit }) {
  const design = useFinState(store, (s) => s.design);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  if (!design) return null;
  const depth = finReadouts(design).depth;
  // The sweep's two foils, then each horizontal slice foil by height.
  const tabs: [number, string][] = [
    [0, 'Base'],
    [TIP_FOIL, 'Tip'],
    ...design.slices.map((sl, i): [number, string] => [i + 1, fmtLen(sl.height * depth, units)]),
  ];
  return (
    <div className="flex gap-1" role="tablist" aria-label="Foil">
      {tabs.map(([foil, label]) => (
        <Button
          key={foil}
          size="sm"
          role="tab"
          aria-selected={activeFoil === foil}
          variant={activeFoil === foil ? 'default' : 'outline'}
          onClick={() => store.getState().setActiveFoil(foil)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

/**
 * The least share of the thickness the outside face takes (%). 50 / 50 is symmetric,
 * which has its own button; below it the tab would no longer sit under the foil.
 */
const MIN_OUTSIDE = 51;

/** A whole percentage, 0 to 100, or null for anything else. */
const parsePct = (text: string): number | null => {
  const v = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null;
};

/**
 * How an asymmetric foil's thickness is shared: outside above the chord line, inside
 * below, as shapers describe a foil (70 / 30). Typing one fills in the other; Enter or
 * leaving the field builds the foil from it (split-foil.ts).
 */
function SplitFields({ store, share }: { store: StoreApi<FinState>; share: number }) {
  const shown = Math.round(share * 100);
  // What the user is typing in one box, and which box, until it is committed.
  const [draft, setDraft] = useState<{ side: 'outside' | 'inside'; text: string } | null>(null);
  const typed = draft ? parsePct(draft.text) : null;
  const outsideNow = draft
    ? draft.side === 'outside'
      ? draft.text
      : typed === null
        ? ''
        : String(100 - typed)
    : String(shown);
  const insideNow = draft
    ? draft.side === 'inside'
      ? draft.text
      : typed === null
        ? ''
        : String(100 - typed)
    : String(100 - shown);
  const commit = () => {
    if (draft && typed !== null) {
      // At least 51 / 49: an even split is the Symmetric button's.
      const outside = Math.max(MIN_OUTSIDE, draft.side === 'outside' ? typed : 100 - typed);
      store.getState().setFoilSplit(outside / 100);
    }
    setDraft(null);
  };
  const field = (side: 'outside' | 'inside', label: string, color: string, value: string) => (
    <label className="flex flex-col gap-0.5">
      <span style={{ color }}>{label}</span>
      <NumericInput
        value={value}
        onValueChange={(text) => setDraft({ side, text })}
        onCommit={commit}
        onEscape={() => setDraft(null)}
        ariaLabel={`${label} share of the thickness (%)`}
        className="h-7 w-12 px-1 text-center tabular-nums"
      />
    </label>
  );
  return (
    <div
      className="absolute left-2 top-1 z-10 flex items-end gap-1 text-xs"
      role="group"
      aria-label="Outside and inside share of the thickness"
    >
      {field('outside', 'Outside', OUTSIDE, outsideNow)}
      <span className="pb-1.5 text-muted-foreground">/</span>
      {field('inside', 'Inside', INSIDE, insideNow)}
    </div>
  );
}

/** The section canvas. `frameKey` re-fits the view (the pane moving large or small). */
export const FinSectionPane = memo(function FinSectionPane({
  store,
  units,
  frameKey = '',
  minThickness = FIN_EXPORT_MIN_THICKNESS.default,
}: {
  store: StoreApi<FinState>;
  units: LengthUnit;
  frameKey?: string;
  /** The exports' minimum thickness (cm): the panel holds the fin as exported. */
  minThickness?: number;
}) {
  const design = useFinState(store, (s) => s.design);
  const selection = useFinState(store, (s) => s.selection);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  const handlers = useMemo(() => curveEditorHandlers(store), [store]);
  const section = design ? (getFoil(design, activeFoil) ?? undefined) : undefined;
  const trueScale = useMemo(
    () => (design ? foilTrueScale(design, activeFoil) : 1),
    [design, activeFoil],
  );

  const layers = useMemo((): FinCurveLayer[] => {
    if (!section) return [];
    const outside: FinCurveLayer = {
      id: 'outside',
      spline: section.outside,
      editable: true,
      color: OUTSIDE,
    };
    return section.inside
      ? [{ id: 'inside', spline: section.inside, editable: true, color: INSIDE }, outside]
      : [
          {
            id: 'mirror',
            spline: mirrored(section.outside),
            editable: false,
            ghost: true,
            color: OUTSIDE,
          },
          outside,
        ];
  }, [section]);

  // Where the taper's thickness applies: this foil's thickest point. On the base and tip
  // foils it is the thickness path's end too: drag it (or the path) and both follow. A
  // horizontal slice starts as the fin's own section, thickest where the fin is, so it
  // has no handle.
  const thickestAt = useMemo(() => (section ? sectionThickest(section).at : null), [section]);
  // A slice's chord past the tip line is the tip's (owner's rules): shaded. Where a slice
  // crosses the tip line, each foil shows the other there as a dot to match by hand.
  const tipPart = useMemo(
    () => (design && activeFoil > 0 ? tipSpanOf(design, activeFoil) : null),
    [design, activeFoil],
  );
  const dots = useMemo((): { x: number; o: number; i: number; color: string }[] => {
    if (!design) return [];
    if (activeFoil > 0) {
      const c = tipPart ? sliceTipCrossing(design, activeFoil - 1) : null;
      return c
        ? [{ x: c.sliceAt, o: c.tipInSlice.outside, i: c.tipInSlice.inside, color: TIP_DOT }]
        : [];
    }
    if (activeFoil !== TIP_FOIL) return [];
    return design.slices.flatMap((_, k) => {
      const c = sliceTipCrossing(design, k);
      return c
        ? [{ x: c.tipAt, o: c.sliceInTip.outside, i: c.sliceInTip.inside, color: SLICE_DOT }]
        : [];
    });
  }, [design, activeFoil, tipPart]);
  const markers = useMemo(
    () =>
      thickestAt === null || activeFoil > 0
        ? []
        : [
            {
              id: 'thickest',
              at: { x: thickestAt, y: 0 },
              color: PATH_COLOR,
              label: 'Thickest point',
            },
          ],
    [thickestAt, activeFoil],
  );
  const markerHandlers = useMemo(
    () => ({
      onMarkerDragStart: () => store.getState().beginEdit('Move the thickest point'),
      onMarkerDrag: (_id: string, to: { x: number }) =>
        store.getState().setFoilThickest(store.getState().activeFoil, to.x),
      onMarkerDragEnd: () => store.getState().endEdit(),
    }),
    [store],
  );

  // The panel's faces, level and true to scale, either side of the foil's middle at its
  // thickest: green if the whole fin fits the panel, orange if not.
  const fit = usePanelFit(store, minThickness);
  const panelLines = useMemo(() => {
    if (!design?.panel || !section || thickestAt === null) return null;
    const { chord } = foilSize(design, activeFoil);
    if (!(chord > 0)) return null;
    const [o, i] = [
      yAtX(section.outside, thickestAt),
      section.inside ? yAtX(section.inside, thickestAt) : -yAtX(section.outside, thickestAt),
    ];
    const half = design.panel.thickness / 2 / chord / trueScale;
    const mid = (o + i) / 2;
    return {
      lo: mid - half,
      hi: mid + half,
      fits: fit?.fits ?? true,
      thickness: design.panel.thickness,
    };
  }, [design, section, thickestAt, activeFoil, trueScale, fit]);

  const drawUnder = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      _vp: unknown,
      toScreen: (p: { x: number; y: number }) => { x: number; y: number },
    ) => {
      const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const sa = toScreen(a);
        const sb = toScreen(b);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
      };
      ctx.save();
      if (tipPart) {
        // The tip past the tip line, full height: the tip foil shapes it, not the slice.
        const a = toScreen({ x: tipPart[0], y: 0 }).x;
        const b = toScreen({ x: tipPart[1], y: 0 }).x;
        ctx.fillStyle = TIP_PART;
        ctx.fillRect(a, 0, b - a, ctx.canvas.height);
      }
      // The other foil at a crossing: a reference, not a handle. A symmetric foil's inside
      // face is its outside mirrored, so one dot does.
      for (const dot of dots) {
        for (const y of section?.inside ? [dot.o, dot.i] : [dot.o]) {
          const p = toScreen({ x: dot.x, y });
          // A ring, wider than a curve point: matched, the point sits in it.
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = dot.color;
          ctx.stroke();
        }
      }
      ctx.strokeStyle = GUIDE;
      ctx.fillStyle = GUIDE;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      line({ x: -0.03, y: 0 }, { x: 1.03, y: 0 }); // the chord line
      // Labels and the thickest-point mark are placed in pixels from the chord line, so
      // they read the same however small the pane is.
      const chord = toScreen({ x: 0, y: 0 }).y;
      const at = (x: number) => toScreen({ x, y: 0 }).x;
      if (thickestAt !== null) {
        ctx.beginPath();
        ctx.moveTo(at(thickestAt), 0);
        ctx.lineTo(at(thickestAt), chord + 20);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.font = '11px system-ui, sans-serif';
      const label = (text: string, x: number, dy: number, align: CanvasTextAlign) => {
        ctx.textAlign = align;
        ctx.fillText(text, at(x), chord + dy);
      };
      label('Leading edge', 0, 16, 'left');
      label('Trailing edge', 1, 16, 'right');
      if (tipPart)
        label(
          'Past the tip line: shaped by the tip foil',
          tipPart[1] >= 1 ? 1 : 0,
          32,
          tipPart[1] >= 1 ? 'right' : 'left',
        );
      if (activeFoil === TIP_FOIL && dots.length)
        label('Aqua: a slice where it crosses', 1, 32, 'right');
      if (thickestAt !== null) label('thickest', thickestAt, 32, 'center');
      if (panelLines) {
        ctx.strokeStyle = panelLines.fits ? PANEL_FIT : PANEL_OVER;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 5]);
        for (const y of [panelLines.lo, panelLines.hi]) {
          const a = toScreen({ x: -0.1, y });
          const b = toScreen({ x: 1.1, y });
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.textAlign = 'right';
        const top = toScreen({ x: 1, y: panelLines.hi });
        ctx.fillText(`Panel ${fmtThick(panelLines.thickness, units)}`, top.x, top.y - 4);
      }
      ctx.restore();
    },
    [thickestAt, panelLines, units, tipPart, dots, section, activeFoil],
  );

  if (!design || !section) return null;
  return (
    <div className="relative h-full">
      {section.inside && design.position !== 'centre' ? (
        <SplitFields store={store} share={foilShare(section)} />
      ) : (
        <span
          className="pointer-events-none absolute left-2 top-1 z-10 flex gap-2 text-xs"
          aria-hidden
        >
          <span style={{ color: OUTSIDE }}>— outside</span>
          {section.inside && <span style={{ color: INSIDE }}>— inside</span>}
        </span>
      )}
      <span
        className="pointer-events-none absolute right-2 top-1 z-10 flex flex-col items-end text-xs"
        data-testid="foil-title"
      >
        <span className="font-medium text-foreground">{foilTitle(design, activeFoil, units)}</span>
        <span className="text-muted-foreground" aria-hidden>
          True scale · scroll to zoom
        </span>
      </span>
      <FinCurveEditor
        label="Foil section"
        layers={layers}
        selection={pickFromSelection(selection, ['outside', 'inside'])}
        alsoSelected={alsoFromSelection(selection, ['outside', 'inside'])}
        yScale={trueScale}
        frameBounds={SECTION_FRAME}
        frameKey={`${design.position}-${activeFoil}-${frameKey}`}
        drawUnder={drawUnder}
        markers={markers}
        {...markerHandlers}
        {...handlers}
      />
    </div>
  );
});
