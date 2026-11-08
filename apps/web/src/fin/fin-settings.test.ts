// SPDX-License-Identifier: GPL-3.0-or-later
import { FIN_EXPORT_MIN_THICKNESS } from '@openshaper/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { fmtLen, fmtThick } from '../format';
import {
  DEFAULT_FIN_SETTINGS,
  finLengthUnit,
  readFinSettings,
  withFinSettings,
  writeFinSettings,
} from './fin-settings';

afterEach(() => {
  localStorage.removeItem('bs.fin.settings');
  localStorage.removeItem('bs.fin.exportMin');
});

describe('fin settings', () => {
  it('shows inches to the chosen fraction', () => {
    const inch = (fraction: 16 | 8 | 4 | 2) =>
      finLengthUnit({ ...DEFAULT_FIN_SETTINGS, unit: 'in', fraction });
    const cm = 2.54 * (3 + 7 / 16); // 3 7/16"
    expect(fmtLen(cm, inch(16))).toBe('3 7/16"');
    expect(fmtLen(cm, inch(8))).toBe('3 3/8"');
    expect(fmtLen(cm, inch(2))).toBe('3"');
    expect(fmtLen(1, finLengthUnit(DEFAULT_FIN_SETTINGS))).toBe('10.0 mm');
    // Thicknesses stay readable: decimal inches, not 0" to the nearest 1/8".
    expect(fmtLen(0.05, inch(8))).toBe('0"');
    expect(fmtThick(0.05, inch(8))).toBe('0.020"');
    expect(fmtThick(0.9525, inch(2))).toBe('0.375"');
    expect(fmtThick(0.05, finLengthUnit(DEFAULT_FIN_SETTINGS))).toBe('0.5 mm');
  });

  it('keeps the grid only if the unit offers it, and the export minimum in range', () => {
    const fiveMm = withFinSettings(DEFAULT_FIN_SETTINGS, { grid: 0.5 });
    expect(fiveMm.grid).toBe(0.5);
    expect(withFinSettings(fiveMm, { unit: 'in' }).grid).toBeNull();
    expect(withFinSettings(fiveMm, { unit: 'in', grid: 2.54 / 4 }).grid).toBeCloseTo(0.635, 12);
    expect(withFinSettings(DEFAULT_FIN_SETTINGS, { grid: 0.3 }).grid).toBeNull();
    expect(withFinSettings(DEFAULT_FIN_SETTINGS, { exportMin: 9 }).exportMin).toBe(
      FIN_EXPORT_MIN_THICKNESS.max,
    );
  });

  it('reads back what it wrote, and the defaults for anything invalid', () => {
    const s = withFinSettings(DEFAULT_FIN_SETTINGS, { unit: 'in', fraction: 8, grid: 2.54 });
    writeFinSettings(s);
    expect(readFinSettings()).toEqual(s);
    localStorage.setItem(
      'bs.fin.settings',
      JSON.stringify({ unit: 'furlongs', fraction: 3, grid: 'big', exportMin: -1 }),
    );
    expect(readFinSettings()).toEqual(DEFAULT_FIN_SETTINGS);
    localStorage.setItem('bs.fin.settings', 'not json');
    expect(readFinSettings()).toEqual(DEFAULT_FIN_SETTINGS);
  });

  it('starts from the export minimum remembered before File settings existed', () => {
    localStorage.setItem('bs.fin.exportMin', '0.2');
    expect(readFinSettings().exportMin).toBe(0.2);
  });
});
