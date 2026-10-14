// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A structural checksum for the immutability tests (design §4.8): checksum
 * every input before and after a public operation; any write into a typed
 * array or a record changes it. Test-only.
 *
 * Numbers are hashed by their IEEE-754 bits (so `-0` and `0`, or two NaN
 * payloads, differ), typed arrays by their bytes, records by sorted keys, arrays
 * element-wise. Functions and symbols hash by kind only. A cycle throws. The
 * hash is two independent 32-bit FNV-1a lanes (64 bits), not cryptographic.
 */

const FNV_PRIME = 0x01000193;

/** Two FNV-1a lanes with different offset bases and byte salts. */
interface Hasher {
  a: number;
  b: number;
}

function byte(h: Hasher, x: number): void {
  h.a = Math.imul(h.a ^ (x & 0xff), FNV_PRIME);
  h.b = Math.imul(h.b ^ ((x + 0x5b) & 0xff), FNV_PRIME);
}

function bytes(h: Hasher, u8: Uint8Array): void {
  for (let i = 0; i < u8.length; i++) byte(h, u8[i]!);
}

function tag(h: Hasher, s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    byte(h, c);
    byte(h, c >>> 8);
  }
  byte(h, 0);
}

function visit(h: Hasher, v: unknown, seen: Set<object>): void {
  if (v === null) return tag(h, 'null');
  switch (typeof v) {
    case 'undefined':
      return tag(h, 'undef');
    case 'boolean':
      return tag(h, v ? 'true' : 'false');
    case 'number':
      tag(h, 'num');
      return bytes(h, new Uint8Array(Float64Array.of(v).buffer));
    case 'bigint':
      return tag(h, `big:${v.toString()}`);
    case 'string':
      tag(h, 'str');
      return tag(h, v);
    case 'function':
    case 'symbol':
      return tag(h, typeof v);
  }
  const o = v as object;
  if (seen.has(o)) throw new Error('checksum: cyclic value');
  seen.add(o);
  if (ArrayBuffer.isView(o)) {
    tag(h, `view:${o.constructor.name}:${o.byteLength}`);
    bytes(h, new Uint8Array(o.buffer, o.byteOffset, o.byteLength));
  } else if (Array.isArray(o)) {
    tag(h, `array:${o.length}`);
    for (const x of o) visit(h, x, seen);
  } else {
    const keys = Object.keys(o).sort();
    tag(h, `object:${keys.length}`);
    for (const k of keys) {
      tag(h, k);
      visit(h, (o as Record<string, unknown>)[k], seen);
    }
  }
  seen.delete(o);
}

/** A 64-bit hex checksum of a value's full structure and bits. */
export function checksum(value: unknown): string {
  const h: Hasher = { a: 0x811c9dc5, b: 0x050c5d1f };
  visit(h, value, new Set());
  const hex = (x: number): string => (x >>> 0).toString(16).padStart(8, '0');
  return hex(h.a) + hex(h.b);
}
