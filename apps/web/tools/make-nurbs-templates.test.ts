// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviveBoardDoc, validateBoard } from '@openshaper/board2';
import { readBoardText } from '@openshaper/io';
import { describe, expect, it } from 'vitest';
import { NURBS_TEMPLATES } from '../src/templates';
import { makeNurbsTemplates } from './make-nurbs-templates';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/templates');
const path = (file: string) => resolve(dir, file);

const made = makeNurbsTemplates();

if (process.env.NURBS_TEMPLATES_WRITE) {
  for (const t of made) writeFileSync(path(t.file), t.text);
}

describe('NURBS starter templates', () => {
  it.each(made.map((t) => [t.name, t] as const))(
    '%s: the committed file is what the generator makes',
    (_name, t) => {
      expect(readFileSync(path(t.file), 'utf8')).toBe(t.text);
    },
  );

  it.each(made.map((t) => [t.name, t] as const))(
    '%s: is a valid section document that saves back byte for byte',
    (name, t) => {
      const file = readBoardText(t.text);
      expect(file.kind).toBe('sections');
      const r = reviveBoardDoc(file.kind === 'sections' ? file.json : null);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(validateBoard(r.value).filter((i) => i.severity === 'error')).toEqual([]);
      expect(r.value.meta.name).toBe(name);
    },
  );

  it('are the ones the New menu lists, with the tails they are named for', async () => {
    expect(NURBS_TEMPLATES.map((t) => t.name)).toEqual(made.map((t) => t.name));
    const texts = await Promise.all(NURBS_TEMPLATES.map((t) => t.load()));
    texts.forEach((text, i) => expect(text).toBe(made[i]!.text));
    expect(made.find((t) => t.name === 'Swallow shortboard')!.text).toContain('"notched"');
    expect(made.find((t) => t.name === 'Fish shortboard')!.text).toContain('"notched"');
    expect(made.find((t) => t.name === 'Shortboard')!.text).toContain('"standard"');
  });
});
