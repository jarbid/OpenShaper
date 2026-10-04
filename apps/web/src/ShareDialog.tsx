// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Share review dialog — what you are about to hand someone, before you hand it
 * to them.
 *
 * Share deliberately does not copy on click. A share link carries the board's
 * full Board Info, and `designer` / `surfer` are usually real names about to be
 * pasted into a public forum. So the link is generated, described and
 * *reviewed*, and only then copied.
 *
 * The dialog also fills a gap the sidebar leaves open: a board nobody named
 * shares as an anonymous link, which is the case where sharing is least useful.
 * When the model or designer is blank, the identification line becomes editable
 * fields writing back through the same `setMeta` the Board info panel uses — one
 * source of truth, and the value stays on the board afterwards. It is offered,
 * never required: Copy link works with both left empty.
 *
 * Everything here displays board metadata or the payload, so the root and the
 * manual-copy field carry `ph-no-capture` — PostHog's replay masking is
 * configured around that class (see analytics.ts).
 *
 * Modeled on ExportStepDialog (backdrop + Panel card, Escape-to-close).
 */
import { encodeShareFragment, shareCodecSupported } from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { BoardMeta } from './file-io';
import { buildShareUrl, copyToClipboard, shareSize, shareSizeLabel } from './share-url';
import { Modal } from './components/modal';

/** What the link contains, and what it deliberately does not. */
const INCLUDED = [
  'Outline, rocker and every cross-section',
  'Interpolation type and the fin setup',
  'Board Info: designer, model, surfer, comments, fin/foam type, glass schedule',
];
const EXCLUDED = [
  'Trace images and any other image data',
  'The comparison ghost board',
  'Undo history and recent boards',
  'Units, camera, overlays and app settings',
];

type LinkState =
  | { kind: 'encoding' }
  | { kind: 'ready'; url: string }
  | { kind: 'unsupported' }
  | { kind: 'failed' };

export interface ShareDialogProps {
  board: BezierBoard;
  meta: BoardMeta;
  /** The same setter the sidebar's Board info panel uses. */
  setMeta: Dispatch<SetStateAction<BoardMeta>>;
  /** Clipboard write succeeded — the app closes, toasts and reports. */
  onCopied: () => void;
  /** Offered instead of a link when the board is too large or the browser too old. */
  onDownloadBoard: () => void;
  onClose: () => void;
}

export function ShareDialog({
  board,
  meta,
  setMeta,
  onCopied,
  onDownloadBoard,
  onClose,
}: ShareDialogProps) {
  const [state, setState] = useState<LinkState>({ kind: 'encoding' });
  /** Set only after a failed clipboard write — the manual-copy fallback. */
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const manualRef = useRef<HTMLInputElement>(null);

  // Same rule as downloadBoard: an all-blank Board Info writes no metadata block.
  const metadata = useMemo(
    () => (Object.values(meta).some(Boolean) ? (meta as Record<string, unknown>) : undefined),
    [meta],
  );

  // Re-encode whenever the metadata changes, so editing the model below updates
  // the link (and its size) live. Gzipping ~12 KB of JSON is sub-millisecond;
  // the stale-response guard is what matters, not debouncing.
  useEffect(() => {
    if (!shareCodecSupported()) {
      setState({ kind: 'unsupported' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'encoding' });
    void encodeShareFragment(board, metadata).then(
      (fragment) => {
        if (!cancelled) setState({ kind: 'ready', url: buildShareUrl(fragment) });
      },
      () => {
        if (!cancelled) setState({ kind: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [board, metadata]);

  // The manual field only exists once the clipboard has refused, and the point
  // of it is that Ctrl+C works immediately.
  useEffect(() => {
    if (manualUrl) manualRef.current?.select();
  }, [manualUrl]);

  const size = state.kind === 'ready' ? shareSize(state.url) : 'ok';
  const model = meta.model?.trim() ?? '';
  const designer = meta.designer?.trim() ?? '';
  /**
   * Whether to offer the naming fields — decided **once, when the dialog
   * opens**, and deliberately not recomputed as the user types.
   *
   * Deriving it live meant the first character typed into an empty field made
   * both fields non-empty, which flipped this to false and replaced the whole
   * form with the read-only identification line — unmounting the input the user
   * was in. Focus fell to the body, so only that first character ever landed,
   * and on a phone the on-screen keyboard collapsed with it, which reads as the
   * share dialog closing.
   */
  const [askForName] = useState(() => {
    const m = meta.model?.trim() ?? '';
    const d = meta.designer?.trim() ?? '';
    return m === '' || d === '';
  });

  const copy = async () => {
    if (state.kind !== 'ready') return;
    if (await copyToClipboard(state.url)) {
      onCopied();
      return;
    }
    // Keep the dialog open — the user is doing the copying now.
    setManualUrl(state.url);
  };

  const downloadInstead = () => {
    onDownloadBoard();
    onClose();
  };

  return (
    <Modal
      name="share"
      label="Share board"
      onClose={onClose}
      className="ph-no-capture grid place-items-center p-4"
    >
      <Panel
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Share board</PanelTitle>
          <Button size="sm" variant="ghost" title="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>

        <PanelBody className="space-y-4 text-sm">
          {!askForName ? (
            <p className="font-medium">
              {model} <span className="text-muted-foreground">— {designer}</span>
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Name the board so the link means something to whoever opens it. Optional — you can
                share without it.
              </p>
              {(['model', 'designer'] as const).map((field) => (
                <label key={field} className="flex items-center gap-2">
                  <span className="w-16 capitalize text-muted-foreground">{field}</span>
                  <Input
                    value={meta[field] ?? ''}
                    placeholder="—"
                    aria-label={`Board ${field}`}
                    onChange={(e) => setMeta((m) => ({ ...m, [field]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}

          <p className="text-muted-foreground">
            The link contains an <strong>editable snapshot</strong> of this board. It will not
            change when you keep editing here, and it cannot be updated or revoked once sent. Anyone
            with the link can open the board and read its Board Info — including the designer and
            surfer names above.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide">Included</h3>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {INCLUDED.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide">Not included</h3>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {EXCLUDED.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>

          {state.kind === 'encoding' && <p className="text-muted-foreground">Building link…</p>}

          {state.kind === 'unsupported' && (
            <p className="text-destructive">
              This browser cannot build share links — it has no Compression Streams support. Update
              it, or send the <code>.board</code> file instead.
            </p>
          )}

          {state.kind === 'failed' && (
            <p className="text-destructive">
              Could not build a link for this board. Send the <code>.board</code> file instead.
            </p>
          )}

          {state.kind === 'ready' && (
            <>
              <p className="text-xs text-muted-foreground">
                Link size: {shareSizeLabel(state.url)}
              </p>
              {size === 'warn' && (
                <p className="text-xs text-destructive">
                  This link is unusually long and some forums may truncate or reject it. Sending the{' '}
                  <code>.board</code> file is more reliable. A URL shortener such as TinyURL may
                  work, but it receives the complete board link, and may not accept or preserve it —
                  OpenShaper never submits your link anywhere.
                </p>
              )}
              {size === 'reject' && (
                <p className="text-xs text-destructive">
                  This board is too large to share as a link. Send the <code>.board</code> file
                  instead.
                </p>
              )}
            </>
          )}

          {manualUrl && (
            <div className="space-y-1">
              <label className="block text-xs text-muted-foreground" htmlFor="share-url-manual">
                Clipboard unavailable — copy this link manually:
              </label>
              <input
                id="share-url-manual"
                ref={manualRef}
                className="ph-no-capture w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                readOnly
                value={manualUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          )}
        </PanelBody>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {state.kind === 'ready' && size !== 'reject' ? (
            <Button size="sm" onClick={() => void copy()}>
              Copy link
            </Button>
          ) : (
            <Button size="sm" disabled={state.kind === 'encoding'} onClick={downloadInstead}>
              Download .board
            </Button>
          )}
        </div>
      </Panel>
    </Modal>
  );
}
