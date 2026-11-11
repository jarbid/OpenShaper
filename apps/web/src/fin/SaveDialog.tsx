// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The dialog Save and Export open: a name for each file, and where it goes.
 *
 * Where the browser lets a page write into a folder (Chrome and Edge on a computer),
 * Location picks one and remembers it. Elsewhere files go to the browser's downloads
 * folder, and the dialog says how to have the browser ask where instead.
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useState } from 'react';
import { Modal } from '../components/modal';
import {
  allowWrite,
  canChooseFolder,
  chooseFolder,
  cleanStem,
  existingNames,
  recallFolder,
  rememberFolder,
} from '../save-files';

/**
 * Names typed this visit, by the name first offered, so the next save offers the name
 * the person chose. Forgotten when a fin is opened or started ({@link forgetSavedNames}).
 */
const typedNames = new Map<string, string>();

/** A different fin: offer its own names again. */
export const forgetSavedNames = (): void => typedNames.clear();

/** One file the dialog names. */
export interface SaveItem {
  /** The field's label: "File name", "Left fin". */
  readonly label: string;
  /** The name offered first, without the extension. */
  readonly stem: string;
}

export function SaveDialog({
  title,
  action,
  busyLabel,
  items,
  ext,
  note,
  onSave,
  onClose,
}: {
  title: string;
  /** The button that writes: "Save", "Export". */
  action: string;
  /** Shown on that button while the files are made and written: "Exporting…". */
  busyLabel: string;
  items: readonly SaveItem[];
  /** The extension added to every name: ".fin.json". */
  ext: string;
  /** A line under the names, for what is being written. */
  note?: string;
  /** Make and write the files, named `stems` (in `items`' order), into `folder` or downloads. */
  onSave: (stems: string[], folder: FileSystemDirectoryHandle | null) => Promise<void>;
  onClose: () => void;
}) {
  const [texts, setTexts] = useState(() => items.map((it) => typedNames.get(it.stem) ?? it.stem));
  const stems = texts.map((t, i) => cleanStem(t, ext, items[i]!.stem));
  const names = stems.map((s) => `${s}${ext}`);
  const clash = new Set(names).size < names.length;

  const pickable = canChooseFolder();
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  useEffect(() => {
    let live = true;
    void recallFolder().then((f) => {
      if (live && f) setFolder((cur) => cur ?? f);
    });
    return () => {
      live = false;
    };
  }, []);

  // Which of the names would replace a file already in the folder.
  const [replacing, setReplacing] = useState<string[]>([]);
  const namesKey = names.join('\n');
  useEffect(() => {
    if (!folder) return setReplacing([]);
    let live = true;
    void existingNames(folder, namesKey.split('\n')).then((found) => {
      if (live) setReplacing(found);
    });
    return () => {
      live = false;
    };
  }, [folder, namesKey]);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async () => {
    try {
      const f = await chooseFolder();
      if (!f) return;
      setFolder(f);
      setProblem(null);
      void rememberFolder(f);
    } catch {
      setProblem("That folder can't be used. Choose another, or save to Downloads.");
    }
  };
  const useDownloads = () => {
    setFolder(null);
    setProblem(null);
    void rememberFolder(null);
  };

  const save = async () => {
    if (busy || clash) return;
    // Asked first, inside the click: the browser only shows its question during one.
    if (folder && !(await allowWrite(folder))) {
      setProblem(`OpenFinShaper may not save to ${folder.name}. Choose it again, or another.`);
      return;
    }
    setBusy(true);
    setProblem(null);
    // Let the busy label paint before the work (a STEP takes about a second a fin).
    await new Promise((r) => setTimeout(r, 0));
    try {
      await onSave(stems, folder);
      items.forEach((it, i) => typedNames.set(it.stem, stems[i]!));
      onClose();
    } catch (e) {
      setBusy(false);
      setProblem(`Not saved: ${(e as Error).message || 'the files could not be written'}.`);
    }
  };

  return (
    <Modal
      name="fin-save"
      label={title}
      onClose={busy ? () => {} : onClose}
      className="grid place-items-center p-4"
    >
      {/* Clicks inside the panel aren't backdrop clicks. */}
      <Panel className="flex w-full max-w-md flex-col" onClick={(e) => e.stopPropagation()}>
        <PanelHeader>
          <PanelTitle>{title}</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4 text-sm">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {items.map((it, i) => (
              <label key={it.stem} className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0">{it.label}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <input
                    className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1"
                    aria-label={it.label}
                    value={texts[i]}
                    onChange={(e) => {
                      const v = e.target.value;
                      setTexts((t) => t.map((x, j) => (j === i ? v : x)));
                    }}
                    autoFocus={i === 0}
                    onFocus={(e) => e.target.select()}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    disabled={busy}
                  />
                  <span className="text-muted-foreground">{ext}</span>
                </span>
              </label>
            ))}
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0">Location</span>
              <span className="min-w-0 flex-1 truncate" data-testid="save-location">
                {folder ? folder.name : 'Downloads'}
              </span>
              {pickable && (
                <span className="flex gap-1">
                  {folder && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={useDownloads}
                    >
                      Use Downloads
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void pick()}
                  >
                    Choose folder…
                  </Button>
                </span>
              )}
            </div>
            {!pickable && (
              <p className="text-xs text-muted-foreground">
                Your browser saves to its downloads folder. To pick the folder each time, turn on
                “Ask where to save each file” in the browser’s settings.
              </p>
            )}
            {clash && (
              <p role="alert" className="text-xs text-destructive">
                Give each file its own name.
              </p>
            )}
            {!clash && replacing.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {replacing.join(' and ')} {replacing.length > 1 ? 'are' : 'is'} already in{' '}
                {folder?.name}: {action} replaces {replacing.length > 1 ? 'them' : 'it'}.
              </p>
            )}
            {problem && (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || clash}>
                {busy ? busyLabel : action}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>
    </Modal>
  );
}
