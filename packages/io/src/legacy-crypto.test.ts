/**
 * Tests for the legacy encrypted-`.brd` crypto (MD5 + PBKDF1 + DES-CBC).
 *
 * GOLDEN ORACLE: `__fixtures__/8-good-gun.brd` is a REAL encrypted BoardCAD
 * file (magic `%BRD-1.02`) supplied as a sample. Decrypting it end-to-end and
 * recovering valid plain-text `.brd` content exercises MD5, PBKDF1, DES, CBC
 * and PKCS#5 unpadding together — if any stage were wrong the result would be
 * garbage or trigger a padding error. The decryption parameters are taken from
 *   ../boardcad-le/src/board/readers/BrdReader.java (lines 39–113).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLength, getMaxWidth, getThickness } from '@openshaper/kernel';
import { md5, decryptBrd, isEncryptedBrd } from './legacy-crypto';
import { parseBrdFile } from './brd-reader';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(here, '__fixtures__', name)));

const toHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

describe('md5 (RFC 1321 test vectors)', () => {
  it('hashes the empty string', () => {
    expect(toHex(md5(ascii('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
  it('hashes "abc"', () => {
    expect(toHex(md5(ascii('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
  it('hashes the longer RFC sample', () => {
    expect(toHex(md5(ascii('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });
  it('hashes a >64-byte input (multi-block)', () => {
    const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    expect(toHex(md5(ascii(s)))).toBe('d174ab98d277d9f5a5611c2c9f419d9f');
  });
});

describe('isEncryptedBrd', () => {
  it('recognises the %BRD-1.02 magic on the sample', () => {
    expect(isEncryptedBrd(fixture('8-good-gun.brd'))).toBe(true);
  });
  it('rejects plain text', () => {
    expect(isEncryptedBrd(ascii('p7 : 1.0\n'))).toBe(false);
  });
});

describe('decryptBrd (real encrypted .brd golden oracle)', () => {
  const plain = decryptBrd(fixture('8-good-gun.brd'));

  it('recovers printable plain-text .brd content', () => {
    // Should be mostly printable ASCII (line-based .brd records), not binary.
    const sample = plain.slice(0, 2000);
    const printable = sample
      .replace(/[\r\n\t]/g, '')
      .split('')
      .filter((c) => {
        const code = c.charCodeAt(0);
        return code >= 0x20 && code < 0x7f;
      }).length;
    expect(printable / sample.replace(/[\r\n\t]/g, '').length).toBeGreaterThan(0.95);
  });

  it('contains line-based pNN records like the .brd text format', () => {
    expect(/p\d{1,2}\s*:/.test(plain)).toBe(true);
  });
});

describe('parseBrdFile (encrypted .brd end-to-end)', () => {
  it('decrypts and parses the encrypted sample into a valid board', () => {
    const { board } = parseBrdFile(fixture('8-good-gun.brd'));
    const lengthCm = getLength(board);
    const widthCm = getMaxWidth(board);
    const thickCm = getThickness(board);
    // "8 Good Gun" — a gun is a long, narrow board. Sanity-check plausible dims.
    expect(lengthCm).toBeGreaterThan(150); // > ~5 ft
    expect(lengthCm).toBeLessThan(330); // < ~11 ft
    expect(widthCm).toBeGreaterThan(20);
    expect(widthCm).toBeLessThan(60);
    expect(thickCm).toBeGreaterThan(3);
    expect(thickCm).toBeLessThan(15);
  });
});
