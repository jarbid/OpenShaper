/**
 * P30: a download's object URL must outlive the click. Safari and Firefox start
 * the download asynchronously, so revoking straight after click() could cancel it.
 */
import { parseBrd } from '@openshaper/io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBoard } from './file-io';
import sampleBrd from './sample-board.brd?raw';

const { board } = parseBrd(sampleBrd);

beforeEach(() => {
  vi.useFakeTimers();
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('download timing (P30)', () => {
  it('revokes the object URL only after the browser has had time to start', () => {
    const attached: boolean[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      attached.push(this.isConnected);
    });

    downloadBoard(board, {});

    expect(attached).toEqual([true]); // clicked while in the document
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(document.querySelector('a[download]')).toBeNull(); // cleaned up
  });
});
