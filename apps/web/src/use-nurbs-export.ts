// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The state of the one NURBS export that may run at a time (docs/design/m3-exports.md, decision 1):
 * what the Export menu and the progress chip show, and the way to cancel it. The compute is in
 * `nurbs-export-client.ts` (a worker per export).
 */
import type { BoardDoc } from '@openshaper/board2';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExportCancelledError, startNurbsExport, type ExportRun } from './nurbs-export-client';
import type { ExportedFile, ExportJob, ExportStage } from './workers/nurbs-protocol';

/** The words for a stage, as the menu and the chip show them. */
export const EXPORT_STAGE_TEXT: Record<ExportStage, string> = {
  building: 'building the surface',
  meshing: 'meshing',
  sampling: 'sampling the sections',
  drawing: 'drawing',
  writing: 'writing the file',
};

export interface ActiveExport {
  /** What is being made, e.g. "STL". */
  readonly label: string;
  readonly stage: ExportStage;
}

export interface NurbsExportControl {
  /** The running export, or null. */
  readonly active: ActiveExport | null;
  /** Start an export of `doc` as it is now. Ignored while one runs. */
  start(label: string, doc: BoardDoc, job: ExportJob): void;
  /** Stop the running export; nothing is downloaded. */
  cancel(): void;
}

export function useNurbsExport(handlers: {
  onDone(files: readonly ExportedFile[], label: string, ms: number, job: ExportJob): void;
  onError(message: string, label: string): void;
  onCancel(label: string): void;
}): NurbsExportControl {
  const [active, setActive] = useState<ActiveExport | null>(null);
  const run = useRef<ExportRun | null>(null);
  const label = useRef('');
  const on = useRef(handlers);
  const gone = useRef(false);
  on.current = handlers;

  const start = useCallback((name: string, doc: BoardDoc, job: ExportJob) => {
    if (run.current) return;
    label.current = name;
    setActive({ label: name, stage: 'building' });
    const r = startNurbsExport(doc, job, (stage) => setActive({ label: name, stage }));
    run.current = r;
    r.result
      .then((a) => {
        if (gone.current) return;
        if (a.ok) on.current.onDone(a.files, name, a.ms, job);
        else on.current.onError(a.error, name);
      })
      .catch((err: unknown) => {
        if (gone.current) return;
        if (err instanceof ExportCancelledError) on.current.onCancel(name);
        else on.current.onError(err instanceof Error ? err.message : String(err), name);
      })
      .finally(() => {
        if (run.current === r) run.current = null;
        setActive(null);
      });
  }, []);

  const cancel = useCallback(() => run.current?.cancel(), []);
  // Leaving the editor stops the export: nobody is waiting for the file.
  useEffect(
    () => () => {
      gone.current = true;
      run.current?.cancel();
    },
    [],
  );

  return { active, start, cancel };
}
