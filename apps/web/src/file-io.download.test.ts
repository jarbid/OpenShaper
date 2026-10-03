/**
 * P30: a download's object URL must outlive the click. Safari and Firefox start
 * the download asynchronously, so revoking straight after click() could cancel it.
 */
import { parseBrd } from '@openshaper/io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBoard, downloadBrd } from './file-io';
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

describe('.brd bytes (P24)', () => {
  it('are latin1, so a non-ASCII model reads back as itself', async () => {
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:test';
    }) as typeof URL.createObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadBrd(board, { model: 'Café' });

    const bytes = new Uint8Array(await blob!.arrayBuffer());
    const at = bytes.findIndex(
      (b, i) => b === 0x43 && bytes[i + 1] === 0x61 && bytes[i + 2] === 0x66,
    );
    expect([...bytes.subarray(at, at + 4)]).toEqual([0x43, 0x61, 0x66, 0xe9]); // C a f é
  });
});
