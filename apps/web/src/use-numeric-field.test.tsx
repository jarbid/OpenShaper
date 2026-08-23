/**
 * The regression these pin: a numeric field driven straight off its `number` prop
 * cannot be cleared, because re-rendering restores the old text. Clearing "25" to
 * type "15" left "215" — the first character was un-deletable in every export and
 * settings field.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { IntField, LenField } from './export-form-atoms';
import { lengthUnitByKey } from './format';

/** Length fields carry their unit suffix inside the label, so match loosely. */
const box = (label: string | RegExp = 'Bands') => screen.getByLabelText(label) as HTMLInputElement;

/** Wraps a field the way the dialogs do: the prop is state the field commits into. */
function Harness({ initial = 25 }: { initial?: number }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <IntField label="Bands" value={v} min={1} max={99} onChange={setV} />
      <output data-testid="committed">{v}</output>
    </>
  );
}

describe('numeric fields can be emptied', () => {
  it('retypes 25 as 15 rather than 215', () => {
    render(<Harness />);
    expect(box().value).toBe('25');

    // Select-all and delete, the way a user replaces a value.
    fireEvent.change(box(), { target: { value: '' } });
    expect(box().value).toBe(''); // the box really is empty

    fireEvent.change(box(), { target: { value: '1' } });
    fireEvent.change(box(), { target: { value: '15' } });

    expect(box().value).toBe('15');
    expect(screen.getByTestId('committed').textContent).toBe('15');
  });

  it('deletes one character at a time down to empty', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '2' } });
    fireEvent.change(box(), { target: { value: '' } });
    expect(box().value).toBe('');
  });

  it('keeps the last good value while the box is empty, and restores it on blur', () => {
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '' } });

    // Nothing downstream ever sees an empty or zero value.
    expect(screen.getByTestId('committed').textContent).toBe('25');

    fireEvent.blur(box());
    expect(box().value).toBe('25');
  });

  it('does not clamp mid-edit, but commits in range', () => {
    const onChange = vi.fn();
    render(<IntField label="Bands" value={3} min={1} max={8} onChange={onChange} />);

    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '12' } });

    // What was typed stays on screen; what was committed stays in range.
    expect(box().value).toBe('12');
    expect(onChange).toHaveBeenLastCalledWith(8);
  });

  it('clears a length field too, and reports centimetres back', () => {
    const onChange = vi.fn();
    render(<LenField label="Tuck up" cm={2} units={lengthUnitByKey('cm')} onChange={onChange} />);

    fireEvent.change(box(/Tuck up/), { target: { value: '' } });
    expect(box(/Tuck up/).value).toBe('');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(box(/Tuck up/), { target: { value: '3.5' } });
    expect(onChange).toHaveBeenLastCalledWith(3.5);
  });

  it('re-syncs an unfocused field when the value changes externally', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <IntField label="Bands" value={3} min={1} max={9} onChange={onChange} />,
    );
    rerender(<IntField label="Bands" value={7} min={1} max={9} onChange={onChange} />);
    expect(box().value).toBe('7');
  });
});
