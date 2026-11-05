// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Share-by-URL codec — a board encoded into a link, with no server behind it.
 *
 * The payload is the native `.board.json` document (see board-json.ts) gzipped
 * and Base64URL-encoded, behind a versioned envelope:
 *
 *   v1.<unpadded base64url of gzip of the UTF-8 .board.json bytes>
 *
 * which `apps/web` puts in a URL *fragment* — `/app#board=v1.…` — so it is never
 * sent to a server, never lands in a request log, and never reaches analytics.
 *
 * Compression is the platform's `CompressionStream`/`DecompressionStream`
 * (WHATWG Compression Streams), not a dependency. They are platform globals
 * rather than DOM APIs, so this module stays framework-free and testable in
 * plain Node — the layering rule in `.claude/CLAUDE.md` holds.
 *
 * What travels is exactly what `writeBoardJson` writes: geometry, interpolation
 * type, the fin config and the board metadata. Trace images, the comparison
 * ghost, undo history, the recent list and every view/app setting live in other
 * stores entirely, so they cannot leak through here by construction.
 *
 * Decoding treats its input as hostile. Every failure is a `ShareLinkError`
 * with a code the UI can turn into a useful sentence, the encoded payload is
 * measured before anything is allocated, and the gunzip is *streamed* under a
 * running byte cap so a small compressed payload cannot expand into a large
 * allocation.
 */
import type { BezierBoard, RefPoints } from '@openshaper/kernel';
import { readBoardJson, writeBoardJson, type ReadBoardJsonResult } from './board-json';

/** Envelope version this module writes. Readers accept only this one. */
export const SHARE_ENVELOPE_VERSION = 'v1';

/**
 * Whole-URL length past which a link still copies but is flagged as one some
 * forums may reject. A realistic board is ~2.9 KB of link, so this is ~10x a
 * normal board and is not reachable in practice — see docs/design/share-link.md.
 */
export const SHARE_URL_WARN_CHARS = 30_000;

/** Whole-URL length past which a link is refused outright (~17x a normal board). */
export const SHARE_URL_MAX_CHARS = 50_000;

/**
 * Ceiling on *decompressed* output. The real memory defence: the encoded cap
 * above bounds what we read, this bounds what a high-ratio payload can expand
 * into. ~80x headroom over a realistic board.
 */
export const SHARE_DECODED_MAX_BYTES = 1_000_000;

export type ShareLinkErrorCode =
  /** Neither compression stream exists — the browser is too old. */
  | 'unsupported'
  /** No `v1.` prefix, an empty payload, or an envelope version we don't know. */
  | 'bad-envelope'
  /** The encoded payload is longer than SHARE_URL_MAX_CHARS. */
  | 'too-large'
  /** Not valid Base64URL, or not valid/complete gzip. */
  | 'decompress-failed'
  /** Decompressed output ran past SHARE_DECODED_MAX_BYTES. */
  | 'too-large-decoded'
  /** Valid JSON, but not a board we can read — including a newer board version. */
  | 'bad-board';

/** The only error this module throws. `code` is what the UI branches on. */
export class ShareLinkError extends Error {
  constructor(
    readonly code: ShareLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

/**
 * Whether this runtime can encode/decode share links at all. Checked before
 * offering Share, so an old browser gets "send the .board file instead" rather
 * than a button that throws.
 */
export const shareCodecSupported = (): boolean =>
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

const requireCodec = (): void => {
  if (!shareCodecSupported()) {
    throw new ShareLinkError(
      'unsupported',
      'This browser has no Compression Streams support — update it, or send the .board file instead.',
    );
  }
};

// ---------------------------------------------------------------------------
// Base64URL
// ---------------------------------------------------------------------------

/**
 * Characters per `String.fromCharCode` call. Spreading a whole multi-kilobyte
 * array into one call overflows the argument stack, so the binary string is
 * built in chunks.
 */
const BINARY_CHUNK = 8192;

/** Bytes → unpadded Base64URL (`+`→`-`, `/`→`_`, no `=`), so it is URL-safe as-is. */
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** The inverse. Assumes the alphabet has already been validated by the caller. */
const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Push `input` through a compression/decompression stream and collect the
 * output, aborting as soon as it passes `maxBytes` (when given).
 *
 * The write runs concurrently with the read loop on purpose: writing a large
 * payload and only then draining the readable deadlocks on backpressure. A
 * corrupt gzip can surface as a rejection on either side, so the write promise
 * is kept from becoming an unhandled rejection and awaited at the end, letting
 * whichever error arrives first be the one reported.
 */
async function pump(
  // `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: a stream writer takes a
  // `BufferSource`, which a `SharedArrayBuffer`-backed view is not.
  input: Uint8Array<ArrayBuffer>,
  // Structural rather than `TransformStream<Uint8Array, Uint8Array>`: the DOM
  // lib types both compression streams' writable side as `BufferSource`, which
  // a Uint8Array-parameterised TransformStream is not assignable to.
  transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
  maxBytes?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter();
  const written = (async () => {
    await writer.write(input);
    await writer.close();
  })();
  written.catch(() => {}); // reported via the read side, or re-awaited below

  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      // Stop pulling immediately — the whole point is not to allocate it.
      await reader.cancel();
      throw new ShareLinkError(
        'too-large-decoded',
        `Shared board is larger than ${maxBytes} bytes once decompressed.`,
      );
    }
    chunks.push(value);
  }
  await written;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a board (and its Board Info metadata) into a share fragment.
 *
 * The result is the value that goes after `#board=`; assembling the URL around
 * it — and deciding whether it is too long to be useful — belongs to the app,
 * which is the only layer that knows the origin.
 */
export async function encodeShareFragment(
  b: BezierBoard,
  metadata?: Record<string, unknown>,
  referencePoints?: RefPoints,
): Promise<string> {
  requireCodec();
  const bytes = new TextEncoder().encode(writeBoardJson(b, metadata, referencePoints));
  const gzipped = await pump(bytes, new CompressionStream('gzip'));
  return `${SHARE_ENVELOPE_VERSION}.${toBase64Url(gzipped)}`;
}

/**
 * Decode a share fragment back into a board.
 *
 * Checks run cheapest-and-most-defensive first: envelope, then encoded length
 * (before any allocation), then the Base64URL alphabet, then the capped
 * gunzip, and only then the board document itself.
 *
 * @throws ShareLinkError — and nothing else.
 */
export async function decodeShareFragment(fragment: string): Promise<ReadBoardJsonResult> {
  requireCodec();

  const dot = fragment.indexOf('.');
  const version = dot === -1 ? '' : fragment.slice(0, dot);
  const payload = dot === -1 ? '' : fragment.slice(dot + 1);
  if (version !== SHARE_ENVELOPE_VERSION) {
    throw new ShareLinkError(
      'bad-envelope',
      /^v\d+$/.test(version)
        ? `Share link version ${version} is newer than supported (${SHARE_ENVELOPE_VERSION}).`
        : 'Not an OpenShaper share link.',
    );
  }
  if (payload.length === 0) {
    throw new ShareLinkError('bad-envelope', 'Share link has no board payload.');
  }
  if (payload.length > SHARE_URL_MAX_CHARS) {
    throw new ShareLinkError(
      'too-large',
      `Share link is longer than the ${SHARE_URL_MAX_CHARS}-character limit.`,
    );
  }
  // Validate the alphabet up front rather than trusting atob's leniency, so a
  // mangled link fails the same way everywhere.
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new ShareLinkError('decompress-failed', 'Share link is damaged or incomplete.');
  }

  let json: string;
  try {
    const bytes = fromBase64Url(payload);
    const inflated = await pump(bytes, new DecompressionStream('gzip'), SHARE_DECODED_MAX_BYTES);
    json = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
  } catch (e) {
    if (e instanceof ShareLinkError) throw e; // the decompressed-size cap
    throw new ShareLinkError('decompress-failed', 'Share link is damaged or incomplete.');
  }

  try {
    return readBoardJson(json);
  } catch (e) {
    // Includes "document version N is newer than supported" from readBoardJson.
    throw new ShareLinkError('bad-board', (e as Error).message);
  }
}
