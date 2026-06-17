/**
 * Settings dialog: editor curve colors, ghost/grid colors, control-point size,
 * and curve stroke thickness. Persisted to localStorage via the settings module.
 * Modeled on the ConstructionPanel modal pattern (fixed-inset backdrop, Panel card).
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useState } from 'react';
import { DEFAULT_SETTINGS, type EditorSettings } from './settings';

// ---- tiny form atoms -------------------------------------------------------

function ColorRow({
  label,
  value,
  onChange,
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3" htmlFor={id}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        id={id}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
      />
    </label>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="h-8 w-20 rounded border border-border bg-background px-2 text-right text-sm"
      />
    </label>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

// ---- main component --------------------------------------------------------

export interface SettingsDialogProps {
  /** The current (persisted) settings, used to pre-populate the form. */
  settings: EditorSettings;
  /** Called with the new settings when the user clicks Apply. */
  onSave: (s: EditorSettings) => void;
  onClose: () => void;
}

/**
 * Modal settings dialog. Renders as a backdrop + centered Panel card,
 * matching the ConstructionPanel pattern from App.tsx.
 */
export function SettingsDialog({ settings, onSave, onClose }: SettingsDialogProps) {
  // Local draft — the user can tweak and cancel without committing.
  const [draft, setDraft] = useState<EditorSettings>({ ...settings });

  const set = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const resetToDefaults = () => setDraft({ ...DEFAULT_SETTINGS });

  const apply = () => {
    onSave(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Panel className="flex w-full max-w-md flex-col" onClick={(e) => e.stopPropagation()}>
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Settings</PanelTitle>
          <Button size="sm" variant="ghost" title="Close settings" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="space-y-5 overflow-y-auto text-sm">
          {/* --- Curve colors --- */}
          <SettingsGroup title="Curve colors">
            <ColorRow
              id="setting-outline-color"
              label="Outline"
              value={draft.outlineColor}
              onChange={(v) => set('outlineColor', v)}
            />
            <ColorRow
              id="setting-deck-color"
              label="Deck (rocker)"
              value={draft.deckColor}
              onChange={(v) => set('deckColor', v)}
            />
            <ColorRow
              id="setting-bottom-color"
              label="Bottom (rocker)"
              value={draft.bottomColor}
              onChange={(v) => set('bottomColor', v)}
            />
            <ColorRow
              id="setting-cs-color"
              label="Cross-section"
              value={draft.crossSectionColor}
              onChange={(v) => set('crossSectionColor', v)}
            />
          </SettingsGroup>

          {/* --- Overlay colors --- */}
          <SettingsGroup title="Overlay colors">
            <ColorRow
              id="setting-ghost-color"
              label="Ghost board"
              value={draft.ghostColor}
              onChange={(v) => set('ghostColor', v)}
            />
            <ColorRow
              id="setting-grid-color"
              label="Grid"
              value={draft.gridColor}
              onChange={(v) => set('gridColor', v)}
            />
          </SettingsGroup>

          {/* --- 3D view --- */}
          <SettingsGroup title="3D view">
            <ColorRow
              id="setting-fin-color"
              label="Fin blades"
              value={draft.finColor}
              onChange={(v) => set('finColor', v)}
            />
          </SettingsGroup>

          {/* --- Sizes --- */}
          <SettingsGroup title="Sizes">
            <NumberRow
              label="Control-point size (px)"
              value={draft.controlPointSize}
              min={2}
              max={12}
              step={1}
              onChange={(v) => set('controlPointSize', v)}
            />
            <NumberRow
              label="Curve thickness (px)"
              value={draft.curveThickness}
              min={0.5}
              max={8}
              step={0.5}
              onChange={(v) => set('curveThickness', v)}
            />
          </SettingsGroup>
        </PanelBody>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={resetToDefaults}>
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
