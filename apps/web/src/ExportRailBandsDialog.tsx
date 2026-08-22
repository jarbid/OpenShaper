/**
 * Rail-bands export dialog: how many facets to cut into the rail, at what angles, and
 * how often along the board.
 *
 * One thing this dialog does that the others do not: it runs the geometry on the draft
 * settings and shows any notes **before** you export. A shaper reading a printed number
 * has no way to tell a confident wrong one from a right one, so anything the solver was
 * unsure about has to surface while the settings are still changeable.
 */
import {
  railBandTradeoff,
  railFacetPlan,
  type BezierBoard,
  type RailAngleMode,
  type RailManualSpec,
} from '@openshaper/kernel';
import { PAPER_SIZES } from '@openshaper/export';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useMemo, useState } from 'react';
import { fmtLen, type LengthUnit } from './format';
import { CheckRow, Group, IntField, LenField, SelectRow } from './export-form-atoms';
import { DEFAULT_RAIL_BANDS, type RailBandsSettings } from './rail-bands-settings';

const PLACEMENT_OPTIONS = [
  { value: 'least-foam', label: 'Least foam (fitted)' },
  { value: 'ladder', label: 'Halving ladder' },
  { value: 'manual', label: 'Manual' },
];

const BY_OPTIONS = [
  { value: 'distance', label: 'By marks' },
  { value: 'angle', label: 'By angle' },
];

/**
 * What each placement actually trades. Stated in terms of the two things a shaper can
 * see on the finished board — how much foam is left, and how sharp the rail stays —
 * rather than in terms of the objective being minimised.
 */
const PLACEMENT_NOTES: Record<RailAngleMode, string> = {
  'least-foam':
    'Every band solved from this board’s own sections — the angles change down the length. Removes the most foam per pass, at the cost of a wider first band than tradition cuts.',
  ladder: '45°, then halving: 45 / 22.5 / 11.25. The angles on every printed reference card.',
  manual:
    'Your own numbers. The sheet still checks them against the board and flags any band that would cut into the finished rail.',
};

/** The draft's manual fields as the kernel wants them. */
export const manualSpecOf = (d: RailBandsSettings): RailManualSpec => ({
  by: d.manualBy,
  angles: d.manualAngles.slice(0, d.bands),
  railPercent: d.railPercent,
  ...(d.railPercentTail !== null ? { railPercentTail: d.railPercentTail } : {}),
  ...(d.railPercentNose !== null ? { railPercentNose: d.railPercentNose } : {}),
  ...(d.markScaleTailPct !== null ? { markScaleTail: d.markScaleTailPct / 100 } : {}),
  ...(d.markScaleNosePct !== null ? { markScaleNose: d.markScaleNosePct / 100 } : {}),
  deckInCm: d.deckInCm.slice(0, d.bands),
  tuckUpCm: d.tuckUpCm,
  tuckInCm: d.tuckInCm,
});

export interface ExportRailBandsDialogProps {
  board: BezierBoard;
  units: LengthUnit;
  /** Current persisted settings, used to pre-populate the form. */
  settings: RailBandsSettings;
  /** Called with the chosen settings to persist + run the export. */
  onExport: (settings: RailBandsSettings) => void;
  onClose: () => void;
}

export function ExportRailBandsDialog({
  board,
  units,
  settings,
  onExport,
  onClose,
}: ExportRailBandsDialogProps) {
  const [draft, setDraft] = useState<RailBandsSettings>({ ...settings });
  const [showNotes, setShowNotes] = useState(false);

  const set = <K extends keyof RailBandsSettings>(key: K, value: RailBandsSettings[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  /** Edit one entry of a per-band array, growing it if the band count ran ahead of it. */
  const setAt = (key: 'manualAngles' | 'deckInCm', i: number, value: number): void =>
    setDraft((prev) => {
      const next = [...prev[key]];
      while (next.length <= i) next.push(value);
      next[i] = value;
      return { ...prev, [key]: next };
    });

  const bandIndexes = Array.from({ length: draft.bands }, (_, i) => i);

  /**
   * Seed the manual marks from what the fit chose for this board, at the widepoint.
   *
   * A chart written for a 2 1/2 inch board is the wrong starting point for the board in
   * front of you — Greenlight's own egg-rail tuck cuts millimetres into a performance
   * shortboard's hard edge. Starting from the fitted numbers means the first thing a
   * shaper adjusts is already true of their own shape.
   */
  const copyFitted = (): void => {
    const fit = railFacetPlan(board, {
      deckBands: draft.bands,
      angleMode: 'least-foam',
      bottomAngle: draft.bottomAngle,
      targetSpacingCm: draft.stationSpacingCm,
      endMarginCm: draft.endMarginCm,
    });
    const st = fit.stations.find((s) => s.position >= fit.widePoint) ?? fit.stations[0];
    if (!st) return;
    const mark = (f: (typeof st.deckFacets)[number] | undefined, kind: string): number | null =>
      f?.marks.find((m) => m.ref.kind === kind)?.distance ?? null;
    const railPctOf = (s: (typeof fit.stations)[number]): number | null => {
      const up = mark(s.deckFacets[0], 'railPlane');
      return up !== null && s.blank.thickness > 0 ? (up / s.blank.thickness) * 100 : null;
    };
    const railUp = mark(st.deckFacets[0], 'railPlane');
    const tuck = st.bottomFacets[0];

    // The mark scale is deliberately *not* seeded. Fitting one from the tip's own deck
    // mark was tried and measured: it cut the shortboard's overcuts from 9 to 2 and made
    // the funboard's worse, 10 to 14, because the deck marks and the tuck want different
    // scales and no single number serves both. Seed only what improves every board — the
    // rail percentage does, on all three — and leave the rest as a dial.
    setDraft((prev) => ({
      ...prev,
      manualAngles: st.deckFacets.map((f) => f.targetAngle),
      ...(railUp !== null && st.blank.thickness > 0
        ? { railPercent: Math.round((railUp / st.blank.thickness) * 100) }
        : {}),
      railPercentTail: railPctOf(fit.stations[0]!)
        ? Math.round(railPctOf(fit.stations[0]!)!)
        : prev.railPercentTail,
      railPercentNose: railPctOf(fit.stations[fit.stations.length - 1]!)
        ? Math.round(railPctOf(fit.stations[fit.stations.length - 1]!)!)
        : prev.railPercentNose,
      deckInCm: st.deckFacets.map((f, i) => mark(f, 'deckPlane') ?? prev.deckInCm[i] ?? 2.5),
      ...(tuck
        ? {
            tuckUpCm: mark(tuck, 'railPlane') ?? prev.tuckUpCm,
            tuckInCm: mark(tuck, 'bottomPlane') ?? prev.tuckInCm,
          }
        : {}),
    }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Cheap enough to run on every keystroke: a handful of stations, each a few hundred
  // spline evaluations. If that ever stops being true it belongs in the specs worker.
  const plan = useMemo(
    () =>
      railFacetPlan(board, {
        deckBands: draft.bands,
        angleMode: draft.angleMode,
        manual: manualSpecOf(draft),
        bottomAngle: draft.bottomAngle,
        targetSpacingCm: draft.stationSpacingCm,
        endMarginCm: draft.endMarginCm,
      }),
    [board, draft],
  );

  // What the target actually worked out to. The two sides of the widepoint are fitted
  // separately, so report the mean gap rather than implying a single exact interval.
  const actualSpacing = useMemo(() => {
    const xs = plan.stations.map((s) => s.position);
    if (xs.length < 2) return null;
    return (xs[xs.length - 1]! - xs[0]!) / (xs.length - 1);
  }, [plan]);

  const notes = useMemo(() => [...new Set(plan.warnings.map((w) => w.message))], [plan]);

  // What each band count would take out, averaged over the stations. The dynamic program
  // returns every count from the one run that answers the chosen one, so showing where
  // the returns die costs nothing — and it is the question a shaper actually has, which
  // is not "what angle" but "is another pass worth cutting".
  const tradeoff = useMemo(() => {
    const rows = plan.stations.map((st) => railBandTradeoff(st.section, { angleMode: draft.angleMode })); // prettier-ignore
    const n = Math.min(...rows.map((r) => r.length), 6);
    if (!Number.isFinite(n) || n < 1) return [];
    return Array.from({ length: n }, (_, i) => ({
      bands: i + 1,
      removed: rows.reduce((acc, r) => acc + r[i]!.removed, 0) / rows.length,
    }));
  }, [plan, draft.angleMode]);

  // The angles are fitted per station, so quote the widepoint's — the section a rail is
  // designed around — and say so rather than implying one set for the whole board.
  const wp = plan.stations.find((st) => st.position >= plan.widePoint) ?? plan.stations[0];
  const angles = wp?.deckFacets.map((f) => `${f.targetAngle}°`).join(' / ') ?? '—';
  const removedNow = tradeoff.find((t) => t.bands === draft.bands)?.removed;

  const exportNow = () => {
    onExport(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Panel
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Export rail bands</PanelTitle>
          <Button size="sm" variant="ghost" title="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="space-y-5 overflow-y-auto text-sm">
          <p className="text-sm text-muted-foreground">
            The flat facets to plane into a squared blank, worked out from this board’s own
            sections. One page maps the stations; each station then gets a 1:1 page with its marks
            and angles.
          </p>

          <Group title="Bands">
            <SelectRow
              label="Placement"
              value={draft.angleMode}
              options={PLACEMENT_OPTIONS}
              onChange={(v) => set('angleMode', v as RailAngleMode)}
            />
            <p className="-mt-1 text-xs text-muted-foreground">
              {PLACEMENT_NOTES[draft.angleMode]}
            </p>
            <IntField
              label="Deck bands"
              value={draft.bands}
              min={1}
              max={6}
              onChange={(v) => set('bands', v)}
            />
            <p className="-mt-1 text-xs text-muted-foreground">
              {plan.stations.length > 0 && (
                <>
                  {angles} at the widepoint
                  {removedNow !== undefined && (
                    <> — takes out {(removedNow * 100).toFixed(0)}% of the foam left proud</>
                  )}
                  .{' '}
                </>
              )}
              {tradeoff.length > 1 && (
                <>
                  By band count:{' '}
                  {tradeoff.map((t) => `${t.bands}: ${(t.removed * 100).toFixed(0)}%`).join(' · ')}
                </>
              )}
            </p>
            {draft.angleMode === 'manual' && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <SelectRow
                    label="Set out"
                    value={draft.manualBy}
                    options={BY_OPTIONS}
                    onChange={(v) => set('manualBy', v as 'angle' | 'distance')}
                  />
                </div>
                <Button size="sm" variant="ghost" className="w-full" onClick={copyFitted}>
                  Start from the fitted marks
                </Button>
                <p className="-mt-1 text-xs text-muted-foreground">
                  Fills these in from what the fit chose for <em>this</em> board, so you are
                  adjusting real numbers rather than a chart written for someone else&rsquo;s.
                </p>
                {draft.manualBy === 'angle'
                  ? bandIndexes.map((i) => (
                      <IntField
                        key={i}
                        label={`Band ${i + 1} angle`}
                        value={Math.round(draft.manualAngles[i] ?? 10)}
                        min={2}
                        max={88}
                        onChange={(v) => setAt('manualAngles', i, v)}
                      />
                    ))
                  : [
                      <IntField
                        key="pct"
                        label="Rail mark (% up the rail face)"
                        value={draft.railPercent}
                        min={20}
                        max={85}
                        onChange={(v) => set('railPercent', v)}
                      />,
                      ...bandIndexes.map((i) => (
                        <LenField
                          key={i}
                          label={`Deck mark ${i + 1}`}
                          cm={draft.deckInCm[i] ?? 2.5 * (i + 1)}
                          units={units}
                          onChange={(cm) => setAt('deckInCm', i, Math.max(0.1, cm))}
                        />
                      )),
                    ]}
                <p className="-mt-1 text-xs text-muted-foreground">
                  {draft.manualBy === 'distance' ? (
                    <>
                      The rail mark goes up the rail face from the bottom corner, deck marks in from
                      the top corner. As a percentage it holds as the board thins, and the deck
                      marks scale with it. Each band after the first starts at the midpoint of the
                      one before. This is the mark, not the finished rail: the apex ends up below
                      it, and a &ldquo;60/40&rdquo; names where that apex lands, counted from the
                      deck.
                    </>
                  ) : (
                    <>
                      Each band is the tangent at that angle, measured off the deck plane — one set
                      for the whole board. Most shapers steepen the bands through the middle and
                      harden them toward the tips; the fitted mode does that for you.
                    </>
                  )}
                </p>
                {draft.manualBy === 'distance' && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Vary the rail along the board</summary>
                    <div className="mt-2 space-y-2">
                      <IntField
                        label="Rail % at the tail"
                        value={draft.railPercentTail ?? draft.railPercent}
                        min={20}
                        max={85}
                        onChange={(v) => set('railPercentTail', v)}
                      />
                      <IntField
                        label="Rail % at the nose"
                        value={draft.railPercentNose ?? draft.railPercent}
                        min={20}
                        max={85}
                        onChange={(v) => set('railPercentNose', v)}
                      />
                      <IntField
                        label="Mark scale at the tail (%)"
                        value={draft.markScaleTailPct ?? 100}
                        min={40}
                        max={200}
                        onChange={(v) => set('markScaleTailPct', v)}
                      />
                      <IntField
                        label="Mark scale at the nose (%)"
                        value={draft.markScaleNosePct ?? 100}
                        min={40}
                        max={200}
                        onChange={(v) => set('markScaleNosePct', v)}
                      />
                      <p>
                        A lower rail percentage is a harder, lower rail — what most boards want
                        through the tail. The mark scale is the rest of the adjustment a shaper
                        makes by eye: thickness alone gets the rail mark right but runs the deck
                        marks and tuck a little small toward the tips, because the rail hardens
                        there rather than just shrinking. Leave both alone to hold one rail the
                        whole way.
                      </p>
                    </div>
                  </details>
                )}
              </>
            )}
            {draft.angleMode === 'manual' && draft.manualBy === 'distance' ? (
              <>
                <LenField
                  label="Tuck up from the corner"
                  cm={draft.tuckUpCm}
                  units={units}
                  onChange={(cm) => set('tuckUpCm', Math.max(0.05, cm))}
                />
                <LenField
                  label="Tuck in from the corner"
                  cm={draft.tuckInCm}
                  units={units}
                  onChange={(cm) => set('tuckInCm', Math.max(0.05, cm))}
                />
                <p className="-mt-1 text-xs text-muted-foreground">
                  An egg rail is about 1/2 in up by 7/8 in in; a pinched rail 5/8 by 1.
                </p>
              </>
            ) : (
              <>
                <IntField
                  label="Tuck angle (degrees)"
                  value={draft.bottomAngle}
                  min={5}
                  max={85}
                  onChange={(v) => set('bottomAngle', v)}
                />
                <p className="-mt-1 text-xs text-muted-foreground">
                  One band on the bottom, usually cut at whatever your plane is set to.
                </p>
              </>
            )}
          </Group>

          <Group title="Stations">
            <LenField
              label="Target spacing"
              cm={draft.stationSpacingCm}
              units={units}
              onChange={(cm) => set('stationSpacingCm', Math.max(2, cm))}
            />
            <LenField
              label="Leave each end"
              cm={draft.endMarginCm}
              units={units}
              onChange={(cm) => set('endMarginCm', Math.max(0, cm))}
            />
            <p className="-mt-1 text-xs text-muted-foreground">
              {plan.stations.length === 0 ? (
                'No room for a station — reduce how much of each end you leave.'
              ) : (
                <>
                  {plan.stations.length} station{plan.stations.length === 1 ? '' : 's'} from{' '}
                  {fmtLen(plan.stations[0]!.position, units)} to{' '}
                  {fmtLen(plan.stations[plan.stations.length - 1]!.position, units)}
                  {actualSpacing !== null && <> , about {fmtLen(actualSpacing, units)} apart</>}.
                  Spacing is adjusted to land on both ends and on the widepoint at{' '}
                  {fmtLen(plan.widePoint, units)}.
                </>
              )}
            </p>
          </Group>

          <Group title="Pages">
            <CheckRow
              label="1:1 page per station"
              value={draft.detailPages}
              onChange={(v) => set('detailPages', v)}
            />
            <CheckRow
              label="Show the finished rail behind the facets"
              value={draft.ghostSection}
              onChange={(v) => set('ghostSection', v)}
              disabled={!draft.detailPages}
            />
            <CheckRow
              label="Print a calibration ruler"
              value={draft.calibration}
              onChange={(v) => set('calibration', v)}
              disabled={!draft.detailPages}
            />
            <SelectRow
              label="Paper"
              value={draft.paperId}
              options={PAPER_SIZES.map((p) => ({ value: p.id, label: p.label }))}
              onChange={(v) => set('paperId', v)}
            />
            <p className="-mt-1 text-xs text-muted-foreground">
              Detail pages print at true 1:1. If a rail needs more room than the sheet, the page
              grows — it is never scaled down.
            </p>
          </Group>

          {notes.length > 0 && (
            <div className="rounded border border-border bg-muted/30 p-3">
              <button
                type="button"
                className="text-sm font-medium"
                onClick={() => setShowNotes((s) => !s)}
              >
                {notes.length} note{notes.length === 1 ? '' : 's'} on this board{' '}
                <span className="text-muted-foreground">{showNotes ? '▾' : '▸'}</span>
              </button>
              {showNotes && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {notes.map((nt) => (
                    <li key={nt}>{nt}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </PanelBody>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...DEFAULT_RAIL_BANDS })}>
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={plan.stations.length === 0} onClick={exportNow}>
              Export
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
