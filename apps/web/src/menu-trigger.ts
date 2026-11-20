// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The menubar button of the menu that is open now, or null when none is.
 *
 * Choosing an item closes the menu and takes the item out of the page, and with it the focus, which is left
 * on the page itself. A dialog an item opens notes what had the focus when it opened and gives it back when it
 * closes, so the item's action puts the focus on this button first: closing the dialog then lands where the
 * menu was opened from, and a keyboard user can open the menu again.
 */
export function openMenuButton(): HTMLElement | null {
  const panel = document.querySelector('[role="menubar"] [role="menu"]');
  const button = panel?.previousElementSibling;
  return button instanceof HTMLElement && button.getAttribute('aria-haspopup') === 'menu'
    ? button
    : null;
}
