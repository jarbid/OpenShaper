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
} from '@openshaper/kernel';
import { PAPER_SIZES } from '@openshaper/export';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useMemo, useState } from 'react';
import { fmtLen, type LengthUnit } from './format';
import { CheckRow, Group, IntField, LenField, SelectRow } from './export-form-atoms';
import { DEFAULT_RAIL_BANDS, type RailBandsSettings } from './rail-bands-settings';

const PLACEMENT_OPTIONS = [
  { value: 'balanced', label: 'Balanced (recommended)' },
  { value: 'least-foam', label: 'Least foam' },
  { value: 'ladder', label: 'Halving ladder' },
];

/**
 * What each placement actually trades. Stated in terms of the two things a shaper can
 * see on the finished board — how much foam is left, and how sharp the rail stays —
 * rather than in terms of the objective being minimised.
 */
const PLACEMENT_NOTES: Record<RailAngleMode, string> = {
  balanced:
    'Bands placed to remove as much foam as possible, with the first held at 45° or steeper — so the rail corner is left exactly where the ladder leaves it.',
  'least-foam':
    'Removes the most foam per pass, at the cost of a wider first band — the rail corner is left about twice as proud as tradition leaves it.',
  ladder: '45°, then halving: 45 / 22.5 / 11.25. The angles on every printed reference card.',
};

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
        bottomAngle: draft.bottomAngle,
        targetSpacingCm: draft.stationSpacingCm,
        endMarginCm: draft.endMarginCm,
      }),
    [
      board,
      draft.bands,
      draft.angleMode,
      draft.bottomAngle,
      draft.stationSpacingCm,
      draft.endMarginCm,
    ],
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
