// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The saved NURBS document in the app (docs/design/m2-editor.md §5): how the Board info the editor keeps
 * (`BoardMeta`) rides in the document's `meta`, and the lazily loaded board2 code that reads and writes the
 * text. Types of board2 only here; the code (`reviveBoardDoc`, `boardDocToJson`) is `workers/nurbs-core`'s,
 * loaded on demand, so the main chunk stays free of it.
 *
 * **Meta.** The document has slots for a name, an author, a comment and a source; the app's Board info has
 * a model, a designer, comments, and four more (surfer, fin type, foam type, glass schedule). The model, the
 * designer and the comments take the three slots; the rest ride in `meta.extra`, which keeps any key it was
 * given that this app does not own, in its order. A file that is opened and saved again has the same text, and the
 * `source` slot (how a converted board began) is never touched.
 */
import type { BoardDoc } from '@openshaper/board2';
import type { BoardMeta } from './file-io';

type DocMeta = BoardDoc['meta'];
type JsonObject = { readonly [key: string]: unknown };

/** The Board info fields that live in `meta.extra`, in the order they are written. */
const EXTRA_FIELDS = ['surfer', 'finType', 'foamType', 'glassSchedule'] as const;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The Board info a document carries (empty strings are absent, as everywhere in the app). */
export function metaOfDoc(meta: DocMeta): BoardMeta {
  const out: BoardMeta = {};
  if (meta.name) out.model = meta.name;
  if (meta.author) out.designer = meta.author;
  if (meta.comment) out.comments = meta.comment;
  if (isObject(meta.extra)) {
    for (const k of EXTRA_FIELDS) {
      const v = meta.extra[k];
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
  }
  return out;
}

/**
 * The document with `meta` written into its `meta`: the three slots and, for the other four fields, the
 * `extra` keys this app owns; any other `extra` key stays. The document itself when nothing changes, so a
 * save of an unedited board does not make a new object.
 */
export function withBoardMeta(doc: BoardDoc, meta: BoardMeta): BoardDoc {
  const prev = doc.meta;
  // Keys keep the order the document had them in; a field the document did not have goes last.
  const extra: Record<string, unknown> = {};
  if (isObject(prev.extra)) {
    for (const [k, v] of Object.entries(prev.extra)) {
      if (!(EXTRA_FIELDS as readonly string[]).includes(k)) extra[k] = v;
      else if (meta[k as (typeof EXTRA_FIELDS)[number]]) {
        extra[k] = meta[k as (typeof EXTRA_FIELDS)[number]];
      }
    }
  }
  for (const k of EXTRA_FIELDS) {
    if (meta[k] && !(k in extra)) extra[k] = meta[k];
  }

  const next: { -readonly [K in keyof DocMeta]: DocMeta[K] } = { name: meta.model ?? '' };
  if (meta.designer) next.author = meta.designer;
  if (meta.comments) next.comment = meta.comments;
  if (prev.source !== undefined) next.source = prev.source;
  if (Object.keys(extra).length > 0) next.extra = extra as DocMeta['extra'];

  const same =
    next.name === prev.name &&
    next.author === prev.author &&
    next.comment === prev.comment &&
    JSON.stringify(next.extra) === JSON.stringify(prev.extra);
  return same ? doc : { ...doc, meta: next };
}

// --- board2's file code, loaded on demand -------------------------------------

type Core = typeof import('./workers/nurbs-core');
let corePromise: Promise<Core> | null = null;
let core: Core | null = null;

/**
 * The compute module (board2, geom, the converter), loaded once. It is the module the NURBS worker runs,
 * so the build puts it in a chunk of its own that the engine-off page never requests.
 */
export function loadNurbsCore(): Promise<Core> {
  corePromise ??= import('./workers/nurbs-core').then(
    (m) => {
      core = m;
      return m;
    },
    (err: unknown) => {
      corePromise = null; // a chunk that would not load (offline) may load later
      throw err;
    },
  );
  return corePromise;
}

/** The canonical text of a document with `meta` as its Board info. */
export async function sectionsText(doc: BoardDoc, meta: BoardMeta): Promise<string> {
  const { docToText } = await loadNurbsCore();
  return docToText(withBoardMeta(doc, meta));
}

/**
 * The same, at once, when the code has been loaded (null before): for the flush at `pagehide`, which has no
 * time to fetch a chunk. The document being held means the code was started loading (`attach`), and a save
 * that waits a few hundred milliseconds has had it.
 */
export function sectionsTextNow(doc: BoardDoc, meta: BoardMeta): string | null {
  return core ? core.docToText(withBoardMeta(doc, meta)) : null;
}

/** A document read from parsed JSON, or the reasons it is not one. */
export type ReadSections =
  | { readonly ok: true; readonly doc: BoardDoc }
  | {
      readonly ok: false;
      readonly error: string;
      /** `unavailable`: the code would not load (offline, a stale app shell); the text may be fine. */
      readonly reason: 'unavailable' | 'invalid';
    };

/** Revive a parsed section document (an opened file, a share link, a session). */
export async function readSections(json: unknown): Promise<ReadSections> {
  let c: Core;
  try {
    c = await loadNurbsCore();
  } catch {
    return {
      ok: false,
      error: 'The NURBS engine could not be loaded (offline, or the app was just updated).',
      reason: 'unavailable',
    };
  }
  const r = c.docFromJson(json);
  return r.ok ? { ok: true, doc: r.doc } : { ok: false, error: r.error, reason: 'invalid' };
}

/** The name in a section document's `meta`, read without reviving it (the share prompt names the board). */
export function sectionsName(json: unknown): string | undefined {
  if (!isObject(json) || !isObject(json.meta)) return undefined;
  const name = json.meta.name;
  return typeof name === 'string' && name.trim() !== '' ? name : undefined;
}
