// SPDX-License-Identifier: GPL-3.0-or-later
import { apexLine, type BezierBoard } from '@openshaper/kernel';
import type { ApexSample } from './specs-protocol';

/**
 * The rail apex height along the board, for the rocker view's apex overlay: the +y
 * rail's apex at the kernel's default sampling (about once a centimetre, on a fine
 * ring). The rails are mirror images, so one side is the whole side view.
 *
 * Tens of milliseconds a board, which is why it runs in the specs worker; the hook's
 * no-Worker fallback calls the same function so both paths trace the same line.
 */
export const apexSamples = (board: BezierBoard): ApexSample[] =>
  apexLine(board)?.right.map(({ x, z }) => ({ x, z })) ?? [];
