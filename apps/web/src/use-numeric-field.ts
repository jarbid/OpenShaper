/**
 * Local text state for a numeric input, so the box can legally be empty.
 *
 * The bug this exists to kill: a field driven straight off a `number` prop can never
 * be cleared. Every keystroke re-renders `value={theNumber}`, so deleting the last
 * character puts it straight back — clearing "25" to type "15" leaves "215". Guarding
 * the handler with `if (e.target.value === '') return` (or letting `parseFloat('')`
 * fail a `Number.isFinite` check) *is* the bug: skipping the commit means the prop
 * never changes, and React restores the old text.
 *
 * The fix is that what is typed and what is committed are two different things. The
 * input renders `text` — including empty, `-`, and `1.` — while only parseable text
 * commits upstream. `ControlPointInspector` and `FinPanel` already worked this way;
 * this is that idea shared, minus their commit-on-blur (the export dialogs preview
 * live, so they commit as you type).
 *
 * Re-syncing is gated on focus rather than on value equality. An unfocused field
 * always shows the canonical display, so external changes — a unit switch, undo,
 * "start from the fitted marks" — land immediately; a focused one is never
 * overwritten mid-edit, which a rounding round-trip ("1.55" → "1.6") otherwise does.
 * Blur re-syncs by the same path, which is what restores a field left empty and
 * normalises one left out of range.
 */
import { useEffect, useState } from 'react';

export interface NumericFieldBinding {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  /**
   * A digits-and-separator keypad rather than whatever `type="number"` alone gets
   * you, which on Android is often the full keyboard.
   *
   * Safe for every field driven by this hook because all of them are non-negative
   * physical quantities — spacings, thicknesses, margins, counts — and not one of
   * their `min` values is below zero. A decimal keypad has no minus key, so this
   * would be the wrong hint for a field that stores a sign; those use
   * `NumericInput`'s `signed` instead.
   */
  inputMode: 'decimal';
  /** Enter commits, so the key should say so rather than "go" or "search". */
  enterKeyHint: 'done';
}

export function useNumericField({
  shown,
  parse,
  onCommit,
  clamp,
}: {
  /** The canonical display text for the current value. */
  shown: string;
  /** Text → value. Return a non-finite number for text that is not a number yet. */
  parse: (text: string) => number;
  onCommit: (value: number) => void;
  /**
   * Kept in range before committing, so downstream never sees a value it can't use.
   * Deliberately not applied to `text`: clamping what you typed as you type it is the
   * same class of bug as this hook exists to fix. Blur normalises the text instead.
   */
  clamp?: (value: number) => number;
}): NumericFieldBinding {
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);

  return {
    inputMode: 'decimal',
    enterKeyHint: 'done',
    value: text,
    onChange: (e) => {
      const next = e.target.value;
      setText(next); // whatever was typed stays on screen, empty included
      if (next.trim() === '') return; // a legal thing to be, mid-edit
      const n = parse(next);
      if (Number.isFinite(n)) onCommit(clamp ? clamp(n) : n);
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}

/**
 * Editable text that resets to `shown` whenever the value behind it changes — the
 * commit-on-blur fields (control point, fins) use this. The reset happens during
 * render rather than in an effect, so a value that changes on every drag move costs
 * one commit per move, not two.
 *
 * `syncKey` is what counts as "the value changed"; it defaults to `shown`. Pass the raw
 * value too when a change below display precision should still reset the text.
 */
export function useSyncedText(
  shown: string,
  syncKey: unknown = shown,
): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [text, setText] = useState(shown);
  const [synced, setSynced] = useState(syncKey);
  if (!Object.is(synced, syncKey)) {
    setSynced(syncKey);
    setText(shown);
  }
  return [text, setText];
}
