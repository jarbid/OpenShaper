// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultCanard, defaultFinDesign } from '@openshaper/kernel';
import { readFinJson } from '@openshaper/io';
import { describe, expect, it } from 'vitest';
import { defaultStems, finFiles, finFileStem, finsToWrite } from './fin-file';

describe('finsToWrite', () => {
  it('writes one fin unless asked for a pair', () => {
    const d = defaultFinDesign('side', 'left');
    expect(finsToWrite(d, false)).toEqual([d]);
  });

  it('pairs a side fin with its mirror: the same design, the other hand', () => {
    const d = defaultFinDesign('side', 'right');
    const [a, b] = finsToWrite(d, true);
    expect(a).toBe(d);
    expect(b).toEqual({ ...d, hand: 'left' });
    expect([a!, b!].map(finFileStem)).toEqual(['fin-side-right', 'fin-side-left']);
  });

  it('pairs a canard too, and never a centre fin', () => {
    expect(finsToWrite(defaultCanard('left'), true).map((f) => f.hand)).toEqual(['left', 'right']);
    expect(finsToWrite(defaultFinDesign('centre'), true)).toHaveLength(1);
  });
});

describe('finFiles', () => {
  it('names each file from its stem plus the extension, in finsToWrite order', async () => {
    const d = defaultFinDesign('side', 'left');
    expect(defaultStems(d, true)).toEqual(['fin-side-left', 'fin-side-right']);
    expect(defaultStems(d, false, true)).toEqual(['fin-side-left-core']);
    const files = await finFiles(d, 'fin', ['keel-l', 'keel-r'], true);
    expect(files.map((f) => f.name)).toEqual(['keel-l.fin.json', 'keel-r.fin.json']);
    expect(readFinJson(files[1]!.data as string).design.hand).toBe('right');
  });
});
