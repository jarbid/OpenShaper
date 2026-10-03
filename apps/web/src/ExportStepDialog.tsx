/**
 * STEP export dialog: pick the file's unit and how closely the fitted surfaces
 * track the design.
 *
 * Deliberately two knobs, not five. The exporter's other inputs — station rows,
 * ring columns — are means to the accuracy end, and exposing them would ask the
 * user to reason about B-spline control nets to get a board out. Accuracy is the
 * thing they can actually judge, against a real scale: a CNC blank cutter finishes
 * at 0.1–0.5 mm.
 *
 * Modeled on ExportPdf1to1Dialog (backdrop + Panel, Escape-to-close, reset).
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useState } from 'react';
import { fmtSmallLen, unitSuffix, type LengthUnit } from './format';
import { SelectRow } from './export-form-atoms';
import {
  DEFAULT_STEP,
  STEP_TOLERANCE_CM,
  type StepAccuracy,
  type StepSettings,
  type StepUnitChoice,
} from './step-export-settings';
import { Modal } from './components/modal';

/** What each accuracy setting means, in terms a shaper can weigh. */
const ACCURACY_NOTES: Record<StepAccuracy, string> = {
  draft: 'Smallest and quickest. Still finer than a blank cutter’s finishing pass.',
  standard: 'Well inside anything a machine or a sanding block can resolve. Use this.',
  fine: 'Beyond what matters for a board. For taking the surface into CAD to build from.',
};

export interface ExportStepDialogProps {
  units: LengthUnit;
  /** Current persisted settings, used to pre-populate the form. */
  settings: StepSettings;
  /** Called with the chosen settings to persist + run the export. */
  onExport: (settings: StepSettings) => void;
  onClose: () => void;
}

export function ExportStepDialog({ units, settings, onExport, onClose }: ExportStepDialogProps) {
  const [draft, setDraft] = useState<StepSettings>({ ...settings });

  const set = <K extends keyof StepSettings>(key: K, value: StepSettings[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const exportNow = () => {
    onExport(draft);
    onClose();
  };

  const toleranceCm = STEP_TOLERANCE_CM[draft.accuracy];

  return (
    <Modal
      name="export-step"
      label="Export STEP"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      <Panel
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Export STEP</PanelTitle>
          <Button size="sm" variant="ghost" title="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="space-y-5 overflow-y-auto text-sm">
          <p className="text-sm text-muted-foreground">
            The board as one solid body with true curved surfaces — what CAD and CAM want. Fin boxes
            are not included.
          </p>

          <SelectRow
            label="Units"
            value={draft.unit}
            options={[
              { value: 'auto', label: `Follow editor (${unitSuffix(units)})` },
              { value: 'mm', label: 'Millimetres' },
              { value: 'cm', label: 'Centimetres' },
              { value: 'in', label: 'Inches' },
            ]}
            onChange={(v) => set('unit', v as StepUnitChoice)}
          />
          <p className="-mt-3 text-xs text-muted-foreground">
            The file states its own unit, so the board lands at the right size either way. This only
            changes the numbers inside it.
          </p>

          <SelectRow
            label="Accuracy"
            value={draft.accuracy}
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'standard', label: 'Standard' },
              { value: 'fine', label: 'Fine' },
            ]}
            onChange={(v) => set('accuracy', v as StepAccuracy)}
          />
          <p className="-mt-3 text-xs text-muted-foreground">
            {ACCURACY_NOTES[draft.accuracy]} Surfaces are fitted to within about{' '}
            {fmtSmallLen(toleranceCm, units)} of the design.
          </p>
        </PanelBody>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...DEFAULT_STEP })}>
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={exportNow}>
              Export
            </Button>
          </div>
        </div>
      </Panel>
    </Modal>
  );
}
