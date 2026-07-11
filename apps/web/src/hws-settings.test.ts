import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_HWS_PARAMS } from '@openshaper/export';
import {
  DEFAULT_HWS_SETTINGS,
  HWS_SETTINGS_VERSION,
  loadHwsSettings,
  migrateHwsSettings,
  saveHwsSettings,
} from './hws-settings';

beforeEach(() => {
  localStorage.clear();
});

describe('loadHwsSettings', () => {
  it('returns defaults when localStorage is empty', () => {
    expect(loadHwsSettings()).toEqual(DEFAULT_HWS_SETTINGS);
    expect(DEFAULT_HWS_SETTINGS.params).toEqual(DEFAULT_HWS_PARAMS);
    expect(DEFAULT_HWS_SETTINGS.version).toBe(HWS_SETTINGS_VERSION);
  });

  it('round-trips through save/load under bs.hwsParams', () => {
    const custom = {
      ...DEFAULT_HWS_SETTINGS,
      params: { ...DEFAULT_HWS_SETTINGS.params, ribCount: 9, lighteningStyle: 'truss' as const },
      output: { ...DEFAULT_HWS_SETTINGS.output, paperId: 'a4' },
    };
    saveHwsSettings(custom);
    expect(localStorage.getItem('bs.hwsParams')).not.toBeNull();
    expect(loadHwsSettings()).toEqual(custom);
  });

  it('returns defaults when the stored JSON is malformed', () => {
    localStorage.setItem('bs.hwsParams', 'not-json{{{');
    expect(loadHwsSettings()).toEqual(DEFAULT_HWS_SETTINGS);
  });
});

describe('migrateHwsSettings', () => {
  it('drops stale param keys (e.g. the removed kerfDiameter) and stamps the version', () => {
    localStorage.setItem(
      'bs.hwsParams',
      JSON.stringify({
        version: 0,
        params: { ...DEFAULT_HWS_PARAMS, ribCount: 7, kerfDiameter: 0.4 },
      }),
    );
    const s = loadHwsSettings();
    expect(s.version).toBe(HWS_SETTINGS_VERSION);
    expect(s.params.ribCount).toBe(7);
    expect('kerfDiameter' in s.params).toBe(false);
  });

  it('fills missing sections and keys from defaults', () => {
    const s = migrateHwsSettings({ params: { ribCount: 5 } });
    expect(s.params.ribCount).toBe(5);
    expect(s.params.materialThickness).toBe(DEFAULT_HWS_PARAMS.materialThickness);
    expect(s.output).toEqual(DEFAULT_HWS_SETTINGS.output);
  });

  it('ignores values whose type does not match the default', () => {
    const s = migrateHwsSettings({ params: { ribCount: 'twelve' } });
    expect(s.params.ribCount).toBe(DEFAULT_HWS_PARAMS.ribCount);
  });
});
