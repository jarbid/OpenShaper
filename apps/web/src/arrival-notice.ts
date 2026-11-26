// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The words a board's arrival says. The notice slot holds one message, and a share link of a rails board
 * has two things to say: what happened to the board, and what changed in the editor because of it. They go
 * out as one message, so neither replaces the other.
 */

/** A rails board arrived and the engines it needs were turned on (a file, a share link, a recent board, a session). */
export const RAILS_ARRIVED_NOTICE =
  'This is a rails board, so the NURBS and rails engines are now on.';

/** A shared board was opened: it is a copy, and what is changed in it stays here. */
export const SHARED_BOARD_NOTICE =
  'Shared board opened as an editable copy. Changes stay in this browser.';

/**
 * The notice for a shared board that has opened. What happened to the board comes first, and it is the
 * whole message for a board of the classic kind; `railsNotice` is the line a rails board adds (null when it
 * turned nothing on).
 */
export const sharedBoardNotice = (railsNotice: string | null): string =>
  railsNotice ? `${SHARED_BOARD_NOTICE} ${railsNotice}` : SHARED_BOARD_NOTICE;
