// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviveBoardDoc, validateBoard } from '@openshaper/board2';
import { readBoardText } from '@openshaper/io';
import { describe, expect, it } from 'vitest';
import { BOARD_TYPE_SHAPES } from '../src/board-type-shapes';
import { NURBS_TEMPLATES } from '../src/templates';
import { SHAPES_FILE, makeBoardTypeShapes, makeNurbsTemplates } from './make-nurbs-templates';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/templates');
const path = (file: string) => resolve(dir, file);

const made = makeNurbsTemplates();
const shapes = makeBoardTypeShapes();
const shapesPath = resolve(dir, '..', SHAPES_FILE);

if (process.env.NURBS_TEMPLATES_WRITE) {
  for (const t of made) writeFileSync(path(t.file), t.text);
  writeFileSync(shapesPath, shapes);
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

describe('the board-type data (src/board-type-shapes.ts)', () => {
  it('is what the generator makes from the templates', () => {
    expect(readFileSync(shapesPath, 'utf8')).toBe(shapes);
  });

  it('holds one entry per starter template, drawn from the board it opens as', () => {
    expect(Object.keys(BOARD_TYPE_SHAPES)).toEqual(made.map((t) => t.name));
    for (const t of made) {
      const shape = BOARD_TYPE_SHAPES[t.name]!;
      expect(shape.length, t.name).toBeGreaterThan(100);
      expect(shape.plan, t.name).toMatch(/^M/);
      // a few hundred bytes a picture: the whole file is small too
      expect(shape.plan.length, t.name).toBeLessThan(400);
    }
    expect(readFileSync(shapesPath, 'utf8').length).toBeLessThan(4000);
  });
});
