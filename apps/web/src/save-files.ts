// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Writing files where the person chose: into a folder they picked, where the browser
 * lets a page do that (the File System Access API: Chrome and Edge on a computer), or
 * as downloads everywhere else, where the browser's own setting decides the folder.
 *
 * The chosen folder is remembered (IndexedDB holds the folder's handle, never a path),
 * so it is offered again next time. The browser asks once a visit before a page may
 * write to it again.
 */
import { download, MULTI_DOWNLOAD_GAP_MS } from './file-io';
import { objectStore, openSingleStoreDb, promisify } from './idb';

/** A file to write. */
export interface OutFile {
  readonly name: string;
  readonly data: BlobPart;
  readonly type: string;
}

/** The parts of the File System Access API that TypeScript's DOM types leave out. */
type Permission = 'granted' | 'denied' | 'prompt';
interface PermissionHandle {
  queryPermission?(o: { mode: 'readwrite' }): Promise<Permission>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<Permission>;
}
type Picker = (o: { id?: string; mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

const picker = (): Picker | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;

/** Whether this browser lets the page write into a folder the person picks. */
export const canChooseFolder = (): boolean => picker() !== undefined;

/** Ask for a folder. Null if the person closed the picker. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | null> {
  const pick = picker();
  if (!pick) return null;
  try {
    return await pick.call(window, { id: 'openfinshaper', mode: 'readwrite' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

/**
 * Whether the page may write into `folder`, asking if it must. Call it from the click
 * that saves: the browser only shows its question during one.
 */
export async function allowWrite(folder: FileSystemDirectoryHandle): Promise<boolean> {
  const h = folder as FileSystemDirectoryHandle & PermissionHandle;
  if (!h.queryPermission || !h.requestPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** Which of `names` are already in `folder`. */
export async function existingNames(
  folder: FileSystemDirectoryHandle,
  names: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    try {
      await folder.getFileHandle(name);
      found.push(name);
    } catch {
      // Not there (NotFoundError), or not readable without permission: nothing to warn about.
    }
  }
  return found;
}

/** Write `files` into `folder` (replacing any of the same name), or download them. */
export async function writeFiles(
  files: readonly OutFile[],
  folder: FileSystemDirectoryHandle | null,
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (folder) {
      const handle = await folder.getFileHandle(f.name, { create: true });
      const out = await handle.createWritable();
      await out.write(new Blob([f.data], { type: f.type }));
      await out.close();
    } else {
      // Spaced, so the browser keeps every download.
      if (i > 0) await new Promise((r) => setTimeout(r, MULTI_DOWNLOAD_GAP_MS));
      download(f.data, f.name, f.type);
    }
  }
}

/** Characters no common file system accepts in a name, and control characters. */
// eslint-disable-next-line no-control-regex
const NOT_IN_NAMES = /[\\/:*?"<>|\u0000-\u001f]+/g;

/**
 * The name typed, made safe for a file: without the extension if it was typed too,
 * without characters a file name can't hold, and `fallback` if nothing is left.
 */
export function cleanStem(text: string, ext: string, fallback: string): string {
  let s = text.trim();
  if (s.toLowerCase().endsWith(ext.toLowerCase())) s = s.slice(0, -ext.length);
  s = s
    .replace(NOT_IN_NAMES, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return s || fallback;
}

/* The remembered folder: one IndexedDB record holding the handle. */
const DB = 'openfinshaper-save-folder';
const STORE = 'folder';
const KEY = 'fin';

const db = () => openSingleStoreDb(indexedDB, DB, 1, STORE, 'id');

/** The folder saved to last, if it is remembered here. */
export async function recallFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof indexedDB === 'undefined' || !canChooseFolder()) return null;
  try {
    const rec = (await promisify(objectStore(await db(), STORE, 'readonly').get(KEY))) as
      { handle?: FileSystemDirectoryHandle } | undefined;
    return rec?.handle ?? null;
  } catch {
    return null;
  }
}

/** Remember `folder` for next time, or forget it (null: back to downloads). */
export async function rememberFolder(folder: FileSystemDirectoryHandle | null): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const store = objectStore(await db(), STORE, 'readwrite');
    if (folder) await promisify(store.put({ id: KEY, handle: folder }));
    else await promisify(store.delete(KEY));
  } catch {
    // Not remembered: it is only a convenience.
  }
}
