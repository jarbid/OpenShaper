// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The step keys are one more table beside the view keys, in the one shortcut table. They use the
 * view keys' numbers, so each row says which layout it is live in.
 */
import { describe, expect, it } from 'vitest';
import { matches, SHORTCUTS, shortcutKeys, STEP_KEYS, VIEW_KEYS } from '../shortcuts';
import { DESIGN_STEPS } from './steps';

const key = (k: string, mods: { mod?: boolean; shift?: boolean } = {}) =>
  ({
    key: k,
    ctrlKey: mods.mod ?? false,
    metaKey: false,
    shiftKey: mods.shift ?? false,
  }) as KeyboardEvent;

const hits = (e: KeyboardEvent, workspace: boolean) =>
  SHORTCUTS.filter((s) => matches(s, e, false, false, workspace)).map((s) => s.id);

describe('STEP_KEYS', () => {
  it('is the design steps, with the keys the step table gives them', () => {
    expect(STEP_KEYS.map((k) => k.key)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(STEP_KEYS.map((k) => k.step)).toEqual(DESIGN_STEPS.map((s) => s.id));
    expect(STEP_KEYS.map((k) => k.label)).toEqual(DESIGN_STEPS.map((s) => `${s.label} step`));
  });

  it('has a shortcut row each, in its own group, scoped to the workspace', () => {
    for (const { key: k, label } of STEP_KEYS) {
      const row = SHORTCUTS.find((s) => s.id === `step-${k}`);
      expect(row, k).toBeDefined();
      expect(row).toMatchObject({ keys: k, label, group: 'Design steps', scope: 'workspace' });
      expect(row!.match).toEqual({ keys: [k], notInField: true });
    }
  });

  it('gives the tooltips the chord by id', () => {
    expect(shortcutKeys('step-1')).toBe('1');
    expect(shortcutKeys('step-7')).toBe('7');
  });
});

describe('the view keys', () => {
  it('are scoped to the tabbed layout and keep their ids and chords', () => {
    for (const v of VIEW_KEYS) {
      expect(SHORTCUTS.find((s) => s.id === `view-${v.key}`)).toMatchObject({
        keys: v.key,
        group: 'View',
        scope: 'views',
      });
    }
  });
});

describe('matches, with the workspace on and off', () => {
  it('lets the number keys choose a view when the workspace is not showing (the default)', () => {
    expect(hits(key('1'), false)).toEqual(['view-1']);
    expect(hits(key('6'), false)).toEqual(['view-6']);
    // no fifth argument at all: as every existing caller asks
    expect(SHORTCUTS.filter((s) => matches(s, key('1'), false)).map((s) => s.id)).toEqual([
      'view-1',
    ]);
  });

  it('lets them choose a step when it is, and nothing else', () => {
    expect(hits(key('1'), true)).toEqual(['step-1']);
    expect(hits(key('7'), true)).toEqual(['step-7']);
  });

  it('has the old keys do nothing while the workspace shows, and 7 do nothing when it does not', () => {
    expect(hits(key('7'), false)).toEqual([]);
    for (const v of VIEW_KEYS) expect(hits(key(v.key), true)).not.toContain(`view-${v.key}`);
  });

  it('never has two shortcuts claim one event, in either layout', () => {
    for (const workspace of [false, true]) {
      for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '[', ']', 'Delete', 'l']) {
        expect(hits(key(k), workspace).length, `${k} ${workspace}`).toBeLessThan(2);
      }
    }
  });

  it('is quiet in a text field, as the view keys are', () => {
    expect(matches(SHORTCUTS.find((s) => s.id === 'step-3')!, key('3'), true, true, true)).toBe(
      false,
    );
  });
});
