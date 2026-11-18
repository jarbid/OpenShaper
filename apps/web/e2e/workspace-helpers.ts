import { readFileSync } from 'node:fs';
import { expect, type ConsoleMessage, type Locator, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * What the two workspace specs share: both experimental switches on before the app loads, a Funboard converted
 * into the rails board, the design list, the drawing, and the helpers that drag a control point and read what
 * the 3D model has been rebuilt for.
 */

export const STEPS = [
  'Outline',
  'Rocker and foil',
  'Deck',
  'Bottom',
  'Rails',
  'Tail',
  'Fins',
] as const;
export const PANELS = ['Specs', 'Build', 'Compare'] as const;

/** Console errors and page errors, leaving the ones a headless browser without a GPU always logs. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !/webgl|WebGL|GPU/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

export const menu = (page: Page, name: string) =>
  page.getByRole('menubar').getByRole('menuitem', { name, exact: true });
export const badge = (page: Page) => page.getByTestId('nurbs-badge');
export const list = (page: Page) => page.getByRole('navigation', { name: 'Design steps' });
/** A list entry by its name: its text on the wide list, its label on the icon column. */
export const entry = (page: Page, name: string) =>
  list(page).getByRole('button', { name, exact: true });
/** The divider between the board and the drawing. */
export const divider = (page: Page) =>
  page.getByRole('separator', { name: /board and the drawing/ });
/** The 2D drawing's canvas: the 3D board's comes first in the page, the drawing's after it. */
export const drawing = (page: Page) => page.locator('canvas').last();
/** The 3D board's canvas. */
export const board3d = (page: Page) => page.locator('canvas').first();

export const updates = async (page: Page): Promise<number> =>
  Number((await badge(page).getAttribute('data-update')) ?? 0);

/** Wait until the 3D model has been rebuilt more than `since` times. */
export const rebuilt = (page: Page, since: number) =>
  expect.poll(() => updates(page), { timeout: 20_000 }).toBeGreaterThan(since);

/**
 * Have the NURBS and rails engines on before the app loads (as turning them on in Settings would), once per
 * browser context, with whatever else the test wants stored (`bs.viewState`, say).
 */
export async function seedSwitches(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.addInitScript((more) => {
    if (localStorage.getItem('bs.settings')) return;
    localStorage.setItem(
      'bs.settings',
      JSON.stringify({ version: 2, nurbsEngine: true, surfaceEngine: 'rails' }),
    );
    for (const [k, v] of Object.entries(more)) localStorage.setItem(k, v);
  }, extra);
}

/** Open the editor with a Funboard converted into the rails board: the workspace is showing. */
export async function openFunboard(page: Page): Promise<void> {
  await page.goto('/app');
  await editorReady(page);
  await menu(page, 'File').click();
  await page.getByRole('menuitem', { name: 'Funboard', exact: true }).click();
  await expect(badge(page)).toHaveAttribute('data-engine', 'rails', { timeout: 60_000 });
  await expect(list(page)).toBeVisible();
}

export async function savedText(page: Page): Promise<string> {
  await menu(page, 'File').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^Save\b/ }).click(),
  ]);
  return readFileSync((await download.path())!, 'utf8');
}

/**
 * Click on a grid of points over the drawing until a control point is selected (its position editor is in the
 * header); leave it selected. `fx` and `fy` are the shares of the canvas's width and height to scan, from the
 * top left. Keep out of what must not be picked: in a cross-section the centre point stands on the middle of
 * the pane and cannot be moved (scan `fx` from 0.6), and in the outline the station markers sit along the top
 * and bottom edges (scan `fy` from 0.14).
 */
export async function selectPoint(
  page: Page,
  fx: [number, number] = [0.04, 0.97],
  fy: [number, number] = [0.06, 0.95],
): Promise<{ x: number; y: number }> {
  const box = (await drawing(page).boundingBox())!;
  for (let y = fy[0]; y < fy[1]; y += 0.025) {
    for (let x = fx[0]; x < fx[1]; x += 0.02) {
      const px = box.x + box.width * x;
      const py = box.y + box.height * y;
      await page.mouse.click(px, py);
      const editor = page.getByLabel(/ position editor$/).first();
      if (await editor.isVisible().catch(() => false)) return { x: px, y: py };
    }
  }
  throw new Error('no control point found in the drawing');
}

export async function drag(page: Page, from: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    // both ways: a point held on one axis (a handle on the stringer) still moves on the other
    await page.mouse.move(from.x + (Math.abs(dy) * i) / 8, from.y + (dy * i) / 8);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

/** The step the list marks as current, by its name. */
export async function currentStep(page: Page): Promise<string[]> {
  const names: string[] = [];
  const buttons = list(page).getByRole('button');
  for (let i = 0; i < (await buttons.count()); i++) {
    const b: Locator = buttons.nth(i);
    if ((await b.getAttribute('aria-current')) === 'step') {
      names.push((await b.getAttribute('aria-label')) ?? ((await b.innerText()).trim() || ''));
    }
  }
  return names;
}
