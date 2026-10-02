// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The share codec is the one place in the app that parses bytes a stranger
 * chose, so these tests are weighted towards what a bad link does, not what a
 * good one does: every failure mode gets its own code, and the two size caps
 * get exercised with synthetic payloads because no realistic board comes close
 * (a real one is ~2.9 KB of link — see docs/design/share-link.md).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  defaultFinConfig,
  getLength,
  getMaxWidth,
  getVolume,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { parseBrd } from './brd-reader';
import { writeBoardJson } from './board-json';
import {
  decodeShareFragment,
  encodeShareFragment,
  SHARE_DECODED_MAX_BYTES,
  SHARE_ENVELOPE_VERSION,
  SHARE_URL_MAX_CHARS,
  ShareLinkError,
  shareCodecSupported,
} from './share-link';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const loadBrd = (name: string) => parseBrd(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

/** Base64URL without the envelope, for hand-built payloads. */
const b64url = (bytes: Uint8Array | Buffer): string =>
  Buffer.from(bytes).toString('base64url').replace(/=+$/, '');

/** Wrap arbitrary bytes as a well-formed v1 fragment. */
const envelope = (bytes: Uint8Array | Buffer): string =>
  `${SHARE_ENVELOPE_VERSION}.${b64url(bytes)}`;

/** A well-formed v1 fragment carrying `text` as its decompressed payload. */
const fragmentOf = (text: string): string => envelope(gzipSync(Buffer.from(text, 'utf8')));

/** Deep copy with -0 collapsed to 0 — see the cross-section assertion below. */
const zeroed = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (Object.is(x, -0) ? 0 : x))) as T;

/** The code of the ShareLinkError a promise rejects with. Fails if it resolves. */
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ShareLinkError);
    return (e as ShareLinkError).code;
  }
  throw new Error('expected the promise to reject');
};

describe('round-trip', () => {
  for (const name of ['shortboard', 'funboard', 'longboard']) {
    it(`${name}: geometry survives gzip + base64url`, async () => {
      const original = loadBrd(name).board;
      const { board: restored } = await decodeShareFragment(await encodeShareFragment(original));

      expect(getLength(restored)).toBeCloseTo(getLength(original), 9);
      expect(getMaxWidth(restored)).toBeCloseTo(getMaxWidth(original), 9);
      expect(getVolume(restored)).toBeCloseTo(getVolume(original), 6);
      expect(restored.outline.knots).toEqual(original.outline.knots);
      expect(restored.bottom.knots).toEqual(original.bottom.knots);
      expect(restored.deck.knots).toEqual(original.deck.knots);
      // Signed zero does not survive JSON (`JSON.stringify(-0)` is `"0"`), and
      // several stations carry a -0 coordinate. That is a property of the
      // native .board.json format — File > Save loses it too — not of sharing,
      // and -0 === 0 everywhere the geometry is used. Normalise rather than
      // pretend the bytes are identical.
      expect(zeroed(restored.crossSections)).toEqual(zeroed(original.crossSections));
      expect(restored.interpolationType).toBe(original.interpolationType);
    });
  }

  it('carries the parametric fin config', async () => {
    const base = loadBrd('shortboard').board;
    const fins = defaultFinConfig('thruster', 'futures');
    const withFins: BezierBoard = { ...base, fins };

    const { board: restored } = await decodeShareFragment(await encodeShareFragment(withFins));
    expect(restored.fins).toEqual(fins);
  });

  it('carries all seven Board Info fields, Unicode included', async () => {
    // Real names, accents, CJK and an emoji: the metadata a forum post would
    // actually carry, and the case a byte-oriented codec gets wrong.
    const metadata = {
      designer: 'Åsa Björk-Oliveira',
      model: '魚 fish 5′6″ 🏄',
      surfer: 'José Núñez',
      comments: 'Låg rocker.\nTwin + trailer.\tTabbed.',
      finType: 'twin',
      foamType: 'EPS',
      glassSchedule: '4+4/4',
    };

    const { metadata: back } = await decodeShareFragment(
      await encodeShareFragment(loadBrd('shortboard').board, metadata),
    );
    expect(back).toEqual(metadata);
  });

  it('omits metadata entirely when there is none', async () => {
    const { metadata } = await decodeShareFragment(
      await encodeShareFragment(loadBrd('shortboard').board),
    );
    expect(metadata).toBeUndefined();
  });
});

describe('URL safety', () => {
  it('emits only the Base64URL alphabet behind a v1 envelope', async () => {
    const fragment = await encodeShareFragment(loadBrd('funboard').board, { model: 'a/b+c=d' });
    expect(fragment).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
  });

  it('never emits raw JSON, image data or ghost state', async () => {
    const fragment = await encodeShareFragment(loadBrd('shortboard').board, {
      model: 'Sample',
      comments: 'data:image/png;base64,AAAA',
    });
    // The payload is compressed, so none of this can appear even though the
    // metadata above deliberately contains a data URI.
    for (const needle of ['data:', 'blob:', 'ghost', '"format"', '"crossSections"']) {
      expect(fragment).not.toContain(needle);
    }
  });

  it('survives a URL fragment round-trip unchanged', async () => {
    const fragment = await encodeShareFragment(loadBrd('longboard').board);
    const url = new URL(`https://openshaper.com/app#board=${fragment}`);
    expect(new URLSearchParams(url.hash.slice(1)).get('board')).toBe(fragment);
  });
});

describe('envelope', () => {
  it.each([
    ['no separator at all', 'v1'],
    ['empty string', ''],
    ['a bare dot', '.'],
    ['an unknown prefix', `board.${b64url(gzipSync(Buffer.from('{}')))}`],
    ['no prefix', b64url(gzipSync(Buffer.from('{}')))],
  ])('rejects %s', async (_label, fragment) => {
    expect(await codeOf(decodeShareFragment(fragment))).toBe('bad-envelope');
  });

  it('rejects an empty payload behind a valid prefix', async () => {
    expect(await codeOf(decodeShareFragment('v1.'))).toBe('bad-envelope');
  });

  it('names the version when the envelope is newer than we support', async () => {
    const fragment = `v2.${b64url(gzipSync(Buffer.from('{}')))}`;
    await expect(decodeShareFragment(fragment)).rejects.toThrow(/v2 is newer than supported/);
  });
});

describe('corruption', () => {
  it('rejects characters outside the Base64URL alphabet', async () => {
    const valid = await encodeShareFragment(loadBrd('shortboard').board);
    // `+`, `/` and `=` are exactly what Base64URL exists to avoid; a link that
    // has them has been through something that re-encoded it.
    for (const bad of ['+', '/', '=', '%', ' ']) {
      const mangled = `${valid.slice(0, 20)}${bad}${valid.slice(21)}`;
      expect(await codeOf(decodeShareFragment(mangled))).toBe('decompress-failed');
    }
  });

  it('rejects a truncated gzip stream', async () => {
    const full = gzipSync(Buffer.from(writeBoardJson(loadBrd('shortboard').board), 'utf8'));
    const half = envelope(full.subarray(0, Math.floor(full.length / 2)));
    expect(await codeOf(decodeShareFragment(half))).toBe('decompress-failed');
  });

  it('rejects bytes that are not gzip at all', async () => {
    expect(await codeOf(decodeShareFragment(envelope(Buffer.from('not gzip, just text'))))).toBe(
      'decompress-failed',
    );
  });

  it('rejects gzip of invalid UTF-8', async () => {
    // A lone continuation byte — decoded with `fatal: true`, so this is caught
    // as damage rather than surfacing later as a confusing JSON error.
    expect(await codeOf(decodeShareFragment(envelope(gzipSync(Buffer.from([0x80])))))).toBe(
      'decompress-failed',
    );
  });
});

describe('board document', () => {
  it.each([
    ['an empty object', '{}'],
    ['a JSON string', '"not a board"'],
    ['not JSON at all', 'hello'],
    ['a document with no format marker', JSON.stringify({ version: 2, outline: [] })],
  ])('rejects %s', async (_label, text) => {
    expect(await codeOf(decodeShareFragment(fragmentOf(text)))).toBe('bad-board');
  });

  it('rejects a board version newer than this build supports', async () => {
    const doc = JSON.parse(writeBoardJson(loadBrd('shortboard').board)) as Record<string, unknown>;
    doc.version = 99;
    const code = await codeOf(decodeShareFragment(fragmentOf(JSON.stringify(doc))));
    expect(code).toBe('bad-board');
    await expect(decodeShareFragment(fragmentOf(JSON.stringify(doc)))).rejects.toThrow(
      /newer than supported/,
    );
  });
});

describe('size caps', () => {
  /**
   * A board with enough stations to blow past the encoded cap. Nothing a shaper
   * would ever draw — the point is that the branch is reachable at all, since a
   * realistic board is ~17x under it.
   */
  const hugeBoard = (stations: number): BezierBoard => {
    const base = loadBrd('shortboard').board;
    const section = base.crossSections[1]!.spline;
    const noise = (i: number, k: number) => 0.0001 * ((i * 7919 + k * 104729) % 1000);
    return {
      ...base,
      crossSections: Array.from({ length: stations }, (_, i) =>
        crossSection(
          (getLength(base) * (i + 1)) / (stations + 1),
          // Perturb every knot so the stations do not compress into nothing.
          splineFromKnots(
            section.knots.map((k, j) =>
              knot(
                vec2(k.end.x + noise(i, j), k.end.y + noise(i, j + 1)),
                vec2(k.tangentToPrev.x + noise(i, j + 2), k.tangentToPrev.y + noise(i, j + 3)),
                vec2(k.tangentToNext.x + noise(i, j + 4), k.tangentToNext.y + noise(i, j + 5)),
                k.continuous,
                k.other,
              ),
            ),
          ),
        ),
      ),
    };
  };

  it('a realistic board stays far under both caps', async () => {
    const fragment = await encodeShareFragment(loadBrd('longboard').board, { model: 'Log' });
    expect(fragment.length).toBeLessThan(SHARE_URL_MAX_CHARS / 4);
  });

  it('rejects an encoded payload over the character cap', async () => {
    const fragment = await encodeShareFragment(hugeBoard(4000));
    expect(fragment.length).toBeGreaterThan(SHARE_URL_MAX_CHARS);
    expect(await codeOf(decodeShareFragment(fragment))).toBe('too-large');
  });

  it('aborts a payload that expands past the decompressed cap', async () => {
    // Highly compressible filler: small enough to pass the encoded cap, far too
    // large once inflated. This is the zip-bomb case the streaming reader exists
    // for — it must abort mid-stream, not buffer the whole thing and measure it.
    const bomb = gzipSync(Buffer.alloc(SHARE_DECODED_MAX_BYTES * 4, 0x41));
    expect(b64url(bomb).length).toBeLessThan(SHARE_URL_MAX_CHARS);
    expect(await codeOf(decodeShareFragment(envelope(bomb)))).toBe('too-large-decoded');
  });

  it('accepts a payload just under the decompressed cap', async () => {
    // Boundary check in the other direction: the cap must not reject what fits.
    const doc = writeBoardJson(loadBrd('shortboard').board, {
      comments: 'x'.repeat(SHARE_DECODED_MAX_BYTES - 20_000),
    });
    expect(doc.length).toBeLessThan(SHARE_DECODED_MAX_BYTES);
    const { board: restored } = await decodeShareFragment(envelope(gzipSync(Buffer.from(doc))));
    expect(restored.outline.knots.length).toBeGreaterThan(0);
  });
});

describe('unsupported runtimes', () => {
  const real = { c: globalThis.CompressionStream, d: globalThis.DecompressionStream };
  afterEach(() => {
    globalThis.CompressionStream = real.c;
    globalThis.DecompressionStream = real.d;
  });

  it('reports support when both streams exist', () => {
    expect(shareCodecSupported()).toBe(true);
  });

  it.each(['CompressionStream', 'DecompressionStream'] as const)(
    'reports no support when %s is missing',
    async (missing) => {
      // Deliberately removing a platform global.
      delete globalThis[missing];
      expect(shareCodecSupported()).toBe(false);
      expect(
        await codeOf(
          encodeShareFragment(
            board(
              splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), true, false)]),
              splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), true, false)]),
              splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), true, false)]),
              [],
            ),
          ),
        ),
      ).toBe('unsupported');
      expect(await codeOf(decodeShareFragment('v1.abc'))).toBe('unsupported');
    },
  );
});
