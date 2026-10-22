import { expect, test, type Page } from '@playwright/test';
import { editorReady } from './helpers';

/**
 * A budget on touch target size, so the floor cannot regress quietly.
 *
 * 44px is Apple's ergonomic minimum; [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
 * sets the legal one at 24px. Before the design system grew a coarse-pointer floor,
 * **47 of 49** interactive elements on the phone landing screen were under 44px and
 * the smallest were 13px checkboxes and 19x18px steppers — under half the legal
 * minimum.
 *
 * Two things make this worth running in a browser rather than asserting on classes:
 *
 *  - Merged Tailwind classes do not tell you the height. `CrossSectionControls`
 *    passes `h-7 w-7` through `className`, which beats the base `h-8` but loses to
 *    `pointer-coarse:h-11`. Reading the class list produced two contradictory audit
 *    claims before anyone measured the box.
 *  - Overflow is invisible to a class check. The cross-section cluster used to run
 *    from 341px to 399px in a 360px viewport, so Copy and Paste were rendered,
 *    styled and completely unreachable. `offscreen` below is the assertion that
 *    catches that, and it is a different question from "is it big enough".
 *
 * Exceptions are listed, never silent: an entry here is a reviewable claim that a
 * control is deliberately below the floor, with the reason attached.
 */

const FLOOR = 44;
/** WCAG 2.5.8's own minimum, which nothing may go under whatever its reason. */
const HARD_FLOOR = 24;

interface Allowed {
  /** Matched against the element's accessible name, when it has one. */
  name?: RegExp;
  /**
   * Matched against `tag`, e.g. `input[checkbox]`.
   *
   * An exception for a control with no accessible name has to key off this. Keying
   * off the empty name instead exempts *every* unnamed control in the app, which is
   * the opposite of an allowlist — it let four 32px number fields through while the
   * entry meant only to cover native checkboxes.
   */
  tag?: RegExp;
  /** The lower bound this control is held to instead of {@link FLOOR}. */
  floor: number;
  why: string;
}

const matches = (a: Allowed, t: Target): boolean =>
  (a.name?.test(t.name) ?? true) && (a.tag?.test(t.tag) ?? true) && (!!a.name || !!a.tag);

const ALLOWLIST: Allowed[] = [
  {
    name: /^(Increase|Decrease) slice position$/,
    floor: HARD_FLOOR,
    why: 'Two stacked steppers at 44px would be an 88px column in a pane header with 40px of content space. They sit at the WCAG minimum, and the 44px field beside them edits the same value.',
  },
  {
    name: /^Learn more$/,
    floor: 0,
    why: 'An inline link inside a sentence. WCAG 2.5.8 exempts targets whose size is constrained by the line box, and padding one out would break the paragraph it sits in.',
  },
  {
    tag: /^input\[checkbox\]$/,
    floor: HARD_FLOOR,
    why: 'Native checkboxes. The box cannot be grown with padding — it IS the control — so the floor lives on the wrapping label, which is the whole clickable row.',
  },
];

interface Target {
  name: string;
  tag: string;
  w: number;
  h: number;
  /** How far the element's right edge runs past the viewport, in px. */
  overflow: number;
}

/** Every visible interactive element, with its rendered box. */
async function targets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    const selector = 'button, a, input, select, textarea, [role=button], [role=menuitem], summary';
    return ([...document.querySelectorAll(selector)] as HTMLElement[])
      .map((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') return null;
        return {
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          tag:
            el.tagName.toLowerCase() +
            (el.getAttribute('type') ? `[${el.getAttribute('type')}]` : ''),
          w: Math.round(box.width),
          h: Math.round(box.height),
          overflow: Math.round(Math.max(0, box.right - window.innerWidth)),
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  });
}

const floorFor = (t: Target): number => ALLOWLIST.find((a) => matches(a, t))?.floor ?? FLOOR;

const describeTarget = (t: Target) => `${t.w}x${t.h} ${t.tag} "${t.name || '(unnamed)'}"`;

/** Controls smaller than the floor they are held to. */
const undersized = (all: Target[]) =>
  all.filter((t) => Math.min(t.w, t.h) < floorFor(t)).map(describeTarget);

/** Controls whose right edge is off the screen — present but unreachable. */
const offscreen = (all: Target[]) =>
  all
    .filter((t) => t.overflow > 0)
    .map((t) => `${describeTarget(t)} runs ${t.overflow}px past the viewport`);

test.describe('touch targets on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test('meet the floor in every editor view', async ({ page }) => {
    await page.goto('/app');
    await editorReady(page);

    // Outline is where a phone lands; cross-section is the densest header in the
    // app and the one that used to overflow.
    for (const [key, view] of [
      ['2', 'outline'],
      ['4', 'cross-section'],
    ] as const) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);

      const all = await targets(page);
      expect(
        all.length,
        `${view}: nothing interactive found — the survey is not looking at the app`,
      ).toBeGreaterThan(5);
      expect(undersized(all), `${view}: under the touch floor`).toEqual([]);
      expect(offscreen(all), `${view}: rendered off the edge of the screen`).toEqual([]);
    }
  });

  test('meet the floor with the panels open', async ({ page }) => {
    await page.goto('/app');
    await editorReady(page);
    await page.getByRole('button', { name: /board panels$/i }).click();
    await page.waitForTimeout(400);

    const all = await targets(page);
    expect(
      all.some((t) => /Copy dimensions/.test(t.name)),
      'the sheet did not open',
    ).toBe(true);
    expect(undersized(all), 'sheet at half: under the touch floor').toEqual([]);
    expect(offscreen(all), 'sheet at half: rendered off the edge of the screen').toEqual([]);
  });

  test('meet the floor inside a dialog, where the form fields live', async ({ page }) => {
    // The dialogs are where nearly every numeric field in the app actually is, and
    // they render over the editor rather than inside it — so the two checks above,
    // which only ever saw the landing screen and the sheet, could not reach them.
    // Three of those fields were still raw `<input>` elements with hand-rolled
    // `h-8 ... text-sm` classes, i.e. 32px and below the iOS zoom threshold.
    await page.goto('/app');
    await editorReady(page);
    await page.getByRole('button', { name: 'Menu and commands' }).click();
    // Rail bands is the dialog that actually renders the shared numeric atoms
    // (`IntField`, `LenField`) — a dozen of them. Picking a dialog without them
    // would make this case pass on an empty form.
    await page.getByRole('option', { name: 'Export: Rail bands…', exact: true }).click();
    await page.waitForTimeout(400);

    const all = await targets(page);
    const fields = all.filter((t) => t.tag.startsWith('input[number]'));
    expect(
      fields.length,
      'the dialog rendered no numeric fields to measure',
    ).toBeGreaterThanOrEqual(4);
    expect(undersized(all), 'export dialog: under the touch floor').toEqual([]);
  });

  test('do not zoom iOS when a text field takes focus', async ({ page }) => {
    // Below 16px, Safari zooms the page on focus and never zooms back. A checkbox
    // has no text to enter, so the threshold does not apply to it.
    await page.goto('/app');
    await editorReady(page);
    await page.getByRole('button', { name: /board panels$/i }).click();
    await page.waitForTimeout(400);

    const small = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('input, select, textarea')] as HTMLElement[];
      return fields
        .filter((el) => {
          if (el.getBoundingClientRect().height === 0) return false;
          return (el as HTMLInputElement).type !== 'checkbox';
        })
        .map((el) => ({
          font: parseFloat(getComputedStyle(el).fontSize),
          name: (el.getAttribute('aria-label') ?? el.tagName).trim(),
        }))
        .filter((f) => f.font < 16)
        .map((f) => `${f.name} at ${f.font}px`);
    });
    expect(small, 'text fields below the 16px iOS focus-zoom threshold').toEqual([]);
  });
});
