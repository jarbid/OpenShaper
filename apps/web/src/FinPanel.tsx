/**
 * Fins panel: pick the configuration (single/twin/thruster/quad/2+1/5-fin) and the
 * mounting system (glass-on / FCS II / FCS x2 / Futures), then fine-tune the selected
 * fin's placement and geometry. Fins are part of the board model (`board.fins`), so all
 * edits go through the store (undoable) and re-render the 2D/3D views and exports.
 *
 * Length fields follow the editor's unit selector (`units`); angles are degrees.
 */
import {
  FIN_PROFILES_LIST,
  FIN_PROFILE_LABELS,
  FIN_SETUPS,
  FIN_SETUP_LABELS,
  FIN_SYSTEMS,
  FIN_SYSTEM_LABELS,
  type FinFoil,
  type FinProfile,
  type FinSpec,
} from '@openshaper/kernel';
import type { BoardState } from '@openshaper/store';
import { Input, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { cmToUnitNumber, parseLen, unitDecimals, unitSuffix, type LengthUnit } from './format';
import { Sel } from './view-toolkit';

const FOILS: { value: FinFoil; label: string }[] = [
  { value: '80/20', label: '80 / 20' },
  { value: '50/50', label: '50 / 50' },
  { value: 'flat', label: 'Flat' },
];

const sideLabel = (side: -1 | 0 | 1): string =>
  side === 0 ? 'Center' : side < 0 ? 'Port' : 'Starboard';

/** Editable length field (units-aware); commits on Enter/blur, reverts on Escape. */
function LenField({
  label,
  valueCm,
  units,
  onCommit,
}: {
  label: string;
  valueCm: number;
  units: LengthUnit;
  onCommit: (cm: number) => void;
}) {
  const shown = cmToUnitNumber(valueCm, units).toFixed(unitDecimals(units));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => onCommit(parseLen(text, units));
  return (
    <label className="flex items-center gap-2">
      <span className="flex-1 text-muted-foreground">{label}</span>
      <Input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-20 tabular-nums"
      />
      <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
    </label>
  );
}

/** Editable degree field (dimensionless). */
function DegField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (deg: number) => void;
}) {
  const shown = value.toFixed(1);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const n = Number.parseFloat(text);
    if (Number.isFinite(n)) onCommit(n);
    else setText(shown);
  };
  return (
    <label className="flex items-center gap-2">
      <span className="flex-1 text-muted-foreground">{label}</span>
      <Input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-20 tabular-nums"
      />
      <span className="w-6 text-xs text-muted-foreground">°</span>
    </label>
  );
}

/** Inspector for the selected fin's parametric spec. */
function FinInspector({
  store,
  units,
  index,
  spec,
}: {
  store: StoreApi<BoardState>;
  units: LengthUnit;
  index: number;
  spec: FinSpec;
}) {
  const patch = (p: Partial<FinSpec>) => store.getState().updateFin(index, p);
  return (
    <div className="space-y-1.5 rounded-md border border-border px-2 py-2 text-sm">
      <div className="text-xs font-medium text-muted-foreground">{sideLabel(spec.side)} fin</div>
      <label className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">Profile</span>
        <Sel
          value={spec.profile ?? 'performance'}
          onChange={(p) => patch({ profile: p as FinProfile })}
          options={FIN_PROFILES_LIST.map((p) => ({ value: p, label: FIN_PROFILE_LABELS[p] }))}
          title="Blade profile"
        />
      </label>
      <LenField
        label="From tail (trailing)"
        valueCm={spec.trailingFromTail}
        units={units}
        onCommit={(v) => patch({ trailingFromTail: Math.max(0, v) })}
      />
      {spec.side !== 0 && (
        <LenField
          label="Inset from rail"
          valueCm={spec.insetFromRail}
          units={units}
          onCommit={(v) => patch({ insetFromRail: Math.max(0, v) })}
        />
      )}
      <LenField
        label="Base"
        valueCm={spec.base}
        units={units}
        onCommit={(v) => patch({ base: Math.max(0.5, v) })}
      />
      <LenField
        label="Depth"
        valueCm={spec.depth}
        units={units}
        onCommit={(v) => patch({ depth: Math.max(0.5, v) })}
      />
      <DegField label="Sweep (rake)" value={spec.sweep} onCommit={(v) => patch({ sweep: v })} />
      {spec.side !== 0 && (
        <>
          <DegField label="Toe-in" value={spec.toe} onCommit={(v) => patch({ toe: v })} />
          <DegField label="Cant" value={spec.cant} onCommit={(v) => patch({ cant: v })} />
        </>
      )}
      <label className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">Foil</span>
        <Sel value={spec.foil} onChange={(f) => patch({ foil: f })} options={FOILS} title="Foil" />
      </label>
    </div>
  );
}

/** The Fins panel for the sidebar. */
export function FinPanel({ store, units }: { store: StoreApi<BoardState>; units: LengthUnit }) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  const selectedFin = useSyncExternalStore(store.subscribe, () => store.getState().selectedFin);
  if (!board) return null;
  const cfg = board.fins;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Fins</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-2 text-sm">
        <Sel
          value={cfg.setup}
          onChange={(s) => store.getState().setFinSetup(s)}
          options={FIN_SETUPS.map((s) => ({ value: s, label: FIN_SETUP_LABELS[s] }))}
          title="Fin setup"
        />
        {cfg.setup !== 'none' && (
          <>
            <Sel
              value={cfg.system}
              onChange={(s) => store.getState().setFinSystem(s)}
              options={FIN_SYSTEMS.map((s) => ({ value: s, label: FIN_SYSTEM_LABELS[s] }))}
              title="Fin system"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={cfg.symmetrical}
                onChange={(e) => store.getState().setFinSymmetrical(e.target.checked)}
              />
              Symmetrical (mirror port/starboard edits)
            </label>
            <div className="flex flex-wrap gap-1">
              {cfg.fins.map((f, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => store.getState().selectFin(selectedFin === i ? null : i)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    selectedFin === i
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border text-muted-foreground'
                  }`}
                  title={`${sideLabel(f.side)} fin`}
                >
                  {sideLabel(f.side)[0]}
                  {i + 1}
                </button>
              ))}
            </div>
            {selectedFin != null && cfg.fins[selectedFin] && (
              <FinInspector
                store={store}
                units={units}
                index={selectedFin}
                spec={cfg.fins[selectedFin]!}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Drag a fin on the outline to re-place it; fins follow the rail and rocker. Saved with
              the board and included in 3D and exports.
            </p>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
