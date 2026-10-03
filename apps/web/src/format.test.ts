import { describe, expect, it } from 'vitest';
import { fineLengthStep, fmtSmallLen, fmtVol, LENGTH_UNITS } from './format';

describe('fmtVol', () => {
  it('shows litres to one decimal place, suffixed L', () => {
    expect(fmtVol(27_370)).toBe('27.4L');
    expect(fmtVol(32_100)).toBe('32.1L');
    expect(fmtVol(3_000)).toBe('3.0L');
    expect(fmtVol(100_049)).toBe('100.0L');
  });

  it('rounds rather than truncates', () => {
    expect(fmtVol(27_349)).toBe('27.3L');
    expect(fmtVol(27_351)).toBe('27.4L');
  });
});

describe('unit-aware small lengths and steps (P14)', () => {
  const byKey = (k: string) => LENGTH_UNITS.find((u) => u.key === k)!;

  it('steps ft·in fields by a sixteenth of an inch, like inch fields', () => {
    expect(fineLengthStep(byKey('in'))).toBe(1 / 16);
    expect(fineLengthStep(byKey('ftin'))).toBe(1 / 16);
    expect(fineLengthStep(byKey('mm'))).toBe(0.5);
    expect(fineLengthStep(byKey('cm'))).toBe(0.1);
  });

  it('formats a tolerance in the chosen unit instead of always mm', () => {
    expect(fmtSmallLen(0.01, byKey('mm'))).toBe('0.1 mm');
    expect(fmtSmallLen(0.01, byKey('cm'))).toBe('0.01 cm');
    expect(fmtSmallLen(0.01, byKey('in'))).toBe('0.0039 in');
  });
});
