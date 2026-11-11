// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { canChooseFolder, cleanStem } from './save-files';

describe('cleanStem', () => {
  it('keeps a plain name', () => {
    expect(cleanStem('my keel', '.fin.json', 'fin')).toBe('my keel');
  });

  it('drops the extension if it was typed, in any case', () => {
    expect(cleanStem('keel.FIN.JSON', '.fin.json', 'fin')).toBe('keel');
    expect(cleanStem('keel.step', '.stl', 'fin')).toBe('keel.step');
  });

  it("replaces characters a file name can't hold, and trims dots and spaces", () => {
    expect(cleanStem(' a/b\\c:d*e?"f"<g>|h ', '.stl', 'fin')).toBe('a-b-c-d-e-f-g-h');
    expect(cleanStem('..hidden.', '.stl', 'fin')).toBe('hidden');
    expect(cleanStem('tab\there', '.stl', 'fin')).toBe('tab-here');
  });

  it('falls back to the name offered when nothing usable is left', () => {
    expect(cleanStem('   ', '.stl', 'fin-centre')).toBe('fin-centre');
    expect(cleanStem('.stl', '.stl', 'fin-centre')).toBe('fin-centre');
  });

  it('keeps a name to 120 characters', () => {
    expect(cleanStem('x'.repeat(300), '.stl', 'fin')).toHaveLength(120);
  });
});

describe('canChooseFolder', () => {
  it('is false without the File System Access API (Safari, Firefox, jsdom)', () => {
    expect(canChooseFolder()).toBe(false);
  });
});
