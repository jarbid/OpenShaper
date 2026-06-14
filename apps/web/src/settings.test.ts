import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  migrateSettings,
  SETTINGS_VERSION,
  type EditorSettings,
} from './settings';

// Reset localStorage between tests.
beforeEach(() => {
  localStorage.clear();
});

describe('DEFAULT_SETTINGS', () => {
  it('has a version field', () => {
    expect(typeof DEFAULT_SETTINGS.version).toBe('number');
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION);
  });

  it('exposes all required color + size fields', () => {
    expect(typeof DEFAULT_SETTINGS.outlineColor).toBe('string');
    expect(typeof DEFAULT_SETTINGS.deckColor).toBe('string');
    expect(typeof DEFAULT_SETTINGS.bottomColor).toBe('string');
    expect(typeof DEFAULT_SETTINGS.crossSectionColor).toBe('string');
    expect(typeof DEFAULT_SETTINGS.ghostColor).toBe('string');
    expect(typeof DEFAULT_SETTINGS.gridColor).toBe('string');
    expect(typeof DEFAULT_SETTINGS.controlPointSize).toBe('number');
    expect(typeof DEFAULT_SETTINGS.curveThickness).toBe('number');
  });

  it('all color values are valid CSS hex strings', () => {
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    expect(DEFAULT_SETTINGS.outlineColor).toMatch(hexRe);
    expect(DEFAULT_SETTINGS.deckColor).toMatch(hexRe);
    expect(DEFAULT_SETTINGS.bottomColor).toMatch(hexRe);
    expect(DEFAULT_SETTINGS.crossSectionColor).toMatch(hexRe);
    expect(DEFAULT_SETTINGS.ghostColor).toMatch(hexRe);
    expect(DEFAULT_SETTINGS.gridColor).toMatch(hexRe);
  });
});

describe('loadSettings', () => {
  it('returns defaults when localStorage is empty', () => {
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('returns saved settings when present and valid', () => {
    const custom: EditorSettings = {
      ...DEFAULT_SETTINGS,
      outlineColor: '#ff0000',
      controlPointSize: 8,
    };
    localStorage.setItem('bs.settings', JSON.stringify(custom));
    const s = loadSettings();
    expect(s.outlineColor).toBe('#ff0000');
    expect(s.controlPointSize).toBe(8);
  });

  it('returns defaults when JSON is malformed', () => {
    localStorage.setItem('bs.settings', 'not-json{{{');
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in missing fields with defaults (forward-compat)', () => {
    // Simulate a saved blob that is missing the gridColor field.
    const partial = { ...DEFAULT_SETTINGS } as Partial<EditorSettings>;
    delete (partial as Record<string, unknown>).gridColor;
    localStorage.setItem('bs.settings', JSON.stringify(partial));
    const s = loadSettings();
    expect(s.gridColor).toBe(DEFAULT_SETTINGS.gridColor);
  });
});

describe('saveSettings', () => {
  it('persists settings to localStorage under the correct key', () => {
    const custom: EditorSettings = { ...DEFAULT_SETTINGS, deckColor: '#123456' };
    saveSettings(custom);
    const raw = localStorage.getItem('bs.settings');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.deckColor).toBe('#123456');
  });

  it('round-trips through load/save', () => {
    const custom: EditorSettings = {
      ...DEFAULT_SETTINGS,
      bottomColor: '#abcdef',
      curveThickness: 3,
    };
    saveSettings(custom);
    const loaded = loadSettings();
    expect(loaded).toEqual(custom);
  });
});

describe('migrateSettings', () => {
  it('returns defaults unchanged when version matches', () => {
    const result = migrateSettings(DEFAULT_SETTINGS);
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('stamps the current version onto an old blob', () => {
    const oldBlob = { ...DEFAULT_SETTINGS, version: 0 };
    const result = migrateSettings(oldBlob as EditorSettings);
    expect(result.version).toBe(SETTINGS_VERSION);
  });

  it('fills in missing keys when migrating from an older version', () => {
    const oldBlob = { version: 0, outlineColor: '#aabbcc' } as Partial<EditorSettings>;
    const result = migrateSettings(oldBlob as EditorSettings);
    expect(result.deckColor).toBe(DEFAULT_SETTINGS.deckColor);
    expect(result.outlineColor).toBe('#aabbcc');
  });
});
