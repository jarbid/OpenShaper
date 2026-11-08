// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The horizontal foil, editable: outside face and inside face over the chord line
 * (docs/design/fin-designer.md, step 12). Drawn four times taller than true, so a
 * 10%-thick foil can be shaped by hand. A symmetric foil (every centre fin) has one
 * face; the other is shown mirrored, dashed. NACA 4-digit presets replace both faces,
 * which stay editable afterwards. The dashed vertical marks the thickest point, where
 * the taper's thickness applies. An
 * asymmetric foil shows how its thickness is shared
 * (outside / inside, top left); typing a share rebuilds the foil as leading-edge radii
 * and straight lines (split-foil.ts).
 */
import {
  FIN_EXPORT_MIN_THICKNESS,
  foilShare,
  smoothSectionDistance,
  knot,
  parseNaca4,
  sectionThickest,
  splineFromKnots,
  vec2,
  yAtX,
  type FinDesign,
  type Spline,
} from '@openshaper/kernel';
import {
  FIN_CANVAS_FONT,
  FIN_CANVAS_LABEL,
  FinCurveEditor,
  type FinCurveLayer,
} from '@openshaper/render2d';
import { foilSize, foilTrueScale, getFoil, TIP_FOIL, type FinState } from '@openshaper/store';
import { Button, Tooltip } from '@openshaper/ui';
import { memo, useCallback, useMemo, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { DegField } from '../components/fields';
import { NumericInput } from '../components/numeric-input';
import { fmtLen, fmtThick, type LengthUnit } from '../format';
import { alsoFromSelection, curveEditorHandlers, pickFromSelection } from './curve-editor-wiring';
import { PointTools } from './PointTools';
import { useFinState } from './use-fin';
import { useSettledDesign } from './use-settled-design';
import {
  FOIL_ANALYSIS_DEFAULT,
  FOIL_ANALYSIS_EVERY,
  foilGhosts,
  ghostAt,
  type FoilAlign,
  type FoilAnalysis,
  type FoilGhost,
  type FoilShow,
} from './foil-analysis';
import { LenField } from '../components/fields';
import { FitToPanel, PANEL_FIT, PANEL_OVER } from './panel-tools';
import { PATH_COLOR } from './sweep-overlay';
import { usePanelFit } from './use-panel-fit';

// The real size a foil is drawn for, and its true-scale stretch: in the store, which
// keeps foils stored near their true thickness (withFoilsNearTrueScale).
export { foilSize, foilTrueScale };

/** What the foil view is showing, as the profile names it. */
export const foilTitle = (d: FinDesign, foil: number, units: LengthUnit): string =>
  foil === 0
    ? 'Base foil'
    : foil === TIP_FOIL
      ? 'Tip foil'
      : `Control section ${fmtLen(smoothSectionDistance(d, d.slices[foil - 1]?.height ?? 0), units)}`;

/** Keep the chord line and a strip under it (for the labels) in view; the faces add the rest. */
const SECTION_FRAME = { minX: 0, maxX: 1, minY: -0.12, maxY: 0.02 };

/** The presets in the dropdown; "Other…" takes any 4-digit code. */
const SUGGESTED = ['0008', '0010', '0012', '2408', '2410', '2412', '4409', '4412', '6409'];

const OUTSIDE = '#22D3EE';
const INSIDE = '#A78BFA';
const GUIDE = 'rgba(138,155,179,0.7)';

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
      <Tooltip label="Turn the fin in the panel (±45°); see it in Panel fit">
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
  const share = useFinState(store, (s) => {
    const sec = s.design && getFoil(s.design, s.activeFoil);
    return sec?.inside ? foilShare(sec) : null;
  });
  if (!position) return null;
  const centre = position === 'centre';
  return (
    <>
      <FoilTabs store={store} units={units} />
      {!centre && (
        <div className="flex gap-1" role="group" aria-label="Inside face">
          <Button
            size="sm"
            variant={asymmetric ? 'outline' : 'selected'}
            aria-pressed={!asymmetric}
            onClick={() => store.getState().setInsideFace('symmetric')}
          >
            Symmetric
          </Button>
          <Button
            size="sm"
            variant={asymmetric ? 'selected' : 'outline'}
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
      {/* Beside Asymmetric, which it belongs to (owner review: it sat on the canvas). */}
      {!centre && share !== null && <SplitFields store={store} share={share} />}
      <NacaPicker store={store} centre={centre} />
      <PointTools store={store} />
      <PanelTools store={store} minThickness={minThickness} />
    </>
  );
});

/**
 * The foil analysis's controls (owner request), over the canvas at its top left: the same
 * place and look as the 3D view's Analysis (SectionAnalysis.tsx), so both work alike
 * (owner review, repetition). On or off, how the other sections line up with this foil,
 * and which to show.
 */
function AnalysisOverlay({
  analysis,
  onChange,
  units,
}: {
  analysis: FoilAnalysis;
  onChange: (a: FoilAnalysis) => void;
  units: LengthUnit;
}) {
  const set = (patch: Partial<FoilAnalysis>) => onChange({ ...analysis, ...patch });
  const chip = 'flex items-center gap-1 rounded bg-background/80 px-1.5 py-1';
  const select = 'h-6 rounded border border-input bg-background px-1 text-xs';
  return (
    <div
      className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2 text-xs"
      role="group"
      aria-label="Analysis"
    >
      <Button
        size="sm"
        variant={analysis.on ? 'selected' : 'outline'}
        aria-pressed={analysis.on}
        onClick={() => set({ on: !analysis.on })}
      >
        Analysis
      </Button>
      {analysis.on && (
        <>
          <label className={chip}>
            Align
            <select
              className={select}
              aria-label="Align sections"
              value={analysis.align}
              onChange={(e) => set({ align: e.target.value as FoilAlign })}
            >
              <option value="thickest">Thickest point</option>
              <option value="front">Front</option>
              <option value="rear">Rear</option>
              <option value="tab">On the tab</option>
            </select>
          </label>
          <label className={chip}>
            Show
            <select
              className={select}
              aria-label="Sections to show"
              value={analysis.show}
              onChange={(e) => set({ show: e.target.value as FoilShow })}
            >
              <option value="sections">Control sections, base and tip</option>
              <option value="every">Sections every…</option>
            </select>
          </label>
          {analysis.show === 'every' && (
            <div className={chip}>
              <LenField
                label="Every"
                valueCm={analysis.every}
                units={units}
                onCommit={(cm) =>
                  set({
                    every: Math.min(FOIL_ANALYSIS_EVERY.max, Math.max(FOIL_ANALYSIS_EVERY.min, cm)),
                  })
                }
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Tabs for the foils: the root's and each slice's, by height. */
function FoilTabs({ store, units }: { store: StoreApi<FinState>; units: LengthUnit }) {
  const design = useFinState(store, (s) => s.design);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  if (!design) return null;
  // The sweep's two foils, then each horizontal slice foil by height.
  const tabs: [number, string][] = [
    [0, 'Base'],
    [TIP_FOIL, 'Tip'],
    ...design.slices.map((sl, i): [number, string] => [
      i + 1,
      fmtLen(smoothSectionDistance(design, sl.height), units),
    ]),
  ];
  return (
    <div className="flex gap-1" role="tablist" aria-label="Foil">
      {tabs.map(([foil, label]) => (
        <Button
          key={foil}
          size="sm"
          role="tab"
          aria-selected={activeFoil === foil}
          variant={activeFoil === foil ? 'selected' : 'outline'}
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
    <label className="flex items-center gap-1">
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
      className="flex items-center gap-1 text-sm"
      role="group"
      aria-label="Outside and inside share of the thickness"
    >
      {field('outside', 'Outside', OUTSIDE, outsideNow)}
      <span className="text-muted-foreground">/</span>
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
  analysis = FOIL_ANALYSIS_DEFAULT,
  onAnalysis,
}: {
  store: StoreApi<FinState>;
  units: LengthUnit;
  frameKey?: string;
  /** The exports' minimum thickness (cm): the panel holds the fin as exported. */
  minThickness?: number;
  /** The other sections drawn faintly behind this foil (foil-analysis.ts), if on. */
  analysis?: FoilAnalysis;
  /** Setting it, from the Analysis controls over the canvas: none without it. */
  onAnalysis?: (a: FoilAnalysis) => void;
}) {
  const design = useFinState(store, (s) => s.design);
  const selection = useFinState(store, (s) => s.selection);
  const activeFoil = useFinState(store, (s) => s.activeFoil);
  const handlers = useMemo(() => curveEditorHandlers(store), [store]);
  const section = design ? (getFoil(design, activeFoil) ?? undefined) : undefined;
  const editing = useFinState(store, (s) => s.editing);
  const liveScale = useMemo(
    () => (design ? foilTrueScale(design, activeFoil) : 1),
    [design, activeFoil],
  );
  // Held through a drag: read afresh at every step, the stretch changed as the dragged
  // point changed the foil's thickness, moving the points not dragged (owner testing).
  const [heldScale, setHeldScale] = useState(liveScale);
  if (!editing && heldScale !== liveScale) setHeldScale(liveScale);
  const trueScale = editing ? heldScale : liveScale;
  // The frame is on screen: the chord line and a strip under it, however tall the foil
  // is stored (scaled with the foil, a thin one's frame zoomed the view far out).

  // The analysis's sections, from the settled design: a drag recuts them once, on release.
  const settled = useSettledDesign(store);
  const ghosts = useMemo(
    () => (analysis.on && settled ? foilGhosts(settled, activeFoil, analysis) : []),
    [analysis, settled, activeFoil],
  );
  // The frame takes the analysis's sections in too: on the tab, a canted fin's upper
  // sections sit well off the active foil.
  const frame = useMemo(() => {
    const f = {
      ...SECTION_FRAME,
      minY: SECTION_FRAME.minY / trueScale,
      maxY: SECTION_FRAME.maxY / trueScale,
    };
    for (const g of ghosts) {
      for (const p of g.outline) {
        f.minX = Math.min(f.minX, p.x);
        f.maxX = Math.max(f.maxX, p.x);
        f.minY = Math.min(f.minY, p.y / trueScale);
        f.maxY = Math.max(f.maxY, p.y / trueScale);
      }
    }
    return f;
  }, [trueScale, ghosts]);
  const analysisKey = analysis.on ? `${analysis.align}-${analysis.show}-${analysis.every}` : 'off';
  const [hoveredGhost, setHoveredGhost] = useState(-1);
  const onHover = useCallback(
    (at: { x: number; y: number } | null, unitsPerPx: number) => {
      if (!at || ghosts.length === 0) return setHoveredGhost(-1);
      // Hover in data units; the ghosts are in true chord units (y stretched).
      setHoveredGhost(ghostAt(ghosts, { x: at.x, y: at.y * trueScale }, unitsPerPx * 6));
    },
    [ghosts, trueScale],
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
      // The analysis's sections first, lowest in the hierarchy: thin slate outlines, the
      // higher on the fin the stronger (the stack order: from above, nearer reads
      // brighter), the one under the pointer named.
      ghosts.forEach((g, i) => {
        const on = i === hoveredGhost;
        ctx.save();
        ctx.lineWidth = on ? 1.5 : 1;
        ctx.strokeStyle = on
          ? 'rgba(230,237,245,0.9)'
          : `rgba(138,155,179,${(0.18 + 0.37 * g.level).toFixed(3)})`;
        ctx.beginPath();
        g.outline.forEach((p, k) => {
          const q = toScreen({ x: p.x, y: p.y / trueScale });
          if (k === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        });
        ctx.closePath();
        ctx.stroke();
        if (on) {
          const top = g.outline.reduce((a, p) => (p.y > a.y ? p : a));
          const q = toScreen({ x: top.x, y: top.y / trueScale });
          ctx.font = FIN_CANVAS_FONT;
          ctx.fillStyle = 'rgba(230,237,245,0.9)';
          ctx.textAlign = 'center';
          ctx.fillText(ghostName(g, units), q.x, q.y - 6);
        }
        ctx.restore();
      });
      ctx.save();
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
      ctx.font = FIN_CANVAS_FONT;
      ctx.fillStyle = FIN_CANVAS_LABEL;
      const label = (text: string, x: number, dy: number, align: CanvasTextAlign) => {
        ctx.textAlign = align;
        ctx.fillText(text, at(x), chord + dy);
      };
      label('Leading edge', 0, 16, 'left');
      label('Trailing edge', 1, 16, 'right');
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
    [thickestAt, panelLines, units, ghosts, hoveredGhost, trueScale],
  );

  if (!design || !section) return null;
  return (
    <div className="relative h-full">
      {onAnalysis && <AnalysisOverlay analysis={analysis} onChange={onAnalysis} units={units} />}
      {/* The faces' key at the bottom left: the top left is the Analysis controls'. */}
      <span
        className="pointer-events-none absolute bottom-1 left-2 z-10 flex gap-2 text-xs"
        aria-hidden
      >
        <span style={{ color: OUTSIDE }}>— outside</span>
        {section.inside && <span style={{ color: INSIDE }}>— inside</span>}
      </span>
      <span
        className="pointer-events-none absolute right-2 top-1 z-10 flex flex-col items-end text-xs"
        data-testid="foil-title"
      >
        <span className="font-medium text-foreground">{foilTitle(design, activeFoil, units)}</span>
        <span className="text-muted-foreground" aria-hidden>
          True scale
        </span>
      </span>
      <FinCurveEditor
        label="Foil"
        layers={layers}
        selection={pickFromSelection(selection, ['outside', 'inside'])}
        alsoSelected={alsoFromSelection(selection, ['outside', 'inside'])}
        yScale={trueScale}
        frameBounds={frame}
        frameKey={`${design.position}-${activeFoil}-${frameKey}-${analysisKey}`}
        drawUnder={drawUnder}
        markers={markers}
        onHover={ghosts.length ? onHover : undefined}
        {...markerHandlers}
        {...handlers}
      />
    </div>
  );
});

/** What a section of the analysis is, for its label: which foil, or how high. */
const ghostName = (g: FoilGhost, units: LengthUnit): string =>
  g.kind === 'base'
    ? 'Base foil'
    : g.kind === 'tip'
      ? 'Tip foil'
      : g.kind === 'control'
        ? `Control section ${fmtLen(g.height, units)}`
        : `${fmtLen(g.height, units)} up`;
