/**
 * Blocking confirmation shown when importing a file required REMOVING geometry
 * (a dropped cross-section). Lists what changed and lets the user proceed or
 * cancel (cancel = nothing loads, so they can fix the source in Shape3d).
 * Modeled on the SettingsDialog backdrop + Panel pattern.
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import type { ImportWarning } from '@openshaper/io';

export interface ImportWarningsDialogProps {
  fileName: string;
  /** Data-loss warnings (≥1 — that's why the dialog is shown). */
  dropped: ImportWarning[];
  /** Non-destructive notes shown for context. */
  info: ImportWarning[];
  onImportAnyway: () => void;
  onCancel: () => void;
}

export function ImportWarningsDialog({
  fileName,
  dropped,
  info,
  onImportAnyway,
  onCancel,
}: ImportWarningsDialogProps) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onCancel}>
      <Panel
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader>
          <PanelTitle>Import will change &quot;{fileName}&quot;</PanelTitle>
        </PanelHeader>

        <PanelBody className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            This file can&apos;t be imported as-is. The following will be changed — review before
            continuing, or cancel and fix the file in Shape3d.
          </p>

          <ul className="space-y-1">
            {dropped.map((w, i) => (
              <li key={`d${i}`} className="text-card-foreground">
                <span className="font-semibold text-[var(--primary)]">Removed: </span>
                {w.message}
              </li>
            ))}
            {info.map((w, i) => (
              <li key={`i${i}`} className="text-muted-foreground">
                {w.message}
              </li>
            ))}
          </ul>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onImportAnyway}>Import anyway</Button>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
