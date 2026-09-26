import { describe, expect, it } from 'vitest';
import { fmtVol } from './format';

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
