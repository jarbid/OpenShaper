import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBrd } from '@openshaper/io';
import { decideImport, downloadBoard, slugifyName } from './file-io';
import { BOARD_TEMPLATES } from './templates';
import type { ImportWarning } from '@openshaper/io';

const info: ImportWarning = { severity: 'info', message: 'fell back' };
const dropped: ImportWarning = { severity: 'dropped', message: 'removed a section' };

describe('slugifyName', () => {
  it('lowercases and hyphenates a board model name', () => {
    expect(slugifyName('My Fish 5\'10"')).toBe('my-fish-5-10');
  });

  it('collapses runs of punctuation and trims edge hyphens', () => {
    expect(slugifyName('  ~~Retro // Twin!  ')).toBe('retro-twin');
  });

  it('falls back to "board" for empty or symbol-only names', () => {
    expect(slugifyName(undefined)).toBe('board');
    expect(slugifyName('')).toBe('board');
    expect(slugifyName('☂☂')).toBe('board');
  });
});

describe('downloadBoard', () => {
  /** The real shortboard the app opens with. */
  const board = parseBrd(BOARD_TEMPLATES[0]!.brd).board;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** Capture the filename the anchor would download, without touching the disk. */
  const savedAs = (meta?: Parameters<typeof downloadBoard>[1]): string => {
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn(() => 'blob:test'),
        revokeObjectURL: vi.fn(),
      }),
    );
    let name = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      name = this.download;
    });
    downloadBoard(board, meta);
    return name;
  };

  // Saving always wrote 'board.board', so the browser de-duplicated repeat saves into
  // 'board (1)', 'board (2)', … even though every other exporter already names its file
  // after the model.
  it('names the file after the board model, like every other export', () => {
    expect(savedAs({ model: 'My Fish 5\'10"' })).toBe('my-fish-5-10.board');
  });

  it('falls back to board.board when the model name is missing or unusable', () => {
    expect(savedAs()).toBe('board.board');
    expect(savedAs({ designer: 'Ada' })).toBe('board.board');
    expect(savedAs({ model: '  ' })).toBe('board.board');
  });
});

describe('decideImport', () => {
  it('loads silently when there are no warnings', () => {
    expect(decideImport([])).toEqual({ action: 'load', dropped: [], info: [] });
  });

  it('loads (no confirm) when warnings are only informational', () => {
    const d = decideImport([info]);
    expect(d.action).toBe('load');
    expect(d.info).toEqual([info]);
    expect(d.dropped).toEqual([]);
  });

  it('requires confirmation when anything was dropped', () => {
    const d = decideImport([info, dropped]);
    expect(d.action).toBe('confirm');
    expect(d.dropped).toEqual([dropped]);
    expect(d.info).toEqual([info]);
  });
});
