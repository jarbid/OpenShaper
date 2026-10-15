// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ISO 10303-21 (Part 21) lexical rules, copied from `packages/export/src/step.ts`
 * and extended (geom may not import `export`; Phase 4 should make `export`
 * import them from here).
 *
 * - A REAL always contains a `.` (an integer literal and a number in exponent form without a point are both illegal); the
 *   exponent letter is `E`, with an optional sign: `1.E-7`.
 * - A string doubles `'` and `\`, and writes everything outside printable ASCII
 *   as `\X2\XXXX\X0\` (UTF-16 code units in hex).
 * - An entity instance is `#id=BODY;`; a complex instance is a parenthesised
 *   list of partial entities, `#id=(A()B(…)…);`.
 */

import { fail } from '../errors';

/** Digits of a rounded number: `'roundTrip'` keeps the exact double (shortest round-trip decimal). */
export type StepPrecision = 'roundTrip' | number;

/**
 * A Part 21 REAL for `n`. `'roundTrip'` writes the shortest decimal that reads
 * back as exactly `n`; a number `d` writes `d` significant digits (the nearest
 * double to the `d`-digit decimal, again as its shortest round-trip form).
 * `-0` is written `0.`.
 */
export function real(n: number, precision: StepPrecision = 'roundTrip'): string {
  if (!Number.isFinite(n)) fail('non-finite', `cannot write a non-finite REAL: ${n}`, { value: n });
  const rounded = precision === 'roundTrip' ? n : Number(n.toPrecision(precision));
  const v = rounded === 0 ? 0 : rounded;
  const s = String(v);
  const e = s.indexOf('e');
  if (e >= 0) {
    const mantissa = s.slice(0, e);
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.`}E${s.slice(e + 1)}`;
  }
  return s.includes('.') ? s : `${s}.`;
}

/** A Part 21 string literal (module comment). */
export function str(s: string): string {
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else {
      const units =
        c <= 0xffff ? [c] : [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)];
      out += `\\X2\\${units.map((u) => u.toString(16).toUpperCase().padStart(4, '0')).join('')}\\X0\\`;
    }
  }
  return `${out}'`;
}

/** `#id`. */
export const ref = (id: number): string => `#${id}`;

/** `(#a,#b,…)`. */
export const refs = (ids: readonly number[]): string => `(${ids.map(ref).join(',')})`;

/** A boolean as Part 21 writes it. */
export const bool = (b: boolean): string => (b ? '.T.' : '.F.');

/** An entity-instance emitter: ids from 1 in emission order. */
export interface Emitter {
  /** The lines written so far (header and trailer excluded). */
  readonly lines: string[];
  /** Appends `#next=body;` and returns its id. */
  emit(body: string): number;
}

export function createEmitter(): Emitter {
  const lines: string[] = [];
  return {
    lines,
    emit(body: string): number {
      const id = lines.length + 1;
      lines.push(`#${id}=${body};`);
      return id;
    },
  };
}
