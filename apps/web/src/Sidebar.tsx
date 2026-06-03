/**
 * The right-hand sidebar: spec readout, resize, board info, fins, weight estimate,
 * trace-image controls, the control-point inspector, analysis toggles, and the
 * ghost comparison. State is owned by the app shell and threaded in as props —
 * this component is purely presentational so the shell stays the single source of
 * truth (several of these values also drive the editor overlays).
 */
import type { InterpolationType } from '@openshaper/kernel';
import type { BoardSpecs } from '@openshaper/store';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { ControlPointInspector } from './ControlPointInspector';
import { CoffeeIcon } from './components/Support';
import { SUPPORT_URL } from './support';
import type { BoardMeta } from './file-io';
import { fmtLen, fmtVol, type LengthUnit } from './format';
import { FIN_SETUP_LABELS, FIN_SETUPS, type FinSetup } from './fins';
import { boardStore } from './store';
import { OverlayToggle, Sel, SpecRow } from './view-toolkit';
import {
  fmtWeight,
  FOAM_TYPES,
  GLASS_SCHEDULES,
  type FoamType,
  type GlassSchedule,
  type WeightBreakdown,
} from './weights';

/** Signed length difference (current − ghost) in the active units. */
function diffLen(cur: number, ghost: number, units: LengthUnit): string {
  const d = cur - ghost;
  return `${d >= 0 ? '+' : '−'}${fmtLen(Math.abs(d), units)}`;
}

/** Signed volume difference (current − ghost) in liters. */
function diffVol(cur: number, ghost: number): string {
  const d = cur - ghost;
  return `${d >= 0 ? '+' : '−'}${fmtVol(Math.abs(d))}`;
}

export interface ResizeFields {
  l: string;
  w: string;
  t: string;
}

export interface OverlayToggles {
  comb: boolean;
  com: boolean;
  dist: boolean;
}

export interface SidebarProps {
  specs: BoardSpecs | null;
  units: LengthUnit;
  interpolationType: InterpolationType;

  resize: ResizeFields;
  setResize: Dispatch<SetStateAction<ResizeFields>>;
  applyResize: () => void;

  meta: BoardMeta;
  setMeta: Dispatch<SetStateAction<BoardMeta>>;

  finType: FinSetup;
  foamType: FoamType;
  glassSchedule: GlassSchedule;
  weight: WeightBreakdown | null;

  trace: HTMLImageElement | null;
  setTrace: Dispatch<SetStateAction<HTMLImageElement | null>>;
  traceInput: RefObject<HTMLInputElement>;
  onOpenTrace: (e: React.ChangeEvent<HTMLInputElement>) => void;
  traceOpacity: number;
  setTraceOpacity: Dispatch<SetStateAction<number>>;
  traceScale: number;
  setTraceScale: Dispatch<SetStateAction<number>>;
  traceOffset: { x: number; y: number };
  setTraceOffset: Dispatch<SetStateAction<{ x: number; y: number }>>;

  overlayToggles: OverlayToggles;
  setOverlayToggles: Dispatch<SetStateAction<OverlayToggles>>;

  ghost: boolean;
  ghostSpecs: BoardSpecs | null;
}

export function Sidebar({
  specs,
  units,
  interpolationType,
  resize,
  setResize,
  applyResize,
  meta,
  setMeta,
  finType,
  foamType,
  glassSchedule,
  weight,
  trace,
  setTrace,
  traceInput,
  onOpenTrace,
  traceOpacity,
  setTraceOpacity,
  traceScale,
  setTraceScale,
  traceOffset,
  setTraceOffset,
  overlayToggles,
  setOverlayToggles,
  ghost,
  ghostSpecs,
}: SidebarProps) {
  return (
    <div className="flex w-72 min-h-0 shrink-0 flex-col gap-3 overflow-y-auto pr-0.5">
      <Panel>
        <PanelHeader>
          <PanelTitle>Specs</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-1 text-sm">
          {specs ? (
            <>
              <SpecRow label="Length" value={fmtLen(specs.length, units)} />
              <SpecRow label="Width" value={fmtLen(specs.maxWidth, units)} />
              <SpecRow label="Thickness" value={fmtLen(specs.thickness, units)} />
              <SpecRow label="Wide point" value={fmtLen(specs.maxWidthPos, units)} />
              <SpecRow label="Max rocker" value={fmtLen(specs.maxRocker, units)} />
              <SpecRow label="Volume" value={fmtVol(specs.volume)} />
              <SpecRow label="Center of mass" value={fmtLen(specs.centerOfMass, units)} />
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-muted-foreground">Interpolation</span>
                <Sel
                  value={interpolationType}
                  onChange={(t) => boardStore.getState().setInterpolationType(t)}
                  options={[
                    { value: 'controlPoint', label: 'Control point' },
                    { value: 'sLinear', label: 'S-blend' },
                  ]}
                  title="Cross-section interpolation model"
                />
              </div>
              <p className="pt-2 text-xs text-muted-foreground">
                Live from the kernel — every pane edits the same board, so changes sync across views
                and the specs update instantly.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">Loading…</p>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Resize</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-2 text-sm">
          {(
            [
              ['l', 'Length', specs?.length],
              ['w', 'Width', specs?.maxWidth],
              ['t', 'Thickness', specs?.thickness],
            ] as const
          ).map(([key, label, cur]) => (
            <label key={key} className="flex items-center gap-2">
              <span className="w-16 text-muted-foreground">{label}</span>
              <Input
                value={resize[key]}
                placeholder={cur != null ? fmtLen(cur, units) : ''}
                onChange={(e) => setResize((r) => ({ ...r, [key]: e.target.value }))}
              />
            </label>
          ))}
          <Button size="sm" variant="secondary" disabled={!specs} onClick={applyResize}>
            Apply
          </Button>
          <p className="text-xs text-muted-foreground">
            Blank fields keep that dimension; others scale to the target. Undoable.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Board info</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-2 text-sm">
          {(['designer', 'model', 'surfer'] as const).map((field) => (
            <label key={field} className="flex items-center gap-2">
              <span className="w-16 capitalize text-muted-foreground">{field}</span>
              <Input
                value={meta[field] ?? ''}
                placeholder="—"
                onChange={(e) => setMeta((m) => ({ ...m, [field]: e.target.value }))}
              />
            </label>
          ))}
          <textarea
            value={meta.comments ?? ''}
            placeholder="Comments…"
            onChange={(e) => setMeta((m) => ({ ...m, comments: e.target.value }))}
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Fins</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-2 text-sm">
          <Sel
            value={finType}
            onChange={(f) => setMeta((m) => ({ ...m, finType: f }))}
            options={FIN_SETUPS.map((sx) => ({ value: sx, label: FIN_SETUP_LABELS[sx] }))}
            title="Fin setup"
          />
          <p className="text-xs text-muted-foreground">
            Shown on the outline near the tail; saved with the board.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Weight estimate</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-2 text-sm">
          <div className="flex gap-2">
            <Sel
              value={foamType}
              onChange={(f) => setMeta((m) => ({ ...m, foamType: f }))}
              options={FOAM_TYPES.map((f) => ({ value: f, label: f }))}
              title="Foam type"
            />
            <Sel
              value={glassSchedule}
              onChange={(g) => setMeta((m) => ({ ...m, glassSchedule: g }))}
              options={GLASS_SCHEDULES.map((g) => ({ value: g, label: `${g} oz` }))}
              title="Glass schedule"
            />
          </div>
          {weight ? (
            <>
              <SpecRow label="Foam" value={fmtWeight(weight.foam)} />
              <SpecRow label="Glass" value={fmtWeight(weight.cloth)} />
              <SpecRow label="Resin" value={fmtWeight(weight.resin)} />
              <SpecRow label="Hardware" value={fmtWeight(weight.hardware)} />
              <div className="border-t border-border pt-1 font-semibold">
                <SpecRow label="Total" value={fmtWeight(weight.total)} />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">—</p>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Trace image</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-2 text-sm">
          <input
            ref={traceInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onOpenTrace}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => traceInput.current?.click()}>
              {trace ? 'Replace…' : 'Load image…'}
            </Button>
            {trace && (
              <Button size="sm" variant="ghost" onClick={() => setTrace(null)}>
                Clear
              </Button>
            )}
          </div>
          {trace && (
            <>
              <label className="flex items-center gap-2">
                <span className="w-14 text-muted-foreground">Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={traceOpacity}
                  onChange={(e) => setTraceOpacity(Number(e.target.value))}
                  className="flex-1"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="w-14 text-muted-foreground">Scale</span>
                <input
                  type="range"
                  min={0.3}
                  max={2}
                  step={0.02}
                  value={traceScale}
                  onChange={(e) => setTraceScale(Number(e.target.value))}
                  className="flex-1"
                />
              </label>
              <div className="flex gap-2">
                <label className="flex flex-1 items-center gap-1">
                  <span className="text-muted-foreground">X</span>
                  <Input
                    value={String(traceOffset.x)}
                    onChange={(e) =>
                      setTraceOffset((o) => ({ ...o, x: Number(e.target.value) || 0 }))
                    }
                  />
                </label>
                <label className="flex flex-1 items-center gap-1">
                  <span className="text-muted-foreground">Y</span>
                  <Input
                    value={String(traceOffset.y)}
                    onChange={(e) =>
                      setTraceOffset((o) => ({ ...o, y: Number(e.target.value) || 0 }))
                    }
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Shows behind the outline — align with opacity/scale/offset, then trace.
              </p>
            </>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Control point</PanelTitle>
        </PanelHeader>
        <PanelBody className="text-sm">
          <ControlPointInspector store={boardStore} units={units} />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Analysis</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-1 text-sm">
          <OverlayToggle
            label="Curvature comb"
            checked={overlayToggles.comb}
            onChange={(v) => setOverlayToggles((s) => ({ ...s, comb: v }))}
          />
          <OverlayToggle
            label="Center of mass"
            checked={overlayToggles.com}
            onChange={(v) => setOverlayToggles((s) => ({ ...s, com: v }))}
          />
          <OverlayToggle
            label="Volume distribution"
            checked={overlayToggles.dist}
            onChange={(v) => setOverlayToggles((s) => ({ ...s, dist: v }))}
          />
          <p className="pt-1 text-xs text-muted-foreground">
            Comb shows on the edited curves; CoM &amp; volume distribution on the outline and
            rocker.
          </p>
        </PanelBody>
      </Panel>

      {ghost && specs && ghostSpecs && (
        <Panel>
          <PanelHeader>
            <PanelTitle>Compare (Δ vs ghost)</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1 text-sm">
            <SpecRow label="Length" value={diffLen(specs.length, ghostSpecs.length, units)} />
            <SpecRow label="Width" value={diffLen(specs.maxWidth, ghostSpecs.maxWidth, units)} />
            <SpecRow
              label="Thickness"
              value={diffLen(specs.thickness, ghostSpecs.thickness, units)}
            />
            <SpecRow label="Volume" value={diffVol(specs.volume, ghostSpecs.volume)} />
            <p className="pt-1 text-xs text-muted-foreground">
              Dashed grey curves are the ghost board.
            </p>
          </PanelBody>
        </Panel>
      )}

      {SUPPORT_URL && (
        <a
          href={SUPPORT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/30"
          title="Buy me a coffee — support OpenShaper"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-secondary text-primary transition-transform group-hover:-translate-y-px">
            <CoffeeIcon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium">Buy me a coffee</span>
            <span className="block text-xs text-muted-foreground">
              Free &amp; open-source — chip in if it helps
            </span>
          </span>
        </a>
      )}
    </div>
  );
}
