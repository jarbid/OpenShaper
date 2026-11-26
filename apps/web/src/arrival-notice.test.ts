// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { RAILS_ARRIVED_NOTICE, SHARED_BOARD_NOTICE, sharedBoardNotice } from './arrival-notice';

describe('sharedBoardNotice', () => {
  it('is the shared-board line, as it always was, when nothing was turned on', () => {
    expect(sharedBoardNotice(null)).toBe(
      'Shared board opened as an editable copy. Changes stay in this browser.',
    );
  });

  it('leads with what happened to the board and adds the rails line once', () => {
    const notice = sharedBoardNotice(RAILS_ARRIVED_NOTICE);
    expect(notice.startsWith(SHARED_BOARD_NOTICE)).toBe(true);
    expect(notice.endsWith(RAILS_ARRIVED_NOTICE)).toBe(true);
    expect(notice.split(RAILS_ARRIVED_NOTICE)).toHaveLength(2);
  });

  it('keeps both sentences word for word: other notices and tests name them', () => {
    expect(RAILS_ARRIVED_NOTICE).toBe(
      'This is a rails board, so the NURBS and rails engines are now on.',
    );
    expect(SHARED_BOARD_NOTICE).toMatch(/^Shared board opened as an editable copy\./);
  });
});
